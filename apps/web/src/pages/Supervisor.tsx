import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { api, download, profileOf, useEntries, useFinals, useMonth, useTrainees, useVerifications, type Me, type MonthResult, type Verification } from '../api';
import { AppShell, Checklist, countableNote, Deadline, ReminderToggle, SignForm, ErrorText, MonthNav, MonthRings, hrs, monthLabel, standardLabel, useMonthParam } from '../components/ui';
import { ATTESTATIONS, FINAL_ATTESTATIONS, type Edition } from '@fieldtrack/rules';
import { EntriesTable } from './Trainee';

const signStatus = (v?: Verification) =>
  v?.supervisorSignedAt ? '✓ Signed' : v?.traineeSignedAt ? 'Ready for your signature' : 'Trainee hasn’t signed';

export function SupervisorDashboard({ me }: { me: Me }) {
  const [month, setMonth] = useMonthParam();
  const trainees = useTrainees();
  const list = trainees.data ?? [];
  const months = useQueries({ queries: list.map(t => ({ queryKey: ['month', month, t.id], queryFn: () => api<MonthResult>(`/months/${month}?traineeId=${t.id}`) })) });
  const sigs = useQueries({ queries: list.map(t => ({ queryKey: ['verifications', month, t.id], queryFn: () => api<Verification[]>(`/verifications?month=${month}&traineeId=${t.id}`) })) });
  const ready = sigs.filter(s => s.data?.[0]?.traineeSignedAt && !s.data[0].supervisorSignedAt).length;

  return (
    <AppShell name={me.fullName} nav={<MonthNav month={month} onChange={setMonth} />}>
      <div className="cols">
        <section className="card highlight">
          <h2>Your invite code</h2>
          <InviteCode code={me.inviteCode ?? ''} />
          <p className="muted small">Trainees enter this code to link to you. You'll see only the hours they log under you.</p>
          <ReminderToggle me={me} />
        </section>
        <section className="card stats">
          <div><span className="muted small">Trainees</span><strong>{list.length}</strong></div>
          <div><span className="muted small">Awaiting your signature</span><strong>{ready}</strong></div>
          <div><span className="muted small">Meeting all requirements</span><strong>{months.filter(m => m.data?.passed).length}</strong></div>
        </section>
      </div>

      <section className="card">
        <h2>{monthLabel(month)}</h2>
        {!list.length ? <p className="muted">No trainees yet. Share your invite code to get started.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Trainee</th><th>Standard</th><th className="num">Hours</th><th className="num">Supervised</th><th>Requirements</th><th>Sign-off</th><th /></tr></thead>
              <tbody>
                {list.map((t, i) => {
                  const m = months[i]?.data, s = m?.summary, failing = m?.checks.filter(c => !c.ok).length ?? 0;
                  return (
                    <tr key={t.id}>
                      <td><strong>{t.fullName}</strong><div className="muted small">{t.email}</div></td>
                      <td className="small">{profileOf(t) ? standardLabel(profileOf(t)!) : '—'}</td>
                      <td className="num">{s ? hrs(s.totalMinutes) : '…'}</td>
                      <td className="num">{s?.totalMinutes ? `${(s.supervisedMinutes / s.totalMinutes * 100).toFixed(1)}%` : '—'}</td>
                      <td>{m ? (m.lost ? <span className="no">✗ Lost: not signed by the deadline</span>
                        : m.passed ? <span className="ok">✓ All met</span>
                        : <span className="no">✗ {failing} not met{m.countableMinutes > 0 ? <span className="muted small"> · {hrs(m.countableMinutes)} h count after adjustment</span> : null}</span>) : '…'}</td>
                      <td>{signStatus(sigs[i]?.data?.[0])}{!sigs[i]?.data?.[0]?.supervisorSignedAt && !!s?.totalMinutes && <div><Deadline month={month} /></div>}</td>
                      <td><Link className="btn small" to={`/supervise/${t.id}?month=${month}`}>Review</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <ErrorText error={trainees.error} />
      </section>
    </AppShell>
  );
}

function InviteCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="row">
      <code className="invite">{code}</code>
      <button className="small" onClick={() => navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })}>{copied ? 'Copied ✓' : 'Copy'}</button>
    </div>
  );
}

export function TraineeReview({ me }: { me: Me }) {
  const { traineeId = '' } = useParams();
  const [month, setMonth] = useMonthParam();
  const trainee = useTrainees().data?.find(t => t.id === traineeId);
  const result = useMonth(month, traineeId), entries = useEntries(month, traineeId), sig = useVerifications(month, traineeId);
  const qc = useQueryClient(), [signing, setSigning] = useState(false);
  const sign = useMutation({
    mutationFn: (signature: string) => api(`/verifications/${month}/sign`, 'POST', { traineeId, signature, attest: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['verifications'] }),
  });
  const v = sig.data?.[0], edition = (trainee && profileOf(trainee)?.edition) || '2027';
  const pdf = useMutation({ mutationFn: () => download(`/verifications/${month}/form.pdf?traineeId=${traineeId}`, `BACB monthly form ${month} ${trainee?.fullName ?? ''}.pdf`) });

  return (
    <AppShell name={me.fullName} nav={<MonthNav month={month} onChange={setMonth} />}>
      <p><Link to={`/supervise?month=${month}`} className="muted">‹ All trainees</Link></p>
      <h1>{trainee?.fullName ?? 'Trainee'} <span className="muted small">{monthLabel(month)}</span></h1>
      <p className="muted small">Showing only hours logged under you.</p>

      <section className="rings-row">{result.data && trainee && profileOf(trainee) && <MonthRings m={result.data} profile={{ ...profileOf(trainee)!, type: result.data.type ?? profileOf(trainee)!.type }} />}</section>
      {result.data?.lost && <p className="notice">⚠ This form wasn't signed by the BACB deadline, so none of its hours count.</p>}

      <div className="cols">
        <section className="card"><h2>Requirements</h2>{result.data ? <Checklist m={result.data} /> : <ErrorText error={result.error} />}</section>
        <section className="card stack">
          <h2>Sign-off</h2>
          <p>{signStatus(v)}</p>
          {v?.traineeSignedAt && !v.supervisorSignedAt && (
            <>
              {result.data && !result.data.passed && <p className="notice">⚠ This month doesn't meet every requirement. {countableNote(result.data)} The form records the adjusted hours.</p>}
              {signing
                ? <SignForm statements={ATTESTATIONS[edition].statements} name={me.fullName} cta="Sign & lock month" busy={sign.isPending} onSign={sign.mutate} onCancel={() => setSigning(false)} />
                : <button className="primary" onClick={() => setSigning(true)}>Sign {monthLabel(month)}…</button>}
              <p className="muted small">Signing locks the month: the trainee can't change these entries afterward.</p>
            </>
          )}
          {v?.supervisorSignedAt && <p className="muted small">Signed {new Date(v.supervisorSignedAt).toLocaleString()} · rules {v.rulesVersion}</p>}
          <button className="ghost small" disabled={pdf.isPending} onClick={() => pdf.mutate()}>Download BACB form (PDF)</button>
          <ErrorText error={sign.error ?? pdf.error} />
        </section>
      </div>

      <FinalVerificationCard traineeId={traineeId} me={me} edition={edition} />

      <section className="card"><div className="row spread"><h2>Entries</h2><span className="row">Export{(['pdf', 'csv'] as const).map(t => <button key={t} className="ghost small" onClick={() => void download(`/entries/export.${t}?traineeId=${traineeId}`, `fieldwork-hours ${trainee?.fullName ?? ''}.${t}`).catch(e => alert(e.message))}>{t.toUpperCase()}</button>)}</span></div><EntriesTable entries={entries.data ?? []} supervisors={[]} month={month} traineeId={traineeId} /></section>
    </AppShell>
  );
}

/** End of fieldwork: the supervisor signs the BACB Final Fieldwork Verification Form, totalled from signed monthly forms. */
function FinalVerificationCard({ traineeId, me, edition }: { traineeId: string; me: Me; edition: Edition }) {
  const finals = useFinals(traineeId), qc = useQueryClient(), [signing, setSigning] = useState(false);
  const signed = finals.data?.[0];
  const sign = useMutation({
    mutationFn: (signature: string) => api('/final/sign', 'POST', { traineeId, signature, attest: true }),
    onSuccess: () => { setSigning(false); void qc.invalidateQueries({ queryKey: ['final'] }) },
  });
  const pdf = useMutation({ mutationFn: () => download(`/final/form.pdf?traineeId=${traineeId}`, 'BACB final fieldwork verification.pdf') });
  return (
    <section className="card stack">
      <h2>Final fieldwork verification</h2>
      <p className="muted small">When fieldwork under you ends, sign the BACB Final Fieldwork Verification Form. Totals come from the monthly forms you've both signed.</p>
      {signed && (signed.valid
        ? <p className="ok small">✓ Signed {new Date(signed.supervisorSignedAt).toLocaleDateString()}. Signing more months afterward means signing this again.</p>
        : <p className="notice">You signed this on {new Date(signed.supervisorSignedAt).toLocaleDateString()}, but the months that count have changed since. Sign it again so the form matches.</p>)}
      <div className="row">
        <button className="ghost small" disabled={pdf.isPending} onClick={() => pdf.mutate()}>Download final form (PDF)</button>
        {!signing && <button className="small" onClick={() => setSigning(true)}>{signed ? 'Re-sign final form…' : 'Sign final form…'}</button>}
      </div>
      {signing && <SignForm statements={FINAL_ATTESTATIONS[edition].statements} name={me.fullName} cta="Sign final form" busy={sign.isPending} onSign={sign.mutate} onCancel={() => setSigning(false)} />}
      <ErrorText error={sign.error ?? pdf.error} />
    </section>
  );
}
