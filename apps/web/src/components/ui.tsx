import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Me } from '../api';
import { Link, useSearchParams } from 'react-router-dom';
import { formatHours, signDeadline, signatureMatches, targetsFor, type MonthResult, type Profile } from '@fieldtrack/rules';
import { signOut } from '../auth';
import { wipeDevice } from '../query';
import { dismissRejected, flush, pendingOps, useSyncState } from '../sync';

export const hrs = (min: number) => formatHours(min, 2);
export const currentMonth = () => new Date().toLocaleDateString('en-CA').slice(0, 7);
export const addMonths = (m: string, n: number) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7);
};
/** Selected month lives in the URL (?month=YYYY-MM) so reloads and shared links keep it. */
export const useMonthParam = () => {
  const [params, setParams] = useSearchParams();
  const m = params.get('month');
  return [m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m) ? m : currentMonth(), (next: string) => setParams({ month: next })] as const;
};
export const monthLabel = (m: string, short = false) =>
  new Date(`${m}-15T00:00:00`).toLocaleDateString(undefined, { month: short ? 'short' : 'long', year: 'numeric' });
export const time12 = (t: string) => new Date(`2000-01-01T${t}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const dateLabel = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', weekday: 'short' });

/** Circular meter: one value against a limit. Status is carried by icon + text, never shade alone. */
export function Ring({ value, max, display, label, sub, ok }: { value: number; max: number; display: string; label: string; sub?: string; ok?: boolean }) {
  const r = 42, c = 2 * Math.PI * r, f = max > 0 ? Math.max(0, Math.min(value / max, 1)) : 0;
  const status = ok === undefined ? '' : ok ? ', met' : ', not met';
  return (
    <figure className="ring" title={`${label}: ${display}${sub ? ` — ${sub}` : ''}`}>
      <svg viewBox="0 0 100 100" role="img" aria-label={`${label}: ${display}${status}`}>
        <circle cx="50" cy="50" r={r} className="ring-track" />
        {f > 0 && <circle cx="50" cy="50" r={r} className="ring-fill" strokeDasharray={`${f * c} ${c}`} transform="rotate(-90 50 50)" />}
        <text x="50" y="50" className="ring-value">{display}</text>
      </svg>
      <figcaption>
        <span className="ring-label">{ok !== undefined && <span className={ok ? 'ok' : 'no'} aria-hidden>{ok ? '✓' : '✗'}</span>} {label}</span>
        {sub && <small>{sub}</small>}
      </figcaption>
    </figure>
  );
}

const neededText = (id: string, n: number, observationInMinutes = false) =>
  id === 'supervision' && n === 0 ? 'No hours logged yet'
  : id === 'observations' && observationInMinutes ? `${n} more minutes needed`
  : ['contacts', 'observations'].includes(id) ? `${n} more needed`
  : id === 'maxHours' || id === 'groupShare' ? `${hrs(n)} h over` : `${hrs(n)} h still needed`;

/** Monthly rings for the trainee's standard (2022: contacts + one observation; 2027: observation minutes). */
export function MonthRings({ m, profile }: { m: MonthResult; profile: Profile }) {
  const by = Object.fromEntries(m.checks.map(c => [c.id, c]));
  const t = targetsFor(profile), s = m.summary;
  const pct = s.totalMinutes ? (s.supervisedMinutes / s.totalMinutes) * 100 : 0, target = t.supervisionPerMille / 10;
  const maxH = t.rules.maxMonthlyMinutes / 60, obsMinutes = t.observation.unit === 'minutes';
  return (
    <>
      <Ring value={s.totalMinutes} max={20 * 60} display={hrs(s.totalMinutes)} label="Hours this month"
        sub={!by.minHours!.ok ? neededText('minHours', by.minHours!.needed!) : !by.maxHours!.ok ? neededText('maxHours', by.maxHours!.needed!)
          : by.maxHours!.needed ? `${hrs(by.maxHours!.needed)} h over ${maxH} won't count` : `20–${maxH} h range`}
        ok={by.minHours!.ok && by.maxHours!.ok} />
      <Ring value={pct} max={target} display={`${pct.toFixed(1)}%`} label={`Supervision (${target}%)`} sub={by.supervision!.ok ? `${hrs(s.supervisedMinutes)} h supervised` : neededText('supervision', by.supervision!.needed!)} ok={by.supervision!.ok} />
      {t.minContacts !== null && by.contacts && (
        <Ring value={s.contacts} max={t.minContacts} display={`${s.contacts}/${t.minContacts}`} label="Contacts" sub={by.contacts.ok ? 'Requirement met' : neededText('contacts', by.contacts.needed!)} ok={by.contacts.ok} />
      )}
      {obsMinutes
        ? <Ring value={s.observationMinutes} max={t.observation.min} display={`${s.observationMinutes}/${t.observation.min}`} label="Minutes observed" sub={by.observations!.ok ? 'Requirement met' : neededText('observations', by.observations!.needed!, true)} ok={by.observations!.ok} />
        : <Ring value={s.observations} max={t.observation.min} display={`${s.observations}`} label="Client observation" sub={by.observations!.ok ? 'Requirement met' : '1 needed'} ok={by.observations!.ok} />}
    </>
  );
}

/** Short description of a trainee's standard, e.g. "BCBA · Concentrated · 2027 rules". */
export const standardLabel = (p: Profile) =>
  `${(p.credential ?? 'bcba').toUpperCase()} · ${p.type === 'concentrated' ? 'Concentrated' : 'Supervised'} · ${p.edition ?? '2027'} rules`;

/** What a month that misses a requirement can still count, per the BACB's adjustment table. */
export const countableNote = (m: MonthResult) =>
  m.passed || m.lost || !m.summary.totalMinutes ? null
    : m.countableMinutes > 0 ? `If the month ends like this, ${hrs(m.countableMinutes)} of ${hrs(m.summary.totalMinutes)} h can count after the BACB's required adjustment${m.estimate ? ' (an estimate: the BACB table is written for the 2022 rules)' : ''}.`
    : m.type === 'concentrated' ? 'If the month ends like this, none of its hours count (concentrated hours can’t be adjusted).'
    : 'If the month ends like this, none of its hours count.';

export function Checklist({ m }: { m: MonthResult }) {
  const note = countableNote(m);
  return (
    <>
      <ul className="checklist">
        {m.checks.map(c => (
          <li key={c.id} className={c.ok ? 'ok' : 'no'}>
            <span aria-hidden>{c.ok ? '✓' : '✗'}</span> {c.label}
            {!c.ok && c.needed !== undefined && <small>{neededText(c.id, c.needed, c.label.includes('minutes'))}</small>}
          </li>
        ))}
      </ul>
      {note && <p className="muted small">{note}</p>}
    </>
  );
}

/** Hours per month, single series, with the 20 h minimum as a reference line. */
const counts = (m: MonthResult) => !m.lost && !m.outsideWindow && m.countableMinutes > 0;
const countsLabel = (m: MonthResult) =>
  m.lost ? '✗ lost: not signed by the deadline' : m.outsideWindow ? '✗ outside your 5-year window'
    : m.passed ? '✓ counts' : m.countableMinutes > 0 ? `${hrs(m.countableMinutes)} h count after adjustment` : '✗ does not count';

/** One bar per verification form (month × supervisor); limits apply to each form separately. */
export function HoursTrend({ months, names = {} }: { months: MonthResult[]; names?: Record<string, string> }) {
  const [hover, setHover] = useState<number | null>(null);
  const data = months.slice(-12), hv = hover === null ? undefined : data[hover];
  if (!data.length) return <p className="muted">Your monthly totals will appear here.</p>;
  const W = 600, H = 180, pad = { l: 36, r: 8, t: 12, b: 24 };
  const max = Math.max(25, ...data.map(m => m.summary.totalMinutes / 60)) * 1.1;
  const bw = Math.min((W - pad.l - pad.r) / data.length, 56), y = (h: number) => pad.t + (H - pad.t - pad.b) * (1 - h / max);
  const ticks = [0, Math.round(max / 2 / 10) * 10, Math.floor(max / 10) * 10].filter((t, i, a) => a.indexOf(t) === i);
  return (
    <div className="trend">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Hours logged per month">
        {ticks.map(t => <g key={t}><line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid" /><text x={pad.l - 6} y={y(t)} className="axis" textAnchor="end" dominantBaseline="middle">{t}</text></g>)}
        <line x1={pad.l} x2={W - pad.r} y1={y(20)} y2={y(20)} className="ref" />
        <text x={W - pad.r} y={y(20) - 4} className="axis" textAnchor="end">20 h minimum</text>
        {data.map((m, i) => {
          const h = m.summary.totalMinutes / 60, x = pad.l + i * bw + 2, w = Math.max(bw - 4, 2), top = y(h), base = y(0), r = Math.min(4, w / 2, base - top);
          return (
            <g key={`${m.month}|${m.supervisorId ?? ''}`} tabIndex={0} aria-label={`${monthLabel(m.month)}: ${hrs(m.summary.totalMinutes)} hours, ${countsLabel(m)}`}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
              <rect x={pad.l + i * bw} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent" />
              {h > 0 && <path className={counts(m) ? 'bar' : 'bar bar-fail'} d={`M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${base} Z`} />}
              <text x={x + w / 2} y={H - 6} className="axis" textAnchor="middle">{monthLabel(m.month, true).split(' ')[0]}</text>
            </g>
          );
        })}
      </svg>
      {hv && (
        <div className="tooltip" style={{ left: `${((pad.l + (hover! + 0.5) * bw) / W) * 100}%` }}>
          <strong>{monthLabel(hv.month)}{hv.supervisorId && names[hv.supervisorId] ? ` · ${names[hv.supervisorId]}` : ''}</strong>
          <span>{hrs(hv.summary.totalMinutes)} h · {countsLabel(hv)}</span>
        </div>
      )}
    </div>
  );
}

export function MonthNav({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  return (
    <div className="month-nav">
      <button className="ghost" onClick={() => onChange(addMonths(month, -1))} aria-label="Previous month">‹</button>
      <strong>{monthLabel(month)}</strong>
      <button className="ghost" onClick={() => onChange(addMonths(month, 1))} aria-label="Next month" disabled={month >= currentMonth()}>›</button>
    </div>
  );
}

export function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? '');
  const next = theme === 'dark' ? 'light' : theme === 'light' ? '' : 'dark';
  return (
    <button className="ghost" title="Theme" onClick={() => {
      if (next) document.documentElement.dataset.theme = next; else delete document.documentElement.dataset.theme;
      try { next ? localStorage.setItem('ft.theme', next) : localStorage.removeItem('ft.theme') } catch { /* ignore */ }
      setTheme(next);
    }}>{theme === 'dark' ? 'Dark' : theme === 'light' ? 'Light' : 'Auto'} theme</button>
  );
}

async function safeSignOut() {
  await flush();
  const n = pendingOps().length;
  if (n && !confirm(`${n} change(s) haven't uploaded yet and will be lost if you sign out now. Sign out anyway?`)) return;
  await wipeDevice(); // cached records can include client notes: never leave them on a shared device
  await signOut();
}

/** Cloud indicator: synced, uploading, or saved on this device while offline. */
export function SyncBadge() {
  const s = useSyncState();
  const label = s.status === 'synced' ? '✓ Synced' : s.status === 'syncing' ? '↻ Saving…' : s.status === 'offline' ? `☁ Saved on this device · ${s.pending} waiting` : `⚠ Upload paused · ${s.pending} waiting`;
  return (
    <>
      <button className={`ghost sync sync-${s.status}`} onClick={() => void flush()} title="Changes save on this device first, then upload automatically" aria-live="polite">{label}</button>
      {s.rejected.length > 0 && (
        <div className="rejected" role="alert">
          {s.rejected.map(r => <p key={r.id + r.at}>⚠ A change couldn't be saved: {r.message} <button className="ghost small" onClick={() => dismissRejected(r.id)}>Dismiss</button></p>)}
        </div>
      )}
    </>
  );
}

export function AppShell({ name, children, nav }: { name: string; nav?: ReactNode; children: ReactNode }) {
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">Fieldtrack</Link>
        {nav}
        <div className="topbar-right">
          <Link to="/help" className="muted small">Help</Link>
          <ThemeToggle />
          <span className="muted hide-sm">{name}</span>
          <button className="ghost" onClick={() => void safeSignOut()}>Sign out</button>
        </div>
      </header>
      <main className="app">{children}</main>
    </>
  );
}

export const ErrorText = ({ error }: { error: unknown }) => (error ? <p className="error" role="alert">{(error as Error).message}</p> : null);

/** Electronic signature: the form's attestation, then the signer types their own name to show intent to sign. */
export function SignForm({ statements, name, cta, busy, onSign, onCancel }: { statements: readonly string[]; name: string; cta: string; busy: boolean; onSign: (signature: string) => void; onCancel: () => void }) {
  const [typed, setTyped] = useState('');
  return (
    <form className="stack sign-form" onSubmit={e => { e.preventDefault(); onSign(typed) }}>
      <strong className="small">By signing, we attest that:</strong>
      <ul className="small attest">{statements.map(s => <li key={s}>{s}</li>)}</ul>
      <label>Type your full name to sign electronically
        <input value={typed} onChange={e => setTyped(e.target.value)} placeholder={name} autoComplete="off" autoFocus />
      </label>
      <div className="row">
        <button className="primary" disabled={busy || !signatureMatches(typed, name)}>{cta}</button>
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** BACB deadline for an unsigned month's form: hours are lost if it isn't signed by the end of the next month. */
export function Deadline({ month }: { month: string }) {
  const due = signDeadline(month), today = new Date().toLocaleDateString('en-CA');
  const days = Math.round((Date.parse(due) - Date.parse(today)) / 86_400_000);
  const label = new Date(`${due}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (days < 0) return <span className="no small">⚠ Past the BACB deadline ({label}): these hours may not count</span>;
  return <span className={days <= 7 ? 'warn small' : 'muted small'}>{days <= 7 ? `Due in ${days} day${days === 1 ? '' : 's'}` : `Sign by ${label}`}</span>;
}

/** Opt in/out of deadline reminder emails (both roles). */
export function ReminderToggle({ me }: { me: Me }) {
  const qc = useQueryClient();
  const save = useMutation({ mutationFn: (emailReminders: boolean) => api<Me>('/me', 'PATCH', { emailReminders }), onSuccess: u => qc.setQueryData(['me'], u) });
  return (
    <label className="check">
      <input type="checkbox" checked={me.emailReminders} disabled={save.isPending} onChange={e => save.mutate(e.target.checked)} />
      Email me before BACB signing deadlines
    </label>
  );
}
