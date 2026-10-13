-- Which BACB standard a trainee is held to. Decided by their planned application date
-- (before 2027-01-01 → 2022 rules, on/after → 2027 rules), and which credential they pursue.
create type credential as enum ('bcba', 'bcaba');
create type rules_edition as enum ('2022', '2027');

alter table users
  add column credential credential,
  add column rules_edition rules_edition;

-- Existing trainees were tracked under the 2022 rules; keep that until they choose otherwise.
update users set credential = 'bcba', rules_edition = '2022' where role = 'trainee';

alter table users add constraint users_trainee_standard check (
  (role = 'trainee' and credential is not null and rules_edition is not null)
  or (role <> 'trainee' and credential is null and rules_edition is null));

-- Trainees may change only their own standard and profile fields (column-level grant + RLS).
grant update (full_name, bacb_id, fieldwork_type, credential, rules_edition) on users to fieldtrack_app;
create policy users_update_self on users for update to fieldtrack_app using (id = app_user()) with check (id = app_user());
