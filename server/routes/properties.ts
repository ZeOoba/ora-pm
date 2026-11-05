import { Hono } from 'hono'
import { getDb } from '../db/client'
import { PropertyInsertSchema, PropertyUpdateSchema } from '../lib/schemas'
import { dbError } from '../lib/api-error'
import { parseListQuery } from '../lib/list-query'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const propertiesRouter = new Hono<{ Bindings: Env }>()

propertiesRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const lq = parseListQuery(c, {
    sortable: ['name', 'city', 'state', 'created_at'],
    defaultSort: 'name',
    searchColumns: ['name', 'city', 'entity_llc'],
  })
  let q = db.from('properties').select('*', { count: 'exact' })
  if (lq.searchFilter) q = q.or(lq.searchFilter)
  const { data, error, count } = await q
    .order(lq.sort, { ascending: lq.ascending })
    .order('id')
    .range(...lq.range!)
  if (error) return dbError(c, error, 'Failed to load properties')
  return c.json({ data, total: count ?? 0 })
})

propertiesRouter.get('/:id', async (c) => {
  const db = getDb(c.env)
  const { data, error } = await db
    .from('properties')
    .select('*, units(*)')
    .eq('id', c.req.param('id'))
    .single()
  // Not-found is a 404, not a 500 — dbError always returns 500, so this
  // stays a plain generic response rather than routing through it.
  if (error) return c.json({ error: 'Property not found' }, 404)
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
  if (error) return dbError(c, error, 'Failed to delete property')
  return c.json({ success: true })
})
