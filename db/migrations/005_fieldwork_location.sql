-- Where fieldwork happens: printed on every Monthly Fieldwork Verification Form.
alter table users
  add column fieldwork_state text check (length(fieldwork_state) <= 100),
  add column fieldwork_country text check (length(fieldwork_country) <= 100);

grant update (fieldwork_state, fieldwork_country) on users to fieldtrack_app;
