import { Hono } from 'hono'
import { getDb } from '../db/client'
import { dbError } from '../lib/api-error'
import { fetchChunked, fetchAllPages, POSTGREST_MAX_ROWS } from '../lib/postgrest-paging'
import { allocateOldestFirst, emptyBucketsCents, toCents, AGING_BUCKET_KEYS, type AgingBucketsCents, type AllocationCharge } from '../lib/ar-aging'

// Ids per `.in()` call — keeps the request URL bounded however many units/leases a property has.
const BULK_QUERY_CHUNK_SIZE = 100

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const reportsRouter = new Hono<{ Bindings: Env }>()

// AR aging from the ar_ledger view — only rows with a positive balance — plus aging buckets.
//
// Every existing ar_ledger field is returned unchanged; each row gains `buckets` and the response
// gains portfolio `totals`. ar_ledger has no payment→charge application, so buckets come from the
// OI-234 oldest-first rule (payments retire the oldest charges first; the balance is owed on the
// newest) — see allocateOldestFirst in server/lib/ar-aging.ts. The charge population is exactly
// the one ar_ledger.balance sums: every `charges` row for the lease WHERE voided_at IS NULL.
// Integer cents throughout; Σ buckets (incl. `unallocated`) === balance per row and in totals.
//
// Fail closed (500, no partial report): any read error, a keyset page that is not ascending, or a
// non-numeric balance/amount or malformed due_date. Both reads are keyset-paged (fetchAllPages) —
// PostgREST truncates at POSTGREST_MAX_ROWS silently, and a truncated charge list would push
// balance into `unallocated` or age it wrongly. A lease's lifetime charges legitimately exceed one
// page per chunk, so the chunk is paged (maxRows: Infinity) rather than row-capped.
//
// Not a snapshot: the two reads are separate requests. A charge voided in between shows up as
// `unallocated`; a payment in between leaves this report on the earlier balance.
type ArLedgerRow = { lease_id: string; balance: number | string } & Record<string, unknown>
type AgingCharge = { id: string; lease_id: string; amount: number | string; due_date: string }

reportsRouter.get('/ar-aging', async (c) => {
  const db = getDb(c.env)
  const propertyId = c.req.query('property_id')
  const { data, error } = await fetchAllPages<ArLedgerRow>((after) => {
    let q = db.from('ar_ledger').select('*').gt('balance', 0)
    if (propertyId) q = q.eq('property_id', propertyId)
    if (after !== null) q = q.gt('lease_id', after)
    return q.order('lease_id').limit(POSTGREST_MAX_ROWS)
  }, (r) => r.lease_id)
  if (error) return dbError(c, error, 'Failed to load AR aging report')

  const { data: charges, error: chargeErr } = await fetchChunked(data.map(r => r.lease_id), BULK_QUERY_CHUNK_SIZE, (chunk) =>
    fetchAllPages<AgingCharge>((after) => {
      let q = db.from('charges').select('id, lease_id, amount, due_date')
        .in('lease_id', chunk)
        .is('voided_at', null)
      if (after !== null) q = q.gt('id', after)
      return q.order('id').limit(POSTGREST_MAX_ROWS)
    }, (ch) => ch.id),
    { maxRows: Infinity })
  if (chargeErr) return dbError(c, chargeErr, 'Failed to load AR aging charges')

  const byLease = new Map<string, AllocationCharge[]>()
  for (const ch of charges) {
    const amountCents = toCents(ch.amount)
    if (amountCents === null || amountCents < 0) {
      return dbError(c, { message: `non-numeric or negative charges.amount on charge ${ch.id}` }, 'Failed to load AR aging report')
    }
    const list = byLease.get(ch.lease_id) ?? []
    list.push({ id: ch.id, due_date: ch.due_date, amountCents })
    byLease.set(ch.lease_id, list)
  }

  // As-of date: today, date-only, UTC — the same clock cron.ts delinquency uses.
  const asOf = new Date().toISOString().slice(0, 10)
  const totalsCents = { balance: 0, ...emptyBucketsCents() }
  const rows: (ArLedgerRow & { buckets: Record<(typeof AGING_BUCKET_KEYS)[number], number> })[] = []
  for (const row of data) {
    const balanceCents = toCents(row.balance)
    if (balanceCents === null) {
      return dbError(c, { message: `non-numeric ar_ledger.balance for lease ${row.lease_id}` }, 'Failed to load AR aging report')
    }
    let b: AgingBucketsCents
    try {
      b = allocateOldestFirst(balanceCents, byLease.get(row.lease_id) ?? [], asOf)
    } catch (e) {
      return dbError(c, { message: `aging allocation failed for lease ${row.lease_id}: ${(e as Error).message}` }, 'Failed to load AR aging report')
    }
    totalsCents.balance += balanceCents
    for (const k of AGING_BUCKET_KEYS) totalsCents[k] += b[k]
    rows.push({ ...row, buckets: centsToDollars(b) })
  }

  return c.json({ data: rows, totals: { balance: totalsCents.balance / 100, ...centsToDollars(totalsCents) } })
})

function centsToDollars(b: AgingBucketsCents): Record<(typeof AGING_BUCKET_KEYS)[number], number> {
  const out = {} as Record<(typeof AGING_BUCKET_KEYS)[number], number>
  for (const k of AGING_BUCKET_KEYS) out[k] = b[k] / 100
  return out
}

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

  // Row cap: PostgREST cuts every response at POSTGREST_MAX_ROWS with no error, and a cut here
  // silently under-reports Budget vs Actual. A year of one property's expenses or charges passes
  // 1000 rows at ordinary portfolio size, so every read below is keyset-paged on its uuid PK
  // (fetchAllPages) — complete, not capped — and each `.in()` id list is chunked (fetchChunked) to
  // bound the URL; `maxRows: Infinity` because a paged chunk is legitimately unbounded. Every
  // error is checked: an unread one reported $0 actuals with a 200.

  // Expense actuals by category (expenses.category aligns with budget expense categories)
  const { data: expenses, error: exErr } = await fetchAllPages<{ id: string; category: string; amount: number }>((after) => {
    let q = db.from('expenses').select('id, category, amount')
      .eq('property_id', propertyId)
      .gte('expense_date', start).lte('expense_date', end)
    if (after !== null) q = q.gt('id', after)
    return q.order('id').limit(POSTGREST_MAX_ROWS)
  }, (e) => e.id)
  if (exErr) return dbError(c, exErr, 'Failed to load expense actuals')

  // Income actuals from charges on this property's leases, mapped to income budget categories.
  // Every lease on the property, not only active ones: a lease that ended mid-year billed in it.
  const { data: unitRows, error: unitErr } = await fetchAllPages<{ id: string }>((after) => {
    let q = db.from('units').select('id').eq('property_id', propertyId)
    if (after !== null) q = q.gt('id', after)
    return q.order('id').limit(POSTGREST_MAX_ROWS)
  }, (u) => u.id)
  if (unitErr) return dbError(c, unitErr, 'Failed to load unit actuals')

  const { data: leaseRows, error: leaseErr } = await fetchChunked(unitRows.map(u => u.id), BULK_QUERY_CHUNK_SIZE, (chunk) =>
    fetchAllPages<{ id: string }>((after) => {
      let q = db.from('leases').select('id').in('unit_id', chunk)
      if (after !== null) q = q.gt('id', after)
      return q.order('id').limit(POSTGREST_MAX_ROWS)
    }, (l) => l.id),
    { maxRows: Infinity })
  if (leaseErr) return dbError(c, leaseErr, 'Failed to load lease actuals')

  // OI-278 / migration 0016: voided charges are not income — excluded from actuals.
  const { data: charges, error: chargeErr } = await fetchChunked(leaseRows.map(l => l.id), BULK_QUERY_CHUNK_SIZE, (chunk) =>
    fetchAllPages<{ id: string; type: string; amount: number }>((after) => {
      let q = db.from('charges').select('id, type, amount')
        .in('lease_id', chunk)
        .is('voided_at', null)
        .gte('charge_date', start).lte('charge_date', end)
      if (after !== null) q = q.gt('id', after)
      return q.order('id').limit(POSTGREST_MAX_ROWS)
    }, (ch) => ch.id),
    { maxRows: Infinity })
  if (chargeErr) return dbError(c, chargeErr, 'Failed to load charge actuals')

  const actuals: Record<string, number> = {}
  const add = (cat: string, amt: number) => { actuals[cat] = (actuals[cat] ?? 0) + amt }

  for (const e of expenses) add(e.category, e.amount)
  for (const ch of charges) {
    if (ch.type === 'rent') add('rental_income', ch.amount)
    else if (ch.type === 'cam_estimate' || ch.type === 'cam_true_up') add('cam_income', ch.amount)
    else add('other_income', ch.amount)
  }

  // round
  for (const k of Object.keys(actuals)) actuals[k] = Math.round(actuals[k] * 100) / 100
  return c.json({ data: actuals })
})
