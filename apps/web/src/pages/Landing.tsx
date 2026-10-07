import { Link } from 'react-router-dom';
import { Ring, ThemeToggle } from '../components/ui';

const features = [
  ['Live requirement checks', 'Every BACB monthly rule for the 2022 or 2027 standard (hours, supervision %, observation, contacts, group limits) checked as you type.'],
  ['Exact numbers, not guesses', '“2.4 supervised hours still needed,” computed so the new hours count toward the total too. No spreadsheet math.'],
  ['Hours that actually count', 'Progress counts only what the BACB counts: months that meet the requirements (or are adjusted the BACB’s way when they fall short), signed by the deadline.'],
  ['Official forms, e-signed', 'You sign, your BCBA countersigns, and the official BACB monthly form downloads already filled in. Signed months lock with the rules they were signed under.'],
  ['Built for real records', 'Every change is audited. Nothing is ever hard-deleted. Your fieldwork history is safe if you switch supervisors.'],
  ['60% unrestricted tracking', 'Split each session into restricted and unrestricted time and watch your overall ratio in one ring.'],
];

const faq = [
  ['Is this affiliated with the BACB?', 'No. Fieldtrack is an independent tool. Always confirm requirements against the current BACB handbook.'],
  ['Does it handle Supervised and Concentrated fieldwork?', 'Yes. Pick your type at sign-up; supervision percentages, contact minimums, and total hours adjust automatically.'],
  ['2022 or 2027 rules?', 'The BACB applies rules by when you apply for certification. Pick yours; months already signed keep the rules they were signed under.'],
  ['How does my supervisor join?', 'Send them an invite link, or enter the 8-character code from their supervisor account. You stay in control of who sees your hours.'],
  ['What about client information?', 'Use initials, never full names. Supervisors only see entries logged under them.'],
];

export function Landing() {
  return (
    <div className="landing">
      <header className="topbar">
        <span className="brand">Fieldtrack</span>
        <nav className="hide-sm"><a href="#features">Features</a><a href="#how">How it works</a><a href="#supervisors">Supervisors</a><a href="#faq">FAQ</a></nav>
        <div className="topbar-right"><ThemeToggle /><Link to="/login" className="ghost btn">Sign in</Link><Link to="/signup?role=trainee" className="btn primary">Get started</Link></div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">BCBA fieldwork tracker</p>
          <h1>Know every month counts.</h1>
          <p className="lead">Log fieldwork hours in seconds. See exactly what's left before the month ends. Get your supervisor's sign-off without paperwork chaos.</p>
          <div className="actions">
            <Link to="/signup?role=trainee" className="btn primary">Start as a trainee</Link>
            <Link to="/signup?role=supervisor" className="btn">I'm a supervisor</Link>
          </div>
          <p className="muted small">Free during beta · Supervised & Concentrated fieldwork</p>
        </div>
        <div className="hero-card" aria-label="Example dashboard">
          <div className="hero-card-head"><strong>October 2026</strong><span className="muted">Concentrated · 2027 rules</span></div>
          <div className="rings">
            <Ring value={1080} max={1200} display="18.00" label="Hours this month" sub="2.00 h still needed" ok={false} />
            <Ring value={9.1} max={7.5} display="9.1%" label="Supervision (7.5%)" sub="1.80 h supervised" ok />
            <Ring value={60} max={90} display="60" label="Minutes observed" sub="30 more needed" ok={false} />
            <Ring value={64} max={60} display="64%" label="Unrestricted (60%)" sub="Across counted months" ok />
          </div>
        </div>
      </section>

      <section id="features" className="section">
        <h2>Everything the monthly form asks for, tracked as you go</h2>
        <div className="grid3">{features.map(([t, d]) => <article key={t} className="card"><h3>{t}</h3><p className="muted">{d}</p></article>)}</div>
      </section>

      <section id="how" className="section">
        <h2>How it works</h2>
        <ol className="steps">
          <li><strong>Sign up</strong><span className="muted">Choose your fieldwork type and when you'll apply.</span></li>
          <li><strong>Link your supervisor</strong><span className="muted">Send an invite link or enter their code. Add more supervisors any time.</span></li>
          <li><strong>Log & sign</strong><span className="muted">Log sessions, watch the rings fill, sign the month when it's done.</span></li>
        </ol>
      </section>

      <section id="supervisors" className="section split">
        <div>
          <h2>For supervisors</h2>
          <p className="muted">See every trainee's month at a glance — who's on track, who needs more contacts, who's waiting on your signature. Review entries, leave comments, then e-sign the official form. If a trainee changes hours after signing, their signature is withdrawn until they re-sign.</p>
          <Link to="/signup?role=supervisor" className="btn">Create a supervisor account</Link>
        </div>
        <ul className="checklist big">
          <li className="ok"><span aria-hidden>✓</span> All trainees, one dashboard</li>
          <li className="ok"><span aria-hidden>✓</span> Only entries logged under you</li>
          <li className="ok"><span aria-hidden>✓</span> Signed months lock automatically</li>
          <li className="ok"><span aria-hidden>✓</span> Deadline reminders by email</li>
        </ul>
      </section>

      <section id="faq" className="section">
        <h2>Questions</h2>
        {faq.map(([q, a]) => <details key={q} className="faq"><summary>{q}</summary><p className="muted">{a}</p></details>)}
      </section>

      <section className="section cta">
        <h2>Stop doing fieldwork math in a spreadsheet.</h2>
        <Link to="/signup?role=trainee" className="btn primary">Get started — it's free</Link>
      </section>

      <footer className="footer muted small">
        <span>© {new Date().getFullYear()} Fieldtrack · <Link to="/help">How it works</Link></span>
        <span>Not affiliated with or endorsed by the Behavior Analyst Certification Board.</span>
      </footer>
    </div>
  );
}
