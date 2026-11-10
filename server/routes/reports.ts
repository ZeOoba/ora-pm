import { Hono, type Context } from 'hono'
import { getDb } from '../db/client'
import { dbError } from '../lib/api-error'
import { fetchChunked, fetchAllPages, POSTGREST_MAX_ROWS } from '../lib/postgrest-paging'
import {
  parseReportRange, parsePropertyIds, fiscalYearStart, trailingMonths, monthRange,
  buildIncomeStatement, buildCashFlow, buildCashActivity, buildMonthlyIncomeStatement,
  type StmtCharge, type StmtPayment, type ActivityPayment, type ActivityExpense, type LeaseMeta,
} from '../lib/financial-report'
import { allocateOldestFirst, emptyBucketsCents, toCents, AGING_BUCKET_KEYS, type AgingBucketsCents, type AllocationCharge, findChargeTotalMismatch, type ChargeTotalMismatch } from '../lib/ar-aging'

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
// Not a transactional snapshot, but cross-checked: each ledger row's total_charged must equal the
// sum of the fetched charges (see readArAging); a mismatch re-runs the read once, then 500s.
// A payment landing between the reads still leaves the report on the earlier balance.
type ArLedgerRow = { lease_id: string; balance: number | string; total_charged: unknown } & Record<string, unknown>
type AgingCharge = { id: string; lease_id: string; amount: number | string; due_date: string }

type AgingRead =
  | { ok: true; data: ArLedgerRow[]; byLease: Map<string, AllocationCharge[]> }
  | { ok: false; error: { message: string; code?: string }; publicMsg: string }

// One full ledger + charges read, with the snapshot cross-check: ar_ledger.total_charged is
// Σ non-voided charges from the ledger's own snapshot, so the separately-fetched charges must sum
// to it per lease. A difference means a charge was inserted/voided/edited between the two requests
// (or a hosted max_rows silently truncated the charge read) and the buckets would be mis-aged.
async function readArAging(db: ReturnType<typeof getDb>, propertyId: string | undefined): Promise<AgingRead & { mismatch?: ChargeTotalMismatch }> {
  const { data, error } = await fetchAllPages<ArLedgerRow>((after) => {
    let q = db.from('ar_ledger').select('*').gt('balance', 0)
    if (propertyId) q = q.eq('property_id', propertyId)
    if (after !== null) q = q.gt('lease_id', after)
    return q.order('lease_id').limit(POSTGREST_MAX_ROWS)
  }, (r) => r.lease_id)
  if (error) return { ok: false, error, publicMsg: 'Failed to load AR aging report' }

  const { data: charges, error: chargeErr } = await fetchChunked(data.map(r => r.lease_id), BULK_QUERY_CHUNK_SIZE, (chunk) =>
    fetchAllPages<AgingCharge>((after) => {
      let q = db.from('charges').select('id, lease_id, amount, due_date')
        .in('lease_id', chunk)
        .is('voided_at', null)
      if (after !== null) q = q.gt('id', after)
      return q.order('id').limit(POSTGREST_MAX_ROWS)
    }, (ch) => ch.id),
    { maxRows: Infinity })
  if (chargeErr) return { ok: false, error: chargeErr, publicMsg: 'Failed to load AR aging charges' }

  const byLease = new Map<string, AllocationCharge[]>()
  for (const ch of charges) {
    const amountCents = toCents(ch.amount)
    if (amountCents === null || amountCents < 0) {
      return { ok: false, error: { message: `non-numeric or negative charges.amount on charge ${ch.id}` }, publicMsg: 'Failed to load AR aging report' }
    }
    const list = byLease.get(ch.lease_id) ?? []
    list.push({ id: ch.id, due_date: ch.due_date, amountCents })
    byLease.set(ch.lease_id, list)
  }
  const mismatch = findChargeTotalMismatch(data, byLease) ?? undefined
  return { ok: true, data, byLease, mismatch }
}

reportsRouter.get('/ar-aging', async (c) => {
  const db = getDb(c.env)
  const propertyId = c.req.query('property_id')

  // Re-run the whole read ONCE on a snapshot mismatch (a concurrent write is transient); a second
  // mismatch fails closed rather than serving a mis-aged report.
  let read = await readArAging(db, propertyId)
  if (read.ok && read.mismatch) read = await readArAging(db, propertyId)
  if (!read.ok) return dbError(c, read.error, read.publicMsg)
  if (read.mismatch) {
    const m = read.mismatch
    return dbError(c, { message: `AR aging snapshot mismatch persisted after retry: lease ${m.leaseId} ar_ledger.total_charged=${m.ledgerCents} cents, fetched charges=${m.chargeCents} cents` }, 'Failed to load AR aging report')
  }
  const { data, byLease } = read

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

// ---------------------------------------------------------------- financial reports (AppFolio-style)
//
// Read-only. Math lives in server/lib/financial-report.ts (billed/cash basis, NOT a GL — see its
// header). Every read is keyset-paged (fetchAllPages) and every `.in()` list is chunked, the same
// fail-closed pattern as /actuals: a truncated read would silently under-report.

type Db = ReturnType<typeof getDb>
type ReadErr = { message: string; code?: string }
type Read<T> = { data: T[]; error: ReadErr | null }

const PAYMENT_COLS = 'id, lease_id, payment_date, method, stripe_status, amount, check_number, notes'
const EXPENSE_COLS = 'id, property_id, expense_date, category, amount, vendor, description, properties(name)'
const CHARGE_COLS = 'id, lease_id, charge_date, type, amount'

/** Lease ids on the selected properties (every lease, any status — an ended lease still billed/paid). */
async function leaseIdsFor(db: Db, propertyIds: string[]): Promise<Read<string>> {
  const { data: units, error: uErr } = await fetchChunked(propertyIds, BULK_QUERY_CHUNK_SIZE, (chunk) =>
    fetchAllPages<{ id: string }>((after) => {
      let q = db.from('units').select('id').in('property_id', chunk)
      if (after !== null) q = q.gt('id', after)
      return q.order('id').limit(POSTGREST_MAX_ROWS)
    }, (u) => u.id), { maxRows: Infinity })
  if (uErr) return { data: [], error: uErr }
  const { data: leases, error: lErr } = await fetchChunked(units.map((u) => u.id), BULK_QUERY_CHUNK_SIZE, (chunk) =>
    fetchAllPages<{ id: string }>((after) => {
      let q = db.from('leases').select('id').in('unit_id', chunk)
      if (after !== null) q = q.gt('id', after)
      return q.order('id').limit(POSTGREST_MAX_ROWS)
    }, (l) => l.id), { maxRows: Infinity })
  return { data: leases.map((l) => l.id), error: lErr }
}

/** Rows of a lease-keyed table (charges/payments) in a date window, for all leases or a lease list. */
async function readLeaseRows<T extends { id: string }>(
  db: Db, table: 'charges' | 'payments', cols: string, dateCol: string, leaseIds: string[] | null, from: string, to: string,
): Promise<Read<T>> {
  const page = (chunk: string[] | null) => fetchAllPages<T>((after) => {
    let q = db.from(table).select(cols).gte(dateCol, from).lte(dateCol, to)
    if (table === 'charges') q = q.is('voided_at', null)
    if (chunk) q = q.in('lease_id', chunk)
    if (after !== null) q = q.gt('id', after)
    return q.order('id').limit(POSTGREST_MAX_ROWS) as unknown as PromiseLike<{ data: T[] | null; error: ReadErr | null }>
  }, (r) => r.id)
  if (leaseIds === null) return page(null)
  return fetchChunked(leaseIds, BULK_QUERY_CHUNK_SIZE, page, { maxRows: Infinity })
}

async function readExpenses(db: Db, propertyIds: string[] | null, from: string, to: string): Promise<Read<ActivityExpense>> {
  const page = (chunk: string[] | null) => fetchAllPages<ActivityExpense>((after) => {
    let q = db.from('expenses').select(EXPENSE_COLS).gte('expense_date', from).lte('expense_date', to)
    if (chunk) q = q.in('property_id', chunk)
    if (after !== null) q = q.gt('id', after)
    return q.order('id').limit(POSTGREST_MAX_ROWS) as unknown as PromiseLike<{ data: ActivityExpense[] | null; error: ReadErr | null }>
  }, (r) => r.id)
  if (propertyIds === null) return page(null)
  return fetchChunked(propertyIds, BULK_QUERY_CHUNK_SIZE, page, { maxRows: Infinity })
}

type LeaseMetaRow = { id: string; tenants: { name: string | null } | null; units: { suite: string | null; property_id: string; properties: { name: string | null } | null } | null }

async function readLeaseMeta(db: Db, leaseIds: string[]): Promise<{ data: Map<string, LeaseMeta>; error: ReadErr | null }> {
  const { data, error } = await fetchChunked(leaseIds, BULK_QUERY_CHUNK_SIZE, (chunk) =>
    db.from('leases').select('id, tenants(name), units(suite, property_id, properties(name))').in('id', chunk)
      .limit(POSTGREST_MAX_ROWS) as unknown as PromiseLike<{ data: LeaseMetaRow[] | null; error: ReadErr | null }>,
  { maxRows: POSTGREST_MAX_ROWS })
  const map = new Map<string, LeaseMeta>()
  for (const l of data) {
    if (!l.units) continue // unresolvable lease → buildCashActivity fails closed on it
    map.set(l.id, { tenant_name: l.tenants?.name ?? null, property_id: l.units.property_id, property_name: l.units.properties?.name ?? null, suite: l.units.suite })
  }
  return { data: map, error }
}

/** Shared query parsing for the financial endpoints; returns a Response on bad input. */
function parseFilters(c: Context<{ Bindings: Env }>) {
  const ids = parsePropertyIds(c.req.query('property_ids'))
  if (!ids.ok) return { error: c.json({ error: ids.error }, 422) }
  return { propertyIds: ids.ids }
}

// Cash in / cash out feed for the Transactions page and the dashboard's recent-activity tables.
reportsRouter.get('/cash-activity', async (c) => {
  const f = parseFilters(c)
  if ('error' in f) return f.error
  const range = parseReportRange(c.req.query('from'), c.req.query('to'))
  if (!range.ok) return c.json({ error: range.error }, 422)
  const db = getDb(c.env)

  let leaseIds: string[] | null = null
  if (f.propertyIds) {
    const l = await leaseIdsFor(db, f.propertyIds)
    if (l.error) return dbError(c, l.error, 'Failed to load cash activity')
    leaseIds = l.data
  }
  const payments = await readLeaseRows<ActivityPayment>(db, 'payments', PAYMENT_COLS, 'payment_date', leaseIds, range.from, range.to)
  if (payments.error) return dbError(c, payments.error, 'Failed to load cash activity')
  const expenses = await readExpenses(db, f.propertyIds, range.from, range.to)
  if (expenses.error) return dbError(c, expenses.error, 'Failed to load cash activity')
  const meta = await readLeaseMeta(db, [...new Set(payments.data.map((p) => p.lease_id))])
  if (meta.error) return dbError(c, meta.error, 'Failed to load cash activity')

  try {
    const { rows, totals } = buildCashActivity(payments.data, expenses.data, meta.data, range)
    return c.json({ data: rows, totals, range: { from: range.from, to: range.to } })
  } catch (e) {
    return dbError(c, { message: (e as Error).message }, 'Failed to load cash activity')
  }
})

// Income statement + cash flow for the selected period and fiscal year to date.
reportsRouter.get('/financials', async (c) => {
  const f = parseFilters(c)
  if ('error' in f) return f.error
  const range = parseReportRange(c.req.query('from'), c.req.query('to'))
  if (!range.ok) return c.json({ error: range.error }, 422)
  const fytd = { from: fiscalYearStart(range.to), to: range.to }
  const readFrom = range.from < fytd.from ? range.from : fytd.from
  const db = getDb(c.env)

  let leaseIds: string[] | null = null
  if (f.propertyIds) {
    const l = await leaseIdsFor(db, f.propertyIds)
    if (l.error) return dbError(c, l.error, 'Failed to load financial report')
    leaseIds = l.data
  }
  const charges = await readLeaseRows<StmtCharge>(db, 'charges', CHARGE_COLS, 'charge_date', leaseIds, readFrom, range.to)
  if (charges.error) return dbError(c, charges.error, 'Failed to load financial report')
  const payments = await readLeaseRows<StmtPayment>(db, 'payments', PAYMENT_COLS, 'payment_date', leaseIds, readFrom, range.to)
  if (payments.error) return dbError(c, payments.error, 'Failed to load financial report')
  const expenses = await readExpenses(db, f.propertyIds, readFrom, range.to)
  if (expenses.error) return dbError(c, expenses.error, 'Failed to load financial report')

  try {
    return c.json({
      range: { from: range.from, to: range.to },
      fytd_range: fytd,
      income_statement: { period: buildIncomeStatement(charges.data, expenses.data, range), fytd: buildIncomeStatement(charges.data, expenses.data, fytd) },
      cash_flow: { period: buildCashFlow(payments.data, expenses.data, range), fytd: buildCashFlow(payments.data, expenses.data, fytd) },
    })
  } catch (e) {
    return dbError(c, { message: (e as Error).message }, 'Failed to load financial report')
  }
})

// Trailing 12-month income statement ending at `through` (YYYY-MM).
reportsRouter.get('/income-statement-12mo', async (c) => {
  const f = parseFilters(c)
  if ('error' in f) return f.error
  const through = c.req.query('through') ?? ''
  let months: string[]
  try {
    months = trailingMonths(through, 12)
  } catch {
    return c.json({ error: 'through must be YYYY-MM' }, 422)
  }
  const from = monthRange(months[0]).from
  const to = monthRange(months[11]).to
  const db = getDb(c.env)

  let leaseIds: string[] | null = null
  if (f.propertyIds) {
    const l = await leaseIdsFor(db, f.propertyIds)
    if (l.error) return dbError(c, l.error, 'Failed to load income statement')
    leaseIds = l.data
  }
  const charges = await readLeaseRows<StmtCharge>(db, 'charges', CHARGE_COLS, 'charge_date', leaseIds, from, to)
  if (charges.error) return dbError(c, charges.error, 'Failed to load income statement')
  const expenses = await readExpenses(db, f.propertyIds, from, to)
  if (expenses.error) return dbError(c, expenses.error, 'Failed to load income statement')

  try {
    return c.json(buildMonthlyIncomeStatement(charges.data, expenses.data, months))
  } catch (e) {
    return dbError(c, { message: (e as Error).message }, 'Failed to load income statement')
  }
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
