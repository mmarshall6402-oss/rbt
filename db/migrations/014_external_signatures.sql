-- Forms signed outside Fieldtrack (on paper or in another tracker), e.g. months imported from elsewhere.
-- The trainee records the date both signatures were complete; it decides whether the month met the signing deadline.
create table external_signatures (
  id            uuid primary key default gen_random_uuid(),
  trainee_id    uuid not null references users,
  supervisor_id uuid not null references users,
  month         date not null check (extract(day from month) = 1),
  signed_on     date not null,
  created_at    timestamptz not null default now(),
  unique (trainee_id, supervisor_id, month)
);
create trigger external_signatures_audit after insert or update or delete on external_signatures for each row execute function audit();
alter table external_signatures enable row level security;
grant select, insert, delete on external_signatures to fieldtrack_app;
create policy external_read on external_signatures for select to fieldtrack_app using (app_user() in (trainee_id, supervisor_id));
create policy external_write on external_signatures for insert to fieldtrack_app with check (
  trainee_id = app_user() and exists (select 1 from supervisions s where s.trainee_id = app_user() and s.supervisor_id = external_signatures.supervisor_id));
create policy external_remove on external_signatures for delete to fieldtrack_app using (trainee_id = app_user());
