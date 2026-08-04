import { Hono } from 'hono'
import { getDb } from '../db/client'
import { ExpenseInsertSchema, ExpenseUpdateSchema, PaginationSchema } from '../lib/schemas'
import { dbError } from '../lib/api-error'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const expensesRouter = new Hono<{ Bindings: Env }>()

expensesRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const propertyId = c.req.query('property_id')
  const { limit, offset } = PaginationSchema.parse({
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
  })
  let q = db
    .from('expenses')
    .select('*, properties(name)')
    .order('expense_date', { ascending: false })
  if (propertyId) q = q.eq('property_id', propertyId)
  const { data, error } = await q.range(offset, offset + limit - 1)
  if (error) return dbError(c, error, 'Failed to load expenses')
  return c.json({ data })
})

expensesRouter.post('/', async (c) => {
  const db = getDb(c.env)
  const raw = await c.req.json()
  const parsed = ExpenseInsertSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const { data, error } = await db.from('expenses').insert(parsed.data).select().single()
  if (error) return c.json({ error: 'Failed to create expense' }, 400)
  return c.json({ data }, 201)
})

expensesRouter.put('/:id', async (c) => {
  const db = getDb(c.env)
  const raw = await c.req.json()
  const parsed = ExpenseUpdateSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const { data, error } = await db
    .from('expenses')
    .update(parsed.data)
    .eq('id', c.req.param('id'))
    .select()
    .single()
  if (error) return c.json({ error: 'Failed to update expense' }, 400)
  return c.json({ data })
})

expensesRouter.delete('/:id', async (c) => {
  const db = getDb(c.env)
  const { error } = await db.from('expenses').delete().eq('id', c.req.param('id'))
  if (error) return dbError(c, error, 'Failed to delete expense')
  return c.json({ success: true })
})
