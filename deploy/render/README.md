# Free test deploy (Render + Neon)

One web service (API + web app) behind a single shared site password. For a small private test only:
anyone with the password can sign in as any email, so **no client names or other PHI** in entries. Production is AWS (`infra/`).

1. **Database.** neon.tech → New project `fieldtrack`, Postgres 16+, region near you. Copy the connection string with
   **Connection pooling off** (host without `-pooler`). It ends in `?sslmode=require`.
2. **Service.** render.com → New → Blueprint → pick this repo. Render reads `render.yaml`; paste the Neon string into
   `DATABASE_URL`, then Apply. The first build takes ~5 min; migrations run on every start.
3. **Password.** Service → Environment → reveal `SITE_PASSWORD` (Render generated it). Change it there any time.
4. **Use it.** Open `https://<service>.onrender.com`. The browser asks for a username (anything) and the password.
   Sign up as a trainee. Logging needs a linked supervisor: the BCBA signs up at `/signup?role=supervisor` and shares
   the invite code (or, to test solo, make a supervisor account with a second email).
5. **Phone.** Open the URL in Safari/Chrome → Share → Add to Home Screen. Works offline after the first load.

Free-plan limits: the service sleeps after 15 min idle (first load after that takes ~1 min), and Neon's free tier has 0.5 GB.
