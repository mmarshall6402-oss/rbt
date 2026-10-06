import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { z, ZodError } from 'zod';
import { evaluateMonth, evaluateProgram, findOverlaps, validateEntry, type Entry } from '@fieldtrack/rules';
import type { Verify } from './auth.js';
import type { DB, User } from './db.js';

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

type Trx = Transaction<DB>;
type EntryRow = Selectable<DB['entries']>;

const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM');
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM');
const Name = z.string().trim().min(1).max(200);
const EntryBody = z.object({
  supervisorId: z.uuid(),
  workDate: z.iso.date(),
  startTime: Time,
  endTime: Time,
  kind: z.enum(['independent', 'supervised']),
  restrictedMinutes: z.number().int().min(0).default(0),
  isGroup: z.boolean().default(false),
  contact: z.enum(['contact', 'observation']).nullable().default(null),
  format: z.enum(['in_person', 'online']).nullable().default(null),
  description: z.string().max(5000).default(''),
});
const SignupBody = z.discriminatedUnion('role', [
  z.object({ role: z.literal('trainee'), fullName: Name, fieldworkType: z.enum(['supervised', 'concentrated']), bacbId: z.string().trim().max(50).optional() }),
  z.object({ role: z.literal('supervisor'), fullName: Name, bacbId: z.string().trim().min(1, 'BACB certification number is required').max(50) }),
]);
const TraineeQuery = z.object({ traineeId: z.uuid().optional() });
const Id = z.object({ id: z.uuid() });

const today = () => new Date().toISOString().slice(0, 10);
const monthRange = (m: string) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return [`${m}-01`, new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10)] as const; // [start, nextMonthStart)
};
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
const newInviteCode = () => Array.from(randomBytes(8), b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
/** JSON with sorted keys: jsonb reorders keys, so compare snapshots canonically. */
const canonical = (v: unknown) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

const publicEntry = ({ traineeId, organizationId, deletedAt, ...e }: EntryRow) => e;
const publicUser = ({ cognitoSub, ...u }: User) => u;

export function buildApp({ db, verify, logger = true }: { db: Kysely<DB>; verify: Verify; logger?: boolean }) {
  // Never log bodies: descriptions are PHI.
  const app = Fastify({ logger: logger && { redact: ['req.headers.authorization', 'req.headers["x-dev-sub"]'] } });

  app.setErrorHandler((err, req, reply) => {
    const code = (err as { code?: string }).code;
    if (err instanceof ZodError) return reply.code(400).send({ error: err.issues[0]?.message ?? 'Invalid request', issues: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })) });
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (code === '55000') return reply.code(409).send({ error: 'This month is signed and locked' });
    if (code === '23505') return reply.code(409).send({ error: 'Already exists' });
    if ((err as { statusCode?: number }).statusCode === 400) return reply.code(400).send({ error: 'Invalid request' }); // malformed JSON etc.
    req.log.error({ code }, 'unhandled error'); // no message/stack: may contain row data
    return reply.code(500).send({ error: 'Internal error' });
  });

  async function identity(req: FastifyRequest) {
    const id = await verify(req);
    if (!id) throw new HttpError(401, 'Unauthorized');
    return id;
  }

  /** Runs fn in a transaction as the authenticated user; sets app.user_id for the audit trigger. */
  async function asUser<T>(req: FastifyRequest, fn: (trx: Trx, user: User) => Promise<T>) {
    const { sub } = await identity(req);
    return db.transaction().execute(async trx => {
      const user = await trx.selectFrom('users').selectAll().where('cognitoSub', '=', sub).executeTakeFirst();
      if (!user) throw new HttpError(403, 'No account for this login');
      await sql`select set_config('app.user_id', ${user.id}, true)`.execute(trx);
      return fn(trx, user);
    });
  }

  const requireRole = (user: User, role: User['role']) => { if (user.role !== role) throw new HttpError(403, `Only ${role}s can do that`) };

  /** Trainees see all their own entries; a supervisor sees only entries logged under them (minimum necessary). */
  async function scope(trx: Trx, user: User, traineeId = user.id) {
    if (traineeId === user.id) return { traineeId, supervisorId: undefined };
    const link = await trx.selectFrom('supervisions').select('id').where('traineeId', '=', traineeId).where('supervisorId', '=', user.id).executeTakeFirst();
    if (!link) throw new HttpError(404, 'Not found'); // don't reveal whether the trainee exists
    return { traineeId, supervisorId: user.id };
  }

  const listEntries = (trx: Trx, s: { traineeId: string; supervisorId: string | undefined }, from?: string, to?: string) => {
    let q = trx.selectFrom('entries').selectAll().where('traineeId', '=', s.traineeId).where('deletedAt', 'is', null);
    if (s.supervisorId) q = q.where('supervisorId', '=', s.supervisorId);
    if (from && to) q = q.where('workDate', '>=', from).where('workDate', '<', to);
    return q.orderBy('workDate', 'desc').orderBy('startTime', 'desc').execute();
  };

  async function checkEntry(trx: Trx, user: User, e: z.infer<typeof EntryBody>, excludeId?: string) {
    requireRole(user, 'trainee');
    const problems = validateEntry(e);
    if (problems.length) throw new HttpError(400, problems.join('; '));
    const link = await trx.selectFrom('supervisions').select('organizationId')
      .where('traineeId', '=', user.id).where('supervisorId', '=', e.supervisorId).where('startsOn', '<=', e.workDate)
      .where(eb => eb.or([eb('endsOn', 'is', null), eb('endsOn', '>=', e.workDate)])).executeTakeFirst();
    if (!link) throw new HttpError(400, 'That supervisor is not assigned to you on this date');
    const sameDay = await trx.selectFrom('entries').selectAll().where('traineeId', '=', user.id).where('workDate', '=', e.workDate)
      .where('deletedAt', 'is', null).$if(!!excludeId, q => q.where('id', '!=', excludeId!)).execute();
    const warnings = findOverlaps<Entry & { id?: string }>([...sameDay, e]).filter(p => p.includes(e)).map(([a, b]) => {
      const other = a === e ? b : a;
      return `Overlaps ${other.startTime}–${other.endTime}`;
    });
    return { organizationId: link.organizationId, warnings };
  }

  async function traineeFieldwork(trx: Trx, traineeId: string) {
    const t = await trx.selectFrom('users').select('fieldworkType').where('id', '=', traineeId).executeTakeFirstOrThrow();
    if (!t.fieldworkType) throw new HttpError(400, 'Trainee has no fieldwork type set');
    return t.fieldworkType;
  }

  /** Month result for one trainee–supervisor pair: what both people sign. */
  async function pairResult(trx: Trx, traineeId: string, supervisorId: string, month: string) {
    return evaluateMonth(month, await listEntries(trx, { traineeId, supervisorId }, ...monthRange(month)), await traineeFieldwork(trx, traineeId));
  }

  app.register(async api => {
    api.get('/health', async () => ({ ok: true }));

    // ---- Accounts ----
    api.post('/signup', async (req, reply) => {
      const id = await identity(req);
      const body = SignupBody.parse(req.body);
      const user = await db.transaction().execute(async trx => {
        if (await trx.selectFrom('users').select('id').where('cognitoSub', '=', id.sub).executeTakeFirst()) throw new HttpError(409, 'Account already exists');
        return trx.insertInto('users').values({
          cognitoSub: id.sub, email: id.email, fullName: body.fullName, role: body.role, bacbId: body.bacbId || null,
          fieldworkType: body.role === 'trainee' ? body.fieldworkType : null,
          inviteCode: body.role === 'supervisor' ? newInviteCode() : null,
        }).returningAll().executeTakeFirstOrThrow();
      });
      return reply.code(201).send(publicUser(user));
    });

    api.get('/me', req => asUser(req, async (_, user) => publicUser(user)));

    // ---- Supervision links ----
    api.post('/supervisions', async (req, reply) => {
      const { inviteCode, startsOn } = z.object({ inviteCode: z.string().trim().toUpperCase().length(8, 'Invite codes are 8 characters'), startsOn: z.iso.date().optional() }).parse(req.body);
      const res = await asUser(req, async (trx, user) => {
        requireRole(user, 'trainee');
        const s = await trx.selectFrom('users').select(['id', 'fullName']).where('inviteCode', '=', inviteCode).where('role', '=', 'supervisor').executeTakeFirst();
        if (!s) throw new HttpError(404, 'No supervisor with that code');
        const link = await trx.insertInto('supervisions').values({ traineeId: user.id, supervisorId: s.id, startsOn: startsOn ?? today(), endsOn: null, organizationId: null })
          .returning(['id', 'startsOn']).executeTakeFirstOrThrow();
        return { ...link, supervisor: s };
      });
      return reply.code(201).send(res);
    });

    api.get('/supervisors', req => asUser(req, async (trx, user) => {
      requireRole(user, 'trainee');
      return trx.selectFrom('supervisions as s').innerJoin('users as u', 'u.id', 's.supervisorId')
        .select(['u.id', 'u.fullName', 'u.email', 'u.bacbId', 's.startsOn', 's.endsOn']).where('s.traineeId', '=', user.id).orderBy('u.fullName').execute();
    }));

    api.get('/trainees', req => asUser(req, async (trx, user) => {
      requireRole(user, 'supervisor');
      return trx.selectFrom('supervisions as s').innerJoin('users as u', 'u.id', 's.traineeId')
        .select(['u.id', 'u.fullName', 'u.email', 'u.fieldworkType', 's.startsOn', 's.endsOn']).where('s.supervisorId', '=', user.id).orderBy('u.fullName').execute();
    }));

    // ---- Entries ----
    api.get('/entries', req => asUser(req, async (trx, user) => {
      const { month, traineeId } = z.object({ month: Month }).extend(TraineeQuery.shape).parse(req.query);
      return (await listEntries(trx, await scope(trx, user, traineeId), ...monthRange(month))).map(publicEntry);
    }));

    api.post('/entries', async (req, reply) => {
      const body = EntryBody.parse(req.body);
      const res = await asUser(req, async (trx, user) => {
        const { organizationId, warnings } = await checkEntry(trx, user, body);
        const row = await trx.insertInto('entries').values({ ...body, traineeId: user.id, organizationId }).returningAll().executeTakeFirstOrThrow();
        return { entry: publicEntry(row), warnings };
      });
      return reply.code(201).send(res);
    });

    api.patch('/entries/:id', req => asUser(req, async (trx, user) => {
      const { id } = Id.parse(req.params);
      const row = await trx.selectFrom('entries').selectAll().where('id', '=', id).where('traineeId', '=', user.id).where('deletedAt', 'is', null).executeTakeFirst();
      if (!row) throw new HttpError(404, 'Not found');
      const next = EntryBody.parse({ ...publicEntry(row), ...EntryBody.partial().parse(req.body) });
      const { organizationId, warnings } = await checkEntry(trx, user, next, id);
      const updated = await trx.updateTable('entries').set({ ...next, organizationId }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      return { entry: publicEntry(updated), warnings };
    }));

    api.delete('/entries/:id', async (req, reply) => {
      const { id } = Id.parse(req.params);
      await asUser(req, async (trx, user) => {
        const r = await trx.updateTable('entries').set({ deletedAt: new Date() }).where('id', '=', id).where('traineeId', '=', user.id).where('deletedAt', 'is', null).executeTakeFirst();
        if (!r.numUpdatedRows) throw new HttpError(404, 'Not found');
      });
      return reply.code(204).send();
    });

    // ---- Requirements ----
    api.get('/months/:month', req => asUser(req, async (trx, user) => {
      const { month } = z.object({ month: Month }).parse(req.params);
      const s = await scope(trx, user, TraineeQuery.parse(req.query).traineeId);
      return evaluateMonth(month, await listEntries(trx, s, ...monthRange(month)), await traineeFieldwork(trx, s.traineeId));
    }));

    api.get('/progress', req => asUser(req, async (trx, user) => {
      const s = await scope(trx, user, TraineeQuery.parse(req.query).traineeId);
      return evaluateProgram(await listEntries(trx, s), await traineeFieldwork(trx, s.traineeId));
    }));

    // ---- Monthly sign-off: trainee signs, then supervisor signs (which locks the month) ----
    api.get('/verifications', req => asUser(req, async (trx, user) => {
      const { month, traineeId } = z.object({ month: Month }).extend(TraineeQuery.shape).parse(req.query);
      const s = await scope(trx, user, traineeId);
      return trx.selectFrom('monthVerifications').select(['id', 'traineeId', 'supervisorId', 'month', 'rulesVersion', 'traineeSignedAt', 'supervisorSignedAt'])
        .where('traineeId', '=', s.traineeId).where('month', '=', `${month}-01`).$if(!!s.supervisorId, q => q.where('supervisorId', '=', s.supervisorId!)).execute();
    }));

    api.post('/verifications/:month/sign', req => asUser(req, async (trx, user) => {
      const { month } = z.object({ month: Month }).parse(req.params);
      const body = z.object({ supervisorId: z.uuid().optional(), traineeId: z.uuid().optional() }).parse(req.body ?? {});
      const traineeId = user.role === 'trainee' ? user.id : body.traineeId;
      const supervisorId = user.role === 'supervisor' ? user.id : body.supervisorId;
      if (!traineeId || !supervisorId || user.role === 'admin') throw new HttpError(400, user.role === 'trainee' ? 'supervisorId is required' : 'traineeId is required');
      const link = await trx.selectFrom('supervisions').select('id').where('traineeId', '=', traineeId).where('supervisorId', '=', supervisorId).executeTakeFirst();
      if (!link) throw new HttpError(404, 'Not found');
      const existing = await trx.selectFrom('monthVerifications').selectAll().where('traineeId', '=', traineeId).where('supervisorId', '=', supervisorId).where('month', '=', `${month}-01`).executeTakeFirst();
      if (existing?.supervisorSignedAt) throw new HttpError(409, 'This month is already signed and locked');
      const result = await pairResult(trx, traineeId, supervisorId, month);

      if (user.role === 'trainee') {
        return trx.insertInto('monthVerifications')
          .values({ traineeId, supervisorId, month: `${month}-01`, fieldworkType: await traineeFieldwork(trx, traineeId), rulesVersion: result.rulesVersion, summary: JSON.stringify(result), traineeSignedAt: new Date(), supervisorSignedAt: null, pdfS3Key: null })
          .onConflict(oc => oc.columns(['traineeId', 'supervisorId', 'month']).doUpdateSet(eb => ({ summary: eb.ref('excluded.summary'), rulesVersion: eb.ref('excluded.rulesVersion'), traineeSignedAt: eb.ref('excluded.traineeSignedAt') })))
          .returning(['id', 'month', 'traineeSignedAt', 'supervisorSignedAt']).executeTakeFirstOrThrow();
      }
      if (!existing?.traineeSignedAt) throw new HttpError(409, 'The trainee has not signed this month yet');
      if (canonical(existing.summary) !== canonical(result)) throw new HttpError(409, 'Entries changed since the trainee signed. Ask them to re-sign.');
      return trx.updateTable('monthVerifications').set({ supervisorSignedAt: new Date() }).where('id', '=', existing.id)
        .returning(['id', 'month', 'traineeSignedAt', 'supervisorSignedAt']).executeTakeFirstOrThrow();
    }));
  }, { prefix: '/api' });

  return app;
}
