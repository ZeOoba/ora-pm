import { Hono } from 'hono'
import { z } from 'zod'
import { getDb } from '../db/client'
import { BudgetUpsertSchema } from '../lib/schemas'
import { dbError } from '../lib/api-error'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const budgetsRouter = new Hono<{ Bindings: Env }>()

// The UI (BudgetsList.tsx) always saves one category at a time via
// Promise.all — never a real batch array — but Supabase's .upsert() accepts
// an array body natively, and the route used to hand the raw request body to
// it with no shape or row-count check. 50 is a defensive cap comfortably
// above the 10-category ceiling a single property/year save can ever produce.
const BudgetPostBodySchema = z.union([BudgetUpsertSchema, z.array(BudgetUpsertSchema).max(50)])

budgetsRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const propertyId = c.req.query('property_id')
  const year = c.req.query('year')
  let q = db.from('budgets').select('*').order('category')
  if (propertyId) q = q.eq('property_id', propertyId)
  if (year) q = q.eq('year', parseInt(year))
  const { data, error } = await q
  if (error) return dbError(c, error, 'Failed to load budgets')
  return c.json({ data })
})

// Upsert — unique on (property_id, year, category)
budgetsRouter.post('/', async (c) => {
  const db = getDb(c.env)
  const raw = await c.req.json()
  const parsed = BudgetPostBodySchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 422)
  const { data, error } = await db
    .from('budgets')
    .upsert(parsed.data, { onConflict: 'property_id,year,category' })
    .select()
    .single()
  if (error) return dbError(c, error, 'Failed to save budget')
  return c.json({ data }, 201)
})
