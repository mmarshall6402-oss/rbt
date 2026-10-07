import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { devVerify } from './auth.js';
import { createDb } from './db.js';
import { migrate } from './migrate.js';

// Requires a throwaway database: TEST_DATABASE_URL=postgres://... (the schema is dropped and recreated)
const url = process.env.TEST_DATABASE_URL;
const db = createDb(url ?? 'postgres://invalid');
const app = buildApp({ db, verify: devVerify(), logger: false });

const ids = { trainee: '', other: '', sup: '', sup2: '' };
const as = (sub: string) => {
  const headers = { 'x-dev-sub': sub };
  return {
    get: (u: string) => app.inject({ method: 'GET', url: `/api${u}`, headers }),
    post: (u: string, payload: object = {}) => app.inject({ method: 'POST', url: `/api${u}`, payload, headers }),
    put: (u: string, payload: object) => app.inject({ method: 'PUT', url: `/api${u}`, payload, headers }),
    patch: (u: string, payload: object) => app.inject({ method: 'PATCH', url: `/api${u}`, payload, headers }),
    del: (u: string) => app.inject({ method: 'DELETE', url: `/api${u}`, headers }),
    /** Logs an entry under a fresh client-generated id (or the given one). */
    log: (o: object = {}, id: string = randomUUID()) => app.inject({ method: 'PUT', url: `/api/entries/${id}`, payload: entry(o), headers }),
  };
};
const trainee = as('trainee'), other = as('other'), sup = as('sup'), sup2 = as('sup2');
const entry = (o: object = {}) => ({ supervisorId: ids.sup, workDate: '2026-09-01', startTime: '08:00', endTime: '10:00', kind: 'independent', ...o });

/** Runs SQL as the restricted app role, the way the API does, for a given user. */
async function asRole<T>(userId: string, fn: (trx: Parameters<Parameters<ReturnType<typeof db.transaction>['execute']>[0]>[0]) => Promise<T>) {
  return db.transaction().execute(async trx => {
    await sql`select set_config('app.user_id', ${userId}, true), set_config('role', 'fieldtrack_app', true)`.execute(trx);
    return fn(trx);
  });
}

describe.skipIf(!url)('API', () => {
  beforeAll(async () => {
    await sql.raw('drop schema public cascade; create schema public;').execute(db);
    await migrate(url!);
  });
  afterAll(() => db.destroy());

  beforeEach(async () => {
    // The audit log refuses TRUNCATE; replica mode (superuser, tests only) skips that trigger.
    await sql.raw(`set session_replication_role = replica;
      truncate users, supervisions, entries, month_verifications, audit_log, organizations restart identity cascade;
      set session_replication_role = origin;`).execute(db);
    const users = await db.insertInto('users').values([
      { cognitoSub: 'trainee', email: 't@x', fullName: 'Trainee', role: 'trainee', fieldworkType: 'concentrated', credential: 'bcba', rulesEdition: '2022' },
      { cognitoSub: 'other', email: 'o@x', fullName: 'Other', role: 'trainee', fieldworkType: 'supervised', credential: 'bcba', rulesEdition: '2022' },
      { cognitoSub: 'sup', email: 's@x', fullName: 'Sup', role: 'supervisor', inviteCode: 'SUPCODE1' },
      { cognitoSub: 'sup2', email: 's2@x', fullName: 'Sup2', role: 'supervisor', inviteCode: 'SUPCODE2' },
    ]).returning(['id', 'cognitoSub']).execute();
    for (const u of users) ids[u.cognitoSub as keyof typeof ids] = u.id;
    await db.insertInto('supervisions').values([
      { traineeId: ids.trainee, supervisorId: ids.sup, startsOn: '2026-01-01', endsOn: null },
      { traineeId: ids.trainee, supervisorId: ids.sup2, startsOn: '2026-01-01', endsOn: '2026-06-30' },
    ]).execute();
  });

  it('rejects unauthenticated and unknown users', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    expect((await as('nobody').get('/me')).statusCode).toBe(403);
    expect((await trainee.get('/me')).json()).not.toHaveProperty('cognitoSub');
  });

  it('creates and lists entries for the month', async () => {
    const res = await trainee.log({ restrictedMinutes: 30 });
    expect(res.statusCode).toBe(201);
    expect(res.json().entry).toMatchObject({ workDate: '2026-09-01', startTime: '08:00', restrictedMinutes: 30 });
    expect((await trainee.get('/entries?month=2026-09')).json()).toHaveLength(1);
    expect((await trainee.get('/entries?month=2026-10')).json()).toHaveLength(0);
  });

  it('validates input with shared rules', async () => {
    expect((await trainee.log({ restrictedMinutes: 121 })).json().error).toMatch(/exceeds/);
    expect((await trainee.log({ endTime: '07:00' })).statusCode).toBe(400);
    expect((await trainee.log({ workDate: 'nope' })).statusCode).toBe(400);
    expect((await trainee.log({ contact: 'contact' })).statusCode).toBe(400); // contact on independent
    expect((await trainee.put('/entries/not-a-uuid', entry())).statusCode).toBe(400);
  });

  it('requires an active supervision on the work date', async () => {
    expect((await trainee.log({ supervisorId: ids.sup2 })).statusCode).toBe(400); // ended June
    expect((await trainee.log({ supervisorId: ids.sup2, workDate: '2026-06-15' })).statusCode).toBe(201);
  });

  it('only trainees log hours', async () => expect((await sup.log()).statusCode).toBe(403));

  it('warns on overlaps without blocking', async () => {
    await trainee.log();
    const res = await trainee.log({ startTime: '09:00', endTime: '11:00' });
    expect(res.statusCode).toBe(201);
    expect(res.json().warnings).toEqual(['Overlaps 08:00–10:00']);
  });

  describe('idempotent sync', () => {
    it('a retried upload with the same UUID never duplicates hours or audit rows', async () => {
      const id = randomUUID();
      expect((await trainee.log({}, id)).statusCode).toBe(201);
      expect((await trainee.log({}, id)).statusCode).toBe(200);
      expect((await trainee.log({}, id)).statusCode).toBe(200);
      expect((await trainee.get('/entries?month=2026-09')).json()).toHaveLength(1);
      expect((await trainee.get('/months/2026-09')).json().summary.totalMinutes).toBe(120);
      expect(await db.selectFrom('auditLog').select('action').where('rowId', '=', id).execute()).toEqual([{ action: 'INSERT' }]);
    });
    it('the same UUID with new data updates in place', async () => {
      const id = randomUUID();
      await trainee.log({}, id);
      const res = await trainee.log({ endTime: '09:00' }, id);
      expect(res.statusCode).toBe(200);
      expect(res.json().entry.endTime).toBe('09:00');
      expect((await trainee.get('/entries?month=2026-09')).json()).toHaveLength(1);
    });
    it("can't take over another trainee's entry id", async () => {
      const id = randomUUID();
      await trainee.log({}, id);
      await db.insertInto('supervisions').values({ traineeId: ids.other, supervisorId: ids.sup, startsOn: '2026-01-01', endsOn: null }).execute();
      expect((await other.log({}, id)).statusCode).toBe(404);
      expect((await trainee.get('/entries?month=2026-09')).json()[0].endTime).toBe('10:00');
    });
    it('deletes are idempotent and deleted entries stay deleted', async () => {
      const id = randomUUID();
      await trainee.log({}, id);
      expect((await trainee.del(`/entries/${id}`)).statusCode).toBe(204);
      expect((await trainee.del(`/entries/${id}`)).statusCode).toBe(204);
      expect((await trainee.log({}, id)).statusCode).toBe(409);
      expect((await other.del(`/entries/${id}`)).statusCode).toBe(404);
    });
  });

  it('enforces who can see what', async () => {
    await trainee.log();
    await trainee.log({ supervisorId: ids.sup2, workDate: '2026-06-15' });
    expect((await other.get(`/entries?month=2026-09&traineeId=${ids.trainee}`)).statusCode).toBe(404);
    expect((await sup.get(`/entries?month=2026-09&traineeId=${ids.trainee}`)).json()).toHaveLength(1);
    expect((await sup.get(`/entries?month=2026-06&traineeId=${ids.trainee}`)).json()).toHaveLength(0); // sup2's entry hidden from sup
  });

  it('edits, soft-deletes, and audits with the actor', async () => {
    const id = randomUUID();
    await trainee.log({}, id);
    expect((await trainee.log({ endTime: '09:00' }, id)).json().entry.endTime).toBe('09:00');
    expect((await trainee.log({ endTime: '07:00' }, id)).statusCode).toBe(400);
    expect((await trainee.del(`/entries/${id}`)).statusCode).toBe(204);
    expect((await trainee.get('/entries?month=2026-09')).json()).toHaveLength(0);
    const audit = await db.selectFrom('auditLog').select(['action', 'actorId']).where('tableName', '=', 'entries').orderBy('id').execute();
    expect(audit.map(a => a.action)).toEqual(['INSERT', 'UPDATE', 'UPDATE']);
    expect(audit.every(a => a.actorId === ids.trainee)).toBe(true);
  });

  describe('history', () => {
    it('explains exactly why a month total dropped', async () => {
      const id = randomUUID();
      await trainee.log({ startTime: '08:00', endTime: '16:00' }, id); // 8 h
      await trainee.log({ startTime: '08:00', endTime: '12:00' }, id); // edited to 4 h
      const changes = (await trainee.get('/changes?month=2026-09')).json();
      expect(changes.map((c: { action: string; minutesDelta: number }) => [c.action, c.minutesDelta])).toEqual([['CREATE', 480], ['UPDATE', -240]]);
      expect(changes[1]).toMatchObject({ entryId: id, actor: { name: 'Trainee' }, changes: [{ field: 'endTime', from: '16:00:00', to: '12:00:00' }] });
    });
    it('tracks entries moved between months and deletions', async () => {
      const id = randomUUID();
      await trainee.log({}, id);
      await trainee.log({ workDate: '2026-10-01' }, id);
      expect((await trainee.get('/changes?month=2026-09')).json().map((c: { minutesDelta: number }) => c.minutesDelta)).toEqual([120, -120]);
      await trainee.del(`/entries/${id}`);
      expect((await trainee.get(`/entries/${id}/history`)).json().map((c: { action: string }) => c.action)).toEqual(['CREATE', 'UPDATE', 'DELETE']);
    });
    it("hides other people's history", async () => {
      const id = randomUUID();
      await trainee.log({}, id);
      expect((await other.get(`/entries/${id}/history`)).statusCode).toBe(404);
      expect((await sup.get(`/entries/${id}/history`)).statusCode).toBe(200);
      expect((await sup2.get(`/changes?month=2026-09&traineeId=${ids.other}`)).statusCode).toBe(404);
    });
  });

  describe('database security (row-level security, enforced by Postgres)', () => {
    it('supervisors only see entries dated inside their active supervision period', async () => {
      await trainee.log({ supervisorId: ids.sup2, workDate: '2026-06-15' });
      await db.updateTable('entries').set({ workDate: '2026-07-15' }).execute(); // as owner: simulate an out-of-period row
      expect(await asRole(ids.sup2, trx => trx.selectFrom('entries').select('id').execute())).toHaveLength(0);
      await db.updateTable('entries').set({ workDate: '2026-06-15' }).execute();
      expect(await asRole(ids.sup2, trx => trx.selectFrom('entries').select('id').execute())).toHaveLength(1);
    });
    it('users cannot read unlinked people or their supervisions', async () => {
      const visible = await asRole(ids.other, trx => trx.selectFrom('users').select('fullName').execute());
      expect(visible.map(u => u.fullName)).toEqual(['Other']);
      expect(await asRole(ids.other, trx => trx.selectFrom('supervisions').select('id').execute())).toHaveLength(0);
    });
    it('raw SQL cannot insert entries for someone else or under an unlinked supervisor', async () => {
      const row = { traineeId: ids.trainee, supervisorId: ids.sup, workDate: '2026-09-01', startTime: '08:00', endTime: '09:00', kind: 'independent' as const, restrictedMinutes: 0, isGroup: false, contact: null, format: null, description: '', deletedAt: null, organizationId: null };
      await expect(asRole(ids.other, trx => trx.insertInto('entries').values(row).execute())).rejects.toThrow(/row-level security/);
      await expect(asRole(ids.trainee, trx => trx.insertInto('entries').values({ ...row, supervisorId: ids.sup2 }).execute())).rejects.toThrow(/row-level security/);
    });
    it('the audit log is append-only, even for the table owner', async () => {
      await trainee.log();
      await expect(sql`update audit_log set action = 'x'`.execute(db)).rejects.toThrow(/append-only/);
      await expect(sql`delete from audit_log`.execute(db)).rejects.toThrow(/append-only/);
      await expect(sql`truncate audit_log`.execute(db)).rejects.toThrow(/append-only/);
      await expect(asRole(ids.trainee, trx => sql`delete from audit_log`.execute(trx))).rejects.toThrow();
    });
    it('only the supervisor can set the supervisor signature', async () => {
      await db.insertInto('monthVerifications').values({ traineeId: ids.trainee, supervisorId: ids.sup, month: '2026-09-01', fieldworkType: 'concentrated', rulesVersion: 'bacb-2022-01', summary: '{}', traineeSignedAt: new Date(), supervisorSignedAt: null, pdfS3Key: null }).execute();
      await expect(asRole(ids.trainee, trx => trx.updateTable('monthVerifications').set({ supervisorSignedAt: new Date() }).execute())).rejects.toThrow(/only the signer/);
    });
  });

  it('returns 409 when editing a signed month', async () => {
    const id = randomUUID();
    await trainee.log({}, id);
    await db.insertInto('monthVerifications').values({ traineeId: ids.trainee, supervisorId: ids.sup, month: '2026-09-01', fieldworkType: 'concentrated', rulesVersion: 'bacb-2022-01', summary: '{}', traineeSignedAt: null, supervisorSignedAt: new Date(), pdfS3Key: null }).execute();
    expect((await trainee.log({ description: 'x' }, id)).statusCode).toBe(409);
    expect((await trainee.log({ workDate: '2026-09-02' })).statusCode).toBe(409);
  });

  it('evaluates the month and overall progress with the rules engine', async () => {
    await trainee.log({ startTime: '00:00', endTime: '18:00' });
    await trainee.log({ workDate: '2026-09-02', kind: 'supervised', contact: 'observation', format: 'online' });
    const month = (await trainee.get('/months/2026-09')).json();
    expect(month.summary).toMatchObject({ totalMinutes: 1200, supervisedMinutes: 120, observations: 1 });
    expect(month.checks.find((c: { id: string }) => c.id === 'contacts')).toMatchObject({ ok: false, needed: 5 });
    expect((await sup.get(`/progress?traineeId=${ids.trainee}`)).json()).toMatchObject({ requiredMinutes: 90000, countableMinutes: 0 });
    expect((await trainee.get('/months/2026-13')).statusCode).toBe(400);
  });

  it('evaluates each verification form (month × supervisor) separately', async () => {
    await trainee.log({ workDate: '2026-06-01' });
    await trainee.log({ workDate: '2026-06-02', supervisorId: ids.sup2, endTime: '11:00' });
    expect((await trainee.get('/months/2026-06')).json().error).toMatch(/per supervisor/);
    expect((await trainee.get(`/months/2026-06?supervisorId=${ids.sup2}`)).json().summary.totalMinutes).toBe(180);
    expect((await sup.get(`/months/2026-06?traineeId=${ids.trainee}&supervisorId=${ids.sup2}`)).json().summary.totalMinutes).toBe(120); // scope wins
    expect((await trainee.get('/progress')).json().months.map((m: { supervisorId: string }) => m.supervisorId).sort()).toEqual([ids.sup, ids.sup2].sort());
  });

  describe('signup', () => {
    it('creates a trainee', async () => {
      const res = await as('new@x').post('/signup', { role: 'trainee', fullName: 'New', fieldworkType: 'supervised' });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ email: 'new@x', role: 'trainee', fieldworkType: 'supervised', credential: 'bcba', rulesEdition: '2027', inviteCode: null });
      expect((await as('new@x').get('/me')).statusCode).toBe(200);
      expect((await as('new@x').post('/signup', { role: 'trainee', fullName: 'New', fieldworkType: 'supervised' })).statusCode).toBe(409);
    });
    it('creates a supervisor with an invite code and requires a BACB number', async () => {
      expect((await as('bcba@x').post('/signup', { role: 'supervisor', fullName: 'B' })).statusCode).toBe(400);
      const res = await as('bcba@x').post('/signup', { role: 'supervisor', fullName: 'B', bacbId: '1-23-45678' });
      expect(res.json().inviteCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
      expect(res.json()).toMatchObject({ credential: null, rulesEdition: null });
    });
    it('rejects self-assigned admin and missing auth', async () => {
      expect((await as('x@x').post('/signup', { role: 'admin', fullName: 'X' })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/signup', payload: {} })).statusCode).toBe(401);
    });
  });

  describe('fieldwork standard (2022 vs 2027)', () => {
    it('a trainee switches standards and the same month is re-evaluated under the new rules', async () => {
      await trainee.log({ startTime: '00:00', endTime: '18:00' });
      await trainee.log({ workDate: '2026-09-02', kind: 'supervised', contact: 'observation', format: 'online' });
      const ids22 = (await trainee.get('/months/2026-09')).json().checks.map((c: { id: string }) => c.id);
      expect(ids22).toContain('contacts');
      const res = await trainee.patch('/me', { rulesEdition: '2027', credential: 'bcaba' });
      expect(res.json()).toMatchObject({ rulesEdition: '2027', credential: 'bcaba' });
      const month = (await trainee.get('/months/2026-09')).json();
      expect(month.rulesVersion).toBe('bacb-2027');
      expect(month.checks.map((c: { id: string }) => c.id)).not.toContain('contacts');
      expect(month.checks.find((c: { id: string }) => c.id === 'observations')).toMatchObject({ ok: true }); // 120 observed minutes >= 90
      expect((await trainee.get('/progress')).json().requiredMinutes).toBe(800 * 60); // BCaBA concentrated, 2027
    });
    it('only accepts valid standards and never lets a user change their role', async () => {
      expect((await trainee.patch('/me', { rulesEdition: '2030' })).statusCode).toBe(400);
      expect((await trainee.patch('/me', {})).statusCode).toBe(400);
      expect((await trainee.patch('/me', { role: 'supervisor' })).statusCode).toBe(400); // unknown keys are stripped → nothing to update
      expect((await trainee.get('/me')).json().role).toBe('trainee');
      expect((await sup.patch('/me', { rulesEdition: '2027' })).statusCode).toBe(403);
    });
    it('signed months keep the rules they were signed under', async () => {
      await trainee.log();
      const signed = (await trainee.post('/verifications/2026-09/sign', { supervisorId: ids.sup })).json();
      expect(signed.traineeSignedAt).toBeTruthy();
      await trainee.patch('/me', { rulesEdition: '2027' });
      const v = await db.selectFrom('monthVerifications').select('rulesVersion').executeTakeFirstOrThrow();
      expect(v.rulesVersion).toBe('bacb-2022');
    });
    it('the database rejects a trainee without a standard', async () => {
      await expect(db.insertInto('users').values({ cognitoSub: 'x', email: 'x@x', fullName: 'X', role: 'trainee', fieldworkType: 'concentrated', credential: null, rulesEdition: null }).execute()).rejects.toThrow(/users_trainee_standard/);
    });
  });

  describe('supervision links', () => {
    it('lets a trainee link by invite code (case-insensitive) and both sides see it', async () => {
      const res = await other.post('/supervisions', { inviteCode: 'supcode1', startsOn: '2026-09-01' });
      expect(res.statusCode).toBe(201);
      expect(res.json().supervisor.fullName).toBe('Sup');
      expect((await other.get('/supervisors')).json().map((s: { fullName: string }) => s.fullName)).toEqual(['Sup']);
      expect((await sup.get('/trainees')).json().map((t: { fullName: string }) => t.fullName)).toEqual(['Other', 'Trainee']);
      expect((await other.post('/supervisions', { inviteCode: 'SUPCODE1', startsOn: '2026-09-01' })).statusCode).toBe(409);
    });
    it('rejects bad codes and non-trainees', async () => {
      expect((await other.post('/supervisions', { inviteCode: 'NOPENOPE' })).statusCode).toBe(404);
      expect((await sup.post('/supervisions', { inviteCode: 'SUPCODE2' })).statusCode).toBe(403);
      expect((await trainee.get('/trainees')).statusCode).toBe(403);
    });
  });

  describe('monthly sign-off', () => {
    const sign = () => trainee.post('/verifications/2026-09/sign', { supervisorId: ids.sup });
    it('requires the trainee to sign first, then locks on supervisor signature', async () => {
      const id = randomUUID();
      await trainee.log({}, id);
      expect((await sup.post('/verifications/2026-09/sign', { traineeId: ids.trainee })).statusCode).toBe(409);
      expect((await sign()).json().traineeSignedAt).toBeTruthy();
      const res = await sup.post('/verifications/2026-09/sign', { traineeId: ids.trainee });
      expect(res.statusCode).toBe(200);
      expect(res.json().supervisorSignedAt).toBeTruthy();
      expect((await trainee.log({ description: 'x' }, id)).statusCode).toBe(409);
      expect((await sign()).statusCode).toBe(409);
      expect((await trainee.get('/verifications?month=2026-09')).json()).toHaveLength(1);
    });
    it('blocks the supervisor if entries changed after the trainee signed', async () => {
      const id = randomUUID();
      await trainee.log({}, id);
      await sign();
      await trainee.log({ endTime: '09:00' }, id);
      expect((await sup.post('/verifications/2026-09/sign', { traineeId: ids.trainee })).json().error).toMatch(/re-sign/);
      await sign();
      expect((await sup.post('/verifications/2026-09/sign', { traineeId: ids.trainee })).statusCode).toBe(200);
    });
    it('rejects unlinked people', async () => {
      expect((await other.post('/verifications/2026-09/sign', { supervisorId: ids.sup })).statusCode).toBe(404);
      expect((await sup2.post('/verifications/2026-09/sign', { traineeId: ids.other })).statusCode).toBe(404);
    });
  });
});
