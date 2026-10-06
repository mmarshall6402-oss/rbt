import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { durationMinutes, evaluateMonth, validateEntry, type FieldworkType } from '@fieldtrack/rules';
import { api, useEntries, useMonth, useProgress, useSupervisors, useVerifications, type EntryDto, type EntryInput, type Me, type Supervisor } from '../api';
import { AppShell, Checklist, ErrorText, HoursTrend, MonthNav, MonthRings, Ring, currentMonth, dateLabel, hrs, monthLabel, time12, useMonthParam } from '../components/ui';

const today = () => new Date().toLocaleDateString('en-CA');
type Draft = Omit<EntryInput, 'restrictedMinutes'> & { restrictedHours: string };
const blank = (supervisorId = '', workDate = today()): Draft =>
  ({ supervisorId, workDate, startTime: '', endTime: '', kind: 'independent', restrictedHours: '0', isGroup: false, contact: null, format: null, description: '' });
const toInput = ({ restrictedHours, ...d }: Draft): EntryInput => ({
  ...d, restrictedMinutes: Math.round((Number(restrictedHours) || 0) * 60),
  ...(d.kind === 'independent' ? { isGroup: false, contact: null, format: null } : { format: d.format ?? 'in_person' }),
});

export function TraineeDashboard({ me }: { me: Me }) {
  const [month, setMonth] = useMonthParam();
  const type = me.fieldworkType as FieldworkType;
  const supervisors = useSupervisors(), entries = useEntries(month), result = useMonth(month), progress = useProgress();
  const [editing, setEditing] = useState<EntryDto | null>(null);

  return (
    <AppShell name={me.fullName} nav={<MonthNav month={month} onChange={setMonth} />}>
      {supervisors.data?.length === 0 && <LinkSupervisor first />}

      <section className="rings-row">
        {progress.data && (
          <>
            <Ring value={progress.data.countableMinutes} max={progress.data.requiredMinutes} display={`${Math.floor(progress.data.countableMinutes / 60)}`}
              label={`of ${progress.data.requiredMinutes / 60} hours`} sub="Countable total" />
            <Ring value={progress.data.unrestrictedPercent} max={60} display={`${progress.data.unrestrictedPercent.toFixed(0)}%`}
              label="Unrestricted (60%)" sub="Across counted months" ok={progress.data.countableMinutes ? progress.data.unrestrictedOk : undefined} />
          </>
        )}
        {result.data && <MonthRings m={result.data} type={type} />}
      </section>

      <div className="cols">
        <section className="card">
          <h2>{editing ? 'Edit entry' : 'Log hours'}</h2>
          {supervisors.data && supervisors.data.length > 0
            ? <EntryForm key={editing?.id ?? `new-${month}`} month={month} type={type} supervisors={supervisors.data} entries={entries.data ?? []} editing={editing} onDone={() => setEditing(null)} />
            : <p className="muted">Link a supervisor to start logging.</p>}
        </section>
        <div className="stack">
          <section className="card">
            <h2>{monthLabel(month)} requirements</h2>
            {result.data ? <Checklist m={result.data} /> : <ErrorText error={result.error} />}
          </section>
          {supervisors.data && supervisors.data.length > 0 && <SignOff month={month} supervisors={supervisors.data} />}
        </div>
      </div>

      <section className="card">
        <h2>Entries</h2>
        <EntriesTable entries={entries.data ?? []} supervisors={supervisors.data ?? []} onEdit={e => { setEditing(e); scrollTo({ top: 0, behavior: 'smooth' }) }} editable />
      </section>

      <div className="cols">
        <section className="card"><h2>Hours by month</h2><HoursTrend months={progress.data?.months ?? []} /></section>
        <section className="card">
          <h2>Supervisors</h2>
          <ul className="people">{supervisors.data?.map(s => <li key={s.id}><strong>{s.fullName}</strong><span className="muted small">since {s.startsOn}{s.endsOn ? ` · until ${s.endsOn}` : ''}</span></li>)}</ul>
          <LinkSupervisor />
        </section>
      </div>
    </AppShell>
  );
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => Promise.all(['entries', 'month', 'progress', 'verifications', 'supervisors'].map(k => qc.invalidateQueries({ queryKey: [k] })));
}

function LinkSupervisor({ first = false }: { first?: boolean }) {
  const [code, setCode] = useState(''), [startsOn, setStartsOn] = useState(today());
  const invalidate = useInvalidate();
  const link = useMutation({ mutationFn: () => api('/supervisions', 'POST', { inviteCode: code, startsOn }), onSuccess: () => { setCode(''); void invalidate() } });
  return (
    <form className={first ? 'card highlight stack' : 'stack link-form'} onSubmit={(e: FormEvent) => { e.preventDefault(); link.mutate() }}>
      {first && <><h2>Link your supervisor</h2><p className="muted">Ask your BCBA for their 8-character invite code. They'll only see hours you log under them.</p></>}
      <div className="row">
        <label>Invite code<input value={code} onChange={e => setCode(e.target.value.toUpperCase())} maxLength={8} required placeholder="ABCD2345" className="mono" /></label>
        <label>Supervising since<input type="date" value={startsOn} onChange={e => setStartsOn(e.target.value)} max={today()} required /></label>
      </div>
      <button className={first ? 'primary' : ''} disabled={link.isPending}>Add supervisor</button>
      <ErrorText error={link.error} />
    </form>
  );
}

function EntryForm({ month, type, supervisors, entries, editing, onDone }: { month: string; type: FieldworkType; supervisors: Supervisor[]; entries: EntryDto[]; editing: EntryDto | null; onDone: () => void }) {
  const [d, setD] = useState<Draft>(() => editing ? { ...editing, restrictedHours: String(editing.restrictedMinutes / 60) } : blank(supervisors[0]?.id, month === currentMonth() ? today() : `${month}-01`));
  const [warnings, setWarnings] = useState<string[]>([]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD(p => ({ ...p, [k]: v }));
  const invalidate = useInvalidate();
  const input = toInput(d);

  // Live checks with the same rules the server enforces.
  const ready = d.startTime && d.endTime;
  const problems = ready ? validateEntry(input) : [];
  const preview = ready && !problems.length && input.workDate.startsWith(month)
    ? evaluateMonth(month, [...entries.filter(e => e.id !== editing?.id), input], type).summary : null;

  const save = useMutation({
    mutationFn: () => editing ? api<{ warnings: string[] }>(`/entries/${editing.id}`, 'PATCH', input) : api<{ warnings: string[] }>('/entries', 'POST', input),
    onSuccess: res => { setWarnings(res.warnings); void invalidate(); if (editing) onDone(); else setD(blank(d.supervisorId, d.workDate)) },
  });

  return (
    <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate() }}>
      <div className="row">
        <label>Date<input type="date" value={d.workDate} max={today()} onChange={e => set('workDate', e.target.value)} required /></label>
        <label>Start<input type="time" value={d.startTime} onChange={e => set('startTime', e.target.value)} required /></label>
        <label>End<input type="time" value={d.endTime} onChange={e => set('endTime', e.target.value)} required /></label>
      </div>
      <label>Supervisor
        <select value={d.supervisorId} onChange={e => set('supervisorId', e.target.value)} required>
          {supervisors.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
        </select>
      </label>
      <div className="seg" role="radiogroup" aria-label="Hour type">
        {(['independent', 'supervised'] as const).map(k => (
          <button type="button" key={k} role="radio" aria-checked={d.kind === k} className={d.kind === k ? 'on' : ''} onClick={() => set('kind', k)}>
            {k === 'independent' ? 'Independent' : 'Supervised'}<small>{k === 'independent' ? 'BCBA not present' : 'BCBA present'}</small>
          </button>
        ))}
      </div>
      <div className="row">
        <label>Restricted hours<input type="number" min="0" step="0.05" value={d.restrictedHours} onChange={e => set('restrictedHours', e.target.value)} /></label>
        {ready && !problems.length && <p className="muted small self-end">{hrs(durationMinutes(input))} h total · {hrs(durationMinutes(input) - input.restrictedMinutes)} h unrestricted</p>}
      </div>
      {d.kind === 'supervised' && (
        <div className="row">
          <label>Supervision<select value={d.isGroup ? 'group' : 'individual'} onChange={e => set('isGroup', e.target.value === 'group')}><option value="individual">Individual</option><option value="group">Group</option></select></label>
          <label>Contact type<select value={d.contact ?? ''} onChange={e => set('contact', (e.target.value || null) as Draft['contact'])}><option value="">None</option><option value="contact">Contact</option><option value="observation">Observation with client</option></select></label>
          <label>Format<select value={d.format ?? 'in_person'} onChange={e => set('format', e.target.value as Draft['format'])}><option value="in_person">In person</option><option value="online">Online</option></select></label>
        </div>
      )}
      <label>Description of activity<textarea value={d.description} onChange={e => set('description', e.target.value)} maxLength={5000} rows={3} /></label>
      <p className="muted small">Use client initials only — never full names.</p>
      {problems.map(p => <p key={p} className="error">{p}</p>)}
      {preview && <p className="notice">With this entry: <strong>{hrs(preview.totalMinutes)} h</strong> this month · <strong>{(preview.supervisedMinutes / preview.totalMinutes * 100).toFixed(1)}%</strong> supervised · {preview.contacts} contacts</p>}
      <div className="row">
        <button className="primary" disabled={save.isPending || problems.length > 0}>{editing ? 'Save changes' : 'Save entry'}</button>
        {editing && <button type="button" className="ghost" onClick={onDone}>Cancel</button>}
      </div>
      <ErrorText error={save.error} />
      {warnings.map(w => <p key={w} className="notice">⚠ {w}</p>)}
    </form>
  );
}

export function EntriesTable({ entries, supervisors, onEdit, editable = false }: { entries: EntryDto[]; supervisors: { id: string; fullName: string }[]; onEdit?: (e: EntryDto) => void; editable?: boolean }) {
  const invalidate = useInvalidate();
  const del = useMutation({ mutationFn: (id: string) => api(`/entries/${id}`, 'DELETE'), onSuccess: () => void invalidate() });
  const name = (id: string) => supervisors.find(s => s.id === id)?.fullName ?? '—';
  if (!entries.length) return <p className="muted">No hours logged this month.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Time</th><th>Type</th><th className="num">Restr.</th><th className="num">Unrestr.</th><th>Contact</th>{editable && <th>Supervisor</th>}<th className="num">Hours</th>{editable && <th />}</tr></thead>
        <tbody>
          {entries.map(e => {
            const total = durationMinutes(e);
            return [
              <tr key={e.id} className={e.description ? 'has-desc' : ''}>
                <td>{dateLabel(e.workDate)}</td>
                <td>{time12(e.startTime)}–{time12(e.endTime)}</td>
                <td><span className={`tag ${e.kind}`}>{e.kind === 'independent' ? 'Independent' : e.isGroup ? 'Supervised · group' : 'Supervised'}</span></td>
                <td className="num">{hrs(e.restrictedMinutes)}</td>
                <td className="num">{hrs(total - e.restrictedMinutes)}</td>
                <td>{e.contact === 'observation' ? 'Observation' : e.contact === 'contact' ? 'Contact' : ''}{e.format ? <span className="muted small"> · {e.format === 'online' ? 'Online' : 'In person'}</span> : null}</td>
                {editable && <td>{name(e.supervisorId)}</td>}
                <td className="num"><strong>{hrs(total)}</strong></td>
                {editable && <td className="actions-cell">
                  <button className="ghost small" onClick={() => onEdit?.(e)}>Edit</button>
                  <button className="ghost small" onClick={() => confirm('Delete this entry?') && del.mutate(e.id)}>Delete</button>
                </td>}
              </tr>,
              e.description && <tr key={`${e.id}-d`} className="desc"><td colSpan={editable ? 9 : 7}>{e.description}</td></tr>,
            ];
          })}
        </tbody>
      </table>
      <ErrorText error={del.error} />
    </div>
  );
}

function SignOff({ month, supervisors }: { month: string; supervisors: Supervisor[] }) {
  const verifications = useVerifications(month), invalidate = useInvalidate();
  const sign = useMutation({ mutationFn: (supervisorId: string) => api(`/verifications/${month}/sign`, 'POST', { supervisorId }), onSuccess: () => void invalidate() });
  return (
    <section className="card">
      <h2>Monthly sign-off</h2>
      <ul className="people">
        {supervisors.map(s => {
          const v = verifications.data?.find(x => x.supervisorId === s.id);
          return (
            <li key={s.id}>
              <strong>{s.fullName}</strong>
              {v?.supervisorSignedAt ? <span className="ok">✓ Signed & locked</span>
                : v?.traineeSignedAt ? <span className="muted small">You signed · waiting on supervisor <button className="ghost small" onClick={() => sign.mutate(s.id)}>Re-sign</button></span>
                : <button className="small" disabled={month > currentMonth() || sign.isPending} onClick={() => sign.mutate(s.id)}>Sign {monthLabel(month, true)}</button>}
            </li>
          );
        })}
      </ul>
      <p className="muted small">Signing sends this month's hours under that supervisor for their countersignature. Re-sign if you edit entries afterward.</p>
      <ErrorText error={sign.error} />
    </section>
  );
}
