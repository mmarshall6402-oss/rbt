-- Final Fieldwork Verification: one per trainee–supervisor pair, signed by the supervisor at the end of fieldwork.
-- Totals come from the signed (locked) monthly forms; the snapshot records exactly what was attested.
create table final_verifications (
  id                   uuid primary key default gen_random_uuid(),
  trainee_id           uuid not null references users,
  supervisor_id        uuid not null references users,
  summary              jsonb not null,
  attestation          text not null check (length(attestation) <= 50),
  supervisor_signature text not null check (length(supervisor_signature) <= 200),
  supervisor_signed_at timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  unique (trainee_id, supervisor_id)
);
create trigger final_verifications_audit after insert or update or delete on final_verifications for each row execute function audit();

alter table final_verifications enable row level security;
grant select, insert, update on final_verifications to fieldtrack_app;
create policy final_read on final_verifications for select to fieldtrack_app using (app_user() in (trainee_id, supervisor_id));
create policy final_sign on final_verifications for insert to fieldtrack_app with check (
  supervisor_id = app_user() and exists (select 1 from supervisions s where s.trainee_id = final_verifications.trainee_id and s.supervisor_id = app_user()));
create policy final_resign on final_verifications for update to fieldtrack_app using (supervisor_id = app_user()) with check (supervisor_id = app_user());
