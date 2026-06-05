import { Hono } from 'hono'
import { getDb } from '../db/client'
import { PaymentInsertSchema, PaginationSchema } from '../lib/schemas'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const paymentsRouter = new Hono<{ Bindings: Env }>()

paymentsRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const leaseId = c.req.query('lease_id')
  const { limit, offset } = PaginationSchema.parse({
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
  })
  let q = db
    .from('payments')
    .select('*, leases(tenant_id, tenants(name))')
    .order('payment_date', { ascending: false })
  if (leaseId) q = q.eq('lease_id', leaseId)
  const { data, error } = await q.range(offset, offset + limit - 1)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// Record manual payment (check/wire/other only — ACH handled via Stripe in Phase 2)
paymentsRouter.post('/', async (c) => {
  const db = getDb(c.env)
  const raw = await c.req.json()
  const parsed = PaymentInsertSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const { data, error } = await db.from('payments').insert(parsed.data).select().single()
  if (error) return c.json({ error: 'Failed to create payment' }, 400)
  return c.json({ data }, 201)
})
