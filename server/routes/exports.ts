import { Hono } from 'hono'
import { getDb } from '../db/client'
import { buildPropertyJournalEntry, generateIIF } from '../lib/iif-export'
import { endOfMonth, format } from 'date-fns'
import { dbError } from '../lib/api-error'
import { fetchChunked, fetchAllPages, POSTGREST_MAX_ROWS } from '../lib/postgrest-paging'

// Ids per `.in()` call — keeps the request URL bounded however many units/leases a property has.
const BULK_QUERY_CHUNK_SIZE = 100

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

  // Every read below checks its error and returns before any file is built: this IIF is imported
  // into QuickBooks, and an unread error used to download a well-formed $0 journal entry.
  // Row cap: responses are cut at POSTGREST_MAX_ROWS with no error, so each read is keyset-paged
  // on its uuid PK (fetchAllPages) and each `.in()` id list is chunked (fetchChunked) to bound the
  // URL; `maxRows: Infinity` because a paged chunk is legitimately unbounded.
  const { data: property, error: propErr } = await db
    .from('properties')
    .select('name, entity_llc')
    .eq('id', propertyId)
    .single()
  if (propErr?.code === 'PGRST116') return c.json({ error: 'Property not found' }, 404)
  if (propErr) return dbError(c, propErr, 'Failed to load property')

  const { data: unitRows, error: unitErr } = await fetchAllPages<{ id: string }>((after) => {
    let q = db.from('units').select('id').eq('property_id', propertyId)
    if (after !== null) q = q.gt('id', after)
    return q.order('id').limit(POSTGREST_MAX_ROWS)
  }, (u) => u.id)
  if (unitErr) return dbError(c, unitErr, 'Failed to load units')

  const { data: leaseRows, error: leaseErr } = await fetchChunked(unitRows.map(u => u.id), BULK_QUERY_CHUNK_SIZE, (chunk) =>
    fetchAllPages<{ id: string }>((after) => {
      let q = db.from('leases').select('id').eq('status', 'active').in('unit_id', chunk)
      if (after !== null) q = q.gt('id', after)
      return q.order('id').limit(POSTGREST_MAX_ROWS)
    }, (l) => l.id),
    { maxRows: Infinity })
  if (leaseErr) return dbError(c, leaseErr, 'Failed to load leases')

  // Sum charges posted for this property in this period (accrual basis). OI-278 / migration 0016:
  // voided charges never reach the journal — this file is what gets imported into QuickBooks.
  const totals = { rent: 0, cam: 0, utility: 0, fees: 0 }

  const { data: charges, error: chargeErr } = await fetchChunked(leaseRows.map(l => l.id), BULK_QUERY_CHUNK_SIZE, (chunk) =>
    fetchAllPages<{ id: string; amount: number; type: string }>((after) => {
      let q = db.from('charges').select('id, amount, type')
        .in('lease_id', chunk)
        .is('voided_at', null)
        .gte('charge_date', startStr)
        .lte('charge_date', endStr)
      if (after !== null) q = q.gt('id', after)
      return q.order('id').limit(POSTGREST_MAX_ROWS)
    }, (ch) => ch.id),
    { maxRows: Infinity })
  if (chargeErr) return dbError(c, chargeErr, 'Failed to load charges')

  for (const charge of charges) {
    if (charge.type === 'rent')                                    totals.rent    += charge.amount
    else if (['cam_estimate','cam_true_up'].includes(charge.type)) totals.cam     += charge.amount
    else if (charge.type.startsWith('utility'))                    totals.utility += charge.amount
    else if (charge.type === 'late_fee')                           totals.fees    += charge.amount
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
