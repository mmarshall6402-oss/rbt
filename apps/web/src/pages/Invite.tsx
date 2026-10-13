import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, useMe } from '../api';
import { ErrorText } from '../components/ui';

/** Where a trainee's invite link lands: a supervisor accepts it to be linked, signing up first if needed. */
export function Invite() {
  const { token = '' } = useParams(), me = useMe(), nav = useNavigate(), qc = useQueryClient();
  const info = useQuery({ queryKey: ['invite', token], queryFn: () => api<{ traineeName: string }>(`/invites/${token}`), retry: false });
  const accept = useMutation({
    mutationFn: () => api(`/invites/${token}/accept`, 'POST'),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['trainees'] }); nav('/supervise') },
  });
  const status = (e: unknown) => (e instanceof ApiError ? e.status : 0);
  const here = `/invite/${token}`;
  if (status(me.error) === 401 || status(info.error) === 401) return <Navigate to={`/login?next=${encodeURIComponent(here)}`} replace />;

  return (
    <main className="auth">
      <Link to="/" className="brand">Fieldtrack</Link>
      <section className="card stack">
        <h1>Supervision invite</h1>
        {info.isPending ? <p className="muted">Checking your invite…</p>
          : info.error ? <p className="notice">{info.error.message}. Ask your trainee to send a new link.</p>
          : <>
            <p><strong>{info.data.traineeName}</strong> invited you to supervise their BACB fieldwork on Fieldtrack. You'll see only the hours they log under you.</p>
            {status(me.error) === 403 && <Link className="btn primary" to={`/signup?role=supervisor&invite=${token}`}>Create your supervisor account</Link>}
            {me.data?.role === 'supervisor' && <button className="primary" disabled={accept.isPending} onClick={() => accept.mutate()}>Accept and link</button>}
            {me.data && me.data.role !== 'supervisor' && <p className="notice">You're signed in as a trainee. Sign in with your supervisor account to accept.</p>}
          </>}
        <ErrorText error={accept.error} />
      </section>
    </main>
  );
}
