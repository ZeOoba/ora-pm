import { Hono } from 'hono'
import { getDb } from '../db/client'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const reportsRouter = new Hono<{ Bindings: Env }>()

// AR aging from the ar_ledger view — only rows with a positive balance
reportsRouter.get('/ar-aging', async (c) => {
  const db = getDb(c.env)
  const propertyId = c.req.query('property_id')
  let q = db.from('ar_ledger').select('*').gt('balance', 0)
  if (propertyId) q = q.eq('property_id', propertyId)
  const { data, error } = await q
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// Rent roll from the rent_roll view
reportsRouter.get('/rent-roll', async (c) => {
  const db = getDb(c.env)
  const propertyId = c.req.query('property_id')
  let q = db.from('rent_roll').select('*').order('property_name').order('suite')
  if (propertyId) q = q.eq('property_id', propertyId)
  const { data, error } = await q
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// Critical dates from the critical_dates view
reportsRouter.get('/critical-dates', async (c) => {
  const db = getDb(c.env)
  const { data, error } = await db.from('critical_dates').select('*').order('days_until')
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})
