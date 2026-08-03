import { Hono } from 'hono'
import Stripe from 'stripe'
import { getStripe } from '../lib/stripe'
import { getDb } from '../db/client'
import type { Env } from '../index'
import { tenantAuthMiddleware } from '../middleware/tenant-auth'
import { checkRateLimit } from '../lib/rate-limit'
import { PaymentIntentClientRequestIdSchema } from '../lib/schemas'

export const stripeRouter = new Hono<{ Bindings: Env }>()

// $50,000 — hard ceiling on a single ACH payment-intent request (OI-040).
// Independent of the outstanding-balance cap below; this bounds the blast
// radius of a single request regardless of what the lease happens to owe.
const MAX_PAYMENT_CENTS = 5_000_000

// Router-wide gate: any future stripe endpoint is tenant-authenticated by
// default (this router is in ADMIN_EXEMPT, so this is its only auth layer).
// The Stripe webhook lives on its own router (/api/webhooks) — not gated here.
stripeRouter.use('/*', tenantAuthMiddleware)

// POST /api/stripe/customer — create Stripe customer + store on tenant record
stripeRouter.post('/customer', async (c) => {
  const userId = c.get('tenantUserId')
  const { tenant_id, email, name } = await c.req.json()
  if (!tenant_id) return c.json({ error: 'tenant_id required' }, 400)

  const stripe = getStripe(c.env.STRIPE_SECRET_KEY)
  const db = getDb(c.env)

  // Resolve the AUTHENTICATED tenant and verify the request-body tenant_id
  // belongs to them (IDOR guard — OI-018)
  const { data: tenant, error: tenantErr } = await db.from('tenants').select('id, stripe_customer_id').eq('auth_user_id', userId).single()
  if (tenantErr || !tenant) return c.json({ error: 'Tenant not found' }, 404)
  if (tenant.id !== tenant_id) return c.json({ error: 'Forbidden' }, 403)
  if (tenant?.stripe_customer_id) {
    return c.json({ customer_id: tenant.stripe_customer_id })
  }

  let customer: Stripe.Customer
  try {
    customer = await stripe.customers.create({ email, name, metadata: { tenant_id: tenant.id } })
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) return c.json({ error: err.message }, 400)
    throw err
  }

  const { error: updateErr } = await db.from('tenants').update({ stripe_customer_id: customer.id }).eq('id', tenant.id)
  if (updateErr) return c.json({ error: 'Failed to save customer ID' }, 500)

  return c.json({ customer_id: customer.id })
})

// POST /api/stripe/setup-intent — create SetupIntent for Financial Connections bank linking
stripeRouter.post('/setup-intent', async (c) => {
  const userId = c.get('tenantUserId')
  const { tenant_id } = await c.req.json()
  if (!tenant_id) return c.json({ error: 'tenant_id required' }, 400)

  const stripe = getStripe(c.env.STRIPE_SECRET_KEY)
  const db = getDb(c.env)

  // Resolve the AUTHENTICATED tenant and verify the request-body tenant_id
  // belongs to them (IDOR guard — OI-018)
  const { data: tenant, error: tenantErr } = await db.from('tenants').select('id, stripe_customer_id').eq('auth_user_id', userId).single()
  if (tenantErr || !tenant) return c.json({ error: 'Tenant not found' }, 404)
  if (tenant.id !== tenant_id) return c.json({ error: 'Forbidden' }, 403)
  if (!tenant?.stripe_customer_id) return c.json({ error: 'No Stripe customer — call /customer first' }, 400)

  let setupIntent: Stripe.SetupIntent
  try {
    setupIntent = await stripe.setupIntents.create({
      customer: tenant.stripe_customer_id,
      payment_method_types: ['us_bank_account'],
      payment_method_options: {
        us_bank_account: {
          financial_connections: { permissions: ['payment_method'] },
          verification_method: 'instant',
        },
      },
    })
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) return c.json({ error: err.message }, 400)
    throw err
  }

  return c.json({ client_secret: setupIntent.client_secret })
})

// POST /api/stripe/payment-intent — create PaymentIntent for ACH charge
stripeRouter.post('/payment-intent', async (c) => {
  const userId = c.get('tenantUserId')
  // CF-Connecting-IP is stamped by Cloudflare's edge and cannot be spoofed by
  // the client; X-Forwarded-For CAN be (OI-038, IP-handling slice), so it is
  // never used as a rate-limit key. Fall back to the authenticated tenant's
  // user id — not an absent-IP sentinel like 'unknown', which would let every
  // client missing the header share a single rate-limit bucket. checkRateLimit's
  // internals are unchanged here — that's Task 6's scope.
  const ip = c.req.header('CF-Connecting-IP') ?? userId
  const { allowed, retryAfterMs } = checkRateLimit(ip)
  if (!allowed) {
    return c.json(
      { error: `Too many payment requests — retry in ${Math.ceil(retryAfterMs / 1000)}s` },
      429
    )
  }

  const { tenant_id, lease_id, amount_cents, payment_method_id, description, client_request_id } = await c.req.json()
  if (!tenant_id || !lease_id || !amount_cents || !payment_method_id || !client_request_id) {
    return c.json({ error: 'tenant_id, lease_id, amount_cents, payment_method_id, client_request_id required' }, 400)
  }
  const clientRequestIdCheck = PaymentIntentClientRequestIdSchema.safeParse(client_request_id)
  if (!clientRequestIdCheck.success) return c.json({ error: 'client_request_id must be a valid UUID' }, 400)
  if (!Number.isInteger(amount_cents)) return c.json({ error: 'amount_cents must be an integer' }, 400)
  if (amount_cents < 50) return c.json({ error: 'Minimum payment is $0.50' }, 400)
  if (amount_cents > MAX_PAYMENT_CENTS) return c.json({ error: 'Amount exceeds maximum payment of $50,000' }, 422)

  const stripe = getStripe(c.env.STRIPE_SECRET_KEY)
  const db = getDb(c.env)

  // Resolve the AUTHENTICATED tenant and verify the request-body tenant_id
  // belongs to them (IDOR guard — OI-018)
  const { data: tenant, error: tenantErr } = await db.from('tenants').select('id, stripe_customer_id').eq('auth_user_id', userId).single()
  if (tenantErr || !tenant) return c.json({ error: 'Tenant not found' }, 404)
  if (tenant.id !== tenant_id) return c.json({ error: 'Forbidden' }, 403)
  if (!tenant?.stripe_customer_id) return c.json({ error: 'No Stripe customer' }, 400)

  // Verify this lease belongs to this tenant (IDOR guard) — before any Stripe
  // call, so a cross-tenant lease_id can never reach the charge or the
  // payments insert (same pattern as /portal/autopay)
  const { data: lease } = await db.from('leases').select('id, tenant_id').eq('id', lease_id).single()
  if (!lease || lease.tenant_id !== tenant.id) return c.json({ error: 'Lease not found' }, 404)

  // Amount cap (OI-040): a payment can never exceed what the lease actually
  // owes. Same ar_ledger.balance query shape as cron.ts's autopay debit cap
  // (OI-034) — balance is US dollars, amount_cents is cents, so convert
  // before comparing. A query failure means the balance is UNKNOWN, so this
  // never falls through to a blind allow.
  const { data: arRows, error: arErr } = await db
    .from('ar_ledger')
    .select('balance')
    .eq('lease_id', lease.id)
    .limit(1)
  if (arErr) return c.json({ error: 'Failed to verify outstanding balance' }, 500)

  const outstandingBalanceCents = Math.round((arRows?.[0]?.balance ?? 0) * 100)
  if (outstandingBalanceCents <= 0) return c.json({ error: 'No balance due' }, 422)
  if (amount_cents > outstandingBalanceCents) return c.json({ error: 'Amount exceeds outstanding balance' }, 422)

  let pi: Stripe.PaymentIntent
  try {
    pi = await stripe.paymentIntents.create({
      amount: amount_cents,
      currency: 'usd',
      customer: tenant.stripe_customer_id,
      payment_method: payment_method_id,
      payment_method_types: ['us_bank_account'],
      confirm: true,
      setup_future_usage: 'off_session' as const,
      description: description ?? `Rent payment — lease ${lease_id}`,
      metadata: { lease_id: lease.id, tenant_id: tenant.id },
    }, {
      // Deterministic per tenant+client_request_id (OI-035 route half): a
      // client retry after a network timeout reuses the same client_request_id
      // verbatim, so Stripe returns the original PaymentIntent from its
      // idempotency cache instead of minting a second one.
      idempotencyKey: `pi:${tenant.id}:${client_request_id}`,
    })
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) return c.json({ error: err.message }, 400)
    throw err
  }

  // Record payment in DB immediately as pending
  const { error: insertErr } = await db.from('payments').insert({
    lease_id: lease.id,
    payment_date: new Date().toISOString().slice(0, 10),
    amount: amount_cents / 100,
    method: 'ach_stripe',
    stripe_payment_intent_id: pi.id,
    stripe_status: pi.status,
    notes: description ?? null,
  })
  if (insertErr) {
    if (insertErr.code === '23505') {
      // Duplicate stripe_payment_intent_id (payments_stripe_pi_uniq, Task 1) —
      // a retry with the same client_request_id already recorded this exact
      // PaymentIntent (Stripe's idempotency cache already returned the same
      // pi.id above). This is the retry succeeding, not a failure.
      return c.json({ payment_intent_id: pi.id, status: pi.status, deduped: true })
    }
    return c.json({ error: 'Failed to record payment' }, 500)
  }

  return c.json({ payment_intent_id: pi.id, status: pi.status })
})
