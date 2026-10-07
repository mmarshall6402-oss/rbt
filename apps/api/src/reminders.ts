import { fileURLToPath } from 'node:url';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { sql, type Kysely } from 'kysely';
import { signDeadline } from '@fieldtrack/rules';
import { databaseUrl } from './config.js';
import { createDb, type DB } from './db.js';

/**
 * Daily job (ECS scheduled task, owner login): reminds people about BACB signing deadlines.
 * Last month's forms are due at the end of this month; we email a week out and two days out, once each.
 * Emails carry counts and links only, never client details.
 */
export interface Reminder { userId: string; email: string; kind: string; subject: string; text: string }
export type Send = (to: string, subject: string, text: string) => Promise<void>;

const window = (daysLeft: number) => (daysLeft < 0 ? null : daysLeft <= 2 ? 'final' : daysLeft <= 7 ? 'week' : null);
const longDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const monthName = (m: string) => new Date(`${m}-15T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const forms = (n: number) => `${n} Monthly Fieldwork Verification Form${n === 1 ? '' : 's'}`;
const FOOTER = '\n\nYou can turn off these reminders in your Fieldtrack settings.';

export async function dueReminders(db: Kysely<DB>, today: string, appUrl: string): Promise<Reminder[]> {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const month = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7), due = signDeadline(month);
  const w = window(Math.round((Date.parse(due) - Date.parse(today)) / 86_400_000));
  if (!w) return [];
  const from = `${month}-01`, to = `${today.slice(0, 7)}-01`;

  // Trainees: forms with hours under a supervisor that they haven't signed.
  const trainees = await db.selectFrom('entries as e').innerJoin('users as u', 'u.id', 'e.traineeId')
    .leftJoin('monthVerifications as v', j => j.onRef('v.traineeId', '=', 'e.traineeId').onRef('v.supervisorId', '=', 'e.supervisorId').on('v.month', '=', from))
    .select(['u.id', 'u.email', sql<number>`count(distinct e.supervisor_id)::int`.as('n')])
    .where('e.deletedAt', 'is', null).where('e.workDate', '>=', from).where('e.workDate', '<', to)
    .where('v.traineeSignedAt', 'is', null).where('u.emailReminders', '=', true)
    .where(eb => eb.not(eb.exists(eb.selectFrom('externalSignatures as x').select('x.id') // already signed outside Fieldtrack
      .whereRef('x.traineeId', '=', 'e.traineeId').whereRef('x.supervisorId', '=', 'e.supervisorId').where('x.month', '=', from))))
    .groupBy(['u.id', 'u.email']).execute();
  // Supervisors: forms the trainee signed that still need their countersignature.
  const supervisors = await db.selectFrom('monthVerifications as v').innerJoin('users as u', 'u.id', 'v.supervisorId')
    .select(['u.id', 'u.email', sql<number>`count(*)::int`.as('n')])
    .where('v.month', '=', from).where('v.traineeSignedAt', 'is not', null).where('v.supervisorSignedAt', 'is', null)
    .where('u.emailReminders', '=', true).groupBy(['u.id', 'u.email']).execute();

  const all: Reminder[] = [
    ...trainees.map(t => ({
      userId: t.id, email: t.email, kind: `trainee-sign:${month}:${w}`,
      subject: `Sign your ${monthName(month)} fieldwork form${t.n === 1 ? '' : 's'} by ${longDate(due).replace(/, \d{4}$/, '')}`,
      text: `You have ${forms(t.n)} for ${monthName(month)} that you haven't signed yet. The BACB requires both signatures by ${longDate(due)}, or those hours can't count.\n\nSign here: ${appUrl}/app?month=${month}${FOOTER}`,
    })),
    ...supervisors.map(s => ({
      userId: s.id, email: s.email, kind: `supervisor-sign:${month}:${w}`,
      subject: `${s.n} fieldwork form${s.n === 1 ? ' is' : 's are'} waiting for your signature`,
      text: `${forms(s.n)} for ${monthName(month)} ${s.n === 1 ? 'has' : 'have'} been signed by your trainee${s.n === 1 ? '' : 's'} and need${s.n === 1 ? 's' : ''} your signature by ${longDate(due)}, or those hours can't count.\n\nReview and sign: ${appUrl}/supervise?month=${month}${FOOTER}`,
    })),
  ];
  if (!all.length) return [];
  const sent = new Set((await db.selectFrom('remindersSent').select(['userId', 'kind']).where('userId', 'in', all.map(r => r.userId)).execute()).map(r => `${r.userId}|${r.kind}`));
  return all.filter(r => !sent.has(`${r.userId}|${r.kind}`));
}

/** Claims each reminder before sending (safe if two runs overlap); a failed send is released to retry tomorrow. */
export async function sendReminders(db: Kysely<DB>, send: Send, today: string, appUrl: string) {
  let sent = 0;
  for (const r of await dueReminders(db, today, appUrl)) {
    const claimed = await db.insertInto('remindersSent').values({ userId: r.userId, kind: r.kind }).onConflict(oc => oc.doNothing()).returning('userId').executeTakeFirst();
    if (!claimed) continue;
    try { await send(r.email, r.subject, r.text); sent++ }
    catch (err) { await db.deleteFrom('remindersSent').where('userId', '=', r.userId).where('kind', '=', r.kind).execute(); console.error(`reminder failed: ${(err as Error).name}`) }
  }
  return sent;
}

export function sesSender(from: string): Send {
  const ses = new SESv2Client({});
  return async (to, subject, text) => {
    await ses.send(new SendEmailCommand({ FromEmailAddress: from, Destination: { ToAddresses: [to] }, Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } } }));
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { REMINDER_FROM, APP_URL = 'http://localhost:5173' } = process.env;
  const db = createDb(databaseUrl());
  const send: Send = REMINDER_FROM ? sesSender(REMINDER_FROM) : async (to, subject) => console.log(`[dry run] ${subject} → ${to.replace(/^(.).*@/, '$1***@')}`);
  const n = await sendReminders(db, send, new Date().toISOString().slice(0, 10), APP_URL);
  console.log(`${n} reminder(s) sent`);
  await db.destroy();
}
