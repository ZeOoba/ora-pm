import { Hono } from 'hono'
import { getDb } from '../db/client'
import { dbError } from '../lib/api-error'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const reportsRouter = new Hono<{ Bindings: Env }>()

// AR aging from the ar_ledger view — only rows with a positive balance
reportsRouter.get('/ar-aging', async (c) => {
  const db = getDb(c.env)
  const propertyId = c.req.query('property_id')
  let q = db.from('ar_ledger').select('*').gt('balance', 0)
  if (propertyId) q = q.eq('property_id', propertyId)
  const { data, error } = await q
  if (error) return dbError(c, error, 'Failed to load AR aging report')
  return c.json({ data })
})

// Rent roll from the rent_roll view
reportsRouter.get('/rent-roll', async (c) => {
  const db = getDb(c.env)
  const propertyId = c.req.query('property_id')
  let q = db.from('rent_roll').select('*').order('property_name').order('suite')
  if (propertyId) q = q.eq('property_id', propertyId)
  const { data, error } = await q
  if (error) return dbError(c, error, 'Failed to load rent roll')
  return c.json({ data })
})

// Critical dates from the critical_dates view
reportsRouter.get('/critical-dates', async (c) => {
  const db = getDb(c.env)
  const { data, error } = await db.from('critical_dates').select('*').order('days_until')
  if (error) return dbError(c, error, 'Failed to load critical dates')
  return c.json({ data })
})

// Actuals per budget category for a property+year (for budget vs actual).
reportsRouter.get('/actuals', async (c) => {
  const db = getDb(c.env)
  const propertyId = c.req.query('property_id')
  const year = c.req.query('year')
  if (!propertyId || !year) return c.json({ error: 'property_id and year are required' }, 400)
  const start = `${year}-01-01`
  const end = `${year}-12-31`

  // Expense actuals by category (expenses.category aligns with budget expense categories)
  const { data: expenses, error: exErr } = await db
    .from('expenses')
    .select('category, amount')
    .eq('property_id', propertyId)
    .gte('expense_date', start).lte('expense_date', end)
  if (exErr) return dbError(c, exErr, 'Failed to load expense actuals')

  // Income actuals from charges on this property's leases, mapped to income budget categories
  const { data: unitRows, error: unitErr } = await db.from('units').select('id').eq('property_id', propertyId)
  if (unitErr) return dbError(c, unitErr, 'Failed to load unit actuals')
  const unitIds = (unitRows ?? []).map((u: { id: string }) => u.id)
  let leaseIds: string[] = []
  if (unitIds.length) {
    const { data: leaseRows, error: leaseErr } = await db.from('leases').select('id').in('unit_id', unitIds)
    if (leaseErr) return dbError(c, leaseErr, 'Failed to load lease actuals')
    leaseIds = (leaseRows ?? []).map((l: { id: string }) => l.id)
  }
  let charges: { type: string; amount: number }[] = []
  if (leaseIds.length) {
    const { data: chargeRows } = await db
      .from('charges')
      .select('type, amount')
      .in('lease_id', leaseIds)
      .gte('charge_date', start).lte('charge_date', end)
    charges = (chargeRows ?? []) as { type: string; amount: number }[]
  }

  const actuals: Record<string, number> = {}
  const add = (cat: string, amt: number) => { actuals[cat] = (actuals[cat] ?? 0) + amt }

  for (const e of (expenses ?? []) as { category: string; amount: number }[]) add(e.category, e.amount)
  for (const ch of charges) {
    if (ch.type === 'rent') add('rental_income', ch.amount)
    else if (ch.type === 'cam_estimate' || ch.type === 'cam_true_up') add('cam_income', ch.amount)
    else add('other_income', ch.amount)
  }

  // round
  for (const k of Object.keys(actuals)) actuals[k] = Math.round(actuals[k] * 100) / 100
  return c.json({ data: actuals })
})
