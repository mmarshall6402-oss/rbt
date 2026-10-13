import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import Stripe from 'stripe';
import type { DB } from './db.js';

export interface Billing { stripe: Stripe; webhookSecret: string; pricePro: string; appUrl: string }

export function billingFromEnv(env = process.env): Billing | undefined {
  const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_PRO, APP_URL } = env;
  if (!STRIPE_SECRET_KEY?.trim()) return undefined; // billing stays off until Stripe is configured
  if (!STRIPE_WEBHOOK_SECRET?.trim() || !STRIPE_PRICE_PRO || !APP_URL) { // half-configured: keep the API up, billing off
    console.error('Billing disabled: Stripe needs STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_PRO and APP_URL too');
    return undefined;
  }
  return { stripe: new Stripe(STRIPE_SECRET_KEY.trim()), webhookSecret: STRIPE_WEBHOOK_SECRET.trim(), pricePro: STRIPE_PRICE_PRO, appUrl: APP_URL };
}

const SUBSCRIPTION_EVENTS = new Set(['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']);
const id = (x: string | { id: string } | null) => (typeof x === 'string' ? x : x?.id ?? null);

/**
 * Stripe webhook: the only writer of subscription state. Unsigned or tampered requests are rejected before
 * anything runs; writes go through definer functions as the restricted role (no user is signed in here).
 */
export function stripeWebhook(app: FastifyInstance, db: Kysely<DB>, billing: Billing) {
  app.register(async hook => {
    hook.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body)); // signature covers the raw bytes
    hook.post('/stripe/webhook', async (req, reply) => {
      let event: Stripe.Event;
      try { event = billing.stripe.webhooks.constructEvent(req.body as Buffer, String(req.headers['stripe-signature'] ?? ''), billing.webhookSecret) }
      catch { return reply.code(400).send({ error: 'Invalid signature' }) }

      await db.transaction().execute(async trx => {
        await sql`select set_config('role', 'fieldtrack_app', true)`.execute(trx);
        const link = (userId: string | null | undefined, customer: string | null) =>
          userId && customer ? sql`select link_stripe_customer(${userId}::uuid, ${customer})`.execute(trx) : undefined;
        if (event.type === 'checkout.session.completed') {
          const s = event.data.object;
          await link(s.client_reference_id, id(s.customer));
        } else if (SUBSCRIPTION_EVENTS.has(event.type)) {
          const sub = event.data.object as Stripe.Subscription, customer = id(sub.customer)!;
          await link(sub.metadata.userId, customer); // events can arrive before checkout.session.completed
          const end = sub.items.data[0]?.current_period_end;
          await sql`select sync_stripe_subscription(${customer}, ${event.type.endsWith('deleted') ? 'canceled' : sub.status}, ${end ? new Date(end * 1000) : null})`.execute(trx);
        }
      });
      return { received: true };
    });
  });
}
