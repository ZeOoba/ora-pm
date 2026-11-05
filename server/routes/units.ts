import { Hono } from 'hono'
import { getDb } from '../db/client'
import { UnitInsertSchema, UnitUpdateSchema } from '../lib/schemas'
import { dbError } from '../lib/api-error'
import { parseListQuery, listErrorResponse } from '../lib/list-query'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const unitsRouter = new Hono<{ Bindings: Env }>()

unitsRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const propertyId = c.req.query('property_id')
  // Historically unpaged (unit pickers need every row): paging only applies
  // when the caller passes limit/offset.
  const lq = parseListQuery(c, {
    sortable: ['suite', 'sf', 'status'],
    defaultSort: 'suite',
    unpagedByDefault: true,
  })
  const base = db.from('units').select('*', { count: 'exact' })
  const ordered = (propertyId ? base.eq('property_id', propertyId) : base)
    .order(lq.sort, { ascending: lq.ascending })
    .order('id')
  const { data, error, count } = await (lq.range ? ordered.range(...lq.range) : ordered)
  if (error) {
    return listErrorResponse(c, error, 'Failed to load units', () => {
      const head = db.from('units').select('id', { count: 'exact', head: true })
      return propertyId ? head.eq('property_id', propertyId) : head
    })
  }
  return c.json({ data, total: count ?? 0 })
})

unitsRouter.post('/', async (c) => {
  const db = getDb(c.env)
  const raw = await c.req.json()
  const parsed = UnitInsertSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const { data, error } = await db.from('units').insert(parsed.data).select().single()
  if (error) return dbError(c, error, 'Failed to create unit')
  return c.json({ data }, 201)
})

unitsRouter.put('/:id', async (c) => {
  const db = getDb(c.env)
  const raw = await c.req.json()
  const parsed = UnitUpdateSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const { data, error } = await db
    .from('units')
    .update(parsed.data)
    .eq('id', c.req.param('id'))
    .select()
    .single()
  if (error) return dbError(c, error, 'Failed to update unit')
  return c.json({ data })
})

unitsRouter.delete('/:id', async (c) => {
  const db = getDb(c.env)
  const { error } = await db.from('units').delete().eq('id', c.req.param('id'))
  if (error) return dbError(c, error, 'Failed to delete unit')
  return c.json({ success: true })
})
