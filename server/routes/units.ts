import { Hono } from 'hono'
import { getDb } from '../db/client'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const unitsRouter = new Hono<{ Bindings: Env }>()

unitsRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const propertyId = c.req.query('property_id')
  let q = db.from('units').select('*').order('suite')
  if (propertyId) q = q.eq('property_id', propertyId)
  const { data, error } = await q
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

unitsRouter.post('/', async (c) => {
  const db = getDb(c.env)
  const body = await c.req.json()
  const { data, error } = await db.from('units').insert(body).select().single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ data }, 201)
})

unitsRouter.put('/:id', async (c) => {
  const db = getDb(c.env)
  const body = await c.req.json()
  const { data, error } = await db
    .from('units')
    .update(body)
    .eq('id', c.req.param('id'))
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ data })
})

unitsRouter.delete('/:id', async (c) => {
  const db = getDb(c.env)
  const { error } = await db.from('units').delete().eq('id', c.req.param('id'))
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ success: true })
})
