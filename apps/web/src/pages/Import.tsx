import { useState } from 'react';
import { importCsv, type ImportRow } from '@fieldtrack/rules';
import type { Me, Supervisor } from '../api';
import { enqueue } from '../sync';

/** Same file + same row → same id, so importing a file twice never duplicates hours (uploads are idempotent). */
async function rowId(traineeId: string, r: ImportRow) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${traineeId}|${JSON.stringify(r.entry)}|${r.supervisorName}`)));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80; // UUID version 5 layout
  const h = [...bytes.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const activeOn = (s: Supervisor, d: string) => s.startsOn <= d && (!s.endsOn || d <= s.endsOn);

/** Import hours from a spreadsheet (our CSV export, or another tracker's) into the offline outbox. */
export function ImportHours({ me, supervisors }: { me: Me; supervisors: Supervisor[] }) {
  const [parsed, setParsed] = useState<{ rows: ImportRow[]; missing: string[] } | null>(null);
  const [fallback, setFallback] = useState(supervisors[0]?.id ?? ''), [done, setDone] = useState<number | null>(null);
  const byName = new Map(supervisors.map(s => [s.fullName.trim().toLowerCase(), s]));

  const plan = (parsed?.rows ?? []).map(r => {
    const sup = byName.get(r.supervisorName.toLowerCase()) ?? supervisors.find(s => s.id === fallback);
    const errors = [...r.errors];
    if (!sup) errors.push('No supervisor to log it under');
    else if (!errors.length && !activeOn(sup, r.entry.workDate)) errors.push(`${sup.fullName} wasn't your supervisor on ${r.entry.workDate}`);
    return { r, sup, errors };
  });
  const ok = plan.filter(p => !p.errors.length), bad = plan.filter(p => p.errors.length);

  async function run() {
    for (const { r, sup } of ok) await enqueue({ kind: 'put', id: await rowId(me.id, r), body: { ...r.entry, supervisorId: sup!.id }, queuedAt: Date.now() });
    setDone(ok.length); setParsed(null);
  }

  return (
    <section className="card stack">
      <h2>Import hours</h2>
      <p className="muted small">From a CSV: our own export, or a spreadsheet from another tracker with Date, Start and End columns (Type, Supervisor, Restricted hours and Notes are used when present). Importing the same file twice won't duplicate anything.</p>
      <input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={async e => { const f = e.target.files?.[0]; setDone(null); setParsed(f ? importCsv(await f.text()) : null) }} />
      {parsed?.missing.length ? <p className="notice">Couldn't find these columns: {parsed.missing.join(', ')}.</p> : null}
      {parsed && !parsed.missing.length && (
        <>
          {plan.some(p => !byName.has(p.r.supervisorName.toLowerCase())) && (
            <label>Rows without a matching supervisor go under
              <select value={fallback} onChange={e => setFallback(e.target.value)}>{supervisors.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select>
            </label>
          )}
          <p><strong>{ok.length}</strong> ready to import{bad.length ? <>, <strong>{bad.length}</strong> with problems (skipped)</> : null}.</p>
          {bad.length > 0 && <ul className="small muted">{bad.slice(0, 8).map(p => <li key={p.r.line}>Line {p.r.line}: {p.errors.join('; ')}</li>)}{bad.length > 8 && <li>…and {bad.length - 8} more</li>}</ul>}
          <button className="primary" disabled={!ok.length} onClick={() => void run()}>Import {ok.length} entr{ok.length === 1 ? 'y' : 'ies'}</button>
        </>
      )}
      {done !== null && <p className="ok">✓ {done} entr{done === 1 ? 'y' : 'ies'} saved. They upload in the background; check the sync badge.</p>}
    </section>
  );
}
