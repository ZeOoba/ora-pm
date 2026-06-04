import { Hono } from 'hono'
import { getDb } from '../db/client'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const budgetsRouter = new Hono<{ Bindings: Env }>()

budgetsRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const propertyId = c.req.query('property_id')
  const year = c.req.query('year')
  let q = db.from('budgets').select('*').order('category')
  if (propertyId) q = q.eq('property_id', propertyId)
  if (year) q = q.eq('year', parseInt(year))
  const { data, error } = await q
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// Upsert — unique on (property_id, year, category)
budgetsRouter.post('/', async (c) => {
  const db = getDb(c.env)
  const { data, error } = await db
    .from('budgets')
    .upsert(await c.req.json(), { onConflict: 'property_id,year,category' })
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ data }, 201)
})
