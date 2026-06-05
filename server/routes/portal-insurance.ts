import { Hono } from 'hono'
import { getDb } from '../db/client'
import { tenantAuthMiddleware } from '../middleware/tenant-auth'
import type { Env } from '../index'

export const portalInsuranceRouter = new Hono<{ Bindings: Env }>()
portalInsuranceRouter.use('/*', tenantAuthMiddleware)

// POST /api/portal/insurance — save COI metadata after client uploads file to Supabase Storage
portalInsuranceRouter.post('/', async (c) => {
  const userId = c.get('tenantUserId')
  const { policy_type, carrier, policy_number, coverage_amount, effective_date, expiration_date, storage_path } = await c.req.json()

  if (!policy_type || !effective_date || !expiration_date) {
    return c.json({ error: 'policy_type, effective_date, expiration_date required' }, 400)
  }

  const db = getDb(c.env)
  const { data: tenant } = await db.from('tenants').select('id').eq('auth_user_id', userId).single()
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404)

  const expDate = new Date(expiration_date)
  const daysUntil = Math.floor((expDate.getTime() - Date.now()) / 86400000)
  const status = daysUntil < 0 ? 'expired' : daysUntil <= 30 ? 'expiring_soon' : 'active'

  const { data, error } = await db.from('insurance_certificates').insert({
    tenant_id: tenant.id,
    policy_type,
    carrier: carrier ?? null,
    policy_number: policy_number ?? null,
    coverage_amount: coverage_amount ?? null,
    effective_date,
    expiration_date,
    document_path: storage_path ?? null,
    status,
  }).select().single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data }, 201)
})
