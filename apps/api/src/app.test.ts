import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { devVerify } from './auth.js';
import { createDb } from './db.js';

// Requires a throwaway database: TEST_DATABASE_URL=postgres://... (the schema is dropped and recreated)
const url = process.env.TEST_DATABASE_URL;
const db = createDb(url ?? 'postgres://invalid');
const app = buildApp({ db, verify: devVerify(), logger: false });
const migration = readFileSync(new URL('../../../db/migrations/001_init.sql', import.meta.url), 'utf8');

const ids = { trainee: '', other: '', sup: '', sup2: '' };
const as = (sub: string) => ({
  get: (u: string) => app.inject({ method: 'GET', url: u, headers: { 'x-dev-sub': sub } }),
  post: (u: string, payload: object) => app.inject({ method: 'POST', url: u, payload, headers: { 'x-dev-sub': sub } }),
  patch: (u: string, payload: object) => app.inject({ method: 'PATCH', url: u, payload, headers: { 'x-dev-sub': sub } }),
  del: (u: string) => app.inject({ method: 'DELETE', url: u, headers: { 'x-dev-sub': sub } }),
});
const trainee = as('trainee'), other = as('other'), sup = as('sup'), sup2 = as('sup2');
const entry = (o: object = {}) => ({ supervisorId: ids.sup, workDate: '2026-09-01', startTime: '08:00', endTime: '10:00', kind: 'independent', ...o });

describe.skipIf(!url)('API', () => {
  beforeAll(async () => {
    await sql.raw('drop schema public cascade; create schema public;').execute(db);
    await sql.raw(migration).execute(db);
  });
  afterAll(() => db.destroy());

  beforeEach(async () => {
    await sql.raw('truncate users, supervisions, entries, month_verifications, audit_log, organizations restart identity cascade').execute(db);
    const users = await db.insertInto('users').values([
      { cognitoSub: 'trainee', email: 't@x', fullName: 'Trainee', role: 'trainee', fieldworkType: 'concentrated' },
      { cognitoSub: 'other', email: 'o@x', fullName: 'Other', role: 'trainee', fieldworkType: 'supervised' },
      { cognitoSub: 'sup', email: 's@x', fullName: 'Sup', role: 'supervisor' },
      { cognitoSub: 'sup2', email: 's2@x', fullName: 'Sup2', role: 'supervisor' },
    ]).returning(['id', 'cognitoSub']).execute();
    for (const u of users) ids[u.cognitoSub as keyof typeof ids] = u.id;
    await db.insertInto('supervisions').values([
      { traineeId: ids.trainee, supervisorId: ids.sup, startsOn: '2026-01-01', endsOn: null },
      { traineeId: ids.trainee, supervisorId: ids.sup2, startsOn: '2026-01-01', endsOn: '2026-06-30' },
    ]).execute();
  });

  it('rejects unauthenticated and unknown users', async () => {
    expect((await app.inject({ method: 'GET', url: '/me' })).statusCode).toBe(401);
    expect((await as('nobody').get('/me')).statusCode).toBe(403);
    expect((await trainee.get('/me')).json()).not.toHaveProperty('cognitoSub');
  });

  it('creates and lists entries for the month', async () => {
    const res = await trainee.post('/entries', entry({ restrictedMinutes: 30 }));
    expect(res.statusCode).toBe(201);
    expect(res.json().entry).toMatchObject({ workDate: '2026-09-01', startTime: '08:00', restrictedMinutes: 30 });
    expect((await trainee.get('/entries?month=2026-09')).json()).toHaveLength(1);
    expect((await trainee.get('/entries?month=2026-10')).json()).toHaveLength(0);
  });

  it('validates input with shared rules', async () => {
    expect((await trainee.post('/entries', entry({ restrictedMinutes: 121 }))).json().error).toMatch(/exceeds/);
    expect((await trainee.post('/entries', entry({ endTime: '07:00' }))).statusCode).toBe(400);
    expect((await trainee.post('/entries', entry({ workDate: 'nope' }))).statusCode).toBe(400);
    expect((await trainee.post('/entries', entry({ contact: 'contact' }))).statusCode).toBe(400); // contact on independent
  });

  it('requires an active supervision on the work date', async () => {
    expect((await trainee.post('/entries', entry({ supervisorId: ids.sup2 }))).statusCode).toBe(400); // ended June
    expect((await trainee.post('/entries', entry({ supervisorId: ids.sup2, workDate: '2026-06-15' }))).statusCode).toBe(201);
  });

  it('only trainees log hours', async () => expect((await sup.post('/entries', entry())).statusCode).toBe(403));

  it('warns on overlaps without blocking', async () => {
    await trainee.post('/entries', entry());
    const res = await trainee.post('/entries', entry({ startTime: '09:00', endTime: '11:00' }));
    expect(res.statusCode).toBe(201);
    expect(res.json().warnings).toEqual(['Overlaps 08:00–10:00']);
  });

  it('enforces who can see what', async () => {
    await trainee.post('/entries', entry());
    await trainee.post('/entries', entry({ supervisorId: ids.sup2, workDate: '2026-06-15' }));
    expect((await other.get(`/entries?month=2026-09&traineeId=${ids.trainee}`)).statusCode).toBe(404);
    expect((await sup.get(`/entries?month=2026-09&traineeId=${ids.trainee}`)).json()).toHaveLength(1);
    expect((await sup.get(`/entries?month=2026-06&traineeId=${ids.trainee}`)).json()).toHaveLength(0); // sup2's entry hidden from sup
  });

  it('edits, soft-deletes, and audits with the actor', async () => {
    const { id } = (await trainee.post('/entries', entry())).json().entry;
    expect((await other.patch(`/entries/${id}`, { endTime: '09:00' })).statusCode).toBe(404);
    expect((await trainee.patch(`/entries/${id}`, { endTime: '09:00' })).json().entry.endTime).toBe('09:00');
    expect((await trainee.patch(`/entries/${id}`, { endTime: '07:00' })).statusCode).toBe(400);
    expect((await trainee.del(`/entries/${id}`)).statusCode).toBe(204);
    expect((await trainee.get('/entries?month=2026-09')).json()).toHaveLength(0);
    const audit = await db.selectFrom('auditLog').select(['action', 'actorId']).where('tableName', '=', 'entries').orderBy('id').execute();
    expect(audit.map(a => a.action)).toEqual(['INSERT', 'UPDATE', 'UPDATE']);
    expect(audit.every(a => a.actorId === ids.trainee)).toBe(true);
  });

  it('returns 409 when editing a signed month', async () => {
    const { id } = (await trainee.post('/entries', entry())).json().entry;
    await db.insertInto('monthVerifications').values({ traineeId: ids.trainee, supervisorId: ids.sup, month: '2026-09-01', fieldworkType: 'concentrated', rulesVersion: 'bacb-2022-01', summary: '{}', traineeSignedAt: null, supervisorSignedAt: new Date(), pdfS3Key: null }).execute();
    expect((await trainee.patch(`/entries/${id}`, { description: 'x' })).statusCode).toBe(409);
    expect((await trainee.post('/entries', entry({ workDate: '2026-09-02' }))).statusCode).toBe(409);
  });

  it('evaluates the month and overall progress with the rules engine', async () => {
    await trainee.post('/entries', entry({ startTime: '00:00', endTime: '18:00' }));
    await trainee.post('/entries', entry({ workDate: '2026-09-02', kind: 'supervised', contact: 'observation', format: 'online' }));
    const month = (await trainee.get('/months/2026-09')).json();
    expect(month.summary).toMatchObject({ totalMinutes: 1200, supervisedMinutes: 120, observations: 1 });
    expect(month.checks.find((c: { id: string }) => c.id === 'contacts')).toMatchObject({ ok: false, needed: 5 });
    expect((await sup.get(`/progress?traineeId=${ids.trainee}`)).json()).toMatchObject({ requiredMinutes: 90000, countableMinutes: 0 });
    expect((await trainee.get('/months/2026-13')).statusCode).toBe(400);
  });
});
