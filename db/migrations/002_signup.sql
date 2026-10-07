-- Supervisors share an invite code; a trainee enters it to link themselves (trainee-initiated = trainee consents to sharing).
alter table users
  add column invite_code text unique,
  add constraint users_invite_code_role check (invite_code is null or role = 'supervisor');
