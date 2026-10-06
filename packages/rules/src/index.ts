// BACB fieldwork rules. Pure functions, shared by the web app (live warnings) and the API (final authority).
// All durations are integer minutes so percentage checks never hit floating-point error.

export type FieldworkType = 'supervised' | 'concentrated';
export type EntryKind = 'independent' | 'supervised';
export type ContactType = 'contact' | 'observation';

export interface Entry {
  workDate: string; // YYYY-MM-DD
  startTime: string; // HH:MM, 24h
  endTime: string;
  kind: EntryKind;
  restrictedMinutes: number; // remainder of the entry is unrestricted
  isGroup: boolean; // group supervision (supervised entries only)
  contact: ContactType | null; // supervised entries only
}

export interface RuleSet {
  version: string;
  effectiveFrom: string; // YYYY-MM-DD; applies to months starting on/after this date
  minMonthlyMinutes: number;
  maxMonthlyMinutes: number;
  overCapPolicy: 'fail' | 'cap'; // UNVERIFIED: does a >130h month fail, or count up to the cap?
  contactCounting: 'perEntry' | 'perDay'; // UNVERIFIED: how BACB counts multiple contacts in one day
  supervisionPercent: Record<FieldworkType, number>;
  minContacts: Record<FieldworkType, number>;
  minObservations: number;
  maxGroupPercent: number; // of supervised minutes
  minUnrestrictedPercent: number; // of all countable minutes
  requiredMinutes: Record<FieldworkType, number>;
}

export const RULESETS: readonly RuleSet[] = [
  {
    version: 'bacb-2022-01',
    effectiveFrom: '2022-01-01',
    minMonthlyMinutes: 20 * 60,
    maxMonthlyMinutes: 130 * 60,
    overCapPolicy: 'fail',
    contactCounting: 'perEntry',
    supervisionPercent: { supervised: 5, concentrated: 10 },
    minContacts: { supervised: 4, concentrated: 6 },
    minObservations: 1,
    maxGroupPercent: 50,
    minUnrestrictedPercent: 60,
    requiredMinutes: { supervised: 2000 * 60, concentrated: 1500 * 60 },
  },
];

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function ruleSetFor(month: string, sets: readonly RuleSet[] = RULESETS): RuleSet {
  const start = `${month}-01`;
  const rs = sets.filter(r => r.effectiveFrom <= start).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)).at(-1);
  if (!rs) throw new RangeError(`No BACB rule set in effect for ${month}`);
  return rs;
}

export function toMinutes(time: string): number {
  const m = TIME.exec(time);
  if (!m) throw new RangeError(`Invalid time "${time}" (expected HH:MM)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function durationMinutes(e: Pick<Entry, 'startTime' | 'endTime'>): number {
  const d = toMinutes(e.endTime) - toMinutes(e.startTime);
  if (d <= 0) throw new RangeError('End time must be after start time');
  return d;
}

/** Returns human-readable problems; empty array means the entry is valid. */
export function validateEntry(e: Entry): string[] {
  const errors: string[] = [];
  if (!DATE.test(e.workDate)) errors.push(`Invalid date "${e.workDate}"`);
  let d = 0;
  try { d = durationMinutes(e) } catch (err) { errors.push((err as Error).message) }
  if (!Number.isInteger(e.restrictedMinutes) || e.restrictedMinutes < 0) errors.push('Restricted minutes must be a whole number ≥ 0');
  else if (d && e.restrictedMinutes > d) errors.push('Restricted time exceeds entry length');
  if (e.kind === 'independent' && (e.isGroup || e.contact)) errors.push('Independent entries cannot have group supervision or a contact type');
  return errors;
}

export interface MonthSummary {
  totalMinutes: number;
  independentMinutes: number;
  supervisedMinutes: number;
  groupMinutes: number;
  restrictedMinutes: number;
  unrestrictedMinutes: number;
  contacts: number;
  observations: number;
}

export function summarize(entries: readonly Entry[], rules: RuleSet): MonthSummary {
  const s: MonthSummary = { totalMinutes: 0, independentMinutes: 0, supervisedMinutes: 0, groupMinutes: 0, restrictedMinutes: 0, unrestrictedMinutes: 0, contacts: 0, observations: 0 };
  const contactKeys = new Set<string>(), obsKeys = new Set<string>();
  entries.forEach((e, i) => {
    const d = durationMinutes(e);
    s.totalMinutes += d;
    s.restrictedMinutes += e.restrictedMinutes;
    if (e.kind === 'independent') { s.independentMinutes += d; return }
    s.supervisedMinutes += d;
    if (e.isGroup) s.groupMinutes += d;
    const key = rules.contactCounting === 'perDay' ? e.workDate : String(i);
    if (e.contact) contactKeys.add(key);
    if (e.contact === 'observation') obsKeys.add(key);
  });
  s.unrestrictedMinutes = s.totalMinutes - s.restrictedMinutes;
  s.contacts = contactKeys.size;
  s.observations = obsKeys.size;
  return s;
}

export type CheckId = 'minHours' | 'maxHours' | 'supervision' | 'groupShare' | 'contacts' | 'observations';
export interface Check { id: CheckId; ok: boolean; label: string; needed?: number } // needed: minutes or count to fix

/** Extra supervised minutes needed so supervised/total reaches pct (supervised time also grows the total). */
export function supervisedMinutesNeeded(totalMinutes: number, supervisedMinutes: number, pct: number): number {
  return Math.max(0, Math.ceil((pct * totalMinutes - 100 * supervisedMinutes) / (100 - pct)));
}

export interface MonthResult {
  month: string;
  rulesVersion: string;
  summary: MonthSummary;
  checks: Check[];
  passed: boolean;
  countableMinutes: number;
}

export function evaluateMonth(month: string, entries: readonly Entry[], type: FieldworkType, sets: readonly RuleSet[] = RULESETS): MonthResult {
  const stray = entries.find(e => !e.workDate.startsWith(`${month}-`));
  if (stray) throw new RangeError(`Entry dated ${stray.workDate} is outside ${month}`);
  const r = ruleSetFor(month, sets), s = summarize(entries, r);
  const pct = r.supervisionPercent[type], contacts = r.minContacts[type];
  const supNeeded = s.totalMinutes ? supervisedMinutesNeeded(s.totalMinutes, s.supervisedMinutes, pct) : 0;
  const over = s.totalMinutes - r.maxMonthlyMinutes;
  const checks: Check[] = [
    { id: 'minHours', ok: s.totalMinutes >= r.minMonthlyMinutes, label: `Minimum ${r.minMonthlyMinutes / 60} hours`, needed: Math.max(0, r.minMonthlyMinutes - s.totalMinutes) },
    { id: 'maxHours', ok: r.overCapPolicy === 'cap' || over <= 0, label: `Maximum ${r.maxMonthlyMinutes / 60} hours`, needed: Math.max(0, over) },
    { id: 'supervision', ok: s.totalMinutes > 0 && supNeeded === 0, label: `Minimum ${pct}% supervision`, needed: supNeeded },
    { id: 'groupShare', ok: s.groupMinutes * 100 <= r.maxGroupPercent * s.supervisedMinutes, label: `Maximum ${r.maxGroupPercent}% group supervision`, needed: Math.max(0, s.groupMinutes - Math.floor(r.maxGroupPercent * s.supervisedMinutes / 100)) },
    { id: 'contacts', ok: s.contacts >= contacts, label: `Minimum ${contacts} supervisor contacts`, needed: Math.max(0, contacts - s.contacts) },
    { id: 'observations', ok: s.observations >= r.minObservations, label: `Minimum ${r.minObservations} observation with client`, needed: Math.max(0, r.minObservations - s.observations) },
  ];
  const passed = checks.every(c => c.ok);
  return { month, rulesVersion: r.version, summary: s, checks, passed, countableMinutes: passed ? Math.min(s.totalMinutes, r.maxMonthlyMinutes) : 0 };
}

export interface ProgramResult {
  months: MonthResult[];
  countableMinutes: number;
  requiredMinutes: number;
  unrestrictedPercent: number; // across passing months
  unrestrictedOk: boolean;
  complete: boolean;
}

export function evaluateProgram(entries: readonly Entry[], type: FieldworkType, sets: readonly RuleSet[] = RULESETS, today = new Date().toISOString().slice(0, 10)): ProgramResult {
  const byMonth = new Map<string, Entry[]>();
  for (const e of entries) {
    const m = e.workDate.slice(0, 7);
    byMonth.set(m, [...(byMonth.get(m) ?? []), e]);
  }
  const months = [...byMonth].sort(([a], [b]) => a.localeCompare(b)).map(([m, list]) => evaluateMonth(m, list, type, sets));
  const passing = months.filter(m => m.passed);
  const countableMinutes = passing.reduce((n, m) => n + m.countableMinutes, 0);
  const total = passing.reduce((n, m) => n + m.summary.totalMinutes, 0);
  const unres = passing.reduce((n, m) => n + m.summary.unrestrictedMinutes, 0);
  const r = ruleSetFor((months.at(-1)?.month ?? today.slice(0, 7)), sets);
  const unrestrictedOk = unres * 100 >= r.minUnrestrictedPercent * total;
  return {
    months, countableMinutes, requiredMinutes: r.requiredMinutes[type],
    unrestrictedPercent: total ? (unres / total) * 100 : 0, unrestrictedOk,
    complete: countableMinutes >= r.requiredMinutes[type] && unrestrictedOk,
  };
}

/** Pairs of entries on the same day whose time ranges overlap. */
export function findOverlaps<T extends Entry>(entries: readonly T[]): [T, T][] {
  const sorted = [...entries].sort((a, b) => (a.workDate + a.startTime).localeCompare(b.workDate + b.startTime));
  const out: [T, T][] = [];
  sorted.forEach((a, i) => {
    for (const b of sorted.slice(i + 1)) {
      if (b.workDate !== a.workDate || toMinutes(b.startTime) >= toMinutes(a.endTime)) break;
      out.push([a, b]);
    }
  });
  return out;
}

export const formatHours = (minutes: number, decimals = 3): string => (minutes / 60).toFixed(decimals);
