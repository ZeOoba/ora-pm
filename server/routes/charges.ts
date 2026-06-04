import { Hono } from 'hono'
import { getDb } from '../db/client'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const chargesRouter = new Hono<{ Bindings: Env }>()

chargesRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const leaseId = c.req.query('lease_id')
  let q = db.from('charges').select('*, leases(tenant_id, tenants(name))').order('charge_date', { ascending: false })
  if (leaseId) q = q.eq('lease_id', leaseId)
  const { data, error } = await q
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

chargesRouter.post('/', async (c) => {
  const db = getDb(c.env)
  const body = await c.req.json()
  const { data, error } = await db
    .from('charges')
    .insert({ ...body, source: 'manual' })
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ data }, 201)
})

chargesRouter.delete('/:id', async (c) => {
  const db = getDb(c.env)
  const { data: charge } = await db
    .from('charges')
    .select('source')
    .eq('id', c.req.param('id'))
    .single()
  if (!charge) return c.json({ error: 'Charge not found' }, 404)
  if ((charge as { source: string }).source === 'auto') {
    return c.json({ error: 'Auto-generated charges cannot be deleted' }, 400)
  }
  const { error } = await db.from('charges').delete().eq('id', c.req.param('id'))
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ success: true })
})
