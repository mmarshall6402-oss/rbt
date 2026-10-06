-- Fieldtrack initial schema. Descriptions may contain PHI: run only on encrypted storage (RDS w/ KMS) under a BAA.
-- The API sets `app.user_id` per transaction (SET LOCAL app.user_id = '<uuid>') so audit rows record the actor.

begin;

create type user_role as enum ('trainee', 'supervisor', 'admin');
create type fieldwork_type as enum ('supervised', 'concentrated');
create type entry_kind as enum ('independent', 'supervised');
create type contact_type as enum ('contact', 'observation');
create type supervision_format as enum ('in_person', 'online');

create table organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table users (
  id             uuid primary key default gen_random_uuid(),
  cognito_sub    text not null unique,
  email          text not null unique,
  full_name      text not null,
  role           user_role not null,
  bacb_id        text,
  fieldwork_type fieldwork_type, -- trainees only
  created_at     timestamptz not null default now(),
  check (role = 'trainee' or fieldwork_type is null)
);

-- Which supervisor oversees which trainee, and for when. Drives API authorization.
create table supervisions (
  id              uuid primary key default gen_random_uuid(),
  trainee_id      uuid not null references users,
  supervisor_id   uuid not null references users,
  organization_id uuid references organizations, -- null for independent supervisors
  starts_on       date not null,
  ends_on         date,
  created_at      timestamptz not null default now(),
  check (trainee_id <> supervisor_id),
  check (ends_on is null or ends_on >= starts_on),
  unique (trainee_id, supervisor_id, starts_on)
);
create index on supervisions (supervisor_id);

create table entries (
  id                 uuid primary key default gen_random_uuid(),
  trainee_id         uuid not null references users,
  supervisor_id      uuid not null references users,
  organization_id    uuid references organizations,
  work_date          date not null,
  start_time         time(0) not null,
  end_time           time(0) not null,
  kind               entry_kind not null,
  restricted_minutes integer not null default 0 check (restricted_minutes >= 0),
  is_group           boolean not null default false,
  contact            contact_type,
  format             supervision_format,
  description        text not null default '', -- PHI
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz, -- soft delete: certification records are never hard-deleted
  check (end_time > start_time),
  check (restricted_minutes * 60 <= extract(epoch from end_time - start_time)),
  check (kind = 'supervised' or (not is_group and contact is null and format is null))
);
create index entries_trainee_month on entries (trainee_id, work_date) where deleted_at is null;

-- Monthly sign-off. Stores the rules version + computed summary so later rule changes never alter a signed month.
create table month_verifications (
  id                   uuid primary key default gen_random_uuid(),
  trainee_id           uuid not null references users,
  supervisor_id        uuid not null references users,
  month                date not null check (extract(day from month) = 1),
  fieldwork_type       fieldwork_type not null,
  rules_version        text not null,
  summary              jsonb not null,
  trainee_signed_at    timestamptz,
  supervisor_signed_at timestamptz,
  pdf_s3_key           text,
  created_at           timestamptz not null default now(),
  unique (trainee_id, supervisor_id, month)
);

-- Append-only audit trail (HIPAA). Grant the app role INSERT/SELECT only; never UPDATE/DELETE.
create table audit_log (
  id         bigint generated always as identity primary key,
  table_name text not null,
  row_id     uuid not null,
  action     text not null,
  actor_id   uuid,
  old_row    jsonb,
  new_row    jsonb,
  at         timestamptz not null default now()
);
create index on audit_log (table_name, row_id);

create function audit() returns trigger language plpgsql as $$
begin
  insert into audit_log (table_name, row_id, action, actor_id, old_row, new_row)
  values (tg_table_name, coalesce(new.id, old.id), tg_op, nullif(current_setting('app.user_id', true), '')::uuid,
          case when tg_op <> 'INSERT' then to_jsonb(old) end, case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

create trigger entries_audit after insert or update or delete on entries for each row execute function audit();
create trigger month_verifications_audit after insert or update or delete on month_verifications for each row execute function audit();
create trigger supervisions_audit after insert or update or delete on supervisions for each row execute function audit();

-- Block hard deletes and edits to entries in a supervisor-signed month; keep updated_at current.
create function month_locked(t uuid, s uuid, d date) returns boolean language sql stable as $$
  select exists (select 1 from month_verifications
                 where trainee_id = t and supervisor_id = s and month = date_trunc('month', d)::date and supervisor_signed_at is not null)
$$;

create function guard_entries() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'entries are soft-deleted: set deleted_at instead';
  end if;
  if month_locked(new.trainee_id, new.supervisor_id, new.work_date)
     or (tg_op = 'UPDATE' and month_locked(old.trainee_id, old.supervisor_id, old.work_date)) then
    raise exception 'month is signed and locked' using errcode = 'object_not_in_prerequisite_state'; -- 55000, API maps to 409
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger entries_guard before insert or update or delete on entries for each row execute function guard_entries();

commit;
