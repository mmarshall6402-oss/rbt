-- Stripe subscriptions. Written only from verified Stripe webhooks, through a definer function;
-- users can read their own row. Card details never touch our database (Stripe Checkout holds them).
create table subscriptions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null unique references users,
  stripe_customer_id text not null unique,
  status             text not null default 'none',  -- Stripe subscription status: active, trialing, past_due, canceled, ...
  current_period_end timestamptz,
  updated_at         timestamptz not null default now()
);
create trigger subscriptions_audit after insert or update or delete on subscriptions for each row execute function audit();
alter table subscriptions enable row level security;
grant select on subscriptions to fieldtrack_app;
create policy subscriptions_own on subscriptions for select to fieldtrack_app using (user_id = app_user());

-- Checkout completed: remember which Stripe customer belongs to which user.
create function link_stripe_customer(u uuid, customer text) returns void language sql security definer set search_path = public as $$
  insert into subscriptions (user_id, stripe_customer_id) values (u, customer)
  on conflict (user_id) do update set stripe_customer_id = excluded.stripe_customer_id, updated_at = now()
$$;
-- Subscription created/updated/deleted: record its status for that customer.
create function sync_stripe_subscription(customer text, new_status text, period_end timestamptz) returns boolean language sql security definer set search_path = public as $$
  update subscriptions set status = new_status, current_period_end = period_end, updated_at = now() where stripe_customer_id = customer returning true
$$;
revoke all on function link_stripe_customer(uuid, text), sync_stripe_subscription(text, text, timestamptz) from public;
grant execute on function link_stripe_customer(uuid, text), sync_stripe_subscription(text, text, timestamptz) to fieldtrack_app;
