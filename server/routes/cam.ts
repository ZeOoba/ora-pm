import { Hono } from 'hono'
import { getDb } from '../db/client'
import {
  assertBaseYearCategoriesMatch, assertCamReconciled, assertDenominatorCoversPool, assertNoStaleClosedLeases, assertValidCategories, calculateCAMTrueUp,
  computeCamPool, CAMTermsError, EXPENSE_CATEGORIES, overRecoveryWarningByCategory, peakConcurrentLeasedSF, poolForCategories,
  resolveTenantShare, type CAMPool, type CAMRentType, type ExpenseCategory, type ResolvedShare,
} from '../lib/cam'
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
// 0025 (rulings 2026-11-10): totals are also split by expenses.category, so a lease that passes
// through only some categories is billed a share of those (poolForCategories). An expense whose
// category is not one of EXPENSE_CATEGORIES (impossible under the 0002 CHECK) fails closed.
type RecoverableTotals = { total: number; count: number; byCategory: Record<ExpenseCategory, number> }
async function loadRecoverableTotal(db: Db, propertyId: string, year: number): Promise<
  (RecoverableTotals & { error: null }) | { total: 0; count: 0; byCategory: null; error: PgErr }
> {
  const { data: rows, error } = await fetchAllPages<{ id: string; amount: number | string; category: string }>((after) => {
    let q = db.from('expenses').select('id, amount, category')
      .eq('property_id', propertyId)
      .eq('recoverable', true)
      .gte('expense_date', `${year}-01-01`).lte('expense_date', `${year}-12-31`)
    if (after !== null) q = q.gt('id', after)
    return q.order('id').limit(POSTGREST_MAX_ROWS)
  }, (e) => e.id)
  if (error) return { total: 0, count: 0, byCategory: null, error }
  // Summed in integer cents: thousands of float additions can drift before a final round.
  const centsBy = Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c, 0])) as Record<ExpenseCategory, number>
  let totalCents = 0
  for (const e of rows) {
    const cents = Math.round(Number(e.amount) * 100)
    if (!(e.category in centsBy)) {
      return { total: 0, count: 0, byCategory: null, error: { message: `recoverable expense ${e.id} has unknown category` } }
    }
    centsBy[e.category as ExpenseCategory] += cents
    totalCents += cents
  }
  const byCategory = Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c, centsBy[c] / 100])) as Record<ExpenseCategory, number>
  return { total: totalCents / 100, count: rows.length, byCategory, error: null }
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
  /** leases.proportionate_share_pct (0021): NUMERIC, may arrive as a string from PostgREST. */
  proportionate_share_pct: number | string | null
  /** 0025: categories passed through (null = all), and the not-reconciled flag. */
  recoverable_categories: string[] | null
  cam_reconciled: boolean
  cam_exclusion_reason: string | null
}

/** NUMERIC columns can arrive from PostgREST as strings; null stays null. A non-numeric value
 *  becomes NaN, which every consumer in server/lib/cam.ts refuses (fail closed). */
const numOrNull = (v: number | string | null | undefined): number | null => (v == null ? null : Number(v))

/** Dollars (number or NUMERIC string) to integer cents, for exact money comparison. */
const cents = (v: unknown) => Math.round(Number(v) * 100)

/**
 * The CAM pool for a property/year, from the DB (audit finding cam-denominator-client-snapshot).
 * Every lease on the property's units whose term overlaps the year (status active / expired /
 * terminated), weighted by days in effect: see computeCamPool in server/lib/cam.ts. Fails closed:
 * any read error, or a chunk at the PostgREST row cap, is returned as an error, never a partial pool.
 */
async function loadCamPool(db: Db, propertyId: string, year: number): Promise<
  {
    pool: CAMPool; leases: PoolLeaseRow[]; denominatorRSF: number | null
    /** Non-blocking pool-level warnings about the denominator (see H1 below). */
    denominatorWarnings: string[]
    /** Holdover flag per lease id (ruling 2026-11-08: holdover excluded from CAM and flagged). */
    holdover: Map<string, string>
    error: null
  }
  | { pool: null; leases: null; denominatorRSF: null; denominatorWarnings: null; holdover: null; error: PgErr | CAMTermsError }
> {
  const fail = (error: PgErr | CAMTermsError) => ({ pool: null, leases: null, denominatorRSF: null, denominatorWarnings: null, holdover: null, error }) as const
  // Building-RSF ruling (2026-11-08): the denominator is the building/project RSF the lease form
  // names (properties.cam_denominator_rsf, 0021) — never total_sf, which the importer fills with
  // summed suite SF. Fail closed on any read error.
  const { data: prop, error: propErr } = await db
    .from('properties')
    .select('id, cam_denominator_rsf')
    .eq('id', propertyId)
    .single()
  if (propErr) return fail(propErr)
  const denominatorRSF = numOrNull((prop as { cam_denominator_rsf: number | string | null } | null)?.cam_denominator_rsf)
  if (denominatorRSF !== null && !(Number.isFinite(denominatorRSF) && denominatorRSF > 0)) {
    return fail(new CAMTermsError('The property\'s CAM denominator rentable SF is not a positive number'))
  }

  const { data: units, error: unitsErr } = await fetchAllPages<{ id: string; sf: number; suite?: string | null }>((after) => {
    let q = db.from('units').select('id, sf, suite').eq('property_id', propertyId)
    if (after !== null) q = q.gt('id', after)
    return q.order('id').limit(POSTGREST_MAX_ROWS)
  }, (u) => u.id)
  if (unitsErr) return fail(unitsErr)

  const sfByUnit = new Map(units.map((u) => [u.id, Number(u.sf)]))
  const unitLabel = new Map(units.map((u) => [u.id, u.suite ? `${u.suite} (${u.id})` : u.id]))
  const { data: leases, error: leasesErr } = await fetchChunked<PoolLeaseRow>(
    units.map((u) => u.id),
    UNIT_ID_CHUNK,
    (chunk) => db.from('leases')
      .select('id, unit_id, status, start_date, end_date, rent_type, proportionate_share_pct, recoverable_categories, cam_reconciled, cam_exclusion_reason')
      .in('unit_id', chunk)
      .in('status', POOL_LEASE_STATUSES)
      .lte('start_date', `${year}-12-31`)
      .gte('end_date', `${year}-01-01`),
    { maxRows: POSTGREST_MAX_ROWS },
  )
  if (leasesErr) return fail(leasesErr)

  // Holdover (ruling 2026-11-08: excluded from CAM and flagged). A lease still 'active' whose
  // end_date has passed is a tenant holding over. computeCamPool clips every lease at end_date, so
  // the holdover days are already excluded; this makes the exclusion visible instead of silent
  // (REFUTE C4, 2026-11-10). A lease counts as holding over during `year` when its end_date is
  // before both today and the year's last day — which includes leases that ended before the year
  // began and so are not in the pool at all (they would otherwise vanish from the CAM page).
  const today = new Date().toISOString().slice(0, 10)
  const yearEnd = `${year}-12-31`
  const holdoverCutoff = today < yearEnd ? today : yearEnd
  const { data: heldOver, error: heldOverErr } = await fetchChunked<{ id: string; unit_id: string; end_date: string }>(
    units.map((u) => u.id),
    UNIT_ID_CHUNK,
    (chunk) => db.from('leases')
      .select('id, unit_id, end_date')
      .in('unit_id', chunk)
      .eq('status', 'active')
      .lte('start_date', yearEnd)
      .lt('end_date', holdoverCutoff),
    { maxRows: POSTGREST_MAX_ROWS },
  )
  if (heldOverErr) return fail(heldOverErr)
  const holdover = new Map(heldOver.map((l) => [l.id, `Holdover: lease ${l.id} (unit ${unitLabel.get(l.unit_id) ?? l.unit_id}) `
    + `is still active but its term ended ${l.end_date}. CAM for days after ${l.end_date} is excluded from `
    + `this ${year} reconciliation, not billed. Decide the holdover terms, then renew/extend the lease or mark it expired.`]))

  // REFUTE H1 (2026-11-10): recoverable expenses are pooled per property row, so the denominator
  // must cover every unit on that row. A denominator below the summed unit SF (e.g. one building's
  // RSF entered on a property row that holds two buildings) overstates every computed share once the
  // units fill. Warning, not refusal: unit SF can legitimately differ from lease-form RSF.
  const unitSFTotal = units.reduce((s, u) => s + (Number.isFinite(Number(u.sf)) ? Number(u.sf) : 0), 0)
  const denominatorWarnings = denominatorRSF !== null && unitSFTotal > denominatorRSF
    ? [`CAM denominator ${denominatorRSF.toLocaleString('en-US')} RSF is less than the ${unitSFTotal.toLocaleString('en-US')} SF of units `
      + 'on this property. The expense pool covers the whole property row: if it holds more than one building, the '
      + 'denominator must be the RSF of all of them, or computed shares are overstated. Check before Approve & Bill.']
    : []

  try {
    const pool = computeCamPool(
      // unit_id: overlapping leases on one unit fail closed (REFUTE C4b) — see computeCamPool.
      leases.map((l) => ({ id: l.id, unit_id: l.unit_id, unit_label: unitLabel.get(l.unit_id), sf: sfByUnit.get(l.unit_id) ?? NaN, start_date: l.start_date, end_date: l.end_date })),
      year,
    )
    // REFUTE C4b': a terminated/expired pool lease whose end_date is still on/after today keeps its
    // original end_date and would be weighted as occupying a possibly vacant unit — fail closed.
    // Runs after computeCamPool so a same-unit overlap (C4b) reports its more specific message.
    assertNoStaleClosedLeases(
      leases.filter((l) => pool.byLease[l.id] !== undefined).map((l) => ({ id: l.id, unit_id: unitLabel.get(l.unit_id) ?? l.unit_id, status: l.status, end_date: l.end_date })),
      new Date().toISOString().slice(0, 10),
    )
    // Ruling 2026-11-08: a denominator smaller than the SF leased on any day of the year means the
    // RSF (or a unit's SF) is wrong and every computed share is overstated — fail closed (422).
    assertDenominatorCoversPool(pool, denominatorRSF)
    return { pool, leases, denominatorRSF, denominatorWarnings, holdover, error: null }
  } catch (err) {
    if (err instanceof CAMTermsError) return fail(err)
    throw err
  }
}

/** Resolve one pool lease's Proportionate Share (see resolveTenantShare in server/lib/cam.ts). */
function shareForPoolLease(pool: CAMPool, lease: PoolLeaseRow, denominatorRSF: number | null): ResolvedShare {
  const inPool = pool.byLease[lease.id]
  return resolveTenantShare({
    leaseId: lease.id,
    statedPct: numOrNull(lease.proportionate_share_pct),
    premisesSF: inPool.sf,
    denominatorRSF,
    overlapDays: inPool.overlapDays,
    daysInYear: pool.daysInYear,
  })
}

/** Every pool lease's resolved share (or the CAMTermsError that refused it), plus the pool-level
 *  over-recovery warning (shares of one category summing above 100% on some day) — warning only.
 *  0025: a lease marked not CAM-reconciled still has its share resolved for display but is left out
 *  of the over-recovery sum (it recovers nothing); a lease with invalid categories is refused. */
function resolvePoolShares(pool: CAMPool, leases: PoolLeaseRow[], denominatorRSF: number | null): {
  byLease: Map<string, ResolvedShare | CAMTermsError>
  poolWarning: string | null
} {
  const byLease = new Map<string, ResolvedShare | CAMTermsError>()
  const recovering = new Map<string, { annualPct: number; categories: readonly ExpenseCategory[] | null }>()
  for (const l of leases) {
    if (!pool.byLease[l.id]) continue
    try {
      const s = shareForPoolLease(pool, l, denominatorRSF)
      const categories = l.recoverable_categories ?? null
      assertValidCategories(categories)
      byLease.set(l.id, s)
      if (l.cam_reconciled !== false) recovering.set(l.id, { annualPct: s.annualPct, categories })
    } catch (err) {
      if (!(err instanceof CAMTermsError)) throw err
      byLease.set(l.id, err)
    }
  }
  return { byLease, poolWarning: overRecoveryWarningByCategory(pool, recovering)[0] ?? null }
}

camRouter.get('/recoverable-expenses', async (c) => {
  const parsed = CamRecoverableQuerySchema.safeParse({
    property_id: c.req.query('property_id'),
    year: c.req.query('year'),
  })
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 400)
  const { property_id, year } = parsed.data

  const { total, count, byCategory, error } = await loadRecoverableTotal(getDb(c.env), property_id, year)
  if (error) return dbError(c, error, 'Failed to load recoverable expenses')
  return c.json({ data: { total, count, by_category: byCategory } })
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

  const { pool: camPool, denominatorRSF } = loaded
  const shares = resolvePoolShares(camPool, loaded.leases, denominatorRSF)
  return c.json({
    data: {
      recoverable_total: recoverable.total,
      recoverable_count: recoverable.count,
      recoverable_by_category: recoverable.byCategory,
      days_in_year: camPool.daysInYear,
      weighted_leased_sf: camPool.weightedLeasedSF,
      // Ruling 2026-11-08: the Proportionate Share denominator (building/project RSF) — null when
      // the property has none entered, in which case only leases with a stated % can be reconciled.
      denominator_rsf: denominatorRSF,
      peak_leased_sf: peakConcurrentLeasedSF(camPool).sf,
      warnings: [
        ...(shares.poolWarning ? [shares.poolWarning] : []),
        ...loaded.denominatorWarnings,
        ...loaded.holdover.values(),
      ],
      leases: loaded.leases
        .filter((l) => camPool.byLease[l.id])
        .map((l) => {
          const inPool = camPool.byLease[l.id]
          // A lease with no usable basis is reported on its own row (share_error) so the page can
          // show which lease needs data, instead of refusing the whole pool; /calculate 422s it.
          const resolved = shares.byLease.get(l.id)
          const share = resolved instanceof CAMTermsError || resolved === undefined ? null : resolved
          const shareError = resolved instanceof CAMTermsError ? resolved.message : null
          return {
            lease_id: l.id,
            status: l.status,
            rent_type: l.rent_type,
            sf: inPool.sf,
            overlap_days: inPool.overlapDays,
            weighted_sf: inPool.weightedSF,
            stated_share_pct: numOrNull(l.proportionate_share_pct),
            computed_share_pct: share ? share.computedPct : null,
            share_basis: share?.basis ?? null,
            annual_share_pct: share?.annualPct ?? null,
            effective_share_pct: share?.effectivePct ?? null,
            share_error: shareError,
            warnings: share?.warnings ?? [],
            // 0025: the CAM page lists a not-reconciled lease with its reason and skips it in
            // Calculate all; /calculate refuses it (422) regardless.
            recoverable_categories: l.recoverable_categories ?? null,
            cam_reconciled: l.cam_reconciled !== false,
            cam_exclusion_reason: l.cam_exclusion_reason ?? null,
          }
        }),
    },
  })
})

/**
 * First field on which a saved draft differs from a recomputed (or re-read) one, or null when they
 * match. Money compared in cents and the share to 1e-9 (NUMERIC columns can arrive as strings).
 */
function draftMismatch(saved: Record<string, unknown>, now: Record<string, unknown>): string | null {
  for (const f of ['true_up_amount', 'actual_cam_owed', 'estimated_cam_paid', 'total_property_recoverable_expenses']) {
    const a = cents(saved[f])
    const b = cents(now[f])
    if (!(Number.isFinite(a) && Number.isFinite(b)) || a !== b) return `${f} ${String(saved[f])} -> ${String(now[f])}`
  }
  const pa = Number(saved.tenant_pro_rata_share_pct)
  const pb = Number(now.tenant_pro_rata_share_pct)
  if (!(Number.isFinite(pa) && Number.isFinite(pb)) || Math.abs(pa - pb) > 1e-9) {
    return `tenant_pro_rata_share_pct ${String(saved.tenant_pro_rata_share_pct)} -> ${String(now.tenant_pro_rata_share_pct)}`
  }
  for (const f of ['share_basis', 'recovery_basis']) {
    if ((saved[f] ?? null) !== (now[f] ?? null)) return `${f} ${String(saved[f])} -> ${String(now[f])}`
  }
  // 0025: a category or cap edit after the draft changes what it billed even when the dollar
  // figures happen to match. Categories compared as sorted sets; the cap in cents, null-aware.
  const cats = (v: unknown) => (Array.isArray(v) ? [...v].map(String).sort().join(',') : null)
  if (cats(saved.recoverable_categories) !== cats(now.recoverable_categories)) {
    return `recoverable_categories ${String(cats(saved.recoverable_categories))} -> ${String(cats(now.recoverable_categories))}`
  }
  const capA = saved.cam_annual_cap_applied == null ? null : cents(saved.cam_annual_cap_applied)
  const capB = now.cam_annual_cap_applied == null ? null : cents(now.cam_annual_cap_applied)
  if (capA !== capB) return `cam_annual_cap_applied ${String(saved.cam_annual_cap_applied)} -> ${String(now.cam_annual_cap_applied)}`
  return null
}

/** What a CAM reconciliation for one lease/year comes to, computed from the DB as it is now. */
type ReconciliationPatch = {
  total_property_recoverable_expenses: number
  tenant_pro_rata_share_pct: number
  estimated_cam_paid: number
  actual_cam_owed: number
  true_up_amount: number
  share_basis: ResolvedShare['basis']
  recovery_basis: string
  basis_warnings: string | null
  /** 0025: the categories the pool summed (null = all) and the prorated cap when it bound. */
  recoverable_categories: ExpenseCategory[] | null
  cam_annual_cap_applied: number | null
  status: 'draft'
}
type Computed =
  | { kind: 'ok'; patch: ReconciliationPatch; warnings: string[] }
  /** The lease's terms or data do not support a reconciliation (422/400): the user fixes data. */
  | { kind: 'refused'; message: string; httpStatus: 422 | 400 }
  | { kind: 'not_found' }
  | { kind: 'db_error'; error: PgErr; label: string }

/**
 * Compute (never save) the reconciliation for a lease/year. Shared by POST /calculate, which saves
 * it, and POST /:id/approve, which recomputes it to prove the saved draft still matches the lease,
 * property, unit and expense data before any charge is posted (REFUTE D1/D2, 2026-11-10).
 *
 * Every read FAILS CLOSED (PR #42 refute): they used to discard `error`, so a failed query read as
 * SF 0 / estimated_cam_paid 0 and SAVED a draft with a wrong pro-rata or an overstated
 * true_up_amount that /approve would then post. A genuinely missing lease is PGRST116 (no row):
 * a 404-class input error, not a DB failure.
 */
async function computeReconciliation(db: Db, lease_id: string, reconciliation_year: number): Promise<Computed> {
  const { data: lease, error: leaseErr } = await db
    .from('leases')
    .select('id, rent_type, expense_stop_amount, base_year, base_year_expense_amount, recoverable_categories, '
      + 'base_year_categories, cam_annual_cap, cam_cap_through, cam_reconciled, cam_exclusion_reason, units(property_id)')
    .eq('id', lease_id)
    .single()
  if (leaseErr) {
    if (leaseErr.code === 'PGRST116') return { kind: 'not_found' }
    return { kind: 'db_error', error: leaseErr, label: 'Failed to load lease' }
  }

  // rent_type + expense_stop_amount (audit finding cam-ignores-rent-type-expense-stop): the true-up
  // used to bill every lease its full pro-rata share, so gross and modified-gross tenants were
  // charged CAM their leases do not pass through. calculateCAMTrueUp applies the schema semantics.
  const leaseRow = lease as unknown as {
    units: { property_id: string } | null
    rent_type: CAMRentType | null
    expense_stop_amount: number | string | null
    base_year: number | string | null
    base_year_expense_amount: number | string | null
    recoverable_categories: string[] | null
    base_year_categories: string[] | null
    cam_annual_cap: number | string | null
    cam_cap_through: string | null
    cam_reconciled: boolean | null
    cam_exclusion_reason: string | null
  } | null
  const refused = (message: string, httpStatus: 422 | 400 = 422): Computed => ({ kind: 'refused', message, httpStatus })

  // 0025 (ruling 2026-11-10): a lease marked not CAM-reconciled (direct pay, fixed charge in rent)
  // is refused before anything else is read, with its recorded reason. cam_reconciled is NOT NULL
  // DEFAULT true; anything but an explicit true is refused (fail closed).
  try {
    assertCamReconciled(lease_id, leaseRow?.cam_reconciled === true, leaseRow?.cam_exclusion_reason ?? null)
    assertValidCategories(leaseRow?.recoverable_categories ?? null)
  } catch (err) {
    if (err instanceof CAMTermsError) return refused(err.message)
    throw err
  }
  const recoverableCategories = (leaseRow?.recoverable_categories ?? null) as ExpenseCategory[] | null
  const annualCap = numOrNull(leaseRow?.cam_annual_cap)
  const capThrough = leaseRow?.cam_cap_through ?? null

  const propertyId = leaseRow?.units?.property_id
  if (!propertyId) return refused('Lease has no unit/property — cannot build the CAM pool')
  const rentType: CAMRentType = leaseRow?.rent_type ?? 'nnn' // column is NOT NULL DEFAULT 'nnn'
  // NUMERIC can arrive as a string from PostgREST; null stays null (no stop).
  const expenseStopPerSF = numOrNull(leaseRow?.expense_stop_amount)
  // Base year (0021; ruling 2026-11-08): recover only the increase over the base year's total.
  const baseYear = numOrNull(leaseRow?.base_year)
  // REFUTE L3: base_year is INTEGER in the schema, but a non-integer here (NaN from a bad string)
  // compared `reconciliationYear < NaN` as false and billed as if the base year had passed.
  if (baseYear !== null && !Number.isInteger(baseYear)) {
    return refused(`Lease base year "${String(leaseRow?.base_year)}" is not a calendar year`)
  }
  const baseYearExpenseAmount = numOrNull(leaseRow?.base_year_expense_amount)
  // REFUTE (0025 pass): the base-year amount must cover the categories the lease is billed on.
  try {
    assertBaseYearCategoriesMatch(baseYear, recoverableCategories, leaseRow?.base_year_categories ?? null)
  } catch (err) {
    if (err instanceof CAMTermsError) return refused(err.message)
    throw err
  }

  // Server-side pool: recoverable total, the leases in effect during the year (days in effect,
  // same-unit overlap, stale-end-date and RSF-covers-pool checks) and the property's denominator RSF.
  const recoverable = await loadRecoverableTotal(db, propertyId, reconciliation_year)
  if (recoverable.error) return { kind: 'db_error', error: recoverable.error, label: 'Failed to load recoverable expenses' }
  // 0025: the lease's pool — the recoverable expenses in its categories (all when null). Saved as
  // total_property_recoverable_expenses so the draft shows the pool it was billed a share of.
  let total_property_recoverable_expenses: number
  try {
    total_property_recoverable_expenses = poolForCategories(recoverable.byCategory, recoverableCategories)
  } catch (err) {
    if (err instanceof CAMTermsError) return refused(err.message)
    throw err
  }
  const loaded = await loadCamPool(db, propertyId, reconciliation_year)
  if (loaded.error instanceof CAMTermsError) return refused(loaded.error.message)
  if (loaded.error) return { kind: 'db_error', error: loaded.error, label: 'Failed to load CAM pool' }
  const holdoverFlag = loaded.holdover.get(lease_id)
  const tenantInPool = loaded.pool.byLease[lease_id]
  if (!tenantInPool) {
    // A holdover lease that ended before this year is not in the pool: say so rather than
    // "not in effect" (ruling 2026-11-08: holdover excluded and flagged).
    return refused(holdoverFlag
      ?? `Lease was not in effect during ${reconciliation_year} (or is pending) — no CAM reconciliation for that year`)
  }
  // Proportionate Share (ruling 2026-11-08): the lease-stated %, else premises RSF / the property's
  // building/project RSF; neither -> 422. Prorated by days in effect. A stated-vs-computed gap over
  // 0.5 pp is a warning returned (and saved) with the draft, never a refusal; so is a pool whose
  // concurrent shares total more than 100% (only reachable through stated percentages).
  const poolShares = resolvePoolShares(loaded.pool, loaded.leases, loaded.denominatorRSF)
  const resolved = poolShares.byLease.get(lease_id)
  if (resolved === undefined) return refused('Lease is missing from its CAM pool')
  if (resolved instanceof CAMTermsError) return refused(resolved.message)
  const share: ResolvedShare = resolved
  // Occupancy-weighted premises SF: the basis an expense stop is applied to, prorated by the same
  // days-in-effect factor as the share (see calculateCAMTrueUp).
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
  if (camChargesErr) return { kind: 'db_error', error: camChargesErr, label: 'Failed to load CAM estimate charges' }

  // REFUTE L1: charges.amount is NUMERIC and can arrive from PostgREST as a string; `s + ch.amount`
  // would then concatenate. Summed in integer cents like loadRecoverableTotal; a non-numeric amount
  // makes the sum NaN, refused just below (fail closed) rather than saved as a NULL true-up.
  const estimatedCamPaid = (camCharges ?? []).reduce(
    (cents: number, ch: { amount: number | string }) => cents + Math.round(Number(ch.amount) * 100),
    0,
  ) / 100
  if (!Number.isFinite(estimatedCamPaid)) {
    return { kind: 'db_error', error: { message: 'non-numeric CAM estimate charge amount' }, label: 'Failed to sum CAM estimate charges' }
  }

  let result
  try {
    result = calculateCAMTrueUp({
      totalRecoverableExpenses: total_property_recoverable_expenses,
      tenantSF,
      tenantSharePct: share.effectivePct,
      estimatedCamPaid,
      rentType,
      expenseStopPerSF,
      baseYear,
      baseYearExpenseAmount,
      reconciliationYear: reconciliation_year,
      annualCap,
      capThrough,
      daysInEffect: tenantInPool.overlapDays,
      daysInYear: loaded.pool.daysInYear,
    })
  } catch (err) {
    // Lease-terms problems (e.g. modified_gross with no expense stop) are a 422 the user fixes on
    // the lease; nothing is saved either way.
    if (err instanceof CAMTermsError) return refused(err.message)
    return refused((err as Error).message, 400)
  }

  // Non-blocking warnings travel with every successful response (and are saved on the draft).
  // The denominator warning (H1) only bears on a computed share; a stated share ignores the RSF.
  const warnings = [
    ...share.warnings,
    ...(poolShares.poolWarning ? [poolShares.poolWarning] : []),
    ...(share.basis === 'premises_rsf_over_denominator' ? loaded.denominatorWarnings : []),
    ...(holdoverFlag ? [holdoverFlag] : []),
    ...result.warnings,
  ]
  return {
    kind: 'ok',
    warnings,
    patch: {
      total_property_recoverable_expenses,
      tenant_pro_rata_share_pct: result.tenantProRataSharePct,
      estimated_cam_paid: estimatedCamPaid,
      actual_cam_owed: result.actualCamOwed,
      true_up_amount: result.trueUpAmount,
      share_basis: share.basis,
      recovery_basis: result.recoveryBasis,
      basis_warnings: warnings.length > 0 ? warnings.join('\n') : null,
      recoverable_categories: recoverableCategories === null ? null : [...recoverableCategories],
      cam_annual_cap_applied: result.capApplied,
      status: 'draft',
    },
  }
}

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
  // REFUTE H2 (2026-11-10): a refused recalculation must not leave the previous draft billable. If
  // the lease's terms changed (base year added, stated share fixed, RSF corrected) and this run is
  // refused, the old draft was priced on terms that no longer hold. Strip its share_basis so
  // /:id/approve refuses it until a recalculation succeeds. Only 'draft' rows are touched (billed /
  // collected rows are history). If the invalidation itself fails, fail closed with a 500 rather
  // than report a 422 that leaves a stale draft approvable.
  const computed = await computeReconciliation(db, lease_id, reconciliation_year)
  if (computed.kind === 'not_found') return c.json({ error: 'Lease not found' }, 404)
  if (computed.kind === 'db_error') return dbError(c, computed.error, computed.label)
  if (computed.kind === 'refused') {
    const { error: invalidateErr } = await db
      .from('cam_reconciliations')
      .update({ share_basis: null, basis_warnings: `Last recalculation was refused: ${computed.message}` })
      .eq('lease_id', lease_id)
      .eq('reconciliation_year', reconciliation_year)
      .eq('status', 'draft')
      .select()
    if (invalidateErr) return dbError(c, invalidateErr, 'Failed to invalidate the stale CAM draft')
    // `message` is CAMTermsError / engine text, never a DB error (those are 'db_error' above).
    const { message, httpStatus } = computed
    return c.json({ error: message }, httpStatus)
  }
  const { patch, warnings } = computed

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
  if (updated && updated.length > 0) return c.json({ data: updated[0], warnings })

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

  if (!insertErr) return c.json({ data: inserted, warnings })
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
  return c.json({ data: retried[0], warnings })
})


/** The true-up charge already holding this lease/year's idempotency key, if any. The key is unique
 *  across voided and live charges alike, so a voided one still blocks a new insert. Advisory here:
 *  approve_cam_reconciliation() (migration 0024) re-reads and locks the holder before it bills. */
async function loadPostedTrueUp(db: Db, leaseId: string, idempotencyKey: string): Promise<
  { kind: 'none' } | { kind: 'live'; amount: number | string } | { kind: 'voided' } | { kind: 'foreign' } | { kind: 'db_error'; error: PgErr }
> {
  const { data, error } = await db
    .from('charges')
    .select('amount, voided_at, type, lease_id')
    .eq('idempotency_key', idempotencyKey)
    .limit(1)
  if (error) return { kind: 'db_error', error }
  const row = (data ?? [])[0] as { amount: number | string; voided_at: string | null; type: string; lease_id: string } | undefined
  if (!row) return { kind: 'none' }
  // REFUTE F3: POST /charges accepts a client-supplied idempotency_key, so a charge holding the key
  // need not be this lease's true-up. It blocks the insert all the same: fail closed.
  if (row.type !== 'cam_true_up' || row.lease_id !== leaseId) return { kind: 'foreign' }
  return row.voided_at ? { kind: 'voided' } : { kind: 'live', amount: row.amount }
}

/** What approve_cam_reconciliation() (migration 0024) returns. NUMERIC fields may arrive as strings. */
type ApproveOutcome =
  | { outcome: 'billed'; inserted: boolean; true_up_amount: number | string }
  | { outcome: 'billed_credit'; true_up_amount: number | string }
  | { outcome: 'balanced' }
  | { outcome: 'not_found' }
  | { outcome: 'not_draft'; status: string }
  | { outcome: 'no_basis'; status: string }
  | { outcome: 'changed'; true_up_amount: number | string; share_basis: string | null }
  | { outcome: 'live_mismatch'; charge_amount: number | string; true_up_amount?: number | string }
  | { outcome: 'voided' }
  | { outcome: 'foreign' }

type ApproveRefusal = Extract<ApproveOutcome, { outcome: 'not_found' | 'not_draft' | 'no_basis' | 'changed' | 'live_mismatch' | 'voided' | 'foreign' }>

// CAM ruling 2026-11-08: a draft with no share_basis is not billable. Either it was saved before
// migration 0021 (priced on the superseded leased-SF basis) or its last recalculation was refused and
// /calculate invalidated it (REFUTE H2).
const NO_BASIS_ERROR = 'This draft has no valid Proportionate Share basis: it was calculated on the superseded '
  + 'leased-SF basis, or its last recalculation was refused. Fix the lease/property data and '
  + 'recalculate it before approving.'

/**
 * The HTTP answer for every approve refusal, whether the route's advisory pre-check or the
 * function's locked re-check found it. One table, so both stages say the same thing. Nothing was
 * posted and the row was not billed in any of these cases.
 */
function approveRefusal(c: Parameters<typeof dbError>[0], o: ApproveRefusal, r: { true_up_amount: number | string; share_basis?: string | null; reconciliation_year: number }) {
  const trueUp = Number(r.true_up_amount)
  const year = r.reconciliation_year
  switch (o.outcome) {
    case 'not_found':
      return c.json({ error: 'Not found' }, 404)
    case 'not_draft':
      return c.json({ error: 'already billed' }, 400)
    case 'no_basis':
      return c.json({ error: NO_BASIS_ERROR }, 409)
    case 'changed': {
      const drift = [
        cents(o.true_up_amount) !== cents(r.true_up_amount) ? `true_up_amount ${String(r.true_up_amount)} -> ${String(o.true_up_amount)}` : null,
        (o.share_basis ?? null) !== (r.share_basis ?? null) ? `share_basis ${String(r.share_basis)} -> ${String(o.share_basis)}` : null,
      ].filter(Boolean).join(', ')
      return c.json({
        error: `This draft changed while it was being approved (${drift || 'figures'}). It was NOT marked billed. `
          + 'No charge was posted. Reload and try again.',
      }, 409)
    }
    case 'foreign':
      return c.json({
        error: `Another charge already uses this lease's ${year} CAM true-up key, so the true-up cannot `
          + 'be posted. Resolve it manually before approving.',
      }, 409)
    case 'voided':
      return c.json({
        error: `A voided ${year} CAM true-up charge already holds this lease's true-up key, so a new one `
          + 'cannot be posted. Resolve it manually before approving.',
      }, 409)
    case 'live_mismatch': {
      const amount = Number(o.charge_amount).toFixed(2)
      // REFUTE F3: a balanced draft never answers "no true-up required" over a live charge.
      if (trueUp === 0) {
        return c.json({
          error: `This draft is now balanced, but a ${year} CAM true-up charge of ${amount} is posted from earlier `
            + 'figures. Delete that charge.',
        }, 409)
      }
      // REFUTE F2: never bill at figures that differ from the charge on the tenant's ledger, and never
      // bill a credit while a +charge is live.
      return c.json({
        error: `A ${year} CAM true-up charge of ${amount} is already posted, but this `
          + `draft now says ${trueUp.toFixed(2)}${trueUp < 0 ? ' (a credit)' : ''}. It was NOT marked billed. `
          + (trueUp < 0
            ? 'Delete that charge before approving the credit.'
            : 'Delete that charge (or, if it is right, correct the data and recalculate) before approving.'),
      }, 409)
    }
  }
}

// Approve CAM reconciliation: posts the true-up charge to the tenant ledger and marks the row billed.
//
// Two stages.
//  1. The recompute-and-compare gate (REFUTE D1/D2, 2026-11-10). A draft is a snapshot: a lease,
//     property, unit or expense edit after it was calculated leaves it priced on data that no longer
//     holds. Before anything posts, the reconciliation is recomputed from the DB as it is NOW and the
//     approval refused (409) unless it still matches the draft.
//  2. approve_cam_reconciliation() (migration 0024): ONE Postgres transaction that locks the row,
//     re-checks status / share_basis / the figures stage 1 priced, classifies whatever charge holds
//     cam_true_up:<lease>:<year> (locking it), inserts the charge only for a positive true-up and sets
//     the row billed. It replaced the insert-then-compare-and-swap sequence and its compensation
//     (OI-046, REFUTE D1-F4): those were separate PostgREST calls, so two overlapping approves plus a
//     recalculation could leave a credit billed while a +true-up was live, and a cancelled request,
//     a DB error or a charge deleted mid-approve could leave that state silently. Every refusal from
//     the function means nothing was posted and nothing changed. An RPC error is all-or-nothing but
//     not necessarily nothing: an error raised in the function rolled everything back, while a
//     connection lost after PostgREST committed means the row IS billed with its charge posted. The
//     500 says the result is unknown; reloading shows which (a retry answers "already billed").
camRouter.post('/:id/approve', async (c) => {
  const db = getDb(c.env)
  const id = c.req.param('id')
  const { data: rec, error: recErr } = await db
    .from('cam_reconciliations')
    .select('*')
    .eq('id', id)
    .single()

  if (recErr || !rec) return c.json({ error: 'Not found' }, 404)

  const r = rec as { true_up_amount: number | string; lease_id: string; reconciliation_year: number; share_basis?: string | null; status?: string }
  // Cheap early answers; the function re-checks both under the row lock.
  if (r.status === 'draft' && (r.share_basis === null || r.share_basis === undefined)) return approveRefusal(c, { outcome: 'no_basis', status: 'draft' }, r)
  // REFUTE D2: only a draft may post anything (a billed row whose charge was deleted must not re-post).
  if (r.status !== undefined && r.status !== 'draft') return approveRefusal(c, { outcome: 'not_draft', status: r.status }, r)
  const trueUp = Number(r.true_up_amount)

  // Advisory look at the key holder (the function repeats it under lock): refuse early with the
  // specific reason, and recognise crash recovery. A live charge equal to this draft's positive
  // true-up was posted by the pre-0024 two-call code path, which could crash between the insert and
  // the status update; the money already moved, so the recompute is skipped and the function only
  // completes the status (after verifying that charge again under the lock).
  const idempotencyKey = `cam_true_up:${r.lease_id}:${r.reconciliation_year}`
  const posted = await loadPostedTrueUp(db, r.lease_id, idempotencyKey)
  if (posted.kind === 'db_error') return dbError(c, posted.error, 'Failed to check for an already-posted true-up')
  if (posted.kind === 'foreign') return approveRefusal(c, { outcome: 'foreign' }, r)
  if (posted.kind === 'voided') return approveRefusal(c, { outcome: 'voided' }, r)
  if (posted.kind === 'live' && !(trueUp > 0 && cents(posted.amount) === cents(trueUp))) {
    return approveRefusal(c, { outcome: 'live_mismatch', charge_amount: posted.amount }, r)
  }

  // Stage 1. A balanced draft posts nothing and bills nothing, so it needs no recompute.
  if (trueUp !== 0 && posted.kind === 'none') {
    const now = await computeReconciliation(db, r.lease_id, r.reconciliation_year)
    if (now.kind === 'db_error') return dbError(c, now.error, now.label)
    if (now.kind !== 'ok') {
      const why = now.kind === 'refused' ? now.message : 'the lease no longer exists'
      return c.json({ error: `This draft is stale: recalculating it now is refused (${why}). Fix the data and recalculate before approving.` }, 409)
    }
    const mismatch = draftMismatch(rec as Record<string, unknown>, now.patch)
    if (mismatch) {
      return c.json({ error: `This draft is stale: the lease, property or expense data changed since it was calculated (${mismatch}). Recalculate it before approving.` }, 409)
    }
  }

  // Stage 2. p_true_up_amount / p_share_basis are the figures stage 1 validated: a recalculation or
  // invalidation that lands after the read above makes the function answer 'changed', not bill.
  const { data, error } = await db.rpc('approve_cam_reconciliation', {
    p_id: id,
    p_true_up_amount: r.true_up_amount,
    p_share_basis: r.share_basis,
    p_today: new Date().toISOString().slice(0, 10),
  })
  if (error || !data) {
    return dbError(c, error ?? { message: 'approve_cam_reconciliation returned no result' },
      'Failed to approve CAM reconciliation: the result is unknown. Reload to see whether it was billed before retrying.')
  }
  const o = data as ApproveOutcome
  switch (o.outcome) {
    case 'billed':
      return c.json({ success: true, true_up_amount: trueUp })
    case 'billed_credit':
      // KNOWN LIMITATION (Phase 1): a negative true-up (credit owed to the tenant) is not posted as a
      // charge (charges.amount CHECK >= 0, and ar_ledger would read a "credit" charge as a debit). The
      // function bills the row with a "handle manually" note.
      return c.json({ success: true, true_up_amount: trueUp, message: 'Credit owed to tenant — flagged for manual handling (not auto-posted)' })
    case 'balanced':
      return c.json({ message: 'No true-up required (balanced)', true_up_amount: 0 })
    case 'not_found':
    case 'not_draft':
    case 'no_basis':
    case 'changed':
    case 'live_mismatch':
    case 'voided':
    case 'foreign':
      return approveRefusal(c, o, r)
    default:
      // An outcome this code does not know (function and route out of step): the function has
      // already committed whatever it did, so say it failed loudly rather than claim success.
      return dbError(c, { message: `approve_cam_reconciliation returned unknown outcome ${String((o as { outcome?: unknown }).outcome)}` }, 'Failed to approve CAM reconciliation')
  }
})
