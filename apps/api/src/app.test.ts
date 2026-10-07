import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { PDFDocument } from 'pdf-lib';
import Stripe from 'stripe';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { devVerify } from './auth.js';
import { createDb } from './db.js';
import { migrate } from './migrate.js';
import { sendReminders } from './reminders.js';

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
/** A month that meets every 2022 concentrated requirement: 18 h independent + six 30-min contacts (one observed) = 21 h, 14% supervised. */
const logPassingMonth = async (month: string, independentId = randomUUID()) => {
  await trainee.log({ workDate: `${month}-01`, startTime: '00:00', endTime: '18:00' }, independentId);
  for (let d = 2; d <= 7; d++) await trainee.log({ workDate: `${month}-0${d}`, startTime: '09:00', endTime: '09:30', kind: 'supervised', contact: d === 2 ? 'observation' : 'contact' });
};

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

  describe('least-privilege API login', () => {
    const apiUrl = () => { const u = new URL(url!); u.username = 'fieldtrack_api'; u.password = 'test-only'; return u.toString() };
    it('can do nothing until it becomes the restricted role, and the whole API runs on it', async () => {
      await sql`alter role fieldtrack_api password 'test-only'`.execute(db);
      const apiDb = createDb(apiUrl());
      try {
        await expect(sql`select id from users`.execute(apiDb)).rejects.toThrow(/permission denied|does not exist/); // can't even see the schema
        await expect(sql`set role postgres`.execute(apiDb)).rejects.toMatchObject({ code: '42501' });
        const api = buildApp({ db: apiDb, verify: devVerify(), logger: false });
        const headers = { 'x-dev-sub': 'trainee' };
        expect((await api.inject({ method: 'GET', url: '/api/me', headers })).statusCode).toBe(200);
        expect((await api.inject({ method: 'PUT', url: `/api/entries/${randomUUID()}`, headers, payload: entry() })).statusCode).toBe(201);
      } finally { await apiDb.destroy() }
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

  it('signed months keep their fieldwork type; switching type later makes the program mixed', async () => {
    await trainee.log({ workDate: '2026-09-01', startTime: '00:00', endTime: '22:00' });
    await trainee.post('/verifications/2026-09/sign', { supervisorId: ids.sup, signature: 'Trainee', attest: true });
    await sup.post('/verifications/2026-09/sign', { traineeId: ids.trainee, signature: 'Sup', attest: true });
    await trainee.patch('/me', { fieldworkType: 'supervised' });
    await trainee.log({ workDate: '2026-10-01', startTime: '00:00', endTime: '22:00' });
    const p = (await trainee.get('/progress')).json();
    expect(p.months.map((m: { month: string; type: string }) => [m.month, m.type])).toEqual([['2026-09', 'concentrated'], ['2026-10', 'supervised']]);
    expect((await trainee.get('/months/2026-09')).json().checks.find((c: { id: string }) => c.id === 'contacts').label).toMatch(/6/); // still the concentrated standard
    expect((await trainee.get('/verifications?month=2026-09')).json()[0].fieldworkType).toBe('concentrated');
  });

  it('a recorded observation on an independent entry counts toward observation only', async () => {
    await trainee.log({ observedAsync: true });
    expect((await trainee.get('/months/2026-09')).json().summary).toMatchObject({ supervisedMinutes: 0, observations: 1, contacts: 0 });
    expect((await trainee.log({ kind: 'supervised', observedAsync: true })).statusCode).toBe(400);
    expect((await trainee.get('/entries?month=2026-09')).json()[0].observedAsync).toBe(true);
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
      expect((await sup.patch('/me', { rulesEdition: '2027' })).statusCode).toBe(400); // supervisors may only change their reminder setting
    });
    it('signed months keep the rules they were signed under', async () => {
      await trainee.log();
      const signed = (await trainee.post('/verifications/2026-09/sign', { supervisorId: ids.sup, signature: 'Trainee', attest: true })).json();
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
    const sign = () => trainee.post('/verifications/2026-09/sign', { supervisorId: ids.sup, signature: 'Trainee', attest: true });
    it('requires the trainee to sign first, then locks on supervisor signature', async () => {
      const id = randomUUID();
      await trainee.log({}, id);
      expect((await sup.post('/verifications/2026-09/sign', { traineeId: ids.trainee, signature: 'Sup', attest: true })).statusCode).toBe(409);
      expect((await sign()).json().traineeSignedAt).toBeTruthy();
      const res = await sup.post('/verifications/2026-09/sign', { traineeId: ids.trainee, signature: 'Sup', attest: true });
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
      expect((await sup.post('/verifications/2026-09/sign', { traineeId: ids.trainee, signature: 'Sup', attest: true })).json().error).toMatch(/re-sign/);
      await sign();
      expect((await sup.post('/verifications/2026-09/sign', { traineeId: ids.trainee, signature: 'Sup', attest: true })).statusCode).toBe(200);
    });
    it('is an electronic signature: requires the attestation and the signer’s own typed name', async () => {
      await trainee.log();
      expect((await trainee.post('/verifications/2026-09/sign', { supervisorId: ids.sup, signature: 'Trainee' })).json().error).toMatch(/attestation/);
      expect((await trainee.post('/verifications/2026-09/sign', { supervisorId: ids.sup, signature: 'Sup', attest: true })).json().error).toMatch(/full name/);
      expect((await trainee.post('/verifications/2026-09/sign', { supervisorId: ids.sup, signature: '  trainee ', attest: true })).statusCode).toBe(200);
      const [v] = (await trainee.get('/verifications?month=2026-09')).json();
      expect(v.attestation).toBe('bacb-mfvf-2022-v2023-08');
      expect((await db.selectFrom('monthVerifications').select('traineeSignature').executeTakeFirstOrThrow()).traineeSignature).toBe('trainee');
    });
    it('rejects unlinked people', async () => {
      expect((await other.post('/verifications/2026-09/sign', { supervisorId: ids.sup, signature: 'Other', attest: true })).statusCode).toBe(404);
      expect((await sup2.post('/verifications/2026-09/sign', { traineeId: ids.other, signature: 'Sup2', attest: true })).statusCode).toBe(404);
    });
  });

  it('exports all hours as CSV, safe to open in a spreadsheet', async () => {
    await trainee.log({ restrictedMinutes: 30, description: '=HYPERLINK("x")' });
    await trainee.log({ workDate: '2026-08-01', kind: 'supervised', contact: 'contact', description: 'said "hi"' });
    const res = await trainee.get('/entries/export.csv');
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    const lines = res.body.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('"2026-08-01","08:00","10:00","2.000","supervised","Sup","0.000","2.000","no","contact","","said ""hi"""');
    expect(lines[2]).toContain(`"1.500","no","","","'=HYPERLINK(""x"")"`);
    expect((await sup2.get(`/entries/export.csv?traineeId=${ids.other}`)).statusCode).toBe(404);
  });

  it('exports a printable PDF hours log, scoped like everything else', async () => {
    await trainee.log();
    await trainee.log({ workDate: '2026-06-02', supervisorId: ids.sup2 });
    const res = await trainee.get('/entries/export.pdf');
    expect(res.headers['content-type']).toBe('application/pdf');
    expect((await PDFDocument.load(res.rawPayload)).getTitle()).toBe('Fieldwork hours log · Trainee');
    expect((await sup.get(`/entries/export.pdf?traineeId=${ids.trainee}`)).statusCode).toBe(200);
    expect((await sup2.get(`/entries/export.pdf?traineeId=${ids.other}`)).statusCode).toBe(404);
    if (process.env.HOURS_LOG_OUT) (await import('node:fs')).writeFileSync(process.env.HOURS_LOG_OUT, res.rawPayload);
  });

  describe('deadline reminder emails', () => {
    const outbox: { to: string; subject: string; text: string }[] = [];
    const run = (today: string) => sendReminders(db, async (to, subject, text) => { outbox.push({ to, subject, text }) }, today, 'https://app.test');
    beforeEach(() => { outbox.length = 0 });

    it('emails a week out and two days out, once each, and never about client details', async () => {
      await trainee.log({ description: 'Client J.D. session' });
      expect(await run('2026-10-20')).toBe(0); // 11 days left
      expect(await run('2026-10-25')).toBe(1);
      expect(outbox[0]).toMatchObject({ to: 't@x', subject: 'Sign your September 2026 fieldwork form by October 31' });
      expect(outbox[0]!.text).toContain('https://app.test/app?month=2026-09');
      expect(outbox[0]!.text).not.toContain('J.D.');
      expect(await run('2026-10-26')).toBe(0); // already sent this window
      await trainee.post('/verifications/2026-09/sign', { supervisorId: ids.sup, signature: 'Trainee', attest: true });
      expect(await run('2026-10-30')).toBe(1); // final window: now the supervisor's turn
      expect(outbox[1]).toMatchObject({ to: 's@x', subject: '1 fieldwork form is waiting for your signature' });
      expect(await run('2026-11-02')).toBe(0); // past the deadline: no more reminders
    });

    it('supervisors can turn reminders off, but change nothing else about themselves', async () => {
      expect((await sup.patch('/me', { emailReminders: false })).json().emailReminders).toBe(false);
      expect((await sup.patch('/me', { rulesEdition: '2027' })).statusCode).toBe(400);
      expect((await sup.patch('/me', {})).statusCode).toBe(400);
    });
    it('respects the opt-out, and retries a failed send the next day', async () => {
      await trainee.log();
      await trainee.patch('/me', { emailReminders: false });
      expect(await run('2026-10-25')).toBe(0);
      await trainee.patch('/me', { emailReminders: true });
      expect(await sendReminders(db, async () => { throw new Error('SES down') }, '2026-10-25', 'https://app.test')).toBe(0);
      expect(await run('2026-10-26')).toBe(1);
    });
  });

  describe('billing (Stripe)', () => {
    const real = new Stripe('sk_test_dummy'), secret = 'whsec_test', created: unknown[] = [];
    const stripe = {
      webhooks: real.webhooks,
      checkout: { sessions: { create: async (p: unknown) => { created.push(p); return { url: 'https://checkout.stripe.test/s' } } } },
      billingPortal: { sessions: { create: async () => ({ url: 'https://billing.stripe.test/p' }) } },
    } as unknown as Stripe;
    const billed = buildApp({ db, verify: devVerify(), logger: false, billing: { stripe, webhookSecret: secret, pricePro: 'price_pro', appUrl: 'https://app.test' } });
    const req = (method: 'GET' | 'POST', url: string, sub = 'trainee') => billed.inject({ method, url: `/api${url}`, headers: { 'x-dev-sub': sub } });
    const hook = (type: string, object: object, sign = true) => {
      const payload = JSON.stringify({ id: 'evt_1', object: 'event', type, data: { object } });
      return billed.inject({ method: 'POST', url: '/api/stripe/webhook', payload, headers: {
        'content-type': 'application/json', 'stripe-signature': sign ? real.webhooks.generateTestHeaderString({ payload, secret }) : 't=1,v1=bad' } });
    };
    const subscription = (status: string) => ({ object: 'subscription', customer: 'cus_1', status, metadata: { userId: ids.trainee }, items: { data: [{ current_period_end: 1_800_000_000 }] } });

    it('is off without Stripe keys', async () => {
      expect((await trainee.get('/billing')).json()).toMatchObject({ enabled: false, status: 'none' });
      expect((await trainee.post('/billing/checkout')).statusCode).toBe(404);
    });

    it('checkout → signed webhooks → active; tampered webhooks are rejected', async () => {
      expect((await req('POST', '/billing/checkout')).json()).toEqual({ url: 'https://checkout.stripe.test/s' });
      expect(created[0]).toMatchObject({ mode: 'subscription', client_reference_id: ids.trainee, customer_email: 't@x', line_items: [{ price: 'price_pro', quantity: 1 }] });
      expect((await req('POST', '/billing/checkout', 'sup')).statusCode).toBe(403);

      expect((await hook('customer.subscription.created', subscription('active'), false)).statusCode).toBe(400);
      expect((await req('GET', '/billing')).json().status).toBe('none');
      // Subscription event can beat checkout.session.completed; metadata links the customer either way.
      expect((await hook('customer.subscription.created', subscription('active'))).statusCode).toBe(200);
      expect((await hook('checkout.session.completed', { object: 'checkout.session', client_reference_id: ids.trainee, customer: 'cus_1' })).statusCode).toBe(200);
      expect((await req('GET', '/billing')).json()).toMatchObject({ enabled: true, status: 'active', currentPeriodEnd: new Date(1_800_000_000_000).toISOString() });
      expect((await req('POST', '/billing/checkout')).statusCode).toBe(409); // already subscribed
      expect((await req('POST', '/billing/portal')).json()).toEqual({ url: 'https://billing.stripe.test/p' });
      expect((await req('GET', '/billing', 'other')).json().status).toBe('none'); // nobody else's

      await hook('customer.subscription.deleted', subscription('active'));
      expect((await req('GET', '/billing')).json().status).toBe('canceled');
    });
  });

  describe('supervisor invite links', () => {
    it('trainee invites by link; a supervisor accepts once and is linked from the chosen date', async () => {
      const { token } = (await other.post('/invites', { startsOn: '2026-08-01' })).json();
      expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect((await as('brand-new@x').get(`/invites/${token}`)).json()).toEqual({ traineeName: 'Other' }); // no account yet is fine
      expect((await trainee.post(`/invites/${token}/accept`)).statusCode).toBe(403); // trainees can't accept
      expect((await sup2.post(`/invites/${token}/accept`)).json()).toEqual({ traineeId: ids.other });
      expect((await other.get('/supervisors')).json()).toMatchObject([{ fullName: 'Sup2', startsOn: '2026-08-01' }]);
      expect((await sup.post(`/invites/${token}/accept`)).statusCode).toBe(404); // single use
      expect((await sup.get(`/invites/${token}`)).statusCode).toBe(404);
      expect(await db.selectFrom('supervisorInvites').select('tokenHash').execute()).not.toContainEqual({ tokenHash: token }); // only the hash is stored
    });
    it('expired or made-up links do nothing', async () => {
      const { token } = (await other.post('/invites')).json();
      await db.updateTable('supervisorInvites').set({ expiresAt: new Date('2020-01-01') }).execute();
      expect((await sup.post(`/invites/${token}/accept`)).statusCode).toBe(404);
      expect((await sup.post(`/invites/${'x'.repeat(32)}/accept`)).statusCode).toBe(404);
      expect((await sup.get('/invites/short')).statusCode).toBe(400);
      expect((await sup.post('/invites')).statusCode).toBe(403); // only trainees invite
    });
  });

  describe('review comments', () => {
    it('supervisor comments on an entry, trainee sees and resolves it; nobody else can', async () => {
      const id = randomUUID();
      await trainee.log({}, id);
      const c = await sup.post(`/entries/${id}/comments`, { body: 'End time should be 9:30' });
      expect(c.statusCode).toBe(201);
      const [seen] = (await trainee.get('/comments?month=2026-09')).json();
      expect(seen).toMatchObject({ entryId: id, body: 'End time should be 9:30', authorName: 'Sup', resolvedAt: null });
      expect((await trainee.post(`/comments/${seen.id}/resolve`)).json().resolvedAt).toBeTruthy();
      expect((await trainee.post(`/comments/${seen.id}/resolve`)).statusCode).toBe(200); // idempotent

      expect((await sup2.post(`/entries/${id}/comments`, { body: 'x' })).statusCode).toBe(404); // not their entry
      expect((await other.post(`/entries/${randomUUID()}/comments`, { body: 'x' })).statusCode).toBe(404);
      expect((await other.post(`/comments/${seen.id}/resolve`)).statusCode).toBe(404);
      expect((await sup2.get(`/comments?month=2026-09&traineeId=${ids.trainee}`)).json()).toEqual([]); // sup2's link ended in June
      expect((await sup.post(`/entries/${id}/comments`, { body: '  ' })).statusCode).toBe(400);
    });
  });

  describe('Final Fieldwork Verification', () => {
    const signMonth = async (month: string) => {
      await trainee.post(`/verifications/${month}/sign`, { supervisorId: ids.sup, signature: 'Trainee', attest: true });
      return sup.post(`/verifications/${month}/sign`, { traineeId: ids.trainee, signature: 'Sup', attest: true });
    };
    const finalForm = async (res: Awaited<ReturnType<typeof trainee.get>>) => {
      expect(res.statusCode).toBe(200);
      const f = (await PDFDocument.load(res.rawPayload)).getForm();
      return (name: string) => (f.getFields().length ? f.getTextField(name).getText() ?? '' : null);
    };

    it('totals the signed monthly forms; the supervisor signs; a newly signed month voids the signature', async () => {
      expect((await sup.get(`/final/form.pdf?traineeId=${ids.trainee}`)).statusCode).toBe(409); // nothing signed yet
      await logPassingMonth('2026-08');
      await logPassingMonth('2026-09');
      await signMonth('2026-08');
      const get = await finalForm(await trainee.get(`/final/form.pdf?supervisorId=${ids.sup}`));
      expect(['START_DATE', 'END_DATE', 'INDEPENDENT_HOURS 2', 'TOTAL_MONTHS_OF_FIELDWORK_OBTAINED 2', 'INDEPENDENT_HOURS'].map(get)).toEqual(['08/2026', '08/2026', '18.00', '1', '']); // concentrated column only

      expect((await trainee.post('/final/sign', { traineeId: ids.trainee, signature: 'Trainee', attest: true })).statusCode).toBe(403);
      expect((await sup.post('/final/sign', { traineeId: ids.trainee, signature: 'Sup', attest: true })).statusCode).toBe(200);
      expect((await finalForm(await trainee.get(`/final/form.pdf?supervisorId=${ids.sup}`)))('TRAINEE_NAME')).toBeNull(); // signed copy is locked
      expect((await trainee.get('/final')).json()).toHaveLength(1);

      await signMonth('2026-09');
      const after = await finalForm(await sup.get(`/final/form.pdf?traineeId=${ids.trainee}`));
      expect([after('END_DATE'), after('INDEPENDENT_HOURS 2'), after('SUPERVISOR_SIGNATURE_DATE')]).toEqual(['09/2026', '36.00', '']); // needs re-signing
    });

    it('only the linked supervisor can sign, with their own name', async () => {
      expect((await sup2.post('/final/sign', { traineeId: ids.other, signature: 'Sup2', attest: true })).statusCode).toBe(404);
      expect((await sup.post('/final/sign', { traineeId: ids.trainee, signature: 'Trainee', attest: true })).json().error).toMatch(/full name/);
      expect((await other.get(`/final/form.pdf?supervisorId=${ids.sup}`)).statusCode).toBe(404);
    });
  });

  describe('BACB monthly verification form (PDF)', () => {
    const form = async (res: Awaited<ReturnType<typeof trainee.get>>) => {
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      const f = (await PDFDocument.load(res.rawPayload)).getForm();
      return (name: string) => f.getFields().length ? f.getTextField(name).getText() ?? '' : null; // null: flattened (signed)
    };
    const url = `/verifications/2026-09/form.pdf`;

    it('prefills the official form, carries signatures only while valid, and locks once both sign', async () => {
      const id = randomUUID();
      await logPassingMonth('2026-09', id);
      await trainee.patch('/me', { fieldworkState: 'Ohio', fieldworkCountry: 'United States' });
      let get = await form(await trainee.get(`${url}?supervisorId=${ids.sup}`));
      expect(['TRAINEE_NAME', 'TRAINEE_CERTIFICATE_MONTH/YEAR', 'TRAINEE_FIELDWORK_STATE', 'RESPONSIBLE_SUPERVISOR_NAME', 'INDEPENDENT_HOURS', 'SUPERVISED_HOURS', 'TOTAL_FIELDWORK', 'PERCENT_HOURS_SUPERVISED', 'TRAINEE_SIGNATURE_DATE'].map(get))
        .toEqual(['Trainee', '09/2026', 'Ohio', 'Sup', '18.00', '3.00', '21.00', String(3 / 21), '']); // percent stored as the form's own fraction

      await trainee.post('/verifications/2026-09/sign', { supervisorId: ids.sup, signature: 'Trainee', attest: true });
      expect((await form(await sup.get(`${url}?traineeId=${ids.trainee}`)))('TRAINEE_SIGNATURE_DATE')).toMatch(/^\d\d\/\d\d\/2026$/);
      await trainee.log({ workDate: '2026-09-01', startTime: '00:00', endTime: '17:00' }, id);
      get = await form(await trainee.get(`${url}?supervisorId=${ids.sup}`));
      expect([get('TRAINEE_SIGNATURE_DATE'), get('INDEPENDENT_HOURS')]).toEqual(['', '17.00']); // stale signature dropped

      await trainee.post('/verifications/2026-09/sign', { supervisorId: ids.sup, signature: 'Trainee', attest: true });
      await sup.post('/verifications/2026-09/sign', { traineeId: ids.trainee, signature: 'Sup', attest: true });
      expect((await form(await trainee.get(`${url}?supervisorId=${ids.sup}`)))('TRAINEE_NAME')).toBeNull();
    });

    it('records the adjusted hours when a finished month misses a requirement (Handbook table)', async () => {
      await trainee.patch('/me', { fieldworkType: 'supervised' });
      for (let d = 1; d <= 4; d++) await trainee.log({ workDate: `2026-09-0${d}`, startTime: '08:00', endTime: '18:00' }); // 40 h
      for (let d = 5; d <= 8; d++) await trainee.log({ workDate: `2026-09-0${d}`, startTime: '09:00', endTime: '09:30', kind: 'supervised', contact: d === 5 ? 'observation' : 'contact' }); // 2 h = 4.8%
      const get = await form(await trainee.get(`${url}?supervisorId=${ids.sup}`));
      expect([get('INDEPENDENT_HOURS'), get('SUPERVISED_HOURS')]).toEqual(['38.00', '2.00']); // independent hours cut until 5% is met
    });

    it('uses the 2027 form for 2027 trainees', async () => {
      await trainee.patch('/me', { rulesEdition: '2027' });
      await trainee.log({ workDate: '2026-09-01', startTime: '00:00', endTime: '20:00' });
      await trainee.log({ workDate: '2026-09-03', kind: 'supervised', contact: 'observation', startTime: '09:00', endTime: '11:00' });
      const get = await form(await trainee.get(`${url}?supervisorId=${ids.sup}`));
      expect(['Supervised_Hours', 'Supervised_Minutes', 'Observation_Hours', 'Independent_Minutes 3', 'Total_Fieldwork_Hours'].map(get)).toEqual(['2', '0', '2', '0', '22']);
    });

    it('only for linked pairs', async () => {
      expect((await sup2.get(`${url}?traineeId=${ids.other}`)).statusCode).toBe(404);
      expect((await other.get(`${url}?supervisorId=${ids.sup}`)).statusCode).toBe(404);
      expect((await trainee.get(url)).statusCode).toBe(400);
    });
  });
});
