import { Link } from 'react-router-dom';
import { Ring, ThemeToggle } from '../components/ui';

const features = [
  ['Live requirement checks', 'Every BACB monthly rule — 20–130 hours, 5% or 10% supervision, contacts, observation, group limits — checked as you type.'],
  ['Exact numbers, not guesses', '“2.4 supervised hours still needed,” computed so the new hours count toward the total too. No spreadsheet math.'],
  ['Hours that actually count', 'Progress toward 1,500 or 2,000 hours only includes months that meet every requirement — no surprises at the end.'],
  ['Supervisor sign-off', 'You sign, your BCBA countersigns. Signed months lock, and the rules version is stored with them forever.'],
  ['Built for real records', 'Every change is audited. Nothing is ever hard-deleted. Your fieldwork history is safe if you switch supervisors.'],
  ['60% unrestricted tracking', 'Split each session into restricted and unrestricted time and watch your overall ratio in one ring.'],
];

const faq = [
  ['Is this affiliated with the BACB?', 'No. Fieldtrack is an independent tool. Always confirm requirements against the current BACB handbook.'],
  ['Does it handle Supervised and Concentrated fieldwork?', 'Yes. Pick your type at sign-up; supervision percentages, contact minimums, and total hours adjust automatically.'],
  ['What happens when BACB changes the rules?', 'Rules are versioned by effective date. Old months keep the rules they were signed under; new months use the new ones.'],
  ['How does my supervisor join?', 'They create a supervisor account and get an 8-character invite code. You enter the code — you stay in control of who sees your hours.'],
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
          <div className="hero-card-head"><strong>October 2026</strong><span className="muted">Concentrated</span></div>
          <div className="rings">
            <Ring value={1080} max={1200} display="18.00" label="Hours this month" sub="2.00 h still needed" ok={false} />
            <Ring value={11.2} max={10} display="11.2%" label="Supervision (10%)" sub="2.02 h supervised" ok />
            <Ring value={4} max={6} display="4/6" label="Contacts" sub="2 more needed" ok={false} />
            <Ring value={1} max={1} display="1" label="Client observation" sub="Requirement met" ok />
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
          <li><strong>Sign up</strong><span className="muted">Choose Supervised or Concentrated fieldwork.</span></li>
          <li><strong>Link your supervisor</strong><span className="muted">Enter their invite code. Add more supervisors any time.</span></li>
          <li><strong>Log & sign</strong><span className="muted">Log sessions, watch the rings fill, sign the month when it's done.</span></li>
        </ol>
      </section>

      <section id="supervisors" className="section split">
        <div>
          <h2>For supervisors</h2>
          <p className="muted">See every trainee's month at a glance — who's on track, who needs more contacts, who's waiting on your signature. Review entries, then countersign in one click. If a trainee edits hours after signing, you're told before you sign.</p>
          <Link to="/signup?role=supervisor" className="btn">Create a supervisor account</Link>
        </div>
        <ul className="checklist big">
          <li className="ok"><span aria-hidden>✓</span> All trainees, one dashboard</li>
          <li className="ok"><span aria-hidden>✓</span> Only entries logged under you</li>
          <li className="ok"><span aria-hidden>✓</span> Signed months lock automatically</li>
          <li className="ok"><span aria-hidden>✓</span> Change detection before you sign</li>
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
        <span>© {new Date().getFullYear()} Fieldtrack</span>
        <span>Not affiliated with or endorsed by the Behavior Analyst Certification Board.</span>
      </footer>
    </div>
  );
}
