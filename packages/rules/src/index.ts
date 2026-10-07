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
  supervisorId?: string; // which verification form (supervision structure) the entry belongs to
  // Independent session the supervisor later observed by recording, without real-time feedback.
  // Handbook: counts toward observation with a client only, not contacts or supervised hours.
  observedAsync?: boolean;
}

export type Credential = 'bcba' | 'bcaba';
/** Which BACB standard applies. Decided by when the trainee submits their application (not when hours were worked):
 *  before 2027-01-01 → '2022', on/after → '2027'. */
export type Edition = '2022' | '2027';
export interface Profile { type: FieldworkType; credential?: Credential; edition?: Edition }

type ByCredential<T> = Record<Credential, Record<FieldworkType, T>>;
export interface RuleSet {
  version: string;
  edition: Edition;
  minMonthlyMinutes: number;
  maxMonthlyMinutes: number;
  contactCounting: 'perEntry' | 'perDay'; // Handbook: a contact is "a real-time interaction", so each one counts
  supervisionPerMille: ByCredential<number>; // 75 = 7.5% (per-mille keeps the math in integers)
  minContacts: Record<FieldworkType, number> | null; // null = not required
  observation: { unit: 'count'; min: number } | { unit: 'minutes'; min: Record<FieldworkType, number> };
  maxGroupPercent: number; // of supervised minutes
  minUnrestrictedPercent: number; // of all countable minutes
  requiredMinutes: ByCredential<number>;
}

const h = (hours: number) => hours * 60;
export const RULESETS: Readonly<Record<Edition, RuleSet>> = {
  '2022': {
    version: 'bacb-2022',
    edition: '2022',
    minMonthlyMinutes: h(20),
    maxMonthlyMinutes: h(130),
    contactCounting: 'perEntry',
    supervisionPerMille: { bcba: { supervised: 50, concentrated: 100 }, bcaba: { supervised: 50, concentrated: 100 } },
    minContacts: { supervised: 4, concentrated: 6 },
    observation: { unit: 'count', min: 1 },
    maxGroupPercent: 50,
    minUnrestrictedPercent: 60,
    requiredMinutes: { bcba: { supervised: h(2000), concentrated: h(1500) }, bcaba: { supervised: h(1300), concentrated: h(1000) } },
  },
  '2027': {
    version: 'bacb-2027',
    edition: '2027',
    minMonthlyMinutes: h(20),
    maxMonthlyMinutes: h(160),
    contactCounting: 'perEntry',
    supervisionPerMille: { bcba: { supervised: 50, concentrated: 75 }, bcaba: { supervised: 50, concentrated: 100 } },
    minContacts: null, // supervisory contacts are no longer required
    observation: { unit: 'minutes', min: { supervised: 60, concentrated: 90 } },
    maxGroupPercent: 50,
    minUnrestrictedPercent: 60,
    requiredMinutes: { bcba: { supervised: h(2000), concentrated: h(1500) }, bcaba: { supervised: h(1300), concentrated: h(800) } },
  },
};

/** Edition for an application submitted on `applicationDate` (YYYY-MM-DD). */
export const editionFor = (applicationDate: string): Edition => (applicationDate < '2027-01-01' ? '2022' : '2027');

/** Resolved targets for one trainee, for displays and checks. */
export function targetsFor(profile: Profile, rules: RuleSet = RULESETS[profile.edition ?? '2027']) {
  const credential = profile.credential ?? 'bcba';
  return {
    rules, credential,
    supervisionPerMille: rules.supervisionPerMille[credential][profile.type],
    minContacts: rules.minContacts?.[profile.type] ?? null,
    observation: rules.observation.unit === 'count'
      ? { unit: 'count' as const, min: rules.observation.min }
      : { unit: 'minutes' as const, min: rules.observation.min[profile.type] },
    requiredMinutes: rules.requiredMinutes[credential][profile.type],
  };
}

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

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
  if (e.kind === 'supervised' && e.observedAsync) errors.push('A recorded observation goes on an independent entry (the supervisor wasn\'t present)');
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
  observations: number; // count (2022)
  observationMinutes: number; // duration (2027)
}

export function summarize(entries: readonly Entry[], rules: RuleSet): MonthSummary {
  const s: MonthSummary = { totalMinutes: 0, independentMinutes: 0, supervisedMinutes: 0, groupMinutes: 0, restrictedMinutes: 0, unrestrictedMinutes: 0, contacts: 0, observations: 0, observationMinutes: 0 };
  const contactKeys = new Set<string>(), obsKeys = new Set<string>();
  entries.forEach((e, i) => {
    const d = durationMinutes(e);
    s.totalMinutes += d;
    s.restrictedMinutes += e.restrictedMinutes;
    if (e.kind === 'independent') {
      s.independentMinutes += d;
      if (e.observedAsync) { obsKeys.add(`async-${i}`); s.observationMinutes += d }
      return;
    }
    s.supervisedMinutes += d;
    if (e.isGroup) s.groupMinutes += d;
    const key = rules.contactCounting === 'perDay' ? e.workDate : String(i);
    if (e.contact) contactKeys.add(key);
    if (e.contact === 'observation') { obsKeys.add(key); s.observationMinutes += d }
  });
  s.unrestrictedMinutes = s.totalMinutes - s.restrictedMinutes;
  s.contacts = contactKeys.size;
  s.observations = obsKeys.size;
  return s;
}

export type CheckId = 'minHours' | 'maxHours' | 'supervision' | 'groupShare' | 'contacts' | 'observations';
export interface Check { id: CheckId; ok: boolean; label: string; needed?: number } // needed: minutes or count to fix

/** Extra supervised minutes needed so supervised/total reaches perMille (supervised time also grows the total). */
export function supervisedMinutesNeeded(totalMinutes: number, supervisedMinutes: number, perMille: number): number {
  return Math.max(0, Math.ceil((perMille * totalMinutes - 1000 * supervisedMinutes) / (1000 - perMille)));
}

const percentLabel = (perMille: number) => `${perMille / 10}%`;

export interface MonthResult {
  month: string;
  supervisorId?: string; // set when evaluated per verification form
  type?: FieldworkType; // the form's fieldwork type
  lost?: boolean; // not signed by the BACB deadline: nothing counts
  rulesVersion: string;
  summary: MonthSummary;
  checks: Check[];
  passed: boolean; // every requirement met as logged
  countable: { independentMinutes: number; supervisedMinutes: number }; // after BACB adjustments: what goes on the M-FVF
  countableMinutes: number;
}

export function evaluateMonth(month: string, entries: readonly Entry[], profile: Profile, rules?: RuleSet): MonthResult {
  const stray = entries.find(e => !e.workDate.startsWith(`${month}-`));
  if (stray) throw new RangeError(`Entry dated ${stray.workDate} is outside ${month}`);
  const t = targetsFor(profile, rules), r = t.rules, s = summarize(entries, r);
  const supNeeded = s.totalMinutes ? supervisedMinutesNeeded(s.totalMinutes, s.supervisedMinutes, t.supervisionPerMille) : 0;
  const checks: Check[] = [
    { id: 'minHours', ok: s.totalMinutes >= r.minMonthlyMinutes, label: `Minimum ${r.minMonthlyMinutes / 60} hours`, needed: Math.max(0, r.minMonthlyMinutes - s.totalMinutes) },
    { id: 'maxHours', ok: s.totalMinutes <= r.maxMonthlyMinutes, label: `Maximum ${r.maxMonthlyMinutes / 60} hours`, needed: Math.max(0, s.totalMinutes - r.maxMonthlyMinutes) },
    { id: 'supervision', ok: s.totalMinutes > 0 && supNeeded === 0, label: `Minimum ${percentLabel(t.supervisionPerMille)} supervision`, needed: supNeeded },
    { id: 'groupShare', ok: s.groupMinutes * 100 <= r.maxGroupPercent * s.supervisedMinutes, label: `Maximum ${r.maxGroupPercent}% group supervision`, needed: Math.max(0, s.groupMinutes - Math.floor(r.maxGroupPercent * s.supervisedMinutes / 100)) },
  ];
  if (t.minContacts !== null)
    checks.push({ id: 'contacts', ok: s.contacts >= t.minContacts, label: `Minimum ${t.minContacts} supervisor contacts`, needed: Math.max(0, t.minContacts - s.contacts) });
  checks.push(t.observation.unit === 'count'
    ? { id: 'observations', ok: s.observations >= t.observation.min, label: `Minimum ${t.observation.min} observation with client`, needed: Math.max(0, t.observation.min - s.observations) }
    : { id: 'observations', ok: s.observationMinutes >= t.observation.min, label: `Minimum ${t.observation.min} minutes observed with client`, needed: Math.max(0, t.observation.min - s.observationMinutes) });
  const passed = checks.every(c => c.ok), countable = countableHours(s, checks, t, profile.type);
  return { month, rulesVersion: r.version, summary: s, checks, passed, countable, countableMinutes: countable.independentMinutes + countable.supervisedMinutes };
}

/**
 * The hours a month can still count, recorded on the M-FVF. Handbook, "Adjusting and Documenting Fieldwork Hours When
 * Monthly Requirements Are Not Met": supervised fieldwork is trimmed to meet each requirement; "concentrated hours may
 * not be prorated or adjusted", so a concentrated month that misses anything counts nothing. The table is written for
 * the 2022 requirements; the 2027 rules get the same adjustments for the requirements they share.
 */
function countableHours(s: MonthSummary, checks: Check[], t: ReturnType<typeof targetsFor>, type: FieldworkType) {
  const failed = new Set(checks.filter(c => !c.ok).map(c => c.id)), r = t.rules;
  if (!failed.size) return { independentMinutes: s.independentMinutes, supervisedMinutes: s.supervisedMinutes };
  // No observation, or fewer than 20 hours: "No hours are eligible for the month."
  if (type === 'concentrated' || failed.has('minHours') || failed.has('observations')) return { independentMinutes: 0, supervisedMinutes: 0 };
  const individual = s.supervisedMinutes - s.groupMinutes;
  // Group over its share: "Reduce the group supervision hours until they equal (or are less than) the individual supervision hours."
  let sup = Math.min(r.maxMonthlyMinutes, individual + Math.min(s.groupMinutes, Math.floor((individual * r.maxGroupPercent) / (100 - r.maxGroupPercent))));
  // Over the maximum: "Remove independent hours for the month until the total equals" the maximum.
  let ind = Math.min(s.independentMinutes, r.maxMonthlyMinutes - sup);
  // Supervision too low: "Decrease the independent hours for the month until the % of supervision meets" the minimum.
  ind = Math.min(ind, Math.floor((sup * (1000 - t.supervisionPerMille)) / t.supervisionPerMille));
  // Too few contacts (2022): prorate the hours (up to the maximum) by the share of required contacts that occurred.
  if (t.minContacts !== null && s.contacts < t.minContacts) {
    ind = Math.floor((ind * s.contacts) / t.minContacts);
    sup = Math.floor((sup * s.contacts) / t.minContacts);
  }
  return { independentMinutes: ind, supervisedMinutes: sup };
}

export interface ProgramResult {
  months: MonthResult[];
  countableMinutes: number; // with mixed fieldwork types, concentrated hours are weighted by 1.33
  countableByType: Record<FieldworkType, number>; // actual hours, as reported on the forms
  mixed: false | 'bcba' | 'estimate';
  requiredMinutes: number;
  unrestrictedPercent: number; // across passing months
  unrestrictedOk: boolean;
  complete: boolean;
}

/** Groups entries into verification forms: one per month per supervisor (Handbook: requirements must be met
 *  independently for each Monthly Fieldwork Verification Form). */
export function groupByForm<T extends Entry>(entries: readonly T[]): { month: string; supervisorId: string | undefined; entries: T[] }[] {
  const forms = new Map<string, { month: string; supervisorId: string | undefined; entries: T[] }>();
  for (const e of entries) {
    const month = e.workDate.slice(0, 7), key = `${month}|${e.supervisorId ?? ''}`;
    const f = forms.get(key) ?? { month, supervisorId: e.supervisorId, entries: [] };
    f.entries.push(e);
    forms.set(key, f);
  }
  return [...forms.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, f]) => f);
}

/**
 * Fieldwork type of one verification form. Handbook: "Hours can only be accrued under one fieldwork type per month,
 * per supervision structure." Signed forms keep the type they were signed with; others follow the trainee's setting.
 */
export type FormType = (month: string, supervisorId: string | undefined) => FieldworkType | undefined;

/** Evaluates each verification form in a month separately, each under its own fieldwork type. */
export function evaluateForms(entries: readonly Entry[], profile: Profile, rules?: RuleSet, typeOf?: FormType): MonthResult[] {
  return groupByForm(entries).map(f => {
    const type = typeOf?.(f.month, f.supervisorId) ?? profile.type;
    return { ...evaluateMonth(f.month, f.entries, { ...profile, type }, rules), type, ...(f.supervisorId ? { supervisorId: f.supervisorId } : {}) };
  });
}

/** Handbook, "Combining Fieldwork Types": concentrated hours × 1.33 plus supervised hours must reach the supervised total (BCBA). */
export const MIXED_CONCENTRATED_MULTIPLIER = 1.33;

export function evaluateProgram(entries: readonly Entry[], profile: Profile, rules?: RuleSet, typeOf?: FormType, lost?: (month: string, supervisorId: string | undefined) => boolean): ProgramResult {
  // A form signed late (or never) loses the whole month.
  const months = evaluateForms(entries, profile, rules, typeOf).map(m => (lost?.(m.month, m.supervisorId)
    ? { ...m, lost: true, countable: { independentMinutes: 0, supervisedMinutes: 0 }, countableMinutes: 0 } : m));
  const passing = months.filter(m => m.countableMinutes > 0);
  const byType = { supervised: 0, concentrated: 0 };
  for (const m of passing) byType[m.type!] += m.countableMinutes;
  const mixed = byType.supervised > 0 && byType.concentrated > 0;
  // Mixed hours count toward the Supervised Fieldwork total, with concentrated hours weighted (only for this sum).
  const t = targetsFor(mixed ? { ...profile, type: 'supervised' } : profile, rules);
  const countableMinutes = mixed ? byType.supervised + Math.floor(byType.concentrated * MIXED_CONCENTRATED_MULTIPLIER) : byType.supervised + byType.concentrated;
  const total = passing.reduce((n, m) => n + m.summary.totalMinutes, 0);
  const unres = passing.reduce((n, m) => n + m.summary.unrestrictedMinutes, 0);
  const unrestrictedOk = unres * 100 >= t.rules.minUnrestrictedPercent * total;
  return {
    months, countableMinutes, requiredMinutes: t.requiredMinutes, countableByType: byType,
    // The 1.33 rule is published in the BCBA Handbook; for BCaBA it's an estimate until confirmed with the BACB.
    mixed: mixed ? (t.credential === 'bcba' ? 'bcba' : 'estimate') : false,
    unrestrictedPercent: total ? (unres / total) * 100 : 0, unrestrictedOk,
    complete: countableMinutes >= t.requiredMinutes && unrestrictedOk,
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

/** The attestation each Monthly Fieldwork Verification Form asks both signers to agree to (verbatim from the BACB forms). */
export const ATTESTATIONS: Readonly<Record<Edition, { id: string; statements: readonly string[] }>> = {
  '2022': { id: 'bacb-mfvf-2022-v2023-08', statements: [
    'The information contained on this form is true and correct to the best of our knowledge;',
    'The required number of supervisory contacts occurred during this month;',
    'Observation of the trainee with a client occurred during this supervisory period with a frequency appropriate for this fieldwork type;',
    'The trainee was supervised for the required amount of time for this supervisory period;',
    'We have read and understand the most recent version of the Fieldwork Requirements (BCBA/BCaBA)',
    'We are only including appropriate behavior-analytic activities in our totals listed above; and',
    'The fieldwork hours obtained during this supervisory period are otherwise compliant with the Fieldwork Requirements (BCBA/BCaBA)',
  ] },
  '2027': { id: 'bacb-mfvf-2027-v2026-06', statements: [
    'The information contained in this form is true and correct to the best of our knowledge.',
    'The trainee completed the fieldwork in compliance with all relevant fieldwork requirements, including adherence to the BACB’s ethics requirements.',
  ] },
};

/** Whether a typed signature matches the signer's name (case and spacing don't matter). */
export const signatureMatches = (typed: string, name: string) => {
  const norm = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(typed) !== '' && norm(typed) === norm(name);
};

/** BACB: the Monthly Fieldwork Verification Form must be signed by the last day of the following month (YYYY-MM-DD). */
export const signDeadline = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
};

/**
 * Projected finish from the countable hours of the last `window` full months before `current` (YYYY-MM).
 * null when there's no recent pace to project from.
 */
export function forecast(program: ProgramResult, current: string, window = 3): { minutesPerMonth: number; finishMonth: string } | null {
  const [y, m] = current.split('-').map(Number) as [number, number];
  const monthAt = (offset: number) => new Date(Date.UTC(y, m - 1 + offset, 1)).toISOString().slice(0, 7);
  const recent = new Set(Array.from({ length: window }, (_, i) => monthAt(-1 - i)));
  const minutes = program.months.filter(r => r.passed && recent.has(r.month)).reduce((n, r) => n + r.countableMinutes, 0);
  const left = program.requiredMinutes - program.countableMinutes;
  if (left <= 0) return { minutesPerMonth: Math.round(minutes / window), finishMonth: current };
  if (!minutes) return null;
  return { minutesPerMonth: Math.round(minutes / window), finishMonth: monthAt(Math.ceil((left * window) / minutes) - 1) };
}

/** Hours needed per month (from `current` through `target`, inclusive) to finish, and whether the monthly maximum allows it. */
export function planFor(program: ProgramResult, profile: Profile, current: string, target: string, rules?: RuleSet) {
  const [cy, cm] = current.split('-').map(Number) as [number, number], [ty, tm] = target.split('-').map(Number) as [number, number];
  const months = (ty - cy) * 12 + (tm - cm) + 1;
  const left = Math.max(0, program.requiredMinutes - program.countableMinutes);
  if (months < 1) return null;
  const minutesPerMonth = Math.ceil(left / months), max = targetsFor(profile, rules).rules.maxMonthlyMinutes;
  return { months, minutesPerMonth, minutesPerWeek: Math.ceil((minutesPerMonth * 12) / 52), feasible: minutesPerMonth <= max, maxMonthlyMinutes: max };
}

/** Attestation on the Final Fieldwork Verification Form (signed by the supervisor; verbatim from the BACB forms). */
export const FINAL_ATTESTATIONS: Readonly<Record<Edition, { id: string; statements: readonly string[] }>> = {
  '2022': { id: 'bacb-ffvf-2022-v2023-12', statements: [
    'Information presented on this Final Fieldwork Verification Form and the corresponding Monthly Fieldwork Verification Forms is true and correct to the best of my knowledge.',
    'The trainee completed the fieldwork under my supervision in compliance with all relevant Fieldwork Requirements (BCBA/BCaBA) including, but not limited to; the minimum number of contacts per month, required amounts of unrestricted activities, required observations each month with clients, and adherence to the BACB’s ethics requirements.',
    'I am the supervisor designated in the signed supervision contract with this trainee.',
    'I completed the 8-hour supervision training prior to the onset of fieldwork.',
  ] },
  '2027': { id: 'bacb-ffvf-2027-v2026-06', statements: [
    'Information presented on this Final Fieldwork Verification Form and the corresponding Monthly Fieldwork Verification Forms is true and correct to the best of my knowledge.',
    'The trainee completed the fieldwork in compliance with all relevant fieldwork requirements, including adherence to the BACB’s ethics requirements.',
    'I am the supervisor designated in the signed supervision contract with this trainee and have been qualified to supervise for the entirety of the fieldwork indicated on this Final Fieldwork Verification form.',
  ] },
};

export * from './importer.js';

export interface FormSignatures { traineeSignedAt?: string | Date | null; supervisorSignedAt?: string | Date | null; externalSignedOn?: string | null }
const day = (d: string | Date) => (typeof d === 'string' ? d : d.toISOString()).slice(0, 10);

/**
 * Handbook: an M-FVF "not signed by the last day of the calendar month following the month of supervision" means
 * "No hours are eligible for the month." Lost once the deadline has passed without both signatures by then
 * (in Fieldtrack, or recorded as signed outside it).
 */
export function formLost(month: string, today: string, s: FormSignatures = {}): boolean {
  const due = signDeadline(month);
  if (today <= due) return false;
  if (s.externalSignedOn) return s.externalSignedOn > due;
  return !(s.traineeSignedAt && s.supervisorSignedAt && day(s.traineeSignedAt) <= due && day(s.supervisorSignedAt) <= due);
}
