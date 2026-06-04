import { Hono } from 'hono'
import { getDb } from '../db/client'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const propertiesRouter = new Hono<{ Bindings: Env }>()

propertiesRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const { data, error } = await db.from('properties').select('*').order('name')
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

propertiesRouter.get('/:id', async (c) => {
  const db = getDb(c.env)
  const { data, error } = await db
    .from('properties')
    .select('*, units(*)')
    .eq('id', c.req.param('id'))
    .single()
  if (error) return c.json({ error: error.message }, 404)
  return c.json({ data })
})

propertiesRouter.post('/', async (c) => {
  const db = getDb(c.env)
  const body = await c.req.json()
  const { data, error } = await db.from('properties').insert(body).select().single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ data }, 201)
})

propertiesRouter.put('/:id', async (c) => {
  const db = getDb(c.env)
  const body = await c.req.json()
  const { data, error } = await db
    .from('properties')
    .update(body)
    .eq('id', c.req.param('id'))
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ data })
})

propertiesRouter.delete('/:id', async (c) => {
  const db = getDb(c.env)
  const { error } = await db.from('properties').delete().eq('id', c.req.param('id'))
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ success: true })
})
