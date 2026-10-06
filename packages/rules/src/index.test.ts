import { describe, expect, it } from 'vitest';
import { RULESETS, durationMinutes, evaluateMonth, evaluateProgram, findOverlaps, formatHours, ruleSetFor, supervisedMinutesNeeded, validateEntry, type Entry, type RuleSet } from './index.js';

const ind = (workDate: string, startTime: string, endTime: string, restrictedMinutes = 0): Entry =>
  ({ workDate, startTime, endTime, kind: 'independent', restrictedMinutes, isGroup: false, contact: null });
const sup = (workDate: string, startTime: string, endTime: string, o: Partial<Entry> = {}): Entry =>
  ({ workDate, startTime, endTime, kind: 'supervised', restrictedMinutes: 0, isGroup: false, contact: 'contact', ...o });
const check = (r: ReturnType<typeof evaluateMonth>, id: string) => r.checks.find(c => c.id === id)!;
const withRules = (o: Partial<RuleSet>): RuleSet[] => [{ ...RULESETS[0]!, ...o }];

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
    const r = evaluateMonth('2026-09', passingMonth(), 'concentrated');
    expect(r.passed).toBe(true);
    expect(r.countableMinutes).toBe(1200);
    expect(r.rulesVersion).toBe('bacb-2022-01');
  });

  it('fails concentrated at 9.9% supervision and says exactly how much is missing', () => {
    // 1000 total, 99 supervised = 9.9%
    const entries = [ind('2026-09-01', '00:00', '15:01'), sup('2026-09-02', '08:00', '09:39')];
    const r = evaluateMonth('2026-09', entries, 'concentrated');
    expect(check(r, 'supervision')).toMatchObject({ ok: false, needed: 2 }); // (101/1002 ≥ 10%)
  });

  it('passes at exactly 10% (no float error)', () => {
    const entries = [ind('2026-09-01', '00:00', '15:00'), sup('2026-09-02', '08:00', '09:40')];
    expect(check(evaluateMonth('2026-09', entries, 'concentrated'), 'supervision').ok).toBe(true);
  });

  it('applies 5% for supervised fieldwork', () => {
    const entries = [ind('2026-09-01', '00:00', '19:00'), sup('2026-09-02', '08:00', '09:00')]; // 60/1200 = 5%
    expect(check(evaluateMonth('2026-09', entries, 'supervised'), 'supervision').ok).toBe(true);
    expect(check(evaluateMonth('2026-09', entries, 'concentrated'), 'supervision').ok).toBe(false);
  });

  it('fails supervision on an empty month', () =>
    expect(check(evaluateMonth('2026-09', [], 'concentrated'), 'supervision').ok).toBe(false));

  it('caps group supervision at 50% of supervised time', () => {
    const half = [sup('2026-09-01', '08:00', '09:00'), sup('2026-09-02', '08:00', '09:00', { isGroup: true })];
    expect(check(evaluateMonth('2026-09', half, 'concentrated'), 'groupShare').ok).toBe(true);
    const over = [...half, sup('2026-09-03', '08:00', '08:01', { isGroup: true })];
    expect(check(evaluateMonth('2026-09', over, 'concentrated'), 'groupShare')).toMatchObject({ ok: false, needed: 1 });
  });

  it('requires 6 contacts concentrated, 4 supervised', () => {
    const four = [3, 4, 5, 6].map(d => sup(`2026-09-0${d}`, '09:00', '10:00'));
    expect(check(evaluateMonth('2026-09', four, 'concentrated'), 'contacts')).toMatchObject({ ok: false, needed: 2 });
    expect(check(evaluateMonth('2026-09', four, 'supervised'), 'contacts').ok).toBe(true);
  });

  it('counts contacts per day when configured', () => {
    const sameDay = [sup('2026-09-01', '09:00', '10:00'), sup('2026-09-01', '11:00', '12:00')];
    expect(evaluateMonth('2026-09', sameDay, 'concentrated').summary.contacts).toBe(2);
    expect(evaluateMonth('2026-09', sameDay, 'concentrated', withRules({ contactCounting: 'perDay' })).summary.contacts).toBe(1);
  });

  it('requires an observation', () => {
    const noObs = passingMonth().map(e => (e.contact === 'observation' ? { ...e, contact: 'contact' as const } : e));
    expect(check(evaluateMonth('2026-09', noObs, 'concentrated'), 'observations').ok).toBe(false);
  });

  it('fails under 20 hours', () =>
    expect(check(evaluateMonth('2026-09', passingMonth().slice(1), 'concentrated'), 'minHours')).toMatchObject({ ok: false, needed: 540 }));

  describe('over 130 hours', () => {
    const big = (m = '2026-09') => [...passingMonth(m), ...[10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].map(d => ind(`${m}-${d}`, '08:00', '17:00')),
      ...[24, 25].map(d => sup(`${m}-${d}`, '08:00', '17:00'))]; // 20 + 126 + 18 = 164h, 12.2% supervised
    it('fails the month under the default (strict) policy', () => {
      const r = evaluateMonth('2026-09', big(), 'concentrated');
      expect(r.passed).toBe(false);
      expect(r.countableMinutes).toBe(0);
    });
    it('counts up to the cap under the "cap" policy', () =>
      expect(evaluateMonth('2026-09', big(), 'concentrated', withRules({ overCapPolicy: 'cap' })).countableMinutes).toBe(7800));
  });

  it('rejects entries from another month', () =>
    expect(() => evaluateMonth('2026-09', [ind('2026-10-01', '08:00', '09:00')], 'concentrated')).toThrow(/outside/));
});

describe('rule versioning', () => {
  const sets = [...RULESETS, { ...RULESETS[0]!, version: 'future', effectiveFrom: '2027-01-01', minMonthlyMinutes: 30 * 60 }];
  it('picks the rule set in effect for the month', () => {
    expect(ruleSetFor('2026-12', sets).version).toBe('bacb-2022-01');
    expect(ruleSetFor('2027-01', sets).version).toBe('future');
  });
  it('old months keep old rules after a change', () =>
    expect(evaluateMonth('2026-09', passingMonth(), 'concentrated', sets).passed).toBe(true));
  it('throws before any rule set exists', () => expect(() => ruleSetFor('2021-12')).toThrow());
});

describe('evaluateProgram', () => {
  it('counts only passing months', () => {
    const r = evaluateProgram([...passingMonth('2026-08'), ...passingMonth('2026-09').slice(1)], 'concentrated');
    expect(r.months.map(m => m.passed)).toEqual([true, false]);
    expect(r.countableMinutes).toBe(1200);
    expect(r.requiredMinutes).toBe(1500 * 60);
    expect(r.complete).toBe(false);
  });
  it('flags unrestricted below 60%', () => {
    const heavyRestricted = passingMonth().map(e => (e.kind === 'independent' ? { ...e, restrictedMinutes: 540 } : e));
    const r = evaluateProgram(heavyRestricted, 'concentrated');
    expect(r.unrestrictedPercent).toBeCloseTo(10);
    expect(r.unrestrictedOk).toBe(false);
  });
});

describe('helpers', () => {
  it('computes supervised minutes needed exactly', () => {
    expect(supervisedMinutesNeeded(1080, 0, 10)).toBe(120); // 18h indep → 2h sup → 2/20 = 10%
    expect(supervisedMinutesNeeded(1200, 200, 10)).toBe(0);
  });
  it('finds overlapping entries on the same day only', () => {
    const a = ind('2026-09-01', '08:00', '12:00'), b = ind('2026-09-01', '11:00', '13:00'), c = ind('2026-09-01', '12:00', '13:00'), d = ind('2026-09-02', '08:00', '12:00');
    expect(findOverlaps([d, c, b, a])).toEqual([[a, b], [b, c]]);
  });
});
