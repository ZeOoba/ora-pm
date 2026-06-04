import { Hono } from 'hono'
import { getDb } from '../db/client'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const leasesRouter = new Hono<{ Bindings: Env }>()

leasesRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const status = c.req.query('status') ?? 'active'
  const { data, error } = await db
    .from('leases')
    .select('*, tenants(name), units(suite, sf, properties(name))')
    .eq('status', status)
    .order('end_date')
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

leasesRouter.get('/:id', async (c) => {
  const db = getDb(c.env)
  const { data, error } = await db
    .from('leases')
    .select('*, tenants(*), units(*, properties(*)), lease_amendments(*), lease_documents(*), broker_commissions(*)')
    .eq('id', c.req.param('id'))
    .single()
  if (error) return c.json({ error: error.message }, 404)
  return c.json({ data })
})

leasesRouter.post('/', async (c) => {
  const db = getDb(c.env)
  const body = await c.req.json()
  const { data, error } = await db.from('leases').insert(body).select().single()
  if (error) return c.json({ error: error.message }, 400)
  // Auto-create renewal tracking record — swallow error if renewals table not ready
  if (data) {
    const lease = data as { id: string; end_date: string }
    await db.from('renewals').insert({
      lease_id: lease.id,
      expiration_date: lease.end_date,
      status: 'tracking',
    })
  }
  return c.json({ data }, 201)
})

leasesRouter.put('/:id', async (c) => {
  const db = getDb(c.env)
  const body = await c.req.json()
  const { data, error } = await db
    .from('leases')
    .update(body)
    .eq('id', c.req.param('id'))
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ data })
})

// POST /api/leases/:id/amendments
leasesRouter.post('/:id/amendments', async (c) => {
  const db = getDb(c.env)
  const body = await c.req.json()
  const { data, error } = await db
    .from('lease_amendments')
    .insert({ ...body, lease_id: c.req.param('id') })
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ data }, 201)
})
