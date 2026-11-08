import { Hono } from 'hono'
import { getDb } from '../db/client'
import { calculateCAMTrueUp, computeCamPool, CAMTermsError, type CAMPool, type CAMRentType } from '../lib/cam'
import { CamCalculateSchema, CamRecoverableQuerySchema } from '../lib/schemas'
import { dbError } from '../lib/api-error'
import { fetchAllPages, fetchChunked, POSTGREST_MAX_ROWS } from '../lib/postgrest-paging'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }
type Db = ReturnType<typeof getDb>
type PgErr = { message: string; code?: string }

export const camRouter = new Hono<{ Bindings: Env }>()

// CAMTermsError messages are authored in server/lib/cam.ts (lease-data problems the user fixes on
// the lease, e.g. "modified-gross lease has no expense stop"), never DB/driver text, so they are
// safe to return verbatim. Typed to CAMTermsError so nothing else can be routed through it
// (allowlisted by name in tests/lib/no-raw-db-errors.test.ts).
const camTermsJson = (err: CAMTermsError) => ({ error: err.message })

camRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const { data, error } = await db
    .from('cam_reconciliations')
    .select('*, leases(tenant_id, tenants(name), units(suite, properties(name)))')
    .order('reconciliation_year', { ascending: false })
  if (error) return dbError(c, error, 'Failed to load CAM reconciliations')
  return c.json({ data })
})

// Total recoverable expenses for a property/year. Computed here, not in the browser: GET /expenses
// returns one PaginationSchema page (50 rows by default), so a client-side sum silently dropped
// every expense past it, and a browser `getFullYear()` on a DATE shifted Jan 1 into the prior year.
// Keyset-paged on expenses.id (uuid PK) so the total is complete regardless of PostgREST's max_rows
// cap; the year is an inclusive DATE range compared in Postgres. Shared by GET
// /recoverable-expenses, GET /pool and POST /calculate (which no longer trusts a client total).
async function loadRecoverableTotal(db: Db, propertyId: string, year: number): Promise<{ total: number; count: number; error: PgErr | null }> {
  const { data: rows, error } = await fetchAllPages<{ id: string; amount: number }>((after) => {
    let q = db.from('expenses').select('id, amount')
      .eq('property_id', propertyId)
      .eq('recoverable', true)
      .gte('expense_date', `${year}-01-01`).lte('expense_date', `${year}-12-31`)
    if (after !== null) q = q.gt('id', after)
    return q.order('id').limit(POSTGREST_MAX_ROWS)
  }, (e) => e.id)
  if (error) return { total: 0, count: 0, error }
  // Summed in integer cents: thousands of float additions can drift before a final round.
  const total = rows.reduce((cents, e) => cents + Math.round(Number(e.amount) * 100), 0) / 100
  return { total, count: rows.length, error: null }
}

// Lease statuses that can have occupied space during a past reconciliation year. 'pending' (not yet
// commenced/executed) never counts. 'expired' and 'terminated' DO count for the days they were in
// effect: that is the point of the server-side pool (audit finding cam-denominator-client-snapshot).
const POOL_LEASE_STATUSES = ['active', 'expired', 'terminated']
const UNIT_ID_CHUNK = 100

type PoolLeaseRow = {
  id: string
  unit_id: string
  status: string
  start_date: string
  end_date: string
  rent_type: CAMRentType
}

/**
 * The CAM pool for a property/year, from the DB (audit finding cam-denominator-client-snapshot).
 * Every lease on the property's units whose term overlaps the year (status active / expired /
 * terminated), weighted by days in effect: see computeCamPool in server/lib/cam.ts. Fails closed:
 * any read error, or a chunk at the PostgREST row cap, is returned as an error, never a partial pool.
 */
async function loadCamPool(db: Db, propertyId: string, year: number): Promise<
  { pool: CAMPool; leases: PoolLeaseRow[]; error: null } | { pool: null; leases: null; error: PgErr | CAMTermsError }
> {
  const { data: units, error: unitsErr } = await fetchAllPages<{ id: string; sf: number }>((after) => {
    let q = db.from('units').select('id, sf').eq('property_id', propertyId)
    if (after !== null) q = q.gt('id', after)
    return q.order('id').limit(POSTGREST_MAX_ROWS)
  }, (u) => u.id)
  if (unitsErr) return { pool: null, leases: null, error: unitsErr }

  const sfByUnit = new Map(units.map((u) => [u.id, Number(u.sf)]))
  const { data: leases, error: leasesErr } = await fetchChunked<PoolLeaseRow>(
    units.map((u) => u.id),
    UNIT_ID_CHUNK,
    (chunk) => db.from('leases')
      .select('id, unit_id, status, start_date, end_date, rent_type')
      .in('unit_id', chunk)
      .in('status', POOL_LEASE_STATUSES)
      .lte('start_date', `${year}-12-31`)
      .gte('end_date', `${year}-01-01`),
    { maxRows: POSTGREST_MAX_ROWS },
  )
  if (leasesErr) return { pool: null, leases: null, error: leasesErr }

  try {
    const pool = computeCamPool(
      leases.map((l) => ({ id: l.id, sf: sfByUnit.get(l.unit_id) ?? NaN, start_date: l.start_date, end_date: l.end_date })),
      year,
    )
    return { pool, leases, error: null }
  } catch (err) {
    if (err instanceof CAMTermsError) return { pool: null, leases: null, error: err }
    throw err
  }
}

camRouter.get('/recoverable-expenses', async (c) => {
  const parsed = CamRecoverableQuerySchema.safeParse({
    property_id: c.req.query('property_id'),
    year: c.req.query('year'),
  })
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 400)
  const { property_id, year } = parsed.data

  const { total, count, error } = await loadRecoverableTotal(getDb(c.env), property_id, year)
  if (error) return dbError(c, error, 'Failed to load recoverable expenses')
  return c.json({ data: { total, count } })
})

// GET /cam/pool?property_id&year — the server-computed CAM pool the CAM page displays and whose
// leases it reconciles. Display only: /calculate recomputes everything itself and never reads it back.
camRouter.get('/pool', async (c) => {
  const parsed = CamRecoverableQuerySchema.safeParse({
    property_id: c.req.query('property_id'),
    year: c.req.query('year'),
  })
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 400)
  const { property_id, year } = parsed.data
  const db = getDb(c.env)

  const recoverable = await loadRecoverableTotal(db, property_id, year)
  if (recoverable.error) return dbError(c, recoverable.error, 'Failed to load recoverable expenses')
  const loaded = await loadCamPool(db, property_id, year)
  if (loaded.error instanceof CAMTermsError) return c.json(camTermsJson(loaded.error), 422)
  if (loaded.error) return dbError(c, loaded.error, 'Failed to load CAM pool')

  return c.json({
    data: {
      recoverable_total: recoverable.total,
      recoverable_count: recoverable.count,
      days_in_year: loaded.pool.daysInYear,
      weighted_leased_sf: loaded.pool.weightedLeasedSF,
      leases: loaded.leases
        .filter((l) => loaded.pool.byLease[l.id])
        .map((l) => ({
          lease_id: l.id,
          status: l.status,
          rent_type: l.rent_type,
          sf: loaded.pool.byLease[l.id].sf,
          overlap_days: loaded.pool.byLease[l.id].overlapDays,
          weighted_sf: loaded.pool.byLease[l.id].weightedSF,
        })),
    },
  })
})

// Calculate and save CAM reconciliation for a lease/year.
// Body: { lease_id, reconciliation_year }. total_property_recoverable_expenses / total_leased_sf
// are still ACCEPTED (an already-loaded older page bundle sends them) but IGNORED: both are
// recomputed from the DB here (audit finding cam-denominator-client-snapshot — the browser used to
// compute the denominator from today's active rent roll, and this route trusted it).
camRouter.post('/calculate', async (c) => {
  const db = getDb(c.env)
  const raw = await c.req.json()
  const parsed = CamCalculateSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const { lease_id, reconciliation_year } = parsed.data

  // Every read below FAILS CLOSED (PR #42 refute): they used to discard `error`, so a failed query
  // read as SF 0 / estimated_cam_paid 0 and SAVED a draft with a wrong pro-rata or an overstated
  // true_up_amount that /approve would then post. A genuinely missing lease is PGRST116 (no row) and
  // is a 404-class input error, not a DB failure — returned as such (PR #42 review follow-up: this
  // used to swallow PGRST116 and fall through with tenantSF defaulted to 0, computing a true-up
  // against a nonexistent lease that only failed later, and generically, via the
  // cam_reconciliations FK constraint on insert).
  const { data: lease, error: leaseErr } = await db
    .from('leases')
    .select('id, rent_type, expense_stop_amount, units(property_id)')
    .eq('id', lease_id)
    .single()
  if (leaseErr) {
    if (leaseErr.code === 'PGRST116') return c.json({ error: 'Lease not found' }, 404)
    return dbError(c, leaseErr, 'Failed to load lease')
  }

  // rent_type + expense_stop_amount (audit finding cam-ignores-rent-type-expense-stop): the true-up
  // used to bill every lease its full pro-rata share, so gross and modified-gross tenants were
  // charged CAM their leases do not pass through. calculateCAMTrueUp applies the schema semantics.
  const leaseRow = lease as unknown as {
    units: { property_id: string } | null
    rent_type: CAMRentType | null
    expense_stop_amount: number | string | null
  } | null
  const propertyId = leaseRow?.units?.property_id
  if (!propertyId) return c.json({ error: 'Lease has no unit/property — cannot build the CAM pool' }, 422)
  const rentType: CAMRentType = leaseRow?.rent_type ?? 'nnn' // column is NOT NULL DEFAULT 'nnn'
  // NUMERIC can arrive as a string from PostgREST; null stays null (no stop).
  const expenseStopPerSF = leaseRow?.expense_stop_amount == null ? null : Number(leaseRow.expense_stop_amount)

  // Server-side pool: recoverable total + occupancy-weighted denominator for the property/year.
  const recoverable = await loadRecoverableTotal(db, propertyId, reconciliation_year)
  if (recoverable.error) return dbError(c, recoverable.error, 'Failed to load recoverable expenses')
  const total_property_recoverable_expenses = recoverable.total
  const loaded = await loadCamPool(db, propertyId, reconciliation_year)
  if (loaded.error instanceof CAMTermsError) return c.json(camTermsJson(loaded.error), 422)
  if (loaded.error) return dbError(c, loaded.error, 'Failed to load CAM pool')
  const tenantInPool = loaded.pool.byLease[lease_id]
  if (!tenantInPool) {
    return c.json({ error: `Lease was not in effect during ${reconciliation_year} (or is pending) — no CAM reconciliation for that year` }, 422)
  }
  // Occupancy-weighted: a tenant in place for part of the year bears that part of a full-year share
  // (and an expense stop is prorated by the same factor — see calculateCAMTrueUp).
  const tenantSF = tenantInPool.weightedSF

  // Sum all CAM estimate charges billed this year. OI-278 / migration 0016: a voided estimate was
  // never really billed, so it must not count as CAM paid (that would understate the true-up).
  // Fail closed on a read error — including 42703 while the app runs ahead of migration 0016.
  const { data: camCharges, error: camChargesErr } = await db
    .from('charges')
    .select('amount')
    .eq('lease_id', lease_id)
    .eq('type', 'cam_estimate')
    .is('voided_at', null)
    .gte('period_start', `${reconciliation_year}-01-01`)
    .lte('period_end', `${reconciliation_year}-12-31`)
  if (camChargesErr) return dbError(c, camChargesErr, 'Failed to load CAM estimate charges')

  const estimatedCamPaid = (camCharges ?? []).reduce(
    (s: number, ch: { amount: number }) => s + ch.amount,
    0
  )

  let result
  try {
    result = calculateCAMTrueUp({
      totalRecoverableExpenses: total_property_recoverable_expenses,
      tenantSF,
      totalLeasedSF: loaded.pool.weightedLeasedSF,
      estimatedCamPaid,
      rentType,
      expenseStopPerSF,
    })
  } catch (err) {
    // Lease-terms problems (e.g. modified_gross with no expense stop) are a 422 the user fixes on
    // the lease; nothing is saved either way.
    if (err instanceof CAMTermsError) return c.json(camTermsJson(err), 422)
    return c.json({ error: (err as Error).message }, 400)
  }

  const patch = {
    total_property_recoverable_expenses,
    tenant_pro_rata_share_pct: result.tenantProRataSharePct,
    estimated_cam_paid: estimatedCamPaid,
    actual_cam_owed: result.actualCamOwed,
    true_up_amount: result.trueUpAmount,
    status: 'draft' as const,
  }

  const ALREADY_BILLED = {
    error: 'This reconciliation has already been billed. Recalculating would silently reopen it '
      + 'and orphan the posted true-up charge — void or credit the existing charge manually before '
      + 'recalculating.',
  }

  // OI-069: this used to be a single `.upsert(..., {onConflict})` that
  // unconditionally reset status to 'draft' — even for an already-'billed'
  // row. A later /:id/approve on that reopened row would try to post a NEW
  // true-up charge whose idempotency key (cam_true_up:<lease_id>:<year>)
  // collides with the OLD charge's key; the collision is correctly
  // swallowed as a no-op by OI-046's own guarantee (working as designed),
  // but the status update still succeeds — the API reports success while
  // the ledger silently keeps the STALE amount.
  //
  // A separate check-then-act pre-check (SELECT status, then upsert) closes
  // the single-request-rerun case but not a genuine race: a concurrent
  // /:id/approve can bill the row in the window between the check and the
  // upsert, and the upsert's unconditional 'draft' reset reopens it anyway.
  // This attempts the update FIRST, atomically guarded by `.eq('status',
  // 'draft')` — the same "conditional update as the concurrency control"
  // idiom OI-046 already uses on /:id/approve, just applied here instead of
  // a separate read. A concurrent approve that bills the row after this
  // request read it (for the lease/tenantSF/estimatedCamPaid lookups above)
  // but before this UPDATE simply causes it to match zero rows — it can
  // never silently overwrite a row that is not 'draft' at the moment of the
  // write, because the DB evaluates the WHERE clause atomically. Allow-list
  // ('draft' only), not a deny-list against 'billed' — 'collected' is a
  // third legal status (0002_financial_tables.sql:71) that must be guarded
  // identically, plus any future status value by default.
  const { data: updated, error: updateErr } = await db
    .from('cam_reconciliations')
    .update(patch)
    .eq('lease_id', lease_id)
    .eq('reconciliation_year', reconciliation_year)
    .eq('status', 'draft')
    .select()

  if (updateErr) return dbError(c, updateErr, 'Failed to save CAM reconciliation')
  if (updated && updated.length > 0) return c.json({ data: updated[0] })

  // Zero rows updated: either no reconciliation exists yet for this
  // lease/year (first-ever calculation — insert), or one exists and IS
  // 'billed' (must reject, not silently reopen). Insert directly rather
  // than reading again first — the unique constraint on
  // (lease_id, reconciliation_year) makes an insert into an existing row
  // fail (23505) instead of silently corrupting it, so this can only ever
  // succeed for the genuinely-new case.
  const { data: inserted, error: insertErr } = await db
    .from('cam_reconciliations')
    .insert({ lease_id, reconciliation_year, ...patch })
    .select()
    .single()

  if (!insertErr) return c.json({ data: inserted })
  if (insertErr.code !== '23505') return dbError(c, insertErr, 'Failed to save CAM reconciliation')

  // Insert conflicted — a row already exists. Either it's the 'billed' row
  // this request should reject, or a concurrent first-time-calculation
  // request for the SAME lease/year beat this one to creating it as
  // 'draft' (a benign, narrow race unrelated to OI-069 — both requests are
  // computing the same lease/year's first draft). Read it to tell which.
  const { data: existing, error: existingErr } = await db
    .from('cam_reconciliations')
    .select('status')
    .eq('lease_id', lease_id)
    .eq('reconciliation_year', reconciliation_year)
    .maybeSingle()

  if (existingErr) return dbError(c, existingErr, 'Failed to check existing reconciliation')
  // Allow-list, not a deny-list: only 'draft' may be recalculated. Guards
  // 'billed' AND 'collected' (a third legal status per the CHECK constraint,
  // 0002_financial_tables.sql:71 — currently unreachable in this codebase,
  // but a deny-list here would silently reopen it too the moment anything
  // starts setting it) identically, plus any future status value by default.
  if (existing?.status !== 'draft') return c.json(ALREADY_BILLED, 409)

  // Existing row is 'draft' (lost the first-time-calculation race above) —
  // retry the same conditional update now that the row exists.
  const { data: retried, error: retryErr } = await db
    .from('cam_reconciliations')
    .update(patch)
    .eq('lease_id', lease_id)
    .eq('reconciliation_year', reconciliation_year)
    .eq('status', 'draft')
    .select()

  if (retryErr) return dbError(c, retryErr, 'Failed to save CAM reconciliation')
  // Vanishingly narrow window: billed between the read above and this
  // retry. Still correctly rejected, not silently reopened.
  if (!retried || retried.length === 0) return c.json(ALREADY_BILLED, 409)
  return c.json({ data: retried[0] })
})

// Approve CAM reconciliation — posts true-up charge to tenant ledger.
//
// OI-046 fix: this used to be a read-check-act sequence (select status, check
// it's 'draft', insert the true-up charge, then update status) — two
// concurrent approve calls could both observe 'draft' and both post a
// true-up charge, double-billing the tenant. Both branches below now use an
// insert-first, conditional-update-second pattern instead:
//   1. Insert (idempotency-keyed per lease+year) — a concurrent/retried
//      request collides on the unique key (23505) instead of posting twice.
//   2. Conditionally transition status with `.eq('status', 'draft')` — an
//      atomic compare-and-swap. Zero rows back means someone else already
//      billed it; return 400 rather than treating that as an error.
// Crash-safety: crash after insert but before the update leaves a posted
// charge + status still 'draft' — safe to retry (insert hits 23505, update
// completes). Crash before insert leaves nothing — safe to retry from
// scratch. The ordering is load-bearing; do not swap it.
camRouter.post('/:id/approve', async (c) => {
  const db = getDb(c.env)
  const id = c.req.param('id')
  const { data: rec, error: recErr } = await db
    .from('cam_reconciliations')
    .select('*')
    .eq('id', id)
    .single()

  if (recErr || !rec) return c.json({ error: 'Not found' }, 404)

  const r = rec as { true_up_amount: number; lease_id: string; reconciliation_year: number }
  const trueUp = r.true_up_amount
  if (trueUp === 0) return c.json({ message: 'No true-up required (balanced)', true_up_amount: 0 })

  const today = new Date().toISOString().slice(0, 10)

  // KNOWN LIMITATION (Phase 1): A negative true-up (credit owed to tenant) is not
  // auto-posted as a charge, because charges.amount has CHECK (amount >= 0) and the
  // ar_ledger view would treat a posted "credit" charge as a DEBIT, overstating
  // tenant AR. Credits must be reconciled manually until Phase 1.1 adds a proper
  // credit mechanism (credit_amount column or separate credits table). This branch
  // only transitions status — mirrored via the same conditional-update guard as the
  // positive-true-up path below (no insert, so no idempotency key needed here).
  if (trueUp < 0) {
    const { data: updated, error: updateErr } = await db
      .from('cam_reconciliations')
      .update({
        status: 'billed',
        billed_date: today,
        notes: `Credit of ${Math.abs(trueUp).toFixed(2)} owed to tenant — handle manually (Phase 1 limitation)`,
      })
      .eq('id', id)
      .eq('status', 'draft')
      .select()

    if (updateErr) return dbError(c, updateErr, 'Failed to approve CAM reconciliation')
    if (!updated || updated.length === 0) return c.json({ error: 'already billed' }, 400)

    return c.json({
      success: true,
      true_up_amount: trueUp,
      message: 'Credit owed to tenant — flagged for manual handling (not auto-posted)',
    })
  }

  const { error: insertErr } = await db.from('charges').insert({
    lease_id: r.lease_id,
    charge_date: today,
    due_date: today,
    period_start: `${r.reconciliation_year}-01-01`,
    period_end: `${r.reconciliation_year}-12-31`,
    type: 'cam_true_up',
    amount: Math.abs(trueUp),
    description: `${r.reconciliation_year} CAM True-Up`,
    source: 'manual',
    idempotency_key: `cam_true_up:${r.lease_id}:${r.reconciliation_year}`,
  })

  // 23505 = unique-constraint conflict on idempotency_key: this true-up was
  // already posted by a concurrent/earlier approve call. Treat as an already-
  // posted no-op and continue to the status update — do not re-insert, do not error.
  if (insertErr && insertErr.code !== '23505') {
    return dbError(c, insertErr, 'Failed to post CAM true-up charge')
  }

  const { data: updated, error: updateErr } = await db
    .from('cam_reconciliations')
    .update({ status: 'billed', billed_date: today })
    .eq('id', id)
    .eq('status', 'draft')
    .select()

  if (updateErr) return dbError(c, updateErr, 'Failed to approve CAM reconciliation')
  if (!updated || updated.length === 0) return c.json({ error: 'already billed' }, 400)

  return c.json({ success: true, true_up_amount: trueUp })
})
