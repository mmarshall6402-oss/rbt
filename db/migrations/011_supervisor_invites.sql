-- A trainee can invite their supervisor by link instead of waiting for an invite code.
-- Creating the invite is the trainee's consent; accepting it links that supervisor, once, within 30 days.
create table supervisor_invites (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text not null unique,           -- sha256 of the token; the token itself only lives in the link
  trainee_id  uuid not null references users,
  starts_on   date not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '30 days',
  accepted_by uuid references users,
  accepted_at timestamptz
);
create trigger supervisor_invites_audit after insert or update or delete on supervisor_invites for each row execute function audit();
alter table supervisor_invites enable row level security;
grant select, insert on supervisor_invites to fieldtrack_app;
create policy invites_own on supervisor_invites for select to fieldtrack_app using (trainee_id = app_user());
create policy invites_create on supervisor_invites for insert to fieldtrack_app with check (
  trainee_id = app_user() and accepted_by is null and expires_at <= now() + interval '30 days');

-- Who sent an open invite (shown to the supervisor before they accept). Reveals only the trainee's name.
create function invite_info(hash text) returns table (trainee_name text) language sql stable security definer set search_path = public as $$
  select u.full_name from supervisor_invites i join users u on u.id = i.trainee_id
  where i.token_hash = hash and i.accepted_at is null and i.expires_at > now()
$$;

-- Accept as the current user, who must be a supervisor. Returns the trainee id, or null if the invite isn't valid.
create function accept_invite(hash text) returns uuid language plpgsql security definer set search_path = public as $$
declare inv supervisor_invites;
begin
  if not is_supervisor(app_user()) then return null; end if;
  update supervisor_invites set accepted_by = app_user(), accepted_at = now()
    where token_hash = hash and accepted_at is null and expires_at > now() returning * into inv;
  if inv is null then return null; end if;
  insert into supervisions (trainee_id, supervisor_id, starts_on)
    select inv.trainee_id, app_user(), inv.starts_on
    where not exists (select 1 from supervisions where trainee_id = inv.trainee_id and supervisor_id = app_user());
  return inv.trainee_id;
end $$;
revoke all on function invite_info(text), accept_invite(text) from public;
grant execute on function invite_info(text), accept_invite(text) to fieldtrack_app;
