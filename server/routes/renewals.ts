import { Hono } from 'hono'
import { getDb } from '../db/client'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const renewalsRouter = new Hono<{ Bindings: Env }>()

renewalsRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const { data, error } = await db
    .from('renewals')
    .select('*, leases(tenant_id, tenants(name), units(suite, properties(name)))')
    .order('expiration_date')
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

renewalsRouter.put('/:id', async (c) => {
  const db = getDb(c.env)
  const { data, error } = await db
    .from('renewals')
    .update({ ...await c.req.json(), updated_at: new Date().toISOString() })
    .eq('id', c.req.param('id'))
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ data })
})
