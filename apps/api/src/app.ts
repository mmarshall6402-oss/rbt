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
const TraineeQuery = z.object({ traineeId: z.uuid().optional() });
const Id = z.object({ id: z.uuid() });

const monthRange = (m: string) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return [`${m}-01`, new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10)] as const; // [start, nextMonthStart)
};

const publicEntry = ({ traineeId, organizationId, deletedAt, ...e }: EntryRow) => e;

export function buildApp({ db, verify, logger = true }: { db: Kysely<DB>; verify: Verify; logger?: boolean }) {
  // Never log bodies: descriptions are PHI.
  const app = Fastify({ logger: logger && { redact: ['req.headers.authorization', 'req.headers["x-dev-sub"]'] } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'Invalid request', issues: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })) });
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if ((err as { code?: string }).code === '55000') return reply.code(409).send({ error: 'This month is signed and locked' });
    req.log.error({ code: (err as { code?: string }).code }, 'unhandled error'); // no message/stack: may contain row data
    return reply.code(500).send({ error: 'Internal error' });
  });

  /** Runs fn in a transaction as the authenticated user; sets app.user_id for the audit trigger. */
  async function asUser<T>(req: FastifyRequest, fn: (trx: Trx, user: User) => Promise<T>) {
    const sub = await verify(req);
    if (!sub) throw new HttpError(401, 'Unauthorized');
    return db.transaction().execute(async trx => {
      const user = await trx.selectFrom('users').selectAll().where('cognitoSub', '=', sub).executeTakeFirst();
      if (!user) throw new HttpError(403, 'No account for this login');
      await sql`select set_config('app.user_id', ${user.id}, true)`.execute(trx);
      return fn(trx, user);
    });
  }

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
    if (user.role !== 'trainee') throw new HttpError(403, 'Only trainees log hours');
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

  app.get('/health', async () => ({ ok: true }));

  app.get('/me', req => asUser(req, async (_, { cognitoSub, ...me }) => me));

  app.get('/entries', req => asUser(req, async (trx, user) => {
    const { month, traineeId } = z.object({ month: Month }).extend(TraineeQuery.shape).parse(req.query);
    return (await listEntries(trx, await scope(trx, user, traineeId), ...monthRange(month))).map(publicEntry);
  }));

  app.post('/entries', async (req, reply) => {
    const body = EntryBody.parse(req.body);
    const res = await asUser(req, async (trx, user) => {
      const { organizationId, warnings } = await checkEntry(trx, user, body);
      const row = await trx.insertInto('entries').values({ ...body, traineeId: user.id, organizationId }).returningAll().executeTakeFirstOrThrow();
      return { entry: publicEntry(row), warnings };
    });
    return reply.code(201).send(res);
  });

  app.patch('/entries/:id', req => asUser(req, async (trx, user) => {
    const { id } = Id.parse(req.params);
    const row = await trx.selectFrom('entries').selectAll().where('id', '=', id).where('traineeId', '=', user.id).where('deletedAt', 'is', null).executeTakeFirst();
    if (!row) throw new HttpError(404, 'Not found');
    const next = EntryBody.parse({ ...publicEntry(row), ...EntryBody.partial().parse(req.body) });
    const { organizationId, warnings } = await checkEntry(trx, user, next, id);
    const updated = await trx.updateTable('entries').set({ ...next, organizationId }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    return { entry: publicEntry(updated), warnings };
  }));

  app.delete('/entries/:id', async (req, reply) => {
    const { id } = Id.parse(req.params);
    await asUser(req, async (trx, user) => {
      const r = await trx.updateTable('entries').set({ deletedAt: new Date() }).where('id', '=', id).where('traineeId', '=', user.id).where('deletedAt', 'is', null).executeTakeFirst();
      if (!r.numUpdatedRows) throw new HttpError(404, 'Not found');
    });
    return reply.code(204).send();
  });

  app.get('/months/:month', req => asUser(req, async (trx, user) => {
    const { month } = z.object({ month: Month }).parse(req.params);
    const s = await scope(trx, user, TraineeQuery.parse(req.query).traineeId);
    return evaluateMonth(month, await listEntries(trx, s, ...monthRange(month)), await traineeFieldwork(trx, s.traineeId));
  }));

  app.get('/progress', req => asUser(req, async (trx, user) => {
    const s = await scope(trx, user, TraineeQuery.parse(req.query).traineeId);
    return evaluateProgram(await listEntries(trx, s), await traineeFieldwork(trx, s.traineeId));
  }));

  return app;
}
