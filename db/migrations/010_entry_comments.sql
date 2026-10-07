-- Review comments on entries ("end time should be 3:30"). Visible to whoever can see the entry (entries RLS applies
-- inside the subquery); written by the trainee or the entry's supervisor; only resolved_at can change afterward.
create table entry_comments (
  id          uuid primary key default gen_random_uuid(),
  entry_id    uuid not null references entries,
  author_id   uuid not null references users,
  body        text not null check (length(body) between 1 and 2000),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);
create index entry_comments_entry on entry_comments (entry_id);
create trigger entry_comments_audit after insert or update or delete on entry_comments for each row execute function audit();

alter table entry_comments enable row level security;
grant select, insert on entry_comments to fieldtrack_app;
grant update (resolved_at) on entry_comments to fieldtrack_app;
create policy comments_read on entry_comments for select to fieldtrack_app using (exists (select 1 from entries e where e.id = entry_id));
create policy comments_write on entry_comments for insert to fieldtrack_app with check (
  author_id = app_user() and exists (select 1 from entries e where e.id = entry_id and app_user() in (e.trainee_id, e.supervisor_id)));
create policy comments_resolve on entry_comments for update to fieldtrack_app
  using (exists (select 1 from entries e where e.id = entry_id and app_user() in (e.trainee_id, e.supervisor_id)));
