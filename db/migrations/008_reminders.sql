-- Deadline reminder emails: per-user opt-out, and a record of what was sent so a reminder never goes out twice.
alter table users add column email_reminders boolean not null default true;
grant update (email_reminders) on users to fieldtrack_app;

create table reminders_sent (
  user_id uuid not null references users,
  kind    text not null,  -- e.g. 'trainee-sign:2026-09:week'
  sent_at timestamptz not null default now(),
  primary key (user_id, kind)
);
-- Written only by the reminders job (owner login); the API role has no access.
alter table reminders_sent enable row level security;
