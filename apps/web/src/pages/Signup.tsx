import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, homeFor, useMe, type Me } from '../api';
import { authMode, signIn } from '../auth';
import { ErrorText } from '../components/ui';

export function Signup() {
  const [params, setParams] = useSearchParams();
  const role = params.get('role') === 'supervisor' ? 'supervisor' : 'trainee';
  const me = useMe(), nav = useNavigate(), qc = useQueryClient();
  const [f, setF] = useState({ email: '', fullName: '', fieldworkType: 'concentrated', bacbId: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const signup = useMutation({
    mutationFn: async () => {
      if (authMode === 'dev') await signIn(f.email, '/signup');
      return api<Me>('/signup', 'POST', role === 'trainee'
        ? { role, fullName: f.fullName, fieldworkType: f.fieldworkType, bacbId: f.bacbId || undefined }
        : { role, fullName: f.fullName, bacbId: f.bacbId });
    },
    onSuccess: user => { qc.setQueryData(['me'], user); nav(homeFor(user.role)) },
  });

  if (me.data) return <Navigate to={homeFor(me.data.role)} replace />;
  const needsLogin = authMode === 'cognito' && me.error && (me.error as { status?: number }).status === 401;

  return (
    <main className="auth">
      <Link to="/" className="brand">Fieldtrack</Link>
      <form className="card stack" onSubmit={(e: FormEvent) => { e.preventDefault(); needsLogin ? void signIn(undefined, `/signup?role=${role}`) : signup.mutate() }}>
        <h1>Create your account</h1>
        <div className="seg" role="radiogroup" aria-label="Account type">
          {(['trainee', 'supervisor'] as const).map(r => (
            <button type="button" key={r} role="radio" aria-checked={role === r} className={role === r ? 'on' : ''} onClick={() => setParams({ role: r })}>
              {r === 'trainee' ? 'Trainee' : 'Supervisor (BCBA)'}
            </button>
          ))}
        </div>
        {needsLogin ? <p className="muted">First, create your secure login. You'll come right back here.</p> : (
          <>
            {authMode === 'dev' && <label>Email<input type="email" required value={f.email} onChange={set('email')} /></label>}
            <label>Full name<input required value={f.fullName} onChange={set('fullName')} autoComplete="name" /></label>
            {role === 'trainee' && (
              <label>Fieldwork type
                <select value={f.fieldworkType} onChange={set('fieldworkType')}>
                  <option value="concentrated">Concentrated (10% supervision, 1,500 h)</option>
                  <option value="supervised">Supervised (5% supervision, 2,000 h)</option>
                </select>
              </label>
            )}
            <label>{role === 'supervisor' ? 'BACB certification number' : 'BACB ID (optional)'}
              <input required={role === 'supervisor'} value={f.bacbId} onChange={set('bacbId')} placeholder="1-23-45678" />
            </label>
          </>
        )}
        <button className="primary" disabled={signup.isPending}>{needsLogin ? 'Continue' : signup.isPending ? 'Creating…' : 'Create account'}</button>
        <ErrorText error={signup.error} />
        <p className="muted small">Already have an account? <Link to="/login">Sign in</Link></p>
      </form>
    </main>
  );
}
