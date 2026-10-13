-- 1. Signing and editing can't interleave: an entry write takes a share lock on that form's verification row,
--    and signing takes an update lock, so a supervisor never locks a month around an entry they didn't see.
create or replace function month_locked(t uuid, s uuid, d date) returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare signed timestamptz;
begin
  select supervisor_signed_at into signed from month_verifications
    where trainee_id = t and supervisor_id = s and month = date_trunc('month', d)::date for share;
  return signed is not null;
end $$;

-- 2. A trainee's signature attests to the hours as they were. Changing them withdraws it (until they re-sign).
create function withdraw_trainee_signature() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and (old.work_date, old.start_time, old.end_time, old.kind, old.restricted_minutes, old.is_group, old.contact,
                           old.observed_async, old.supervisor_id, old.deleted_at)
                       is not distinct from (new.work_date, new.start_time, new.end_time, new.kind, new.restricted_minutes, new.is_group, new.contact,
                           new.observed_async, new.supervisor_id, new.deleted_at) then
    return new; -- description-only edits don't change what was signed
  end if;
  update month_verifications set trainee_signed_at = null
    where trainee_signed_at is not null and supervisor_signed_at is null and trainee_id = new.trainee_id
      and ((supervisor_id = new.supervisor_id and month = date_trunc('month', new.work_date)::date)
        or (tg_op = 'UPDATE' and supervisor_id = old.supervisor_id and month = date_trunc('month', old.work_date)::date));
  return new;
end $$;
create trigger entries_withdraw_signature after insert or update on entries for each row execute function withdraw_trainee_signature();

-- 3. Trainees can end a supervision link (e.g. changed supervisors), which ends the old supervisor's access to new hours.
grant update (ends_on) on supervisions to fieldtrack_app;
create policy supervisions_end on supervisions for update to fieldtrack_app using (trainee_id = app_user()) with check (trainee_id = app_user());
