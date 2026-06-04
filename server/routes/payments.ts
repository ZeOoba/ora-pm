import { Hono } from 'hono'
import { getDb } from '../db/client'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const paymentsRouter = new Hono<{ Bindings: Env }>()

paymentsRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const leaseId = c.req.query('lease_id')
  let q = db
    .from('payments')
    .select('*, leases(tenant_id, tenants(name))')
    .order('payment_date', { ascending: false })
  if (leaseId) q = q.eq('lease_id', leaseId)
  const { data, error } = await q
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// Record manual payment (check/wire/other only — ACH handled via Stripe in Phase 2)
paymentsRouter.post('/', async (c) => {
  const db = getDb(c.env)
  const body = await c.req.json()
  const allowedMethods = ['check', 'wire', 'other']
  if (!allowedMethods.includes(body.method)) {
    return c.json({ error: 'Only check, wire, or other payments accepted via this endpoint' }, 400)
  }
  const { data, error } = await db.from('payments').insert(body).select().single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ data }, 201)
})
