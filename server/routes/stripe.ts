import { Hono } from 'hono'
import Stripe from 'stripe'
import { getStripe } from '../lib/stripe'
import { getDb } from '../db/client'
import type { Env } from '../index'
import { tenantAuthMiddleware } from '../middleware/tenant-auth'
import { checkRateLimit } from '../lib/rate-limit'

export const stripeRouter = new Hono<{ Bindings: Env }>()

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
  const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown'
  const { allowed, retryAfterMs } = checkRateLimit(ip)
  if (!allowed) {
    return c.json(
      { error: `Too many payment requests — retry in ${Math.ceil(retryAfterMs / 1000)}s` },
      429
    )
  }

  const { tenant_id, lease_id, amount_cents, payment_method_id, description } = await c.req.json()
  if (!tenant_id || !lease_id || !amount_cents || !payment_method_id) {
    return c.json({ error: 'tenant_id, lease_id, amount_cents, payment_method_id required' }, 400)
  }
  if (!Number.isInteger(amount_cents)) return c.json({ error: 'amount_cents must be an integer' }, 400)
  if (amount_cents < 50) return c.json({ error: 'Minimum payment is $0.50' }, 400)

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
  if (insertErr) return c.json({ error: 'Failed to record payment' }, 500)

  return c.json({ payment_intent_id: pi.id, status: pi.status })
})
