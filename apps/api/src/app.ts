import { createHash, randomBytes } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { z, ZodError } from 'zod';
import { ATTESTATIONS, FINAL_ATTESTATIONS, RULESETS, durationMinutes, evaluateMonth, signatureMatches, evaluateProgram, findOverlaps, validateEntry, type Entry, type FieldworkType, type Profile } from '@fieldtrack/rules';
import type { Verify } from './auth.js';
import { errorTracking } from './observability.js';
import { fillFinalForm, fillMonthlyForm, type TypeTotals } from './forms.js';
import { hoursLogPdf } from './hourslog.js';
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
const FieldworkTypeEnum = z.enum(['supervised', 'concentrated']);
const CredentialEnum = z.enum(['bcba', 'bcaba']);
const EditionEnum = z.enum(['2022', '2027']);
const Place = z.string().trim().max(100).transform(v => v || null);
const ProfileBody = z.object({ fieldworkType: FieldworkTypeEnum, credential: CredentialEnum, rulesEdition: EditionEnum, fieldworkState: Place, fieldworkCountry: Place, bacbId: Place, emailReminders: z.boolean() }).partial();

const SignupBody = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('trainee'), fullName: Name, fieldworkType: FieldworkTypeEnum, bacbId: z.string().trim().max(50).optional(),
    credential: CredentialEnum.default('bcba'), rulesEdition: EditionEnum.default('2027'),
  }),
  z.object({ role: z.literal('supervisor'), fullName: Name, bacbId: z.string().trim().min(1, 'BACB certification number is required').max(50) }),
]);
const editionOf = (rulesVersion: string) => (RULESETS['2027'].version === rulesVersion ? '2027' : '2022');
const TraineeQuery = z.object({ traineeId: z.uuid().optional() });
const Id = z.object({ id: z.uuid() });

const today = () => new Date().toISOString().slice(0, 10);
const monthRange = (m: string) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return [`${m}-01`, new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10)] as const; // [start, nextMonthStart)
};
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');
const newInviteCode = () => Array.from(randomBytes(8), b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
/** JSON with sorted keys: jsonb reorders keys, so compare snapshots canonically. */
const canonical = (v: unknown) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

const ENTRY_FIELDS = ['supervisorId', 'organizationId', 'workDate', 'startTime', 'endTime', 'kind', 'restrictedMinutes', 'isGroup', 'contact', 'format', 'description'] as const;
// Snapshot keys arrive camelCased (CamelCasePlugin converts nested JSON keys too).
const AUDIT_IGNORED = new Set(['id', 'traineeId', 'organizationId', 'createdAt', 'updatedAt']);
type AuditRow = { id: string; rowId: string; action: string; at: Date; oldRow: unknown; newRow: unknown; actorId: string | null; actorName: string | null };
type Snapshot = Record<string, unknown> | null;

/** Minutes an audited row contributes to a month's total (0 if deleted or outside the month). */
const countedMinutes = (r: Snapshot, month?: string) => {
  if (!r || r.deletedAt || (month && !String(r.workDate).startsWith(month))) return 0;
  return durationMinutes({ startTime: String(r.startTime).slice(0, 5), endTime: String(r.endTime).slice(0, 5) });
};

function describeChange(a: AuditRow, month?: string) {
  const before = a.oldRow as Snapshot, after = a.newRow as Snapshot;
  const action = a.action === 'UPDATE' && !before?.deletedAt && after?.deletedAt ? 'DELETE' : a.action === 'INSERT' ? 'CREATE' : a.action;
  const changes = action === 'UPDATE' && before && after
    ? Object.keys(after).filter(k => !AUDIT_IGNORED.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k])).map(field => ({ field, from: before[field], to: after[field] }))
    : [];
  return {
    auditId: a.id, entryId: a.rowId, at: a.at, action,
    actor: a.actorId ? { id: a.actorId, name: a.actorName ?? 'Unknown' } : null,
    workDate: String((after ?? before)?.workDate ?? ''),
    minutesDelta: countedMinutes(after, month) - countedMinutes(before, month),
    changes,
  };
}

/** CSV cell: quoted, and formula-looking text neutralized so spreadsheets never execute it. */
const csvCell = (v: unknown) => {
  const t = v == null ? '' : String(v);
  return `"${(/^[=+\-@\t\r]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"`;
};
const toCsv = (rows: unknown[][]) => rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

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
    if (code === '42501') return reply.code(404).send({ error: 'Not found' }); // refused by row-level security
    if ((err as { statusCode?: number }).statusCode === 400) return reply.code(400).send({ error: 'Invalid request' }); // malformed JSON etc.
    req.log.error({ code }, 'unhandled error'); // no message/stack in logs: may contain row data
    errorTracking.capture(err, { code, route: req.routeOptions.url });
    return reply.code(500).send({ error: 'Internal error' });
  });

  async function identity(req: FastifyRequest) {
    const id = await verify(req);
    if (!id) throw new HttpError(401, 'Unauthorized');
    return id;
  }

  /** Drops to the RLS-restricted role for the rest of the transaction. app.user_id also feeds the audit trigger. */
  const becomeUser = (trx: Trx, sub: string, userId = '') =>
    sql`select set_config('app.sub', ${sub}, true), set_config('app.user_id', ${userId}, true), set_config('role', 'fieldtrack_app', true)`.execute(trx);

  /** Runs fn in a transaction as the authenticated user; Postgres row-level security filters every query. */
  async function asUser<T>(req: FastifyRequest, fn: (trx: Trx, user: User) => Promise<T>) {
    const { sub } = await identity(req);
    return db.transaction().execute(async trx => {
      await becomeUser(trx, sub);
      const user = await trx.selectFrom('users').selectAll().where('cognitoSub', '=', sub).executeTakeFirst();
      if (!user) throw new HttpError(403, 'No account for this login');
      await becomeUser(trx, sub, user.id);
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

  /** The standard a trainee is held to: fieldwork type, credential, and 2022 vs 2027 rules. */
  async function traineeProfile(trx: Trx, traineeId: string): Promise<Profile> {
    const t = await trx.selectFrom('users').select(['fieldworkType', 'credential', 'rulesEdition']).where('id', '=', traineeId).executeTakeFirstOrThrow();
    if (!t.fieldworkType || !t.credential || !t.rulesEdition) throw new HttpError(400, 'Trainee has no fieldwork standard set');
    return { type: t.fieldworkType, credential: t.credential, edition: t.rulesEdition };
  }

  /** Month result for one trainee–supervisor pair: what both people sign. */
  async function pairResult(trx: Trx, traineeId: string, supervisorId: string, month: string) {
    return evaluateMonth(month, await listEntries(trx, { traineeId, supervisorId }, ...monthRange(month)), await traineeProfile(trx, traineeId));
  }

  /** What a Final Fieldwork Verification Form reports for a pair: totals from their signed (locked) monthly forms, by fieldwork type. */
  async function finalSummary(trx: Trx, traineeId: string, supervisorId: string) {
    const months = await trx.selectFrom('monthVerifications').select(['month', 'fieldworkType', 'summary'])
      .where('traineeId', '=', traineeId).where('supervisorId', '=', supervisorId).where('supervisorSignedAt', 'is not', null).orderBy('month').execute();
    if (!months.length) throw new HttpError(409, 'No signed monthly forms with this supervisor yet');
    const totals: Record<FieldworkType, TypeTotals | null> = { supervised: null, concentrated: null };
    for (const m of months) {
      const s = (m.summary as { summary: { independentMinutes: number; supervisedMinutes: number } }).summary;
      const t = (totals[m.fieldworkType] ??= { independentMinutes: 0, supervisedMinutes: 0, months: 0 });
      t.independentMinutes += s.independentMinutes; t.supervisedMinutes += s.supervisedMinutes; t.months++;
    }
    return { edition: (await traineeProfile(trx, traineeId)).edition!, startMonth: months[0]!.month.slice(0, 7), endMonth: months.at(-1)!.month.slice(0, 7), totals };
  }

  /** Resolves the trainee–supervisor pair from the caller's role; 404 unless they're linked. */
  async function pairFor(trx: Trx, user: User, q: { traineeId?: string | undefined; supervisorId?: string | undefined }) {
    const traineeId = user.role === 'trainee' ? user.id : q.traineeId, supervisorId = user.role === 'supervisor' ? user.id : q.supervisorId;
    if (!traineeId || !supervisorId || user.role === 'admin') throw new HttpError(400, user.role === 'trainee' ? 'supervisorId is required' : 'traineeId is required');
    if (!await trx.selectFrom('supervisions').select('id').where('traineeId', '=', traineeId).where('supervisorId', '=', supervisorId).executeTakeFirst()) throw new HttpError(404, 'Not found');
    return { traineeId, supervisorId };
  }

  const auditRows = (trx: Trx) => trx.selectFrom('auditLog as a').leftJoin('users as u', 'u.id', 'a.actorId')
    .select(['a.id', 'a.rowId', 'a.action', 'a.at', 'a.oldRow', 'a.newRow', 'a.actorId', 'u.fullName as actorName'])
    .where('a.tableName', '=', 'entries').orderBy('a.id', 'asc');

  app.register(async api => {
    api.get('/health', async () => ({ ok: true }));

    // ---- Accounts ----
    api.post('/signup', async (req, reply) => {
      const id = await identity(req);
      const body = SignupBody.parse(req.body);
      const user = await db.transaction().execute(async trx => {
        await becomeUser(trx, id.sub);
        if (await trx.selectFrom('users').select('id').where('cognitoSub', '=', id.sub).executeTakeFirst()) throw new HttpError(409, 'Account already exists');
        return trx.insertInto('users').values({
          cognitoSub: id.sub, email: id.email, fullName: body.fullName, role: body.role, bacbId: body.bacbId || null,
          fieldworkType: body.role === 'trainee' ? body.fieldworkType : null,
          credential: body.role === 'trainee' ? body.credential : null,
          rulesEdition: body.role === 'trainee' ? body.rulesEdition : null,
          inviteCode: body.role === 'supervisor' ? newInviteCode() : null,
        }).returningAll().executeTakeFirstOrThrow();
      });
      return reply.code(201).send(publicUser(user));
    });

    api.get('/me', req => asUser(req, async (_, user) => publicUser(user)));

    // Trainees choose their standard and profile (e.g. switch to 2027 rules if their application date moves). Signed months keep their rules.
    api.patch('/me', req => asUser(req, async (trx, user) => {
      // Supervisors have no fieldwork standard: they can only change their reminder setting.
      const changes = user.role === 'trainee' ? ProfileBody.parse(req.body) : ProfileBody.pick({ emailReminders: true }).strict().parse(req.body);
      if (!Object.keys(changes).length) throw new HttpError(400, 'Nothing to update');
      return publicUser(await trx.updateTable('users').set(changes).where('id', '=', user.id).returningAll().executeTakeFirstOrThrow());
    }));

    // ---- Supervision links ----
    api.post('/supervisions', async (req, reply) => {
      const { inviteCode, startsOn } = z.object({ inviteCode: z.string().trim().toUpperCase().length(8, 'Invite codes are 8 characters'), startsOn: z.iso.date().optional() }).parse(req.body);
      const res = await asUser(req, async (trx, user) => {
        requireRole(user, 'trainee');
        const { rows: [s] } = await sql<{ id: string; fullName: string }>`select id, full_name from find_supervisor_by_code(${inviteCode})`.execute(trx);
        if (!s) throw new HttpError(404, 'No supervisor with that code');
        const link = await trx.insertInto('supervisions').values({ traineeId: user.id, supervisorId: s.id, startsOn: startsOn ?? today(), endsOn: null, organizationId: null })
          .returning(['id', 'startsOn']).executeTakeFirstOrThrow();
        return { ...link, supervisor: s };
      });
      return reply.code(201).send(res);
    });

    // Invite links: the trainee sends one to their supervisor, who is linked on accepting (no code needed).
    const Token = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{32}$/, 'Invalid invite link') });
    api.post('/invites', async (req, reply) => {
      const { startsOn } = z.object({ startsOn: z.iso.date().optional() }).parse(req.body ?? {});
      const token = randomBytes(24).toString('base64url');
      await asUser(req, async (trx, user) => {
        requireRole(user, 'trainee');
        await trx.insertInto('supervisorInvites').values({ tokenHash: tokenHash(token), traineeId: user.id, startsOn: startsOn ?? today() }).execute();
      });
      return reply.code(201).send({ token });
    });

    // Signed in, but maybe without an account yet (a supervisor about to sign up).
    api.get('/invites/:token', async req => {
      const { token } = Token.parse(req.params), id = await identity(req);
      const row = await db.transaction().execute(async trx => {
        await becomeUser(trx, id.sub);
        return (await sql<{ traineeName: string }>`select trainee_name from invite_info(${tokenHash(token)})`.execute(trx)).rows[0];
      });
      if (!row) throw new HttpError(404, 'This invite link is invalid, used or expired');
      return row;
    });

    api.post('/invites/:token/accept', req => asUser(req, async (trx, user) => {
      const { token } = Token.parse(req.params);
      requireRole(user, 'supervisor');
      const { rows: [r] } = await sql<{ traineeId: string | null }>`select accept_invite(${tokenHash(token)}) as trainee_id`.execute(trx);
      if (!r?.traineeId) throw new HttpError(404, 'This invite link is invalid, used or expired');
      return { traineeId: r.traineeId };
    }));

    api.get('/supervisors', req => asUser(req, async (trx, user) => {
      requireRole(user, 'trainee');
      return trx.selectFrom('supervisions as s').innerJoin('users as u', 'u.id', 's.supervisorId')
        .select(['u.id', 'u.fullName', 'u.email', 'u.bacbId', 's.startsOn', 's.endsOn']).where('s.traineeId', '=', user.id).orderBy('u.fullName').execute();
    }));

    api.get('/trainees', req => asUser(req, async (trx, user) => {
      requireRole(user, 'supervisor');
      return trx.selectFrom('supervisions as s').innerJoin('users as u', 'u.id', 's.traineeId')
        .select(['u.id', 'u.fullName', 'u.email', 'u.fieldworkType', 'u.credential', 'u.rulesEdition', 's.startsOn', 's.endsOn']).where('s.supervisorId', '=', user.id).orderBy('u.fullName').execute();
    }));

    // ---- Entries ----
    api.get('/entries', req => asUser(req, async (trx, user) => {
      const { month, traineeId } = z.object({ month: Month }).extend(TraineeQuery.shape).parse(req.query);
      return (await listEntries(trx, await scope(trx, user, traineeId), ...monthRange(month))).map(publicEntry);
    }));

    api.get('/entries/export.csv', async (req, reply) => {
      const csv = await asUser(req, async (trx, user) => {
        const s = await scope(trx, user, TraineeQuery.parse(req.query).traineeId);
        const names = new Map((await trx.selectFrom('users').select(['id', 'fullName']).where('role', '=', 'supervisor').execute()).map(u => [u.id, u.fullName]));
        const rows = (await listEntries(trx, s)).reverse().map(e => {
          const min = durationMinutes(e);
          return [e.workDate, e.startTime.slice(0, 5), e.endTime.slice(0, 5), (min / 60).toFixed(3), e.kind, names.get(e.supervisorId) ?? '',
            (e.restrictedMinutes / 60).toFixed(3), ((min - e.restrictedMinutes) / 60).toFixed(3), e.isGroup ? 'yes' : 'no', e.contact ?? '', e.format ?? '', e.description];
        });
        return toCsv([['Date', 'Start', 'End', 'Hours', 'Type', 'Supervisor', 'Restricted hours', 'Unrestricted hours', 'Group', 'Contact', 'Format', 'Description'], ...rows]);
      });
      return reply.type('text/csv; charset=utf-8').header('cache-control', 'no-store').header('content-disposition', 'attachment; filename="fieldwork-hours.csv"').send(csv);
    });

    api.get('/entries/export.pdf', async (req, reply) => {
      const pdf = await asUser(req, async (trx, user) => {
        const s = await scope(trx, user, TraineeQuery.parse(req.query).traineeId);
        const [entries, profile, t, people, signed] = await Promise.all([
          listEntries(trx, s), traineeProfile(trx, s.traineeId),
          trx.selectFrom('users').select(['fullName', 'bacbId']).where('id', '=', s.traineeId).executeTakeFirstOrThrow(),
          trx.selectFrom('users').select(['id', 'fullName']).where('role', '=', 'supervisor').execute(),
          trx.selectFrom('monthVerifications').select(['month', 'supervisorId', 'supervisorSignedAt']).where('traineeId', '=', s.traineeId).where('supervisorSignedAt', 'is not', null)
            .$if(!!s.supervisorId, q => q.where('supervisorId', '=', s.supervisorId!)).execute(),
        ]);
        const program = evaluateProgram(entries, profile);
        return hoursLogPdf({
          trainee: { name: t.fullName, bacbId: t.bacbId }, entries, forms: program.months,
          standard: `${profile.credential?.toUpperCase()} · ${profile.type === 'concentrated' ? 'Concentrated' : 'Supervised'} · ${profile.edition} rules`,
          supervisors: new Map(people.map(p => [p.id, p.fullName])),
          signedAt: new Map(signed.map(v => [`${String(v.month).slice(0, 7)}|${v.supervisorId}`, v.supervisorSignedAt!])),
          countableMinutes: program.countableMinutes, requiredMinutes: program.requiredMinutes,
        });
      });
      return reply.type('application/pdf').header('cache-control', 'no-store').header('content-disposition', 'attachment; filename="fieldwork-hours.pdf"').send(Buffer.from(pdf));
    });

    /**
     * Idempotent create-or-replace keyed by the client's UUID. Offline clients retry freely:
     * a replay with identical data changes nothing (no update, no audit row), never a duplicate.
     */
    api.put('/entries/:id', async (req, reply) => {
      const { id } = Id.parse(req.params);
      const body = EntryBody.parse(req.body);
      const res = await asUser(req, async (trx, user) => {
        const existing = await trx.selectFrom('entries').select('deletedAt').where('id', '=', id).executeTakeFirst();
        if (existing?.deletedAt) throw new HttpError(409, 'This entry was deleted');
        const { organizationId, warnings } = await checkEntry(trx, user, body, id);
        const values = { ...body, organizationId };
        const changed = await trx.insertInto('entries').values({ id, traineeId: user.id, ...values })
          .onConflict(oc => oc.column('id').doUpdateSet(values)
            .where(eb => eb.or(ENTRY_FIELDS.map(f => eb(`entries.${f}`, 'is distinct from', eb.ref(`excluded.${f}`))))))
          .returningAll().executeTakeFirst();
        // No row back: either an identical replay, or the id belongs to someone else (RLS skipped the update).
        const row = changed ?? await trx.selectFrom('entries').selectAll().where('id', '=', id).executeTakeFirst();
        if (!row) throw new HttpError(404, 'Not found');
        return { created: !existing, entry: publicEntry(row), warnings };
      });
      return reply.code(res.created ? 201 : 200).send({ entry: res.entry, warnings: res.warnings });
    });

    api.delete('/entries/:id', async (req, reply) => {
      const { id } = Id.parse(req.params);
      await asUser(req, async (trx, user) => {
        const row = await trx.selectFrom('entries').select('deletedAt').where('id', '=', id).where('traineeId', '=', user.id).executeTakeFirst();
        if (!row) throw new HttpError(404, 'Not found');
        if (!row.deletedAt) await trx.updateTable('entries').set({ deletedAt: new Date() }).where('id', '=', id).execute(); // repeat deletes are no-ops
      });
      return reply.code(204).send();
    });

    // ---- Review comments ----
    api.get('/comments', req => asUser(req, async (trx, user) => {
      const { month, traineeId } = z.object({ month: Month }).extend(TraineeQuery.shape).parse(req.query);
      const s = await scope(trx, user, traineeId), [from, to] = monthRange(month);
      return trx.selectFrom('entryComments as c').innerJoin('entries as e', 'e.id', 'c.entryId').leftJoin('users as u', 'u.id', 'c.authorId')
        .select(['c.id', 'c.entryId', 'c.body', 'c.createdAt', 'c.resolvedAt', 'c.authorId', 'u.fullName as authorName'])
        .where('e.traineeId', '=', s.traineeId).where('e.workDate', '>=', from).where('e.workDate', '<', to)
        .$if(!!s.supervisorId, q => q.where('e.supervisorId', '=', s.supervisorId!)).orderBy('c.createdAt').execute();
    }));

    api.post('/entries/:id/comments', async (req, reply) => {
      const { id } = Id.parse(req.params);
      const { body } = z.object({ body: z.string().trim().min(1, 'Write a comment').max(2000) }).parse(req.body);
      const row = await asUser(req, async (trx, user) =>
        trx.insertInto('entryComments').values({ entryId: id, authorId: user.id, body, resolvedAt: null }).returning(['id', 'entryId', 'body', 'createdAt', 'resolvedAt']).executeTakeFirstOrThrow());
      return reply.code(201).send(row);
    });

    api.post('/comments/:id/resolve', req => asUser(req, async trx => {
      const { id } = Id.parse(req.params);
      const row = await trx.updateTable('entryComments').set({ resolvedAt: new Date() }).where('id', '=', id).where('resolvedAt', 'is', null).returning(['id', 'resolvedAt']).executeTakeFirst();
      if (!row && !await trx.selectFrom('entryComments').select('id').where('id', '=', id).executeTakeFirst()) throw new HttpError(404, 'Not found');
      return row ?? { id, alreadyResolved: true };
    }));

    // ---- History: "why did my total change?" ----
    api.get('/entries/:id/history', req => asUser(req, async trx => {
      const { id } = Id.parse(req.params);
      const rows = await auditRows(trx).where('a.rowId', '=', id).execute();
      if (!rows.length) throw new HttpError(404, 'Not found');
      return rows.map(r => describeChange(r));
    }));

    api.get('/changes', req => asUser(req, async (trx, user) => {
      const { month, traineeId } = z.object({ month: Month }).extend(TraineeQuery.shape).parse(req.query);
      const s = await scope(trx, user, traineeId);
      const [from, to] = monthRange(month);
      const inMonth = (col: 'a.oldRow' | 'a.newRow') => sql<boolean>`(${sql.ref(col)} ->> 'work_date') >= ${from} and (${sql.ref(col)} ->> 'work_date') < ${to}`;
      const rows = await auditRows(trx)
        .where(sql<boolean>`coalesce(a.new_row ->> 'trainee_id', a.old_row ->> 'trainee_id') = ${s.traineeId}`)
        .where(eb => eb.or([inMonth('a.oldRow'), inMonth('a.newRow')]))
        .execute();
      return rows.map(r => describeChange(r, month)).filter(c => c.minutesDelta !== 0 || c.action !== 'UPDATE' || c.changes.length);
    }));

    // ---- Requirements ----
    api.get('/months/:month', req => asUser(req, async (trx, user) => {
      const { month } = z.object({ month: Month }).parse(req.params);
      const q = TraineeQuery.extend({ supervisorId: z.uuid().optional() }).parse(req.query);
      const s = await scope(trx, user, q.traineeId);
      // Requirements are met per verification form (month × supervisor), so a trainee with several supervisors must pick one.
      const entries = await listEntries(trx, { ...s, supervisorId: s.supervisorId ?? q.supervisorId }, ...monthRange(month));
      if (new Set(entries.map(e => e.supervisorId)).size > 1) throw new HttpError(400, 'Requirements are checked per supervisor; pass supervisorId');
      return evaluateMonth(month, entries, await traineeProfile(trx, s.traineeId));
    }));

    api.get('/progress', req => asUser(req, async (trx, user) => {
      const s = await scope(trx, user, TraineeQuery.parse(req.query).traineeId);
      return evaluateProgram(await listEntries(trx, s), await traineeProfile(trx, s.traineeId));
    }));

    // ---- Monthly sign-off: trainee signs, then supervisor signs (which locks the month) ----
    api.get('/verifications', req => asUser(req, async (trx, user) => {
      const { month, traineeId } = z.object({ month: Month }).extend(TraineeQuery.shape).parse(req.query);
      const s = await scope(trx, user, traineeId);
      return trx.selectFrom('monthVerifications').select(['id', 'traineeId', 'supervisorId', 'month', 'rulesVersion', 'attestation', 'traineeSignedAt', 'supervisorSignedAt'])
        .where('traineeId', '=', s.traineeId).where('month', '=', `${month}-01`).$if(!!s.supervisorId, q => q.where('supervisorId', '=', s.supervisorId!)).execute();
    }));

    api.post('/verifications/:month/sign', req => asUser(req, async (trx, user) => {
      const { month } = z.object({ month: Month }).parse(req.params);
      const body = z.object({
        supervisorId: z.uuid().optional(), traineeId: z.uuid().optional(), signature: z.string().max(200),
        attest: z.literal(true, 'You must agree to the attestation to sign'),
      }).parse(req.body ?? {});
      // Electronic signature: typing your own name after reading the attestation shows intent to sign.
      if (!signatureMatches(body.signature, user.fullName)) throw new HttpError(400, `Type your full name exactly as on your account (${user.fullName}) to sign`);
      const { traineeId, supervisorId } = await pairFor(trx, user, body);
      const existing = await trx.selectFrom('monthVerifications').selectAll().where('traineeId', '=', traineeId).where('supervisorId', '=', supervisorId).where('month', '=', `${month}-01`).executeTakeFirst();
      if (existing?.supervisorSignedAt) throw new HttpError(409, 'This month is already signed and locked');
      const result = await pairResult(trx, traineeId, supervisorId, month);

      if (user.role === 'trainee') {
        return trx.insertInto('monthVerifications')
          .values({ traineeId, supervisorId, month: `${month}-01`, fieldworkType: (await traineeProfile(trx, traineeId)).type, rulesVersion: result.rulesVersion, summary: JSON.stringify(result), traineeSignedAt: new Date(), supervisorSignedAt: null, traineeSignature: body.signature.trim(), supervisorSignature: null, attestation: ATTESTATIONS[editionOf(result.rulesVersion)].id, pdfS3Key: null })
          .onConflict(oc => oc.columns(['traineeId', 'supervisorId', 'month']).doUpdateSet(eb => ({ summary: eb.ref('excluded.summary'), rulesVersion: eb.ref('excluded.rulesVersion'), traineeSignedAt: eb.ref('excluded.traineeSignedAt'), traineeSignature: eb.ref('excluded.traineeSignature'), attestation: eb.ref('excluded.attestation') })))
          .returning(['id', 'month', 'traineeSignedAt', 'supervisorSignedAt']).executeTakeFirstOrThrow();
      }
      if (!existing?.traineeSignedAt) throw new HttpError(409, 'The trainee has not signed this month yet');
      if (canonical(existing.summary) !== canonical(result)) throw new HttpError(409, 'Entries changed since the trainee signed. Ask them to re-sign.');
      return trx.updateTable('monthVerifications').set({ supervisorSignedAt: new Date(), supervisorSignature: body.signature.trim() }).where('id', '=', existing.id)
        .returning(['id', 'month', 'traineeSignedAt', 'supervisorSignedAt']).executeTakeFirstOrThrow();
    }));

    // The official BACB Monthly Fieldwork Verification Form, prefilled. Signed months print the signed snapshot.
    api.get('/verifications/:month/form.pdf', async (req, reply) => {
      const { month } = z.object({ month: Month }).parse(req.params);
      const q = z.object({ traineeId: z.uuid().optional(), supervisorId: z.uuid().optional() }).parse(req.query);
      const pdf = await asUser(req, async (trx, user) => {
        const { traineeId, supervisorId } = await pairFor(trx, user, q);
        const people = await trx.selectFrom('users').selectAll().where('id', 'in', [traineeId, supervisorId]).execute();
        const t = people.find(p => p.id === traineeId)!, s = people.find(p => p.id === supervisorId)!;
        const v = await trx.selectFrom('monthVerifications').selectAll().where('traineeId', '=', traineeId).where('supervisorId', '=', supervisorId).where('month', '=', `${month}-01`).executeTakeFirst();
        const live = await pairResult(trx, traineeId, supervisorId, month);
        // A trainee signature only stands while the entries still match what they signed.
        const traineeSignatureValid = !!v?.traineeSignedAt && (!!v.supervisorSignedAt || canonical(v.summary) === canonical(live));
        const result = v?.supervisorSignedAt ? v.summary as typeof live : live;
        return fillMonthlyForm({
          edition: editionOf(result.rulesVersion), fieldworkType: v?.fieldworkType ?? t.fieldworkType!, month,
          trainee: { name: t.fullName, bacbId: t.bacbId }, supervisor: { name: s.fullName, bacbId: s.bacbId },
          state: t.fieldworkState, country: t.fieldworkCountry, summary: result.summary,
          traineeSigned: traineeSignatureValid ? { name: v!.traineeSignature ?? t.fullName, at: v!.traineeSignedAt! } : null,
          supervisorSigned: v?.supervisorSignedAt ? { name: v.supervisorSignature ?? s.fullName, at: v.supervisorSignedAt } : null,
          reference: v?.id ?? 'unsigned draft',
        });
      });
      return reply.type('application/pdf').header('cache-control', 'no-store')
        .header('content-disposition', `attachment; filename="fieldwork-verification-${month}.pdf"`).send(Buffer.from(pdf));
    });

    // ---- Final Fieldwork Verification (supervisor signs once fieldwork with them ends) ----
    const PairQuery = z.object({ traineeId: z.uuid().optional(), supervisorId: z.uuid().optional() });

    api.get('/final', req => asUser(req, async (trx, user) => {
      const { traineeId } = TraineeQuery.parse(req.query);
      return trx.selectFrom('finalVerifications').select(['id', 'traineeId', 'supervisorId', 'summary', 'supervisorSignedAt'])
        .$if(user.role === 'supervisor', q => q.where('supervisorId', '=', user.id).$if(!!traineeId, q2 => q2.where('traineeId', '=', traineeId!)))
        .$if(user.role !== 'supervisor', q => q.where('traineeId', '=', user.id)).execute();
    }));

    api.post('/final/sign', req => asUser(req, async (trx, user) => {
      requireRole(user, 'supervisor');
      const body = z.object({ traineeId: z.uuid(), signature: z.string().max(200), attest: z.literal(true, 'You must agree to the attestation to sign') }).parse(req.body ?? {});
      if (!signatureMatches(body.signature, user.fullName)) throw new HttpError(400, `Type your full name exactly as on your account (${user.fullName}) to sign`);
      const { traineeId, supervisorId } = await pairFor(trx, user, body);
      const summary = await finalSummary(trx, traineeId, supervisorId);
      const values = { summary: JSON.stringify(summary), attestation: FINAL_ATTESTATIONS[summary.edition].id, supervisorSignature: body.signature.trim(), supervisorSignedAt: new Date() };
      return trx.insertInto('finalVerifications').values({ traineeId, supervisorId, ...values })
        .onConflict(oc => oc.columns(['traineeId', 'supervisorId']).doUpdateSet(values))
        .returning(['id', 'supervisorSignedAt']).executeTakeFirstOrThrow();
    }));

    api.get('/final/form.pdf', async (req, reply) => {
      const pdf = await asUser(req, async (trx, user) => {
        const { traineeId, supervisorId } = await pairFor(trx, user, PairQuery.parse(req.query));
        const [summary, people, signed] = await Promise.all([
          finalSummary(trx, traineeId, supervisorId),
          trx.selectFrom('users').selectAll().where('id', 'in', [traineeId, supervisorId]).execute(),
          trx.selectFrom('finalVerifications').selectAll().where('traineeId', '=', traineeId).where('supervisorId', '=', supervisorId).executeTakeFirst(),
        ]);
        const t = people.find(p => p.id === traineeId)!, s = people.find(p => p.id === supervisorId)!;
        // The signature stands only while it covers exactly the signed months (none signed since).
        const valid = signed && canonical(signed.summary) === canonical(summary);
        return fillFinalForm({
          ...summary, trainee: { name: t.fullName, bacbId: t.bacbId }, supervisor: { name: s.fullName, bacbId: s.bacbId },
          state: t.fieldworkState, country: t.fieldworkCountry,
          supervisorSigned: valid ? { name: signed.supervisorSignature, at: signed.supervisorSignedAt } : null, reference: valid ? signed.id : 'unsigned draft',
        });
      });
      return reply.type('application/pdf').header('cache-control', 'no-store').header('content-disposition', 'attachment; filename="final-fieldwork-verification.pdf"').send(Buffer.from(pdf));
    });
  }, { prefix: '/api' });

  return app;
}
