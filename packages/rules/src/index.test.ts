import { describe, expect, it } from 'vitest';
import { RULESETS, durationMinutes, editionFor, evaluateForms, evaluateMonth, evaluateProgram, groupByForm, findOverlaps, forecast, formatHours, signDeadline, supervisedMinutesNeeded, targetsFor, validateEntry, type Entry, type MonthResult, type Profile, type ProgramResult, type RuleSet } from './index.js';

const ind = (workDate: string, startTime: string, endTime: string, restrictedMinutes = 0): Entry =>
  ({ workDate, startTime, endTime, kind: 'independent', restrictedMinutes, isGroup: false, contact: null });
const sup = (workDate: string, startTime: string, endTime: string, o: Partial<Entry> = {}): Entry =>
  ({ workDate, startTime, endTime, kind: 'supervised', restrictedMinutes: 0, isGroup: false, contact: 'contact', ...o });
const check = (r: ReturnType<typeof evaluateMonth>, id: string) => r.checks.find(c => c.id === id)!;
const withRules = (o: Partial<RuleSet>): RuleSet => ({ ...RULESETS['2022'], ...o });
const C22: Profile = { type: 'concentrated', edition: '2022' }, S22: Profile = { type: 'supervised', edition: '2022' };
const C27: Profile = { type: 'concentrated', edition: '2027' }, S27: Profile = { type: 'supervised', edition: '2027' };

// A month that passes every concentrated requirement: 18h independent + 6 x 20min supervised (one observation) = 20h, 10%
const passingMonth = (m = '2026-09'): Entry[] => [
  ind(`${m}-01`, '08:00', '17:00'), ind(`${m}-02`, '08:00', '17:00'),
  ...[3, 4, 5, 6, 7].map(d => sup(`${m}-0${d}`, '09:00', '09:20')),
  sup(`${m}-08`, '09:00', '09:20', { contact: 'observation' }),
];

describe('time handling', () => {
  it('computes duration in minutes', () => expect(durationMinutes({ startTime: '16:00', endTime: '20:45' })).toBe(285));
  it('rejects end before start and bad formats', () => {
    expect(() => durationMinutes({ startTime: '09:00', endTime: '09:00' })).toThrow();
    expect(() => durationMinutes({ startTime: '9:00', endTime: '10:00' })).toThrow();
    expect(() => durationMinutes({ startTime: '23:00', endTime: '24:00' })).toThrow();
  });
  it('formats like Ripley (3 decimals)', () => expect(formatHours(3987)).toBe('66.450'));
});

describe('validateEntry', () => {
  it('accepts a valid split entry', () => expect(validateEntry(ind('2026-09-01', '08:00', '10:00', 30))).toEqual([]));
  it('rejects restricted time longer than the entry', () => expect(validateEntry(ind('2026-09-01', '08:00', '09:00', 61))).toHaveLength(1));
  it('rejects fractional restricted minutes', () => expect(validateEntry(ind('2026-09-01', '08:00', '09:00', 1.5))).toHaveLength(1));
  it('rejects contact/group on independent entries', () =>
    expect(validateEntry({ ...ind('2026-09-01', '08:00', '09:00'), contact: 'contact' })).toHaveLength(1));
  it('rejects impossible dates', () => expect(validateEntry(ind('2026-13-01', '08:00', '09:00'))).toHaveLength(1));
});

describe('evaluateMonth', () => {
  it('passes a fully compliant concentrated month', () => {
    const r = evaluateMonth('2026-09', passingMonth(), C22);
    expect(r.passed).toBe(true);
    expect(r.countableMinutes).toBe(1200);
    expect(r.rulesVersion).toBe('bacb-2022');
  });

  it('fails concentrated at 9.9% supervision and says exactly how much is missing', () => {
    // 1000 total, 99 supervised = 9.9%
    const entries = [ind('2026-09-01', '00:00', '15:01'), sup('2026-09-02', '08:00', '09:39')];
    const r = evaluateMonth('2026-09', entries, C22);
    expect(check(r, 'supervision')).toMatchObject({ ok: false, needed: 2 }); // (101/1002 ≥ 10%)
  });

  it('passes at exactly 10% (no float error)', () => {
    const entries = [ind('2026-09-01', '00:00', '15:00'), sup('2026-09-02', '08:00', '09:40')];
    expect(check(evaluateMonth('2026-09', entries, C22), 'supervision').ok).toBe(true);
  });

  it('applies 5% for supervised fieldwork', () => {
    const entries = [ind('2026-09-01', '00:00', '19:00'), sup('2026-09-02', '08:00', '09:00')]; // 60/1200 = 5%
    expect(check(evaluateMonth('2026-09', entries, S22), 'supervision').ok).toBe(true);
    expect(check(evaluateMonth('2026-09', entries, C22), 'supervision').ok).toBe(false);
  });

  it('fails supervision on an empty month', () =>
    expect(check(evaluateMonth('2026-09', [], C22), 'supervision').ok).toBe(false));

  it('caps group supervision at 50% of supervised time', () => {
    const half = [sup('2026-09-01', '08:00', '09:00'), sup('2026-09-02', '08:00', '09:00', { isGroup: true })];
    expect(check(evaluateMonth('2026-09', half, C22), 'groupShare').ok).toBe(true);
    const over = [...half, sup('2026-09-03', '08:00', '08:01', { isGroup: true })];
    expect(check(evaluateMonth('2026-09', over, C22), 'groupShare')).toMatchObject({ ok: false, needed: 1 });
  });

  it('requires 6 contacts concentrated, 4 supervised', () => {
    const four = [3, 4, 5, 6].map(d => sup(`2026-09-0${d}`, '09:00', '10:00'));
    expect(check(evaluateMonth('2026-09', four, C22), 'contacts')).toMatchObject({ ok: false, needed: 2 });
    expect(check(evaluateMonth('2026-09', four, S22), 'contacts').ok).toBe(true);
  });

  it('counts contacts per day when configured', () => {
    const sameDay = [sup('2026-09-01', '09:00', '10:00'), sup('2026-09-01', '11:00', '12:00')];
    expect(evaluateMonth('2026-09', sameDay, C22).summary.contacts).toBe(2);
    expect(evaluateMonth('2026-09', sameDay, C22, withRules({ contactCounting: 'perDay' })).summary.contacts).toBe(1);
  });

  it('requires an observation', () => {
    const noObs = passingMonth().map(e => (e.contact === 'observation' ? { ...e, contact: 'contact' as const } : e));
    expect(check(evaluateMonth('2026-09', noObs, C22), 'observations').ok).toBe(false);
  });

  it('fails under 20 hours', () =>
    expect(check(evaluateMonth('2026-09', passingMonth().slice(1), C22), 'minHours')).toMatchObject({ ok: false, needed: 540 }));

  describe('over 130 hours', () => {
    const big = (m = '2026-09') => [...passingMonth(m), ...[10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].map(d => ind(`${m}-${d}`, '08:00', '17:00')),
      ...[24, 25].map(d => sup(`${m}-${d}`, '08:00', '17:00'))]; // 20 + 126 + 18 = 164h, 12.2% supervised
    it('fails the month under the default (strict) policy', () => {
      const r = evaluateMonth('2026-09', big(), C22);
      expect(r.passed).toBe(false);
      expect(r.countableMinutes).toBe(0);
    });
    it('counts up to the cap under the "cap" policy', () =>
      expect(evaluateMonth('2026-09', big(), C22, withRules({ overCapPolicy: 'cap' })).countableMinutes).toBe(7800));
  });

  it('rejects entries from another month', () =>
    expect(() => evaluateMonth('2026-09', [ind('2026-10-01', '08:00', '09:00')], C22)).toThrow(/outside/));
});

describe('2027 standard', () => {
  // 18.5 h independent + 90 min supervised observation = 20 h, exactly 7.5% supervised
  const month27 = (m = '2027-02'): Entry[] => [ind(`${m}-01`, '08:00', '17:00'), ind(`${m}-02`, '08:00', '17:30'), sup(`${m}-03`, '09:00', '10:30', { contact: 'observation' })];

  it('passes a compliant concentrated month with no supervisor contacts required', () => {
    const r = evaluateMonth('2027-02', month27(), C27);
    expect(r.passed).toBe(true);
    expect(r.rulesVersion).toBe('bacb-2027');
    expect(r.checks.map(c => c.id)).not.toContain('contacts');
  });

  it('uses 7.5% for concentrated BCBA, exactly (per-mille math, no float error)', () => {
    const exact = [ind('2027-02-01', '00:00', '15:25'), sup('2027-02-02', '08:00', '09:15')]; // 75 / 1000
    expect(check(evaluateMonth('2027-02', exact, C27), 'supervision')).toMatchObject({ ok: true, label: 'Minimum 7.5% supervision' });
    const short = [ind('2027-02-01', '00:00', '15:26'), sup('2027-02-02', '08:00', '09:14')]; // 74 / 1000
    expect(check(evaluateMonth('2027-02', short, C27), 'supervision')).toMatchObject({ ok: false, needed: 2 }); // 76 / 1002 >= 7.5%
  });

  it('measures observation in minutes: 90 concentrated, 60 supervised', () => {
    const obs = (min: number) => [ind('2027-02-01', '00:00', '20:00'), sup('2027-02-02', '09:00', `${String(9 + Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`, { contact: 'observation' })];
    expect(check(evaluateMonth('2027-02', obs(89), C27), 'observations')).toMatchObject({ ok: false, needed: 1, label: 'Minimum 90 minutes observed with client' });
    expect(check(evaluateMonth('2027-02', obs(90), C27), 'observations').ok).toBe(true);
    expect(check(evaluateMonth('2027-02', obs(60), S27), 'observations').ok).toBe(true);
    expect(evaluateMonth('2027-02', obs(75), C27).summary.observationMinutes).toBe(75);
  });

  it('a month over 160 hours does not count (same rule wording as 2022)', () => {
    const big = [...month27(), ...Array.from({ length: 16 }, (_, i) => ind(`2027-02-${String(i + 10).padStart(2, '0')}`, '08:00', '17:00')),
      ...[26, 27].map(d => sup(`2027-02-${d}`, '06:00', '20:00'))]; // 20 + 144 + 28 = 192 h, 15.4% supervised
    const r = evaluateMonth('2027-02', big, C27);
    expect(r.passed).toBe(false);
    expect(check(r, 'maxHours')).toMatchObject({ ok: false, label: 'Maximum 160 hours', needed: 32 * 60 });
  });

  it('applies BCaBA hours and supervision', () => {
    expect(targetsFor({ type: 'concentrated', credential: 'bcaba', edition: '2027' })).toMatchObject({ supervisionPerMille: 100, requiredMinutes: 800 * 60 });
    expect(targetsFor({ type: 'concentrated', credential: 'bcaba', edition: '2022' }).requiredMinutes).toBe(1000 * 60);
    expect(targetsFor({ type: 'supervised', credential: 'bcaba', edition: '2027' }).requiredMinutes).toBe(1300 * 60);
    expect(targetsFor(C27)).toMatchObject({ supervisionPerMille: 75, requiredMinutes: 1500 * 60, minContacts: null });
  });

  it('picks the edition by application date, not by when hours were worked', () => {
    expect(editionFor('2026-12-31')).toBe('2022');
    expect(editionFor('2027-01-01')).toBe('2027');
    // Same 2026 month evaluates differently depending on the trainee's standard
    expect(evaluateMonth('2026-09', passingMonth(), C22).passed).toBe(true);
    expect(evaluateMonth('2026-09', passingMonth(), C27).passed).toBe(false); // 20 observed minutes < 90
  });

  it('defaults to the 2027 standard and BCBA', () => expect(targetsFor({ type: 'concentrated' })).toMatchObject({ credential: 'bcba', supervisionPerMille: 75 }));
});

describe('evaluateProgram', () => {
  it('counts only passing months', () => {
    const r = evaluateProgram([...passingMonth('2026-08'), ...passingMonth('2026-09').slice(1)], C22);
    expect(r.months.map(m => m.passed)).toEqual([true, false]);
    expect(r.countableMinutes).toBe(1200);
    expect(r.requiredMinutes).toBe(1500 * 60);
    expect(r.complete).toBe(false);
  });
  it('flags unrestricted below 60%', () => {
    const heavyRestricted = passingMonth().map(e => (e.kind === 'independent' ? { ...e, restrictedMinutes: 540 } : e));
    const r = evaluateProgram(heavyRestricted, C22);
    expect(r.unrestrictedPercent).toBeCloseTo(10);
    expect(r.unrestrictedOk).toBe(false);
  });
});

describe('per verification form (one per supervisor per month)', () => {
  const tag = (list: Entry[], supervisorId: string) => list.map(e => ({ ...e, supervisorId }));
  it('evaluates each supervisor separately: a passing form and a failing form in the same month', () => {
    const entries = [...tag(passingMonth(), 'sup-a'), ...tag([ind('2026-09-20', '08:00', '12:00')], 'sup-b')];
    const forms = evaluateForms(entries, C22);
    expect(forms.map(f => [f.supervisorId, f.passed])).toEqual([['sup-a', true], ['sup-b', false]]);
    // Combined, the month would look fine; per form, only supervisor A's hours count.
    expect(evaluateProgram(entries, C22).countableMinutes).toBe(1200);
  });
  it('groups by month and supervisor', () => {
    const groups = groupByForm([...tag([ind('2026-09-01', '08:00', '09:00')], 'b'), ...tag([ind('2026-09-02', '08:00', '09:00')], 'a'), ...tag([ind('2026-10-01', '08:00', '09:00')], 'a')]);
    expect(groups.map(g => `${g.month}/${g.supervisorId}`)).toEqual(['2026-09/a', '2026-09/b', '2026-10/a']);
  });
});

describe('helpers', () => {
  it('computes supervised minutes needed exactly', () => {
    expect(supervisedMinutesNeeded(1080, 0, 100)).toBe(120); // 18h indep → 2h sup → 2/20 = 10%
    expect(supervisedMinutesNeeded(1200, 200, 100)).toBe(0);
    expect(supervisedMinutesNeeded(1000, 74, 75)).toBe(2); // 7.5%
  });
  it('finds overlapping entries on the same day only', () => {
    const a = ind('2026-09-01', '08:00', '12:00'), b = ind('2026-09-01', '11:00', '13:00'), c = ind('2026-09-01', '12:00', '13:00'), d = ind('2026-09-02', '08:00', '12:00');
    expect(findOverlaps([d, c, b, a])).toEqual([[a, b], [b, c]]);
  });
});

describe('signDeadline', () => {
  it('is the last day of the following month', () => {
    expect(signDeadline('2026-09')).toBe('2026-10-31');
    expect(signDeadline('2026-12')).toBe('2027-01-31');
    expect(signDeadline('2028-01')).toBe('2028-02-29');
  });
});

describe('forecast', () => {
  const month = (m: string, h: number, passed = true) => ({ month: m, passed, countableMinutes: passed ? h * 60 : 0 }) as MonthResult;
  const prog = (months: MonthResult[], doneHours: number) => ({ months, countableMinutes: doneHours * 60, requiredMinutes: 1500 * 60 }) as ProgramResult;
  it('projects from the last three full months, ignoring the current one and failed months', () => {
    const p = prog([month('2026-07', 100), month('2026-08', 100, false), month('2026-09', 200), month('2026-10', 999)], 1200);
    // 300 h over 3 months = 100 h/month; 300 h left -> 3 months: Oct, Nov, Dec
    expect(forecast(p, '2026-10')).toEqual({ minutesPerMonth: 6000, finishMonth: '2026-12' });
  });
  it('is null with no recent pace, and the current month once complete', () => {
    expect(forecast(prog([month('2025-01', 100)], 100), '2026-10')).toBeNull();
    expect(forecast(prog([], 1500), '2026-10')?.finishMonth).toBe('2026-10');
  });
});
