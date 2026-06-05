import { Hono } from 'hono'
import { getDb } from '../db/client'
import { PropertyInsertSchema, PropertyUpdateSchema, PaginationSchema } from '../lib/schemas'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const propertiesRouter = new Hono<{ Bindings: Env }>()

propertiesRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const { limit, offset } = PaginationSchema.parse({
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
  })
  const { data, error } = await db
    .from('properties')
    .select('*')
    .order('name')
    .range(offset, offset + limit - 1)
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
  const raw = await c.req.json()
  const parsed = PropertyInsertSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const { data, error } = await db.from('properties').insert(parsed.data).select().single()
  if (error) return c.json({ error: 'Failed to create property' }, 400)
  return c.json({ data }, 201)
})

propertiesRouter.put('/:id', async (c) => {
  const db = getDb(c.env)
  const raw = await c.req.json()
  const parsed = PropertyUpdateSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const { data, error } = await db
    .from('properties')
    .update(parsed.data)
    .eq('id', c.req.param('id'))
    .select()
    .single()
  if (error) return c.json({ error: 'Failed to update property' }, 400)
  return c.json({ data })
})

propertiesRouter.delete('/:id', async (c) => {
  const db = getDb(c.env)
  const { error } = await db.from('properties').delete().eq('id', c.req.param('id'))
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ success: true })
})
