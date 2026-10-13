// Static demo: answers the app's /api calls in the browser from a recorded snapshot, so it runs with no server.
// Logged hours, deletions, settings and signatures are kept in this browser only (localStorage).
import data from './snapshot.json';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const { users, snap } = data as { users: Record<string, string>; snap: Record<string, { status: number; body: Json }> };
const KEY = 'ft.demo', SUB = 'ft.devSub';
const ls = { get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } }, set: (k: string, v: string | null) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch { /* storage blocked */ } } };
const load = () => { try { return JSON.parse(ls.get(KEY) ?? '') } catch { return null } };
const state: { entries: Record<string, Json | null>; signed: Record<string, { traineeSignedAt?: string; supervisorSignedAt?: string }>; me: Record<string, Json> } =
  load() ?? { entries: {}, signed: {}, me: {} };
const save = () => ls.set(KEY, JSON.stringify(state));
const json = (body: Json, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fail = (status: number, error: string) => json({ error }, status);
const thisMonth = () => new Date().toISOString().slice(0, 7);
const NO_DOWNLOAD = "Downloads are turned off on this demo page. In the real app this button saves the filled-in PDF.";
const NOT_SAVED = "This is a demo, so that isn't saved. Try logging hours, or sign September's form as the supervisor.";

function verifications(month: string, base: Json[]) {
  const s = state.signed[month];
  if (!s) return base;
  const v = base[0] ?? { id: `demo-${month}`, traineeId: users.traineeId, supervisorId: users.supervisorId, month: `${month}-01`, fieldworkType: 'supervised', rulesVersion: 'bacb-2027', traineeSignedAt: null, supervisorSignedAt: null };
  return [{ ...v, ...s }];
}

function handle(role: string, method: string, path: string, body: Json): Response {
  const [p, qs = ''] = path.split('?'), q = new URLSearchParams(qs), month = q.get('month') ?? '';
  q.delete('traineeId'); q.delete('supervisorId');
  const key = `${role}|${p}${q.size ? `?${q}` : ''}`, hit = snap[key];
  let m: RegExpMatchArray | null;

  if ((m = p.match(/^\/entries\/([^/]+)$/))) {
    if (method === 'PUT') { const now = new Date().toISOString(), e = { ...body, id: m[1], createdAt: now, updatedAt: now }; state.entries[m[1]] = e; save(); return json({ entry: e }) }
    if (method === 'DELETE') { state.entries[m[1]] = null; save(); return new Response(null, { status: 204 }) }
  }
  if (method === 'GET' && p === '/entries') {
    const base = (hit?.body ?? []).filter((e: Json) => !(e.id in state.entries));
    const mine = Object.values(state.entries).filter((e): e is Json => !!e && e.workDate.startsWith(month));
    return json([...base, ...mine].sort((a, b) => (b.workDate + b.startTime).localeCompare(a.workDate + a.startTime)));
  }
  if (method === 'GET' && p === '/verifications') return json(verifications(month, hit?.body ?? []));
  if ((m = p.match(/^\/verifications\/(\d{4}-\d{2})\/sign$/))) {
    const mo = m[1]!, name = role === 'supervisor' ? users.supervisorName : snap['trainee|/me']!.body.fullName;
    if (mo >= thisMonth()) return fail(400, 'You can sign once the month is over');
    if (String(body?.signature ?? '').trim().toLowerCase() !== String(name).toLowerCase()) return fail(400, `Type your full name exactly as on your account (${name}) to sign`);
    const v = verifications(mo, snap[`${role}|/verifications?month=${mo}`]?.body ?? [])[0];
    if (role === 'supervisor' && !v?.traineeSignedAt) return fail(409, 'The trainee has to sign first');
    state.signed[mo] = { ...state.signed[mo], ...(v?.traineeSignedAt && { traineeSignedAt: v.traineeSignedAt }), [role === 'supervisor' ? 'supervisorSignedAt' : 'traineeSignedAt']: new Date().toISOString() };
    save();
    const s = verifications(mo, [])[0];
    return json({ id: s.id, month: s.month, traineeSignedAt: s.traineeSignedAt, supervisorSignedAt: s.supervisorSignedAt });
  }
  if (method === 'GET' && /\.(pdf|csv)$/.test(p)) return fail(400, NO_DOWNLOAD); // the demo page's frame blocks file downloads
  if (p === '/me') {
    if (method === 'PATCH') { state.me[role] = { ...state.me[role], ...body }; save() }
    return json({ ...snap[`${role}|/me`]!.body, ...state.me[role] });
  }
  if (method === 'GET' && hit) return json(hit.body, hit.status);
  if (method === 'GET') return /^\/(changes|comments|entries|verifications|external-signatures|supervisors|trainees)/.test(p) ? json([]) : fail(404, 'Not in the demo data');
  return fail(400, NOT_SAVED);
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('/api/')) return realFetch(input, init);
  await new Promise(r => setTimeout(r, 120)); // feel like a network
  const sub = ls.get(SUB), role = sub === users.trainee ? 'trainee' : sub === users.supervisor ? 'supervisor' : null;
  if (!sub) return fail(401, 'Sign in');
  if (!role) return fail(403, 'Pick "Mom (trainee)" or "Supervisor" in the demo bar at the bottom');
  return handle(role, (init?.method ?? 'GET').toUpperCase(), url.slice(4), typeof init?.body === 'string' ? JSON.parse(init.body) : undefined);
};

// Demo bar: switch between the two sample accounts.
async function viewAs(sub: string | null, hash: string) {
  const { queryClient, persister } = await import('../src/query');
  queryClient.clear(); await persister.removeClient();
  ls.set(SUB, sub);
  location.hash = hash; location.reload();
}
const bar = document.createElement('div');
bar.className = 'demo-bar';
bar.innerHTML = `<span><strong>Demo</strong> with sample data. Nothing is sent to a server.</span>
  <span class="demo-actions"><button data-v="trainee">Mom (trainee)</button><button data-v="supervisor">Supervisor</button><button data-v="reset">Reset</button></span>`;
bar.addEventListener('click', e => {
  const v = (e.target as HTMLElement).dataset.v;
  if (v === 'trainee') void viewAs(users.trainee!, '#/app');
  if (v === 'supervisor') void viewAs(users.supervisor!, '#/supervise');
  if (v === 'reset') { ls.set(KEY, null); void viewAs(null, '#/') }
});
document.body.append(bar);
