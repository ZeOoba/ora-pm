import { Hono } from 'hono'
import { getStripe } from '../lib/stripe'
import { getDb } from '../db/client'
import type { Env } from '../index'

export const stripeRouter = new Hono<{ Bindings: Env }>()

// POST /api/stripe/customer — create Stripe customer + store on tenant record
stripeRouter.post('/customer', async (c) => {
  const { tenant_id, email, name } = await c.req.json()
  if (!tenant_id) return c.json({ error: 'tenant_id required' }, 400)

  const stripe = getStripe(c.env.STRIPE_SECRET_KEY)
  const db = getDb(c.env)

  // Check if already has a customer ID
  const { data: tenant } = await db.from('tenants').select('stripe_customer_id').eq('id', tenant_id).single()
  if (tenant?.stripe_customer_id) {
    return c.json({ customer_id: tenant.stripe_customer_id })
  }

  const customer = await stripe.customers.create({ email, name, metadata: { tenant_id } })

  await db.from('tenants').update({ stripe_customer_id: customer.id }).eq('id', tenant_id)

  return c.json({ customer_id: customer.id })
})

// POST /api/stripe/setup-intent — create SetupIntent for Financial Connections bank linking
stripeRouter.post('/setup-intent', async (c) => {
  const { tenant_id } = await c.req.json()
  if (!tenant_id) return c.json({ error: 'tenant_id required' }, 400)

  const stripe = getStripe(c.env.STRIPE_SECRET_KEY)
  const db = getDb(c.env)

  const { data: tenant } = await db.from('tenants').select('stripe_customer_id').eq('id', tenant_id).single()
  if (!tenant?.stripe_customer_id) return c.json({ error: 'No Stripe customer — call /customer first' }, 400)

  const setupIntent = await stripe.setupIntents.create({
    customer: tenant.stripe_customer_id,
    payment_method_types: ['us_bank_account'],
    payment_method_options: {
      us_bank_account: {
        financial_connections: { permissions: ['payment_method'] },
      },
    },
  })

  return c.json({ client_secret: setupIntent.client_secret })
})

// POST /api/stripe/payment-intent — create PaymentIntent for ACH charge
stripeRouter.post('/payment-intent', async (c) => {
  const { tenant_id, lease_id, amount_cents, payment_method_id, description } = await c.req.json()
  if (!tenant_id || !lease_id || !amount_cents || !payment_method_id) {
    return c.json({ error: 'tenant_id, lease_id, amount_cents, payment_method_id required' }, 400)
  }
  if (amount_cents < 50) return c.json({ error: 'Minimum payment is $0.50' }, 400)

  const stripe = getStripe(c.env.STRIPE_SECRET_KEY)
  const db = getDb(c.env)

  const { data: tenant } = await db.from('tenants').select('stripe_customer_id').eq('id', tenant_id).single()
  if (!tenant?.stripe_customer_id) return c.json({ error: 'No Stripe customer' }, 400)

  const pi = await stripe.paymentIntents.create({
    amount: amount_cents,
    currency: 'usd',
    customer: tenant.stripe_customer_id,
    payment_method: payment_method_id,
    payment_method_types: ['us_bank_account'],
    confirm: true,
    description: description ?? `Rent payment — lease ${lease_id}`,
    metadata: { lease_id, tenant_id },
  })

  // Record payment in DB immediately as pending
  await db.from('payments').insert({
    lease_id,
    payment_date: new Date().toISOString().slice(0, 10),
    amount: amount_cents / 100,
    method: 'ach_stripe',
    stripe_payment_intent_id: pi.id,
    stripe_status: pi.status,
    notes: description ?? null,
  })

  return c.json({ payment_intent_id: pi.id, status: pi.status })
})
