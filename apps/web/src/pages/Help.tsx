import { Link } from 'react-router-dom';
import { RULESETS, targetsFor, type Credential, type Edition, type FieldworkType } from '@fieldtrack/rules';

const hours = (min: number) => `${min / 60}`;
const TYPES: [FieldworkType, string][] = [['supervised', 'Supervised'], ['concentrated', 'Concentrated']];

/** Requirements rendered from the same rule sets the app checks with, so this page can't drift from the math. */
function Requirements({ edition, credential }: { edition: Edition; credential: Credential }) {
  const r = RULESETS[edition], t = TYPES.map(([type]) => targetsFor({ type, credential, edition }));
  const row = (label: string, f: (i: number) => string) => <tr><th scope="row">{label}</th>{TYPES.map((_, i) => <td key={i}>{f(i)}</td>)}</tr>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>{credential.toUpperCase()} · {edition} rules</th>{TYPES.map(([, l]) => <th key={l}>{l}</th>)}</tr></thead>
        <tbody>
          {row('Total hours', i => hours(t[i]!.requiredMinutes))}
          {row('Hours per month', () => `${hours(r.minMonthlyMinutes)}–${hours(r.maxMonthlyMinutes)}`)}
          {row('Supervised, of each month', i => `${t[i]!.supervisionPerMille / 10}%`)}
          {row('Supervisor contacts per month', i => (t[i]!.minContacts === null ? 'Not required' : String(t[i]!.minContacts)))}
          {row('Observation with a client', i => (t[i]!.observation.unit === 'count' ? `${t[i]!.observation.min} per month` : `${t[i]!.observation.min} minutes per month`))}
          {row('Group supervision', () => `At most ${r.maxGroupPercent}% of supervised time`)}
          {row('Unrestricted activities', () => `At least ${r.minUnrestrictedPercent}% of all hours`)}
        </tbody>
      </table>
    </div>
  );
}

export function Help() {
  return (
    <main className="app help">
      <p><Link to="/" className="brand">Fieldtrack</Link></p>
      <h1>How Fieldtrack checks your fieldwork</h1>
      <p className="muted">Plain answers, based on the BACB Handbook and the 2027 Fieldwork Requirements. When in doubt, the BACB's documents win.</p>

      <section className="card stack">
        <h2>2022 or 2027 rules?</h2>
        <p>It depends on <strong>when you apply</strong> for certification, not when you did the hours: applying before January 1, 2027 means the 2022 rules; on or after means the 2027 rules. Pick yours in Settings; you can switch any time, and months already signed keep the rules they were signed under.</p>
      </section>

      <section className="card stack">
        <h2>What each month needs</h2>
        <p>The BACB checks requirements <strong>separately for each Monthly Fieldwork Verification Form</strong>, which means each supervisor's hours in a month stand on their own. A month that misses any requirement doesn't count at all, so Fieldtrack shows one result per supervisor.</p>
        {(['2027', '2022'] as const).map(e => (['bcba', 'bcaba'] as const).map(c => <Requirements key={e + c} edition={e} credential={c} />))}
        <p className="muted small">Unrestricted share is checked across all your counted months, not month by month.</p>
        <p><strong>Switching fieldwork type.</strong> Each monthly form has one fieldwork type. Your setting applies to months that aren't signed yet; signed months keep the type they were signed under. If you mix types, the BACB adds your supervised hours to your concentrated hours × 1.33, and that total must reach 2,000 (BCBA). Forms always show the actual hours.</p>
      </section>

      <section className="card stack">
        <h2>Signing each month</h2>
        <p>Both you and your supervisor sign every monthly form by the <strong>last day of the following month</strong> (September's form by October 31). Fieldtrack shows the due date and emails both of you a week and two days before.</p>
        <p>Signatures here are electronic signatures: you read the form's attestation and type your own name. The BACB's Acceptable Signatures Policy accepts any electronic signature made with intent to sign. Once your supervisor signs, the month locks, and the official BACB form downloads already filled in and signed.</p>
        <p>Both of you must keep signed forms for at least 7 years. Download them any time; Fieldtrack keeps them too.</p>
      </section>

      <section className="card stack">
        <h2>When fieldwork with a supervisor ends</h2>
        <p>Your supervisor signs the Final Fieldwork Verification Form. Fieldtrack totals it from the monthly forms you've both signed, split by fieldwork type.</p>
      </section>

      <section className="card stack">
        <h2>Bringing your hours over</h2>
        <p>Import a CSV from your current tracker or spreadsheet (Date, Start and End columns are required). Rows with problems are listed by line and skipped, and importing the same file twice never duplicates hours. You can export everything as CSV or PDF at any time.</p>
      </section>

      <section className="card stack">
        <h2>Privacy</h2>
        <p>Your supervisor sees only the hours you log under them. Session notes stay out of emails, logs and error reports. Every change to an entry is kept in a history you can see, so you can always answer "why did my total change?".</p>
      </section>
    </main>
  );
}
