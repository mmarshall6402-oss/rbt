import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { authMode, completeSignIn, signIn } from '../auth';
import { ErrorText } from '../components/ui';

export function Login() {
  const [params] = useSearchParams(), next = params.get('next') ?? '/app';
  const [email, setEmail] = useState(''), [error, setError] = useState<unknown>(null);
  const nav = useNavigate(), qc = useQueryClient();

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      if (await signIn(email, next)) { qc.clear(); nav(next.startsWith('/') ? next : '/app') }
    } catch (err) { setError(err) }
  }

  return (
    <main className="auth">
      <Link to="/" className="brand">Fieldtrack</Link>
      <form className="card stack" onSubmit={submit}>
        <h1>Sign in</h1>
        {authMode === 'dev' ? (
          <>
            <p className="notice">Dev mode: no password. Type any email to act as that user.</p>
            <label>Email<input type="email" required value={email} onChange={e => setEmail(e.target.value)} autoFocus /></label>
          </>
        ) : <p className="muted">You'll continue to our secure sign-in page.</p>}
        <button className="primary">Continue</button>
        <ErrorText error={error} />
        <p className="muted small">New here? <Link to={next.startsWith('/invite/') ? `/signup?role=supervisor&invite=${next.slice(8)}` : '/signup?role=trainee'}>Create an account</Link></p>
      </form>
    </main>
  );
}

export function AuthCallback() {
  const nav = useNavigate();
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { completeSignIn().then(to => nav(to, { replace: true }), setError) }, [nav]);
  return <main className="center">{error ? <ErrorText error={error} /> : <span className="muted">Signing you in…</span>}</main>;
}
