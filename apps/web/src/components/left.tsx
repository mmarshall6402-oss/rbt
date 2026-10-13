import { useEffect, useRef } from 'react';
import { durationMinutes, formatHours, signDeadline, targetsFor, type MonthResult, type Profile, type ProgramResult } from '@fieldtrack/rules';
import type { EntryDto } from '../api';
import { currentMonth, dateLabel, hrs, monthLabel, standardLabel, time12 } from './ui';

/** Half-filled circle drawn in CSS: the ◐ glyph is missing or tiny in many system fonts. */
const Half = () => <span className="half" aria-hidden />;
const whole = (min: number) => Number(formatHours(min, 0)).toLocaleString();
type Status = 'good' | 'bad' | 'part' | 'info';
function Row({ label, value, status, note }: { label: string; value: string; status: Status; note: string }) {
  return (
    <li className="left-row">
      <span className="left-label">{label}</span>
      <span className="left-value">{value}</span>
      <span className={`pill ${status}`}>{status === 'good' ? '✓ ' : status === 'bad' ? '✗ ' : status === 'part' ? <><Half /> </> : ''}{note}</span>
    </li>
  );
}

const counts = (m: MonthResult) => m.countableMinutes > 0 && !m.lost && !m.outsideWindow;

/** Restricted vs unrestricted across the hours that count (trimmed hours assumed unrestricted, as the rules engine does). */
function split(program: ProgramResult) {
  const passing = program.months.filter(counts);
  const total = passing.reduce((n, m) => n + m.countableMinutes, 0);
  const unres = passing.reduce((n, m) => n + Math.max(0, m.summary.unrestrictedMinutes - (m.summary.totalMinutes - m.countableMinutes)), 0);
  return { unres, restricted: total - unres };
}

/** What's left: the whole program first, then the selected month's requirements, each with the exact amount remaining. */
export function HoursLeft({ program, m, profile, lost }: { program: ProgramResult; m: MonthResult; profile: Profile; lost: boolean }) {
  const t = targetsFor(profile), req = program.requiredMinutes, { unres, restricted } = split(program);
  const needUnres = Math.max(0, Math.ceil((req * t.rules.minUnrestrictedPercent) / 100) - unres);
  const roomRestricted = Math.max(0, Math.floor((req * (100 - t.rules.minUnrestrictedPercent)) / 100) - restricted);
  const totalLeft = Math.max(0, req - program.countableMinutes);
  const by = Object.fromEntries(m.checks.map(c => [c.id, c])), s = m.summary;
  const pct = s.totalMinutes ? (s.supervisedMinutes / s.totalMinutes) * 100 : 0;
  const obsMin = t.observation.unit === 'minutes';
  return (
    <section className="card left">
      <div className="left-col program">
        <h2>Toward {(req / 60).toLocaleString()} hours</h2>
        <p className="standard">{standardLabel(profile)}</p>
        <div className="left-big"><strong>{whole(totalLeft)}</strong> h left <span className="muted small">· {whole(program.countableMinutes)} counted</span></div>
        <ul className="left-list">
          <Row label="Unrestricted" value={`${whole(unres)} h`} status={unres * 100 < t.rules.minUnrestrictedPercent * (unres + restricted) ? 'bad' : needUnres ? 'part' : 'good'} note={needUnres ? `${whole(needUnres)} h left (${t.rules.minUnrestrictedPercent}% min)` : `${t.rules.minUnrestrictedPercent}% met`} />
          <Row label="Restricted" value={`${whole(restricted)} h`} status={roomRestricted ? 'info' : 'bad'} note={roomRestricted ? `${whole(roomRestricted)} h more can count` : 'at the 40% max'} />
        </ul>
      </div>
      <div className="left-col month">
        <h2>{monthLabel(m.month)}</h2>
        <p className="standard">Checked as <strong>{profile.type === 'concentrated' ? 'Concentrated' : 'Supervised'}</strong> fieldwork: {t.rules.minMonthlyMinutes / 60}–{t.rules.maxMonthlyMinutes / 60} h, {t.supervisionPerMille / 10}% supervised{t.minContacts ? `, ${t.minContacts} contacts` : ''}</p>
        {lost && <p className="pill bad block">✗ This form wasn't signed by {signDeadline(m.month)}, so per the BACB none of its hours count. Signed it elsewhere in time? Record that under Monthly sign-off.</p>}
        <ul className="left-list">
          <Row label={`Hours (${t.rules.minMonthlyMinutes / 60}–${t.rules.maxMonthlyMinutes / 60} h)`} value={`${hrs(s.totalMinutes)} of ${t.rules.maxMonthlyMinutes / 60} h`}
            status={!by.minHours?.ok || !by.maxHours?.ok ? 'bad' : s.totalMinutes >= t.rules.maxMonthlyMinutes ? 'good' : 'part'}
            note={!by.minHours?.ok ? `${hrs(by.minHours?.needed ?? 0)} h left to ${t.rules.minMonthlyMinutes / 60}` : !by.maxHours?.ok ? `${hrs(by.maxHours?.needed ?? 0)} h over max`
              : s.totalMinutes >= t.rules.maxMonthlyMinutes ? 'full' : `${hrs(t.rules.maxMonthlyMinutes - s.totalMinutes)} h left to ${t.rules.maxMonthlyMinutes / 60}`} />
          <Row label={`Supervision (${t.supervisionPerMille / 10}% min)`} value={`${hrs(s.supervisedMinutes)} h · ${pct.toFixed(1)}%`} status={by.supervision?.ok ? 'good' : 'bad'}
            note={by.supervision?.ok ? 'met' : s.totalMinutes ? `${hrs(by.supervision?.needed ?? 0)} h more` : 'none yet'} />
          {by.contacts && <Row label={`Supervisor contacts (${t.minContacts} min)`} value={`${s.contacts} of ${t.minContacts}`} status={by.contacts.ok ? 'good' : 'bad'} note={by.contacts.ok ? 'met' : `${by.contacts.needed} more`} />}
          {by.observations && <Row label="Observation" value={obsMin ? `${s.observationMinutes} of ${t.observation.min} min` : `${s.observations} of ${t.observation.min}`} status={by.observations.ok ? 'good' : 'bad'}
            note={by.observations.ok ? 'met' : `${by.observations.needed}${obsMin ? ' min' : ''} more`} />}
          {by.groupShare && !by.groupShare.ok && <Row label="Group supervision" value={`${hrs(s.groupMinutes)} h`} status="bad" note={`${hrs(by.groupShare.needed ?? 0)} h over 50%`} />}
          <Row label="Restricted" value={`${hrs(s.restrictedMinutes)} h`} status="info" note="this month" />
          <Row label="Unrestricted" value={`${hrs(s.unrestrictedMinutes)} h`} status="info" note="this month" />
        </ul>
      </div>
    </section>
  );
}

/** One chip per month: ✓ full (counts, at the monthly max), ◐ counts but under the max, ✗ doesn't count. Tap to open. */
export function MonthStrip({ program, profile, month, onPick }: { program: ProgramResult; profile: Profile; month: string; onPick: (m: string) => void }) {
  const now = currentMonth(), ref = useRef<HTMLDivElement>(null), max = targetsFor(profile).rules.maxMonthlyMinutes;
  const byMonth = new Map<string, MonthResult[]>();
  for (const m of program.months) byMonth.set(m.month, [...(byMonth.get(m.month) ?? []), m]);
  if (!byMonth.has(now)) byMonth.set(now, []);
  const months = [...byMonth.keys()].sort();
  useEffect(() => { ref.current?.scrollTo({ left: ref.current.scrollWidth }) }, [months.length]);
  return (
    <div className="stack tight">
      <nav className="month-strip" ref={ref} aria-label="Months">
        {months.map(k => {
          const forms = byMonth.get(k)!, ok = forms.length > 0 && forms.every(f => f.passed && counts(f));
          const total = Math.max(0, ...forms.map(f => f.summary.totalMinutes)), full = total >= max;
          const state = !ok ? (k === now ? 'now' : 'bad') : full ? 'good' : 'part';
          const why = !forms.length ? 'no hours yet' : ok ? (full ? 'counts · full' : `counts · ${hrs(max - total)} h left to ${max / 60}`)
            : k === now ? 'in progress' : forms.some(f => f.lost) ? 'not signed in time' : forms.some(f => counts(f)) ? 'partly counts' : "doesn't count";
          return (
            <button key={k} type="button" className={`chip ${state}${k === month ? ' on' : ''}`} aria-current={k === month ? 'true' : undefined} aria-label={`${monthLabel(k)}: ${why}`} title={why} onClick={() => onPick(k)}>
              {state === 'part' ? <Half /> : <span aria-hidden>{{ good: '✓', bad: '✗', now: '•' }[state]}</span>}{monthLabel(k, true)}<small>{whole(total)}/{max / 60}</small>
            </button>
          );
        })}
      </nav>
      <p className="muted small legend"><span className="good">✓ full ({max / 60} h)</span> <span className="part"><Half /> counts, under {max / 60} h</span> <span className="bad">✗ doesn't count</span></p>
    </div>
  );
}

export function RecentEntries({ entries }: { entries: EntryDto[] }) {
  const recent = [...entries].sort((a, b) => (b.workDate + b.startTime).localeCompare(a.workDate + a.startTime)).slice(0, 6);
  return (
    <section className="card">
      <div className="row spread"><h2>Recent entries</h2>{entries.length > 6 && <a className="small" href="#entries">All {entries.length} ↓</a>}</div>
      {!recent.length ? <p className="muted">No hours logged this month yet.</p> : (
        <ul className="recent">
          {recent.map(e => {
            const min = durationMinutes(e);
            return (
              <li key={e.id}>
                <span><strong>{dateLabel(e.workDate)}</strong> <span className="muted small">{time12(e.startTime)}–{time12(e.endTime)}{e.pending ? ' · ☁ on device' : ''}</span></span>
                <span className={`tag ${e.kind}`}>{e.kind === 'independent' ? 'Indep.' : e.isGroup ? 'Sup. group' : 'Supervised'}</span>
                <span className="muted small">R {hrs(e.restrictedMinutes)} · U {hrs(min - e.restrictedMinutes)}</span>
                <strong className="num">{hrs(min)} h</strong>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Pinned under the top bar on every scroll position: overall progress and how the open month stands. */
export function ProgressBar({ program, m }: { program: ProgramResult; m?: MonthResult }) {
  const req = program.requiredMinutes, done = Math.min(program.countableMinutes, req), pct = req ? (done / req) * 100 : 0;
  const missing = m ? m.checks.filter(c => !c.ok).length : 0;
  return (
    <div className="progress" role="group" aria-label="Overall progress">
      <div className="progress-text">
        <span><strong>{whole(done)}</strong> of {(req / 60).toLocaleString()} h · <strong>{pct.toFixed(0)}%</strong></span>
        <span className="muted">{whole(req - done)} h left</span>
        {m && <span className={`pill ${missing || m.lost ? 'bad' : 'good'}`}>{monthLabel(m.month, true)}: {m.lost ? '✗ not signed in time' : missing ? `✗ ${missing} not met` : '✓ on track'}</span>}
      </div>
      <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Hours toward the total"><div style={{ width: `${pct}%` }} /></div>
    </div>
  );
}
