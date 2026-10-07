import { UserManager, WebStorageStateStore } from 'oidc-client-ts';

// dev: fake login that sends `x-dev-sub` (API must run with AUTH_MODE=dev). cognito: Hosted UI + PKCE, sends the ID token.
export const authMode = import.meta.env.VITE_AUTH_MODE === 'cognito' ? 'cognito' : 'dev';
const DEV_KEY = 'ft.devSub';

const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string | null) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch { /* storage blocked */ } },
};

const oidc = authMode === 'cognito'
  ? new UserManager({
      authority: import.meta.env.VITE_COGNITO_AUTHORITY,
      client_id: import.meta.env.VITE_COGNITO_CLIENT_ID,
      redirect_uri: `${location.origin}/auth/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      userStore: new WebStorageStateStore({ store: sessionStorage }), // tokens die with the tab
    })
  : null;

export async function authHeaders(): Promise<Record<string, string>> {
  if (!oidc) { const sub = store.get(DEV_KEY); return sub ? { 'x-dev-sub': sub } : {} }
  const user = await oidc.getUser();
  return user && !user.expired && user.id_token ? { authorization: `Bearer ${user.id_token}` } : {};
}

/** dev: signs in as `email` immediately. cognito: redirects to the Hosted UI, returning to `returnTo`. */
export async function signIn(email: string | undefined, returnTo: string) {
  if (!oidc) { store.set(DEV_KEY, email?.trim().toLowerCase() ?? null); return true }
  await oidc.signinRedirect({ state: returnTo });
  return false;
}

export async function completeSignIn(): Promise<string> {
  const user = await oidc!.signinRedirectCallback();
  return typeof user.state === 'string' ? user.state : '/app';
}

export async function signOut() {
  if (!oidc) { store.set(DEV_KEY, null); location.assign('/'); return }
  await oidc.removeUser();
  const domain = import.meta.env.VITE_COGNITO_DOMAIN;
  location.assign(`${domain}/logout?client_id=${import.meta.env.VITE_COGNITO_CLIENT_ID}&logout_uri=${encodeURIComponent(location.origin)}`);
}
