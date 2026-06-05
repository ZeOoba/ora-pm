import { Hono } from 'hono'
import { getDb } from '../db/client'
import { getStripe } from '../lib/stripe'
import { buildMonthlyCharges } from '../lib/billing'
import { cronAuthMiddleware } from '../middleware/auth'

type Env = {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  CRON_SECRET: string
  STRIPE_SECRET_KEY: string
}

export const cronRouter = new Hono<{ Bindings: Env }>()

cronRouter.use('/*', cronAuthMiddleware)

// POST /api/cron/monthly-billing?year=2026&month=6
cronRouter.post('/monthly-billing', async (c) => {
  const db = getDb(c.env)
  const now = new Date()
  const year  = parseInt(c.req.query('year')  ?? String(now.getFullYear()))
  const month = parseInt(c.req.query('month') ?? String(now.getMonth() + 1))

  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    return c.json({ error: 'Invalid year or month' }, 400)
  }

  const periodStartStr = `${year}-${String(month).padStart(2, '0')}-01`
  const lastDay = new Date(year, month, 0).getDate()
  const periodEndStr = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

  const { data: leases, error: leaseErr } = await db
    .from('leases')
    .select('id, tenant_id, base_rent_monthly, cam_estimate_monthly, start_date, autopay_enabled, autopay_payment_method_id, tenants(id, stripe_customer_id)')
    .eq('status', 'active')

  if (leaseErr) return c.json({ error: leaseErr.message }, 500)

  let posted = 0, skipped = 0, errors = 0
  const errorMessages: string[] = []

  for (const lease of (leases ?? [])) {
    const { charges } = buildMonthlyCharges({
      leaseId: lease.id,
      baseRentMonthly: lease.base_rent_monthly,
      camEstimateMonthly: lease.cam_estimate_monthly,
      leaseStartDate: lease.start_date,
      periodYear: year,
      periodMonth: month,
    })

    for (const charge of charges) {
      const { error: insErr } = await db.from('charges').insert(charge)
      if (insErr) {
        if (insErr.code === '23505') {
          skipped++ // unique constraint = already posted (idempotent)
        } else {
          errors++
          errorMessages.push(`lease ${lease.id}: ${insErr.message}`)
        }
      } else {
        posted++
      }
    }

    // Auto-pay: create a PaymentIntent if autopay is enabled and bank account is saved
    const tenant = Array.isArray(lease.tenants) ? lease.tenants[0] : lease.tenants
    if (lease.autopay_enabled && lease.autopay_payment_method_id && tenant?.stripe_customer_id) {
      const { data: openCharges } = await db
        .from('charges')
        .select('amount')
        .eq('lease_id', lease.id)
        .gte('due_date', periodStartStr)
        .lte('due_date', periodEndStr)

      const totalAmount = (openCharges ?? []).reduce((s: number, ch: { amount: number }) => s + ch.amount, 0)
      if (totalAmount > 0) {
        try {
          const stripe = getStripe(c.env.STRIPE_SECRET_KEY)
          const pi = await stripe.paymentIntents.create({
            amount: Math.round(totalAmount * 100),
            currency: 'usd',
            customer: tenant.stripe_customer_id,
            payment_method: lease.autopay_payment_method_id,
            payment_method_types: ['us_bank_account'],
            confirm: true,
            off_session: true,
            description: `Autopay — ${periodStartStr}`,
            metadata: { lease_id: lease.id, tenant_id: tenant.id },
          })
          await db.from('payments').insert({
            lease_id: lease.id,
            payment_date: new Date().toISOString().slice(0, 10),
            amount: totalAmount,
            method: 'ach_stripe',
            stripe_payment_intent_id: pi.id,
            stripe_status: pi.status,
            notes: `Autopay — ${periodStartStr}`,
          })
        } catch (err) {
          errors++
          errorMessages.push(`autopay lease ${lease.id}: ${(err as Error).message}`)
        }
      }
    }
  }

  return c.json({ posted, skipped, errors, errorMessages, year, month })
})
