-- The API's own login. It has no privileges of its own: the only thing it can do is SET ROLE fieldtrack_app,
-- which the API does at the start of every request. The owner login is kept for migrations only.
-- On RDS it signs in with short-lived IAM tokens, so no password exists to leak. (Roles are cluster-wide.)
do $$
begin
  if not exists (select from pg_roles where rolname = 'fieldtrack_api') then
    create role fieldtrack_api login noinherit;
  end if;
  if exists (select from pg_roles where rolname = 'rds_iam') then
    grant rds_iam to fieldtrack_api;
  end if;
  execute format('grant connect on database %I to fieldtrack_api', current_database());
end $$;

grant fieldtrack_app to fieldtrack_api with inherit false, set true;
