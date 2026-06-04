import { Hono } from 'hono'
import { getDb } from '../db/client'
import { buildPropertyJournalEntry, generateIIF } from '../lib/iif-export'
import { endOfMonth, format } from 'date-fns'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const exportsRouter = new Hono<{ Bindings: Env }>()

// GET /api/exports/qb-iif?property_id=X&year=2026&month=6
// Returns an IIF file as a downloadable attachment
exportsRouter.get('/qb-iif', async (c) => {
  const db = getDb(c.env)
  const propertyId = c.req.query('property_id')
  const yearStr    = c.req.query('year')
  const monthStr   = c.req.query('month')

  if (!propertyId || !yearStr || !monthStr) {
    return c.json({ error: 'property_id, year, and month are required' }, 400)
  }

  const year  = parseInt(yearStr)
  const month = parseInt(monthStr)
  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    return c.json({ error: 'Invalid year or month' }, 400)
  }

  const periodStart = new Date(year, month - 1, 1)
  const periodEnd   = endOfMonth(periodStart)
  const startStr    = format(periodStart, 'yyyy-MM-dd')
  const endStr      = format(periodEnd, 'yyyy-MM-dd')

  const { data: property } = await db
    .from('properties')
    .select('name, entity_llc')
    .eq('id', propertyId)
    .single()

  const { data: unitRows } = await db
    .from('units')
    .select('id')
    .eq('property_id', propertyId)

  const unitIds = (unitRows ?? []).map((u: { id: string }) => u.id)

  const { data: leaseRows } = unitIds.length > 0
    ? await db.from('leases').select('id').eq('status', 'active').in('unit_id', unitIds)
    : { data: [] }

  const leaseIds = (leaseRows ?? []).map((l: { id: string }) => l.id)

  // Sum charges posted for this property in this period (accrual basis)
  const totals = { rent: 0, cam: 0, utility: 0, fees: 0 }

  if (leaseIds.length > 0) {
    const { data: charges } = await db
      .from('charges')
      .select('amount, type')
      .in('lease_id', leaseIds)
      .gte('charge_date', startStr)
      .lte('charge_date', endStr)

    for (const ch of (charges ?? [])) {
      const charge = ch as { amount: number; type: string }
      if (charge.type === 'rent')                                    totals.rent    += charge.amount
      else if (['cam_estimate','cam_true_up'].includes(charge.type)) totals.cam     += charge.amount
      else if (charge.type.startsWith('utility'))                    totals.utility += charge.amount
      else if (charge.type === 'late_fee')                           totals.fees    += charge.amount
    }
  }

  const entry = buildPropertyJournalEntry({
    propertyName: (property as { name: string; entity_llc: string | null } | null)?.name ?? 'Unknown',
    entityLLC:    (property as { name: string; entity_llc: string | null } | null)?.entity_llc ?? '',
    periodStart,
    periodEnd,
    baseRentCollected: totals.rent,
    camCollected:      totals.cam,
    utilityCollected:  totals.utility,
    lateFeeCollected:  totals.fees,
    arAccountName:      'Accounts Receivable',
    incomeAccountBase: 'Rental Income:Base Rent',
    incomeAccountCAM:  'Rental Income:CAM',
    incomeAccountUtil: 'Rental Income:Utilities',
    incomeAccountFees: 'Rental Income:Late Fees',
  })

  const iifContent = generateIIF([entry])
  const propSlug   = ((property as { name: string } | null)?.name ?? 'property').replace(/\s+/g, '-').slice(0, 30)
  const filename   = `JE-${year}-${String(month).padStart(2, '0')}-${propSlug}.iif`

  return new Response(iifContent, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
})
