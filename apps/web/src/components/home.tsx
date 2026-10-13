import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { durationMinutes, targetsFor, type MonthResult, type Profile } from '@fieldtrack/rules';
import { api, type EntryDto, type Me } from '../api';
import { ErrorText, hrs, monthLabel } from './ui';

const QUOTES = ['Small steps make big progress.', 'Progress is the result of consistent action.', 'Same purpose, bigger impact.', 'Document today, build tomorrow.', 'Every hour counts toward the analyst you’re becoming.'];

export function Greeting({ me }: { me: Me }) {
  const h = new Date().getHours(), first = me.fullName.trim().split(/\s+/)[0];
  const quote = QUOTES[Math.floor(Date.now() / 86_400_000) % QUOTES.length]; // one quote per day
  return (
    <section className="greeting">
      <h1>Good {h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'}, {first}</h1>
      <p className="quote">“{quote}”</p>
    </section>
  );
}

/** One month's totals across every supervisor's form. */
const totals = (forms: MonthResult[]) => forms.reduce((t, f) => ({
  total: t.total + f.summary.totalMinutes, unres: t.unres + f.summary.unrestrictedMinutes,
  restr: t.restr + f.summary.restrictedMinutes, sup: t.sup + f.summary.supervisedMinutes,
}), { total: 0, unres: 0, restr: 0, sup: 0 });

function Tile({ label, value, goal, kind, note }: { label: string; value: number; goal: number; kind: string; note?: string }) {
  const pct = goal ? Math.min(100, (value / goal) * 100) : 0;
  return (
    <div className={`tile ${kind}`}>
      <span className="tile-label">{label}</span>
      <span className="tile-value"><strong>{hrs(value)}</strong> / {hrs(goal)} h</span>
      <span className="tile-track" aria-hidden><span style={{ width: `${pct}%` }} /></span>
      {note && <span className="muted small">{note}</span>}
    </div>
  );
}

/** Her own monthly goal (default: the BACB monthly max), split the way the BACB weighs hours. */
export function GoalCard({ me, forms, month, profile }: { me: Me; forms: MonthResult[]; month: string; profile: Profile }) {
  const t = targetsFor(profile), goal = me.monthlyGoalMinutes ?? t.rules.maxMonthlyMinutes, v = totals(forms);
  const unresGoal = Math.ceil((goal * t.rules.minUnrestrictedPercent) / 100), supGoal = Math.ceil((goal * t.supervisionPerMille) / 1000);
  const pct = Math.min(100, (v.total / goal) * 100), r = 52, c = 2 * Math.PI * r;
  const qc = useQueryClient(), [editing, setEditing] = useState(false), [hours, setHours] = useState(String(goal / 60));
  const save = useMutation({
    mutationFn: (minutes: number | null) => api<Me>('/me', 'PATCH', { monthlyGoalMinutes: minutes }),
    onSuccess: u => { qc.setQueryData(['me'], u); setEditing(false) },
  });
  const max = t.rules.maxMonthlyMinutes / 60, min = t.rules.minMonthlyMinutes / 60;
  return (
    <section className="card goal">
      <div className="goal-ring">
        <svg viewBox="0 0 120 120" role="img" aria-label={`${pct.toFixed(0)}% of your ${hrs(goal)} hour goal for ${monthLabel(month)}`}>
          <circle cx="60" cy="60" r={r} className="ring-track" />
          <circle cx="60" cy="60" r={r} className="ring-fill" strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 60 60)" />
          <text x="60" y="58" textAnchor="middle" className="ring-pct">{pct.toFixed(0)}%</text>
          <text x="60" y="76" textAnchor="middle" className="ring-sub">of goal</text>
        </svg>
        <p className="small"><strong>{hrs(v.total)}</strong> of {hrs(goal)} h · {monthLabel(month, true)}</p>
        {editing ? (
          <form className="row goal-edit" onSubmit={e => { e.preventDefault(); save.mutate(Math.round(Number(hours) * 60)) }}>
            <label>Monthly goal (h)<input type="number" min={min} max={max} step="1" value={hours} onChange={e => setHours(e.target.value)} required autoFocus /></label>
            <button className="small primary" disabled={save.isPending}>Save</button>
            <button type="button" className="small ghost" onClick={() => setEditing(false)}>Cancel</button>
          </form>
        ) : <button className="ghost small" onClick={() => { setHours(String(goal / 60)); setEditing(true) }}>{me.monthlyGoalMinutes ? 'Change goal' : 'Set your goal'}</button>}
        <ErrorText error={save.error} />
      </div>
      <div className="tiles">
        <Tile label="Total" value={v.total} goal={goal} kind="total" />
        <Tile label="Unrestricted" value={v.unres} goal={unresGoal} kind="unres" note={`${t.rules.minUnrestrictedPercent}% of your goal`} />
        <Tile label="Restricted" value={v.restr} goal={goal - unresGoal} kind="restr" note="at most the rest" />
        <Tile label="Supervision" value={v.sup} goal={supGoal} kind="sup" note={`${t.supervisionPerMille / 10}% of your goal`} />
      </div>
    </section>
  );
}

/** This month by hour type (part of whole) and by week (change over time). Values are labeled; colors follow the type. */
export function Reports({ entries, month }: { entries: EntryDto[]; month: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [y0, m0] = month.split('-').map(Number) as [number, number];
  const first = new Date(y0, m0 - 1, 1).getDay(), used = Array<number>(Math.ceil((first + new Date(y0, m0, 0).getDate()) / 7)).fill(0); // calendar weeks, Sunday first
  let unres = 0, restr = 0, sup = 0;
  for (const e of entries) {
    const m = durationMinutes(e);
    unres += m - e.restrictedMinutes; restr += e.restrictedMinutes; if (e.kind === 'supervised') sup += m;
    used[Math.floor((Number(e.workDate.slice(8, 10)) - 1 + first) / 7)]! += m;
  }
  const total = unres + restr;
  if (!total) return <section className="card" id="reports"><h2>Reports</h2><p className="muted">Your charts appear once you log hours this month.</p></section>;
  const R = 54, C = 2 * Math.PI * R, gap = 2, uLen = (unres / total) * C;
  const W = 420, H = 180, pad = { l: 28, r: 6, t: 18, b: 22 }, top = Math.ceil(Math.max(10, ...used.map(m => m / 60)) / 5) * 5;
  const bw = (W - pad.l - pad.r) / used.length, y = (h: number) => pad.t + (H - pad.t - pad.b) * (1 - h / top), peak = Math.max(...used);
  const pctOf = (n: number) => `${Math.round((n / total) * 100)}%`;
  return (
    <section className="card" id="reports">
      <h2>Reports · {monthLabel(month)}</h2>
      <div className="reports">
        <figure className="donut">
          <svg viewBox="0 0 140 140" role="img" aria-label={`Unrestricted ${hrs(unres)} hours, restricted ${hrs(restr)} hours`}>
            <circle cx="70" cy="70" r={R} className="seg-unres" strokeDasharray={`${Math.max(0, uLen - gap)} ${C}`} transform="rotate(-90 70 70)" />
            <circle cx="70" cy="70" r={R} className="seg-restr" strokeDasharray={`${Math.max(0, C - uLen - gap)} ${C}`} transform={`rotate(${-90 + (uLen / C) * 360} 70 70)`} />
            <text x="70" y="68" textAnchor="middle" className="donut-total">{hrs(total)}</text>
            <text x="70" y="86" textAnchor="middle" className="ring-sub">total h</text>
          </svg>
          <ul className="legend-list">
            <li><span className="key unres" />Unrestricted <strong>{hrs(unres)} h</strong> <span className="muted">{pctOf(unres)}</span></li>
            <li><span className="key restr" />Restricted <strong>{hrs(restr)} h</strong> <span className="muted">{pctOf(restr)}</span></li>
            <li><span className="key sup" />Supervised <strong>{hrs(sup)} h</strong> <span className="muted">{pctOf(sup)} of total</span></li>
          </ul>
        </figure>
        <figure className="weekly">
          <figcaption className="small muted">Hours by week</figcaption>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Hours logged each week this month">
            {[0, top / 2, top].map(t => <g key={t}><line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid" /><text x={pad.l - 6} y={y(t)} className="axis" textAnchor="end" dominantBaseline="middle">{t}</text></g>)}
            {used.map((m, i) => {
              const h = m / 60, x = pad.l + i * bw + 6, w = bw - 12, t = y(h), b = y(0), rr = Math.min(4, w / 2, b - t);
              return (
                <g key={i} tabIndex={0} aria-label={`Week ${i + 1}: ${hrs(m)} hours`} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
                  <rect x={pad.l + i * bw} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent" />
                  {h > 0 && <path className={hover === i ? 'wbar on' : 'wbar'} d={`M${x},${b} V${t + rr} Q${x},${t} ${x + rr},${t} H${x + w - rr} Q${x + w},${t} ${x + w},${t + rr} V${b} Z`} />}
                  {(hover === i || m === peak) && h > 0 && <text x={x + w / 2} y={t - 5} textAnchor="middle" className="axis strong">{hrs(m)}</text>}
                  <text x={x + w / 2} y={H - 6} textAnchor="middle" className="axis">W{i + 1}</text>
                </g>
              );
            })}
          </svg>
        </figure>
      </div>
    </section>
  );
}

/** Phone navigation: jumps to the main sections of the one-page dashboard. */
export function TabBar() {
  const go = (id: string) => () => {
    const el = document.getElementById(id);
    if (el instanceof HTMLDetailsElement) el.open = true;
    (id === 'top' ? window.scrollTo({ top: 0, behavior: 'smooth' }) : el?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  return (
    <nav className="tabbar" aria-label="Sections">
      <button type="button" onClick={go('top')}><span aria-hidden>⌂</span>Home</button>
      <button type="button" className="tab-add" onClick={go('log')}><span aria-hidden>+</span>Add hours</button>
      <button type="button" onClick={go('reports')}><span aria-hidden>▤</span>Reports</button>
      <button type="button" onClick={go('more')}><span aria-hidden>☰</span>More</button>
    </nav>
  );
}
