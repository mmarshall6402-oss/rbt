import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { durationMinutes, evaluateForms, forecast, planFor, evaluateMonth, findOverlaps, targetsFor, validateEntry, type Edition, type Profile, type ProgramResult } from '@fieldtrack/rules';
import { api, download, profileOf, useChanges, useEntries, useHistory, useProgress, useSupervisors, useVerifications, type Change, type EntryDto, type EntryInput, type Me, type Supervisor } from '../api';
import { enqueue, useSyncState, type Op } from '../sync';
import { AppShell, Deadline, SignForm, SyncBadge, Checklist, ErrorText, HoursTrend, MonthNav, MonthRings, Ring, currentMonth, standardLabel, dateLabel, hrs, monthLabel, time12, useMonthParam } from '../components/ui';

const today = () => new Date().toLocaleDateString('en-CA');
type Draft = Omit<EntryInput, 'restrictedMinutes'> & { restrictedHours: string };
const blank = (supervisorId = '', workDate = today()): Draft =>
  ({ supervisorId, workDate, startTime: '', endTime: '', kind: 'independent', restrictedHours: '0', isGroup: false, contact: null, format: null, description: '' });
const fromEntry = (e: EntryDto, workDate = e.workDate): Draft => ({
  supervisorId: e.supervisorId, workDate, startTime: e.startTime, endTime: e.endTime, kind: e.kind, restrictedHours: String(e.restrictedMinutes / 60),
  isGroup: e.isGroup, contact: e.contact, format: e.format, description: e.description,
});
const toInput = ({ restrictedHours, ...d }: Draft): EntryInput => ({
  ...d, restrictedMinutes: Math.round((Number(restrictedHours) || 0) * 60),
  ...(d.kind === 'independent' ? { isGroup: false, contact: null, format: null } : { format: d.format ?? 'in_person' }),
});

export function TraineeDashboard({ me }: { me: Me }) {
  const [month, setMonth] = useMonthParam();
  const profile = profileOf(me)!; // trainees always have a standard (enforced by the database)
  const supervisors = useSupervisors(), entries = useEntries(month), progress = useProgress(), verifications = useVerifications(month);
  const locked = new Set(verifications.data?.filter(v => v.supervisorSignedAt).map(v => v.supervisorId));
  // Computed on the device with the same rules the server uses: updates instantly, works offline.
  // BACB checks each verification form (month × supervisor) on its own, so each supervisor gets separate results.
  const forms = entries.data ? evaluateForms(entries.data, profile) : [];
  const [picked, setPicked] = useState<string>();
  const form = forms.find(f => f.supervisorId === picked) ?? forms[0];
  const result = { data: entries.data ? form ?? evaluateMonth(month, [], profile) : undefined, error: entries.error };
  const names = Object.fromEntries((supervisors.data ?? []).map(s => [s.id, s.fullName]));
  const [editing, setEditing] = useState<EntryDto | null>(null), [copying, setCopying] = useState<EntryDto | null>(null);

  return (
    <AppShell name={me.fullName} nav={<><MonthNav month={month} onChange={setMonth} /><SyncBadge /></>}>
      {supervisors.data?.length === 0 && <LinkSupervisor first />}

      {forms.length > 1 && (
        <div className="seg" role="radiogroup" aria-label="Verification form">
          {forms.map(f => (
            <button type="button" key={f.supervisorId} role="radio" aria-checked={f === form} className={f === form ? 'on' : ''} onClick={() => setPicked(f.supervisorId)}>
              {names[f.supervisorId!] ?? 'Supervisor'}<small>{f.passed ? '✓ all met' : `✗ ${f.checks.filter(c => !c.ok).length} not met`}</small>
            </button>
          ))}
        </div>
      )}

      <section className="rings-row">
        {progress.data && (
          <>
            <Ring value={progress.data.countableMinutes} max={progress.data.requiredMinutes} display={`${Math.floor(progress.data.countableMinutes / 60)}`}
              label={`of ${progress.data.requiredMinutes / 60} hours`} sub="Countable total" />
            <Ring value={progress.data.unrestrictedPercent} max={60} display={`${progress.data.unrestrictedPercent.toFixed(0)}%`}
              label="Unrestricted (60%)" sub="Across counted months" ok={progress.data.countableMinutes ? progress.data.unrestrictedOk : undefined} />
          </>
        )}
        {result.data && <MonthRings m={result.data} profile={profile} />}
      </section>
      {progress.data && <Pace program={progress.data} profile={profile} />}

      <div className="cols">
        <section className="card">
          <h2>{editing ? 'Edit entry' : 'Log hours'}</h2>
          {supervisors.data && supervisors.data.length > 0
            ? <EntryForm key={editing?.id ?? (copying ? `copy-${copying.id}` : `new-${month}`)} month={month} profile={profile} supervisors={supervisors.data} entries={entries.data ?? []} editing={editing} copyOf={copying} onDone={() => { setEditing(null); setCopying(null) }} />
            : <p className="muted">Link a supervisor to start logging.</p>}
        </section>
        <div className="stack">
          <section className="card">
            <h2>{monthLabel(month)} requirements{forms.length > 1 && form?.supervisorId && ` · ${names[form.supervisorId] ?? ''}`}</h2>
            <p className="muted small">{standardLabel(profile)}{forms.length > 1 && ' · checked separately for each supervisor’s form'}</p>
            {result.data ? <Checklist m={result.data} /> : <ErrorText error={result.error} />}
          </section>
          {supervisors.data && supervisors.data.length > 0 && <SignOff month={month} supervisors={supervisors.data} me={me} edition={profile.edition!} withHours={new Set(forms.map(f => f.supervisorId))} />}
        </div>
      </div>

      <section className="card">
        <div className="row spread"><h2>Entries</h2><span className="row">Export all hours{(['pdf', 'csv'] as const).map(t => <button key={t} className="ghost small" onClick={() => void download(`/entries/export.${t}`, `fieldwork-hours.${t}`).catch(e => alert(e.message))}>{t.toUpperCase()}</button>)}</span></div>
        <EntriesTable entries={entries.data ?? []} supervisors={supervisors.data ?? []} onEdit={e => { setCopying(null); setEditing(e); scrollTo({ top: 0, behavior: 'smooth' }) }} onRepeat={e => { setEditing(null); setCopying(e); scrollTo({ top: 0, behavior: 'smooth' }) }} editable isLocked={e => locked.has(e.supervisorId)} />
      </section>

      <MonthChanges month={month} />

      <div className="cols">
        <section className="card"><h2>Hours by month</h2><HoursTrend months={progress.data?.months ?? []} names={names} /></section>
        <StandardSettings me={me} />
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
  return () => Promise.all(['entries', 'month', 'progress', 'verifications', 'supervisors', 'changes', 'history'].map(k => qc.invalidateQueries({ queryKey: [k] })));
}

/** Saves to the on-device outbox; lists re-render from it at once and uploading happens in the background. */
const useLocalChange = () => (op: Op) => enqueue(op);

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

function EntryForm({ month, profile, supervisors, entries, editing, copyOf, onDone }: { month: string; profile: Profile; supervisors: Supervisor[]; entries: EntryDto[]; editing: EntryDto | null; copyOf?: EntryDto | null; onDone: () => void }) {
  const [d, setD] = useState<Draft>(() => editing ? fromEntry(editing) : copyOf ? fromEntry(copyOf, today()) : blank(supervisors[0]?.id, month === currentMonth() ? today() : `${month}-01`));
  const [warnings, setWarnings] = useState<string[]>([]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD(p => ({ ...p, [k]: v }));
  const change = useLocalChange();
  const input = toInput(d);

  // Live checks with the same rules the server enforces.
  const ready = d.startTime && d.endTime;
  const problems = ready ? validateEntry(input) : [];
  const preview = ready && !problems.length && input.workDate.startsWith(month)
    ? evaluateMonth(month, [...entries.filter(e => e.id !== editing?.id && e.supervisorId === input.supervisorId), input], profile).summary : null; // this supervisor’s form only

  async function save() {
    const id = editing?.id ?? crypto.randomUUID(); // client-generated id makes uploads idempotent
    const sameDay = entries.filter(e => e.id !== id && e.workDate === input.workDate);
    setWarnings(findOverlaps<EntryInput>([...sameDay, input]).filter(p => p.includes(input))
      .map(([a, b]) => { const o = a === input ? b : a; return `Overlaps ${time12(o.startTime)}–${time12(o.endTime)}` }));
    await change({ kind: 'put', id, body: input, queuedAt: Date.now() });
    if (editing || copyOf) onDone(); else setD(blank(d.supervisorId, d.workDate));
  }

  return (
    <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); void save() }}>
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
      {preview && <p className="notice">With this entry: <strong>{hrs(preview.totalMinutes)} h</strong> this month{supervisors.length > 1 ? ' with this supervisor' : ''} · <strong>{(preview.supervisedMinutes / preview.totalMinutes * 100).toFixed(1)}%</strong> supervised{targetsFor(profile).rules.minContacts && ` · ${preview.contacts} contacts`}</p>}
      <div className="row">
        <button className="primary" disabled={problems.length > 0}>{editing ? 'Save changes' : 'Save entry'}</button>
        {editing && <button type="button" className="ghost" onClick={onDone}>Cancel</button>}
      </div>
      {warnings.map(w => <p key={w} className="notice">⚠ {w}</p>)}
    </form>
  );
}

export function EntriesTable({ entries, supervisors, onEdit, onRepeat, editable = false, isLocked = () => false }: { entries: EntryDto[]; supervisors: { id: string; fullName: string }[]; onEdit?: (e: EntryDto) => void; onRepeat?: (e: EntryDto) => void; editable?: boolean; isLocked?: (e: EntryDto) => boolean }) {
  const change = useLocalChange();
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const name = (id: string) => supervisors.find(s => s.id === id)?.fullName ?? '—';
  if (!entries.length) return <p className="muted">No hours logged this month.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Time</th><th>Type</th><th className="num">Restr.</th><th className="num">Unrestr.</th><th>Contact</th>{editable && <th>Supervisor</th>}<th className="num">Hours</th><th /></tr></thead>
        <tbody>
          {entries.map(e => {
            const total = durationMinutes(e);
            return [
              <tr key={e.id} className={e.description ? 'has-desc' : ''}>
                <td>{dateLabel(e.workDate)}{e.pending && <div className="muted small" title="Saved on this device; uploads automatically">☁ On device</div>}</td>
                <td>{time12(e.startTime)}–{time12(e.endTime)}</td>
                <td><span className={`tag ${e.kind}`}>{e.kind === 'independent' ? 'Independent' : e.isGroup ? 'Supervised · group' : 'Supervised'}</span></td>
                <td className="num">{hrs(e.restrictedMinutes)}</td>
                <td className="num">{hrs(total - e.restrictedMinutes)}</td>
                <td>{e.contact === 'observation' ? 'Observation' : e.contact === 'contact' ? 'Contact' : ''}{e.format ? <span className="muted small"> · {e.format === 'online' ? 'Online' : 'In person'}</span> : null}</td>
                {editable && <td>{name(e.supervisorId)}</td>}
                <td className="num"><strong>{hrs(total)}</strong></td>
                <td className="actions-cell">
                  {!e.pending && <button className="ghost small" aria-expanded={historyFor === e.id} onClick={() => setHistoryFor(historyFor === e.id ? null : e.id)}>History</button>}
                  {editable && <button className="ghost small" title="Copy to today" onClick={() => onRepeat?.(e)}>Repeat</button>}
                  {editable && isLocked(e) && <span className="muted small" title="Signed by your supervisor">🔒 Signed</span>}
                  {editable && !isLocked(e) && <>
                    <button className="ghost small" onClick={() => onEdit?.(e)}>Edit</button>
                    <button className="ghost small" onClick={() => confirm('Delete this entry?') && void change({ kind: 'delete', id: e.id, queuedAt: Date.now() })}>Delete</button>
                  </>}
                </td>
              </tr>,
              e.description && <tr key={`${e.id}-d`} className="desc"><td colSpan={editable ? 9 : 8}>{e.description}</td></tr>,
              historyFor === e.id && <tr key={`${e.id}-h`} className="desc"><td colSpan={editable ? 9 : 8}><EntryHistory id={e.id} /></td></tr>,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

function SignOff({ month, supervisors, me, edition, withHours }: { month: string; supervisors: Supervisor[]; me: Me; edition: Edition; withHours: Set<string | undefined> }) {
  const [signing, setSigning] = useState<string | null>(null);
  const verifications = useVerifications(month), invalidate = useInvalidate(), { pending } = useSyncState();
  const pdf = useMutation({ mutationFn: (s: Supervisor) => download(`/verifications/${month}/form.pdf?supervisorId=${s.id}`, `BACB monthly form ${month} ${s.fullName}.pdf`) });
  const sign = useMutation({
    mutationFn: (signature: string) => api(`/verifications/${month}/sign`, 'POST', { supervisorId: signing, signature, attest: true }),
    onSuccess: () => { setSigning(null); void invalidate() },
  });
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
                : v?.traineeSignedAt ? <span className="muted small">You signed · waiting on supervisor <button className="ghost small" disabled={pending > 0} onClick={() => setSigning(s.id)}>Re-sign</button></span>
                : <button className="small" disabled={month > currentMonth() || sign.isPending || pending > 0} onClick={() => setSigning(s.id)}>Sign {monthLabel(month, true)}</button>}
              {!v?.supervisorSignedAt && withHours.has(s.id) && <Deadline month={month} />}
              <button className="ghost small" disabled={pdf.isPending || pending > 0} onClick={() => pdf.mutate(s)}>BACB form (PDF)</button>
              {signing === s.id && <SignForm edition={edition} name={me.fullName} cta={`Sign ${monthLabel(month, true)} for ${s.fullName}`} busy={sign.isPending || pending > 0} onSign={sign.mutate} onCancel={() => setSigning(null)} />}
            </li>
          );
        })}
      </ul>
      {pending > 0 && <p className="notice">Waiting for {pending} change(s) to upload before you can sign.</p>}
      <p className="muted small">Signing sends this month's hours under that supervisor for their countersignature. Re-sign if you edit entries afterward.</p>
      <ErrorText error={sign.error ?? pdf.error} />
    </section>
  );
}

const FIELD_LABELS: Record<string, string> = {
  workDate: 'Date', startTime: 'Start', endTime: 'End', kind: 'Type', restrictedMinutes: 'Restricted minutes', isGroup: 'Group',
  contact: 'Contact', format: 'Format', description: 'Description', supervisorId: 'Supervisor', deletedAt: 'Deleted',
};
const showValue = (field: string, v: unknown) =>
  v === null || v === '' ? 'none' : field.endsWith('Time') ? time12(String(v).slice(0, 5)) : field === 'workDate' ? dateLabel(String(v)) : String(v);
const ACTION_WORD = { CREATE: 'Added', UPDATE: 'Edited', DELETE: 'Deleted' } as const;

function ChangeLine({ c }: { c: Change }) {
  const fields = c.changes.filter(x => x.field !== 'deletedAt');
  return (
    <li>
      <span className="muted small">{new Date(c.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>{' '}
      <strong>{ACTION_WORD[c.action]}</strong> {c.workDate && <>the {dateLabel(c.workDate)} entry</>}{c.actor && <span className="muted"> by {c.actor.name}</span>}
      {c.minutesDelta !== 0 && <strong className="delta"> {c.minutesDelta > 0 ? '+' : '−'}{hrs(Math.abs(c.minutesDelta))} h</strong>}
      {fields.length > 0 && <div className="muted small">{fields.map(x => `${FIELD_LABELS[x.field] ?? x.field}: ${showValue(x.field, x.from)} → ${showValue(x.field, x.to)}`).join(' · ')}</div>}
    </li>
  );
}

function EntryHistory({ id }: { id: string }) {
  const h = useHistory(id);
  if (h.isPending) return <span className="muted small">Loading history…</span>;
  return h.data ? <ul className="history">{h.data.map(c => <ChangeLine key={c.auditId} c={c} />)}</ul> : <ErrorText error={h.error} />;
}

/** Answers "why did my total change?" for the month, newest first. */
function MonthChanges({ month }: { month: string }) {
  const changes = useChanges(month);
  const list = [...(changes.data ?? [])].reverse();
  return (
    <section className="card">
      <h2>What changed in {monthLabel(month)}</h2>
      {!list.length ? <p className="muted">No changes yet.</p> : <ul className="history">{list.slice(0, 15).map(c => <ChangeLine key={c.auditId} c={c} />)}</ul>}
      <p className="muted small">Every add, edit and delete is recorded permanently and can't be altered.</p>
    </section>
  );
}

/** Which BACB standard the trainee is held to. Signed months always keep the rules they were signed under. */
function StandardSettings({ me }: { me: Me }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (patch: Partial<Pick<Me, 'credential' | 'fieldworkType' | 'rulesEdition' | 'bacbId' | 'fieldworkState' | 'fieldworkCountry'>>) => api<Me>('/me', 'PATCH', patch),
    onSuccess: user => { qc.setQueryData(['me'], user); void qc.invalidateQueries({ queryKey: ['progress'] }) },
  });
  return (
    <section className="card stack">
      <h2>Your standard</h2>
      <label>When will you apply for certification?
        <select value={me.rulesEdition ?? '2027'} onChange={e => save.mutate({ rulesEdition: e.target.value as Me['rulesEdition'] })}>
          <option value="2022">Before January 1, 2027 (2022 rules)</option>
          <option value="2027">On or after January 1, 2027 (2027 rules)</option>
        </select>
      </label>
      <div className="row">
        <label>Credential
          <select value={me.credential ?? 'bcba'} onChange={e => save.mutate({ credential: e.target.value as Me['credential'] })}>
            <option value="bcba">BCBA</option><option value="bcaba">BCaBA</option>
          </select>
        </label>
        <label>Fieldwork type
          <select value={me.fieldworkType ?? 'concentrated'} onChange={e => save.mutate({ fieldworkType: e.target.value as Me['fieldworkType'] })}>
            <option value="concentrated">Concentrated</option><option value="supervised">Supervised</option>
          </select>
        </label>
      </div>
      <p className="muted small">The BACB applies rules by your application date, not by when you worked. Months already signed keep the rules they were signed under.</p>
      <h3>For your BACB forms</h3>
      <div className="row">
        {([['bacbId', 'BACB ID'], ['fieldworkState', 'State where fieldwork occurs'], ['fieldworkCountry', 'Country']] as const).map(([k, label]) => (
          <label key={k}>{label}
            <input defaultValue={me[k] ?? ''} maxLength={100} onBlur={e => e.target.value.trim() !== (me[k] ?? '') && save.mutate({ [k]: e.target.value })} />
          </label>
        ))}
      </div>
      {(!me.bacbId || !me.fieldworkState || !me.fieldworkCountry) && <p className="notice">The BACB denies verification forms with missing information. Fill these in before you download forms.</p>}
      <ErrorText error={save.error} />
    </section>
  );
}

/** "When will I finish?" from recent pace, and what it takes to finish by a chosen month. */
function Pace({ program, profile }: { program: ProgramResult; profile: Profile }) {
  const [target, setTarget] = useState(() => { try { return localStorage.getItem('ft.finishBy') ?? '' } catch { return '' } });
  if (program.complete) return <p className="notice">🎉 You've met the fieldwork hours. Keep your signed forms for 7 years.</p>;
  const now = currentMonth(), f = forecast(program, now), plan = target ? planFor(program, profile, now, target) : null;
  const pick = (v: string) => { setTarget(v); try { localStorage.setItem('ft.finishBy', v) } catch { /* private mode */ } };
  return (
    <div className="pace muted small center-text">
      <p>{f ? <>At your recent pace ({Math.round(f.minutesPerMonth / 60)} countable h/month) you'll finish around <strong>{monthLabel(f.finishMonth)}</strong>.</> : 'Your projected finish date appears after your first fully countable month.'}</p>
      <p>
        <label className="inline">Want to finish by <input type="month" min={now} value={target} onChange={e => pick(e.target.value)} /></label>
        {plan && (plan.feasible
          ? <> → log about <strong>{Math.ceil(plan.minutesPerWeek / 60)} h/week</strong> ({Math.ceil(plan.minutesPerMonth / 60)} h/month), with every month meeting its requirements.</>
          : <> → <strong>not possible</strong>: that needs {Math.ceil(plan.minutesPerMonth / 60)} h/month, over the {plan.maxMonthlyMinutes / 60} h monthly maximum.</>)}
      </p>
    </div>
  );
}
