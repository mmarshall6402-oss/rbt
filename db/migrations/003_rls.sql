-- Row-level security. The API connects as the schema owner, then per request runs
--   SET LOCAL app.user_id / app.sub, SET LOCAL ROLE fieldtrack_app
-- so every query is filtered by Postgres itself, not just by API code.


do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'fieldtrack_app') then
    create role fieldtrack_app nologin;
  end if;
end $$;
grant fieldtrack_app to current_user; -- lets the connecting owner SET ROLE

grant usage on schema public to fieldtrack_app;
grant select, insert on users, supervisions to fieldtrack_app;
grant select, insert, update on entries, month_verifications to fieldtrack_app;
grant select on audit_log to fieldtrack_app;

create function app_user() returns uuid language sql stable as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
create function app_sub() returns text language sql stable as $$ select nullif(current_setting('app.sub', true), '') $$;

-- Helpers that must see past RLS run as the owner, with a pinned search_path.
create function is_supervisor(u uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from users where id = u and role = 'supervisor')
$$;
create function active_link(t uuid, s uuid, d date) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from supervisions where trainee_id = t and supervisor_id = s and starts_on <= d and (ends_on is null or ends_on >= d))
$$;
create function find_supervisor_by_code(code text) returns table (id uuid, full_name text) language sql stable security definer set search_path = public as $$
  select id, full_name from users where invite_code = code and role = 'supervisor'
$$;
alter function audit() security definer set search_path = public;
alter function month_locked(uuid, uuid, date) security definer set search_path = public;

-- ---- Immutable audit trail ----
create function audit_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only' using errcode = 'insufficient_privilege';
end $$;
create trigger audit_log_append_only before update or delete on audit_log for each row execute function audit_append_only();
create trigger audit_log_no_truncate before truncate on audit_log for each statement execute function audit_append_only();

-- ---- Policies ----
alter table users enable row level security;
alter table supervisions enable row level security;
alter table entries enable row level security;
alter table month_verifications enable row level security;
alter table audit_log enable row level security;

-- users: yourself, and people you are linked to by a supervision record
create policy users_self on users for select to fieldtrack_app using (id = app_user() or cognito_sub = app_sub());
create policy users_linked on users for select to fieldtrack_app using (exists (
  select 1 from supervisions s
  where (s.trainee_id = app_user() and s.supervisor_id = users.id) or (s.supervisor_id = app_user() and s.trainee_id = users.id)));
create policy users_signup on users for insert to fieldtrack_app with check (cognito_sub = app_sub() and role in ('trainee', 'supervisor'));

-- supervisions: both parties read; only the trainee creates the link (consent), only to a real supervisor
create policy supervisions_read on supervisions for select to fieldtrack_app using (app_user() in (trainee_id, supervisor_id));
create policy supervisions_link on supervisions for insert to fieldtrack_app with check (trainee_id = app_user() and is_supervisor(supervisor_id));

-- entries: trainee owns them; a supervisor reads only entries logged under them, dated inside an active supervision period
create policy entries_trainee_read on entries for select to fieldtrack_app using (trainee_id = app_user());
create policy entries_trainee_insert on entries for insert to fieldtrack_app
  with check (trainee_id = app_user() and active_link(trainee_id, supervisor_id, work_date));
create policy entries_trainee_update on entries for update to fieldtrack_app using (trainee_id = app_user())
  with check (trainee_id = app_user() and (deleted_at is not null or active_link(trainee_id, supervisor_id, work_date)));
create policy entries_supervisor_read on entries for select to fieldtrack_app
  using (supervisor_id = app_user() and active_link(trainee_id, supervisor_id, work_date));

-- month verifications: both parties read and update; only the trainee creates, unsigned by the supervisor
create policy mv_read on month_verifications for select to fieldtrack_app using (app_user() in (trainee_id, supervisor_id));
create policy mv_insert on month_verifications for insert to fieldtrack_app with check (trainee_id = app_user() and supervisor_signed_at is null);
create policy mv_update on month_verifications for update to fieldtrack_app
  using (app_user() in (trainee_id, supervisor_id)) with check (app_user() in (trainee_id, supervisor_id));

-- Each person can only set their own signature, and a supervisor-signed month never changes.
create function guard_verifications() returns trigger language plpgsql as $$
begin
  if old.supervisor_signed_at is not null then
    raise exception 'month is signed and locked' using errcode = 'object_not_in_prerequisite_state';
  end if;
  if app_user() is not null and (
       (new.supervisor_signed_at is distinct from old.supervisor_signed_at and app_user() <> new.supervisor_id)
    or (new.trainee_signed_at is distinct from old.trainee_signed_at and app_user() <> new.trainee_id)) then
    raise exception 'only the signer can sign' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger month_verifications_guard before update on month_verifications for each row execute function guard_verifications();

-- audit: trainees read the history of their own records; supervisors read history of entries logged under them
create policy audit_read on audit_log for select to fieldtrack_app using (
  coalesce(new_row ->> 'trainee_id', old_row ->> 'trainee_id')::uuid = app_user()
  or (table_name = 'entries' and coalesce(new_row ->> 'supervisor_id', old_row ->> 'supervisor_id')::uuid = app_user()));

