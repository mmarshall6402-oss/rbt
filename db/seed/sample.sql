-- Representative data for migration tests: loaded onto the base branch's schema, then the PR's
-- migrations run on top. Loads on any base from 001_init.sql onward.
-- Bases from 004_standards.sql on require a trainee's standard; plpgsql only plans the branch it runs.
do $$ begin
  if exists (select 1 from information_schema.columns where table_name = 'users' and column_name = 'credential') then
    insert into users (id, cognito_sub, email, full_name, role, fieldwork_type, credential, rules_edition) values
      ('11111111-1111-4111-8111-111111111111', 'seed-trainee', 'trainee@seed.test', 'Seed Trainee', 'trainee', 'concentrated', 'bcba', '2022'),
      ('22222222-2222-4222-8222-222222222222', 'seed-super', 'super@seed.test', 'Seed Supervisor', 'supervisor', null, null, null),
      ('33333333-3333-4333-8333-333333333333', 'seed-trainee2', 'trainee2@seed.test', 'Seed Trainee Two', 'trainee', 'supervised', 'bcba', '2022');
  else
    insert into users (id, cognito_sub, email, full_name, role, fieldwork_type) values
      ('11111111-1111-4111-8111-111111111111', 'seed-trainee', 'trainee@seed.test', 'Seed Trainee', 'trainee', 'concentrated'),
      ('22222222-2222-4222-8222-222222222222', 'seed-super', 'super@seed.test', 'Seed Supervisor', 'supervisor', null),
      ('33333333-3333-4333-8333-333333333333', 'seed-trainee2', 'trainee2@seed.test', 'Seed Trainee Two', 'trainee', 'supervised');
  end if;
end $$;

insert into supervisions (trainee_id, supervisor_id, starts_on, ends_on) values
  ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '2026-01-01', null),
  ('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', '2026-01-01', '2026-06-30');

insert into entries (trainee_id, supervisor_id, work_date, start_time, end_time, kind, restricted_minutes, is_group, contact, format, description)
select '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', d::date, '08:00', '12:00',
       case when extract(day from d)::int % 5 = 0 then 'supervised' else 'independent' end::entry_kind,
       30, false,
       case when extract(day from d)::int % 5 = 0 then 'contact' end::contact_type,
       case when extract(day from d)::int % 5 = 0 then 'online' end::supervision_format,
       'Seed session ' || to_char(d, 'YYYY-MM-DD')
from generate_series('2026-03-01'::date, '2026-08-31'::date, '1 day') d;

update entries set deleted_at = now() where work_date = '2026-08-31';

insert into month_verifications (trainee_id, supervisor_id, month, fieldwork_type, rules_version, summary, trainee_signed_at, supervisor_signed_at)
values ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '2026-03-01', 'concentrated', 'bacb-2022-01', '{}', now(), now());
