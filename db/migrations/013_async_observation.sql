-- An independent session the supervisor later observed by recording (no real-time feedback):
-- counts toward observation with a client only (Handbook), never toward supervised hours or contacts.
alter table entries add column observed_async boolean not null default false;
alter table entries add constraint entries_async_observation_independent check (not observed_async or kind = 'independent');
