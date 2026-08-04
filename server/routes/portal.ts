import { Hono } from 'hono'
import Stripe from 'stripe'
import { getDb } from '../db/client'
import { getStripe } from '../lib/stripe'
import { tenantAuthMiddleware } from '../middleware/tenant-auth'
import { requireAal2 } from '../middleware/aal-guard'
import { dbError } from '../lib/api-error'
import type { Env } from '../index'

// OI-043: payment_method_id must look like a Stripe PaymentMethod id before
// it's ever sent to Stripe or persisted.
const PAYMENT_METHOD_ID_RE = /^pm_[A-Za-z0-9]+$/

export const portalRouter = new Hono<{ Bindings: Env }>()

// All portal routes require a valid tenant JWT
portalRouter.use('/*', tenantAuthMiddleware)

// GET /api/portal/me — tenant profile + AR balance
portalRouter.get('/me', async (c) => {
  const userId = c.get('tenantUserId')
  const db = getDb(c.env)

  const { data: tenant, error } = await db
    .from('tenants')
    .select('id, name, contact_email, stripe_customer_id, auth_user_id')
    .eq('auth_user_id', userId)
    .single()

  if (error || !tenant) return c.json({ error: 'Tenant not found for this user' }, 404)

  const { data: arRows } = await db.from('ar_ledger').select('balance').eq('tenant_id', tenant.id)
  const totalBalance = (arRows ?? []).reduce((sum, r) => sum + (r.balance ?? 0), 0)

  return c.json({ tenant, total_balance: totalBalance })
})

// GET /api/portal/charges — open charges for tenant's active leases
portalRouter.get('/charges', async (c) => {
  const userId = c.get('tenantUserId')
  const db = getDb(c.env)

  const { data: tenant, error: tenantErr } = await db.from('tenants').select('id').eq('auth_user_id', userId).single()
  if (tenantErr) return c.json({ error: 'DB error' }, 500)
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404)

  const { data: leases, error: leasesErr } = await db.from('leases').select('id').eq('tenant_id', tenant.id).eq('status', 'active')
  if (leasesErr) return c.json({ error: 'DB error' }, 500)
  const leaseIds = (leases ?? []).map((l: { id: string }) => l.id)
  if (!leaseIds.length) return c.json({ data: [] })

  const { data, error } = await db
    .from('charges')
    .select('*, leases(units(properties(name,address)))')
    .in('lease_id', leaseIds)
    .order('due_date', { ascending: false })

  if (error) return dbError(c, error, 'Failed to load charges')
  return c.json({ data })
})

// GET /api/portal/payments — payment history
portalRouter.get('/payments', async (c) => {
  const userId = c.get('tenantUserId')
  const db = getDb(c.env)

  const { data: tenant, error: tenantErr } = await db.from('tenants').select('id').eq('auth_user_id', userId).single()
  if (tenantErr) return c.json({ error: 'DB error' }, 500)
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404)

  const { data: leases, error: leasesErr } = await db.from('leases').select('id').eq('tenant_id', tenant.id)
  if (leasesErr) return c.json({ error: 'DB error' }, 500)
  const leaseIds = (leases ?? []).map((l: { id: string }) => l.id)
  if (!leaseIds.length) return c.json({ data: [] })

  const { data, error } = await db
    .from('payments')
    .select('*')
    .in('lease_id', leaseIds)
    .order('payment_date', { ascending: false })

  if (error) return dbError(c, error, 'Failed to load payment history')
  return c.json({ data })
})

// GET /api/portal/lease — active lease terms
portalRouter.get('/lease', async (c) => {
  const userId = c.get('tenantUserId')
  const db = getDb(c.env)

  const { data: tenant, error: tenantErr } = await db.from('tenants').select('id').eq('auth_user_id', userId).single()
  if (tenantErr) return c.json({ error: 'DB error' }, 500)
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404)

  const { data, error } = await db
    .from('leases')
    .select('*, units(suite, sf, properties(name, address, city, state)), lease_amendments(*)')
    .eq('tenant_id', tenant.id)
    .eq('status', 'active')

  if (error) return dbError(c, error, 'Failed to load lease information')
  return c.json({ data })
})

// GET /api/portal/documents — document list
portalRouter.get('/documents', async (c) => {
  const userId = c.get('tenantUserId')
  const db = getDb(c.env)

  const { data: tenant, error: tenantErr } = await db.from('tenants').select('id').eq('auth_user_id', userId).single()
  if (tenantErr) return c.json({ error: 'DB error' }, 500)
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404)

  const { data: leases, error: leasesErr } = await db.from('leases').select('id').eq('tenant_id', tenant.id)
  if (leasesErr) return c.json({ error: 'DB error' }, 500)
  const leaseIds = (leases ?? []).map((l: { id: string }) => l.id)
  if (!leaseIds.length) return c.json({ data: [] })

  const { data, error } = await db
    .from('lease_documents')
    .select('*')
    .in('lease_id', leaseIds)
    .order('uploaded_at', { ascending: false })

  if (error) return dbError(c, error, 'Failed to load documents')
  return c.json({ data })
})

// PATCH /api/portal/autopay — toggle autopay for a lease
//
// OI-045: this is the ACH-authorizing action the browser SPA's AAL2 gate
// exists to protect — enabling it attaches a Stripe bank-account payment
// method for recurring autopay. The SPA gate alone is client-side-only and
// trivially bypassed by a direct API call (see server/middleware/aal-guard.ts's
// header comment); requireAal2 enforces the same decision here, server-side,
// so it holds regardless of how the request arrives.
portalRouter.patch('/autopay', requireAal2, async (c) => {
  const userId = c.get('tenantUserId')
  const { lease_id, enabled, payment_method_id } = await c.req.json()
  if (!lease_id) return c.json({ error: 'lease_id required' }, 400)

  const db = getDb(c.env)
  const { data: tenant, error: tenantErr } = await db.from('tenants').select('id, stripe_customer_id').eq('auth_user_id', userId).single()
  if (tenantErr) return c.json({ error: 'DB error' }, 500)
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404)

  // Verify this lease belongs to this tenant (IDOR guard) — unchanged by OI-043.
  const { data: lease } = await db.from('leases').select('id, tenant_id').eq('id', lease_id).single()
  if (!lease || lease.tenant_id !== tenant.id) return c.json({ error: 'Lease not found' }, 404)

  const updates: Record<string, unknown> = { autopay_enabled: enabled }
  if (enabled && payment_method_id) {
    // OI-043: a client-supplied Stripe object id was previously written
    // straight through with no verification it's actually attached to this
    // tenant's Stripe customer — a mismatch failed silently, off-session,
    // months later in cron.ts. Verify it here, before it's ever persisted.
    if (!PAYMENT_METHOD_ID_RE.test(payment_method_id)) {
      return c.json({ error: 'Invalid payment_method_id format' }, 400)
    }
    if (!tenant.stripe_customer_id) {
      return c.json({ error: 'No Stripe customer on file for this tenant' }, 400)
    }

    const stripe = getStripe(c.env.STRIPE_SECRET_KEY)
    let pm: Stripe.PaymentMethod
    try {
      pm = await stripe.paymentMethods.retrieve(payment_method_id)
    } catch (err) {
      if (err instanceof Stripe.errors.StripeError) return c.json({ error: err.message }, 400)
      throw err
    }
    if (pm.customer !== tenant.stripe_customer_id || pm.type !== 'us_bank_account') {
      return c.json({ error: 'Payment method does not belong to this account' }, 403)
    }

    updates.autopay_payment_method_id = payment_method_id
  }
  if (!enabled) updates.autopay_payment_method_id = null

  const { error } = await db.from('leases').update(updates).eq('id', lease_id)
  if (error) return dbError(c, error, 'Failed to update autopay settings')

  return c.json({ autopay_enabled: enabled })
})
