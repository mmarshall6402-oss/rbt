# Infrastructure (AWS)

Terraform in `terraform/` builds one environment per folder in `terraform/envs/` (`staging`, `prod`), both from `terraform/modules/app`.

| Piece | What it does |
|---|---|
| RDS Postgres 16 | Encrypted (KMS), TLS required, private subnets, deletion protection, **point-in-time recovery** (staging 7 days, prod 35 days), Multi-AZ in prod, password managed and rotated by RDS |
| ECS Fargate | API containers behind an ALB; circuit breaker rolls back failed deploys; CPU autoscaling |
| ALB | Reachable only from CloudFront IPs **and** only with a secret origin header |
| CloudFront + S3 | Serves the web app; `/api/*` goes to the ALB, never cached; HSTS, strict CSP, frame denial |
| WAF | AWS managed rules, per-IP rate limit, tight limit on invite-code guessing; logs redact auth headers |
| Cognito | Email sign-in (verified), optional TOTP MFA, PKCE web client |
| S3 records | Signed forms, KMS-encrypted, **Object Lock for 7 years**, access-logged |
| Logs/alarms | VPC flow logs, ALB and S3 access logs, app logs (365 days), alarms and budget alerts by email |
| GitHub OIDC | Deploy role per environment; no AWS keys stored in GitHub |

## One-time setup

1. **Sign the AWS BAA** in AWS Artifact before any real user data exists.
2. Create an S3 bucket for Terraform state. Copy `backend.hcl.example` to `backend.hcl` in each env and fill it in.
3. A Route 53 hosted zone for your domain.
4. Apply prod first (it creates the account-wide GitHub OIDC provider), then staging:
   ```sh
   cd infra/terraform/envs/prod
   terraform init -backend-config=backend.hcl
   terraform apply -var domain=app.example.com -var hosted_zone_id=Z123 -var alarm_email=you@example.com
   ```
5. Confirm the SNS email subscription. In Billing, activate the `env` cost-allocation tag (the budget filters on it).
6. In GitHub → Settings → Environments, create `staging` and `production`. Give `production` required reviewers. In each, add variables from `terraform output app`:
   `AWS_REGION, DEPLOY_ROLE_ARN, ECR_REPOSITORY_URL, ECS_CLUSTER, ECS_SERVICE, API_TASK_FAMILY, MIGRATE_TASK_FAMILY, REMINDERS_TASK_FAMILY, TASK_SUBNETS, TASK_SECURITY_GROUP, DB_INSTANCE_ID, DB_SUBNET_GROUP, DB_SECURITY_GROUP, DB_PARAMETER_GROUP, WEB_BUCKET, CLOUDFRONT_DISTRIBUTION_ID, COGNITO_AUTHORITY, COGNITO_CLIENT_ID, COGNITO_DOMAIN, APP_URL` (and optionally `SENTRY_DSN_WEB`).
7. Optional: put the API Sentry DSN in Secrets Manager (`fieldtrack-<env>/sentry-dsn`). Sentry must be on a plan with a signed BAA before production.
8. Set the repository variable `DEPLOY_ENABLED=true`. Merges to `main` now deploy.

## How a deploy works (`.github/workflows/deploy.yml`)

1. Build the API image once; every environment gets that exact image.
2. **Staging**: migrate → roll out API → publish web → smoke test.
3. **Production** (after approval): restore a **point-in-time clone of the live database**, run the new migrations against it, delete the clone. Only if that passes: migrate production → roll out → publish → smoke test.

Migrations run with a 5-second lock timeout, so a migration that would block live traffic fails instead.

**Reminder emails.** A daily EventBridge schedule (14:00 UTC) runs `dist/reminders.js` from the same image: it emails trainees and supervisors a week and two days before each BACB signing deadline, once per window, with no client details. SES starts in the sandbox (verified addresses only): request production access after the domain's DKIM records verify.

**Billing (Stripe).** Off until configured. To turn on: create the Pro product and price in Stripe, set `stripe_price_pro` in the environment's Terraform, put the secret key and webhook signing secret into the `<prefix>/stripe-secret-key` and `<prefix>/stripe-webhook-secret` secrets, and point a Stripe webhook at `https://<domain>/api/stripe/webhook` for `checkout.session.completed` and `customer.subscription.*`. Card data never reaches our servers.

**Database logins.** Migrations run as the RDS owner (password in Secrets Manager, readable only by the task execution role). The API never gets that password: it signs in as `fieldtrack_api` with 15-minute IAM tokens (`rds-db:connect` on the task role). That login has no privileges except switching to the row-level-security role per request (`db/migrations/007_api_login.sql`). Migrations always run before the new API rolls out, so the login exists before anything uses it.

## Recovering from a bad change (point-in-time restore)

```sh
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier fieldtrack-prod \
  --target-db-instance-identifier fieldtrack-prod-restore \
  --restore-time 2026-10-06T14:13:00Z \
  --db-subnet-group-name <db_subnet_group> --vpc-security-group-ids <db_security_group>
```
Verify the restored data, then point the API at it (or copy the affected rows back). Practice this once before launch.

## Known follow-ups
- Cross-region copies of backups and records for disaster recovery.
- SES for Cognito email (the default sender is limited to 50 emails/day). The SES domain identity already exists for reminder emails; after SES production access is granted, point Cognito's `email_configuration` at it.
