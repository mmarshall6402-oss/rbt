// Run after seed.mjs. Builds snapshot.json for the static demo: real API responses for both demo users.
// Keys are `${role}|${path}` with traineeId stripped (the demo has one trainee), so the shim can look them up either way.
import { writeFileSync } from 'node:fs';
const API = 'http://localhost:3000/api', T = 'mom@demo.test', S = 'supervisor@demo.test';
const call = async (sub, p, m = 'GET', b) => { const r = await fetch(API + p, { method: m, headers: { 'x-dev-sub': sub, ...(b ? { 'content-type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined }); if (!r.ok) throw new Error(`${m} ${p} ${r.status} ${await r.text()}`); return r };
await call(T, '/me', 'PATCH', { bacbId: '1-26-99999', fieldworkState: 'Georgia', fieldworkCountry: 'United States' });
const mom = await (await call(T, '/me')).json(), sup = await (await call(S, '/me')).json();
const snap = {}, months = ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'];
const grab = async (role, sub, path, tid = '') => {
  const sep = path.includes('?') ? '&' : '?', r = await fetch(API + path + (tid && `${sep}traineeId=${tid}`), { headers: { 'x-dev-sub': sub } });
  snap[`${role}|${path}`] = { status: r.status, body: r.status === 204 ? null : await r.json() };
};
for (const [role, sub, tid] of [['trainee', T, ''], ['supervisor', S, mom.id]]) {
  for (const p of ['/me', '/billing', '/supervisors', '/trainees', '/progress', '/final', '/external-signatures']) await grab(role, sub, p, p === '/progress' || p === '/final' || p === '/external-signatures' ? tid : '');
  for (const m of months) { for (const p of ['/changes', '/comments', '/entries', '/verifications']) await grab(role, sub, `${p}?month=${m}`, tid); await grab(role, sub, `/months/${m}`, tid) }
}
for (const m of months) for (const e of snap[`trainee|/entries?month=${m}`].body) await grab('trainee', T, `/entries/${e.id}/history`);




await call(S, '/verifications/2026-09/sign', 'POST', { traineeId: mom.id, signature: sup.fullName, attest: true });

writeFileSync(new URL('./snapshot.json', import.meta.url), JSON.stringify({ users: { trainee: T, supervisor: S, traineeId: mom.id, supervisorId: sup.id, supervisorName: sup.fullName }, snap }));
console.log(Object.keys(snap).length, 'responses');
