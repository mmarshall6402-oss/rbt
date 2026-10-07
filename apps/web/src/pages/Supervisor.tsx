import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { api, download, profileOf, useEntries, useMonth, useTrainees, useVerifications, type Me, type MonthResult, type Verification } from '../api';
import { AppShell, Checklist, Deadline, SignForm, ErrorText, MonthNav, MonthRings, hrs, monthLabel, standardLabel, useMonthParam } from '../components/ui';
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
                      <td>{m ? (m.passed ? <span className="ok">✓ All met</span> : <span className="no">✗ {failing} not met</span>) : '…'}</td>
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
  const v = sig.data?.[0];
  const pdf = useMutation({ mutationFn: () => download(`/verifications/${month}/form.pdf?traineeId=${traineeId}`, `BACB monthly form ${month} ${trainee?.fullName ?? ''}.pdf`) });

  return (
    <AppShell name={me.fullName} nav={<MonthNav month={month} onChange={setMonth} />}>
      <p><Link to={`/supervise?month=${month}`} className="muted">‹ All trainees</Link></p>
      <h1>{trainee?.fullName ?? 'Trainee'} <span className="muted small">{monthLabel(month)}</span></h1>
      <p className="muted small">Showing only hours logged under you.</p>

      <section className="rings-row">{result.data && trainee && profileOf(trainee) && <MonthRings m={result.data} profile={profileOf(trainee)!} />}</section>

      <div className="cols">
        <section className="card"><h2>Requirements</h2>{result.data ? <Checklist m={result.data} /> : <ErrorText error={result.error} />}</section>
        <section className="card stack">
          <h2>Sign-off</h2>
          <p>{signStatus(v)}</p>
          {v?.traineeSignedAt && !v.supervisorSignedAt && (
            <>
              {result.data && !result.data.passed && <p className="notice">⚠ This month doesn't meet every requirement. Signed months still won't count toward the total.</p>}
              {signing
                ? <SignForm edition={trainee && profileOf(trainee)?.edition || '2027'} name={me.fullName} cta="Sign & lock month" busy={sign.isPending} onSign={sign.mutate} onCancel={() => setSigning(false)} />
                : <button className="primary" onClick={() => setSigning(true)}>Sign {monthLabel(month)}…</button>}
              <p className="muted small">Signing locks the month: the trainee can't change these entries afterward.</p>
            </>
          )}
          {v?.supervisorSignedAt && <p className="muted small">Signed {new Date(v.supervisorSignedAt).toLocaleString()} · rules {v.rulesVersion}</p>}
          <button className="ghost small" disabled={pdf.isPending} onClick={() => pdf.mutate()}>Download BACB form (PDF)</button>
          <ErrorText error={sign.error ?? pdf.error} />
        </section>
      </div>

      <section className="card"><div className="row spread"><h2>Entries</h2><button className="ghost small" onClick={() => void download(`/entries/export.csv?traineeId=${traineeId}`, `fieldwork-hours ${trainee?.fullName ?? ''}.csv`).catch(e => alert(e.message))}>Export CSV</button></div><EntriesTable entries={entries.data ?? []} supervisors={[]} /></section>
    </AppShell>
  );
}
