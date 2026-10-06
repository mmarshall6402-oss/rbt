import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { formatHours, ruleSetFor, type FieldworkType, type MonthResult } from '@fieldtrack/rules';
import { signOut } from '../auth';

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

const neededText = (id: string, n: number) =>
  id === 'supervision' && n === 0 ? 'No hours logged yet' : ['contacts', 'observations'].includes(id) ? `${n} more needed` : id === 'maxHours' || id === 'groupShare' ? `${hrs(n)} h over` : `${hrs(n)} h still needed`;

/** The four monthly rings + checklist, shared by trainee and supervisor views. */
export function MonthRings({ m, type }: { m: MonthResult; type: FieldworkType }) {
  const by = Object.fromEntries(m.checks.map(c => [c.id, c]));
  const s = m.summary, pct = s.totalMinutes ? (s.supervisedMinutes / s.totalMinutes) * 100 : 0;
  const rules = ruleSetFor(m.month), target = rules.supervisionPercent[type], minContacts = rules.minContacts[type];
  return (
    <>
      <Ring value={s.totalMinutes} max={20 * 60} display={hrs(s.totalMinutes)} label="Hours this month" sub={by.minHours!.ok ? (by.maxHours!.ok ? '20–130 h range' : neededText('maxHours', by.maxHours!.needed!)) : neededText('minHours', by.minHours!.needed!)} ok={by.minHours!.ok && by.maxHours!.ok} />
      <Ring value={pct} max={target} display={`${pct.toFixed(1)}%`} label={`Supervision (${target}%)`} sub={by.supervision!.ok ? `${hrs(s.supervisedMinutes)} h supervised` : neededText('supervision', by.supervision!.needed!)} ok={by.supervision!.ok} />
      <Ring value={s.contacts} max={minContacts} display={`${s.contacts}/${minContacts}`} label="Contacts" sub={by.contacts!.ok ? 'Requirement met' : neededText('contacts', by.contacts!.needed!)} ok={by.contacts!.ok} />
      <Ring value={s.observations} max={1} display={`${s.observations}`} label="Client observation" sub={by.observations!.ok ? 'Requirement met' : '1 needed'} ok={by.observations!.ok} />
    </>
  );
}

export function Checklist({ m }: { m: MonthResult }) {
  return (
    <ul className="checklist">
      {m.checks.map(c => (
        <li key={c.id} className={c.ok ? 'ok' : 'no'}>
          <span aria-hidden>{c.ok ? '✓' : '✗'}</span> {c.label}
          {!c.ok && c.needed !== undefined && <small>{neededText(c.id, c.needed)}</small>}
        </li>
      ))}
    </ul>
  );
}

/** Hours per month, single series, with the 20 h minimum as a reference line. */
export function HoursTrend({ months }: { months: MonthResult[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const data = months.slice(-12);
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
            <g key={m.month} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={pad.l + i * bw} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent" />
              {h > 0 && <path className={m.passed ? 'bar' : 'bar bar-fail'} d={`M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${base} Z`} />}
              <text x={x + w / 2} y={H - 6} className="axis" textAnchor="middle">{monthLabel(m.month, true).split(' ')[0]}</text>
            </g>
          );
        })}
      </svg>
      {hover !== null && data[hover] && (
        <div className="tooltip" style={{ left: `${((pad.l + (hover + 0.5) * bw) / W) * 100}%` }}>
          <strong>{monthLabel(data[hover]!.month)}</strong>
          <span>{hrs(data[hover]!.summary.totalMinutes)} h · {data[hover]!.passed ? '✓ counts' : '✗ does not count'}</span>
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

export function AppShell({ name, children, nav }: { name: string; nav?: ReactNode; children: ReactNode }) {
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">Fieldtrack</Link>
        {nav}
        <div className="topbar-right">
          <ThemeToggle />
          <span className="muted hide-sm">{name}</span>
          <button className="ghost" onClick={() => void signOut()}>Sign out</button>
        </div>
      </header>
      <main className="app">{children}</main>
    </>
  );
}

export const ErrorText = ({ error }: { error: unknown }) => (error ? <p className="error" role="alert">{(error as Error).message}</p> : null);
