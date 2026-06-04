import { Hono } from 'hono'
import { getDb } from '../db/client'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const tenantsRouter = new Hono<{ Bindings: Env }>()

tenantsRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const { data, error } = await db.from('tenants').select('*').order('name')
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

tenantsRouter.get('/:id', async (c) => {
  const db = getDb(c.env)
  const { data, error } = await db
    .from('tenants')
    .select('*, leases(*, units(*, properties(name))), insurance_certificates(*), correspondence_log(*)')
    .eq('id', c.req.param('id'))
    .single()
  if (error) return c.json({ error: error.message }, 404)
  return c.json({ data })
})

tenantsRouter.post('/', async (c) => {
  const db = getDb(c.env)
  const body = await c.req.json()
  const { data, error } = await db.from('tenants').insert(body).select().single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ data }, 201)
})

tenantsRouter.put('/:id', async (c) => {
  const db = getDb(c.env)
  const body = await c.req.json()
  const { data, error } = await db
    .from('tenants')
    .update(body)
    .eq('id', c.req.param('id'))
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ data })
})
