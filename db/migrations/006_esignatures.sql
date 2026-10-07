-- Electronic signatures: the name each person typed, and which attestation text they agreed to (intent to sign).
alter table month_verifications
  add column trainee_signature text check (length(trainee_signature) <= 200),
  add column supervisor_signature text check (length(supervisor_signature) <= 200),
  add column attestation text check (length(attestation) <= 50);

create or replace function guard_verifications() returns trigger language plpgsql as $$
begin
  if old.supervisor_signed_at is not null then
    raise exception 'month is signed and locked' using errcode = 'object_not_in_prerequisite_state';
  end if;
  if app_user() is not null and (
       ((new.supervisor_signed_at, new.supervisor_signature) is distinct from (old.supervisor_signed_at, old.supervisor_signature) and app_user() <> new.supervisor_id)
    or ((new.trainee_signed_at, new.trainee_signature) is distinct from (old.trainee_signed_at, old.trainee_signature) and app_user() <> new.trainee_id)) then
    raise exception 'only the signer can sign' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
