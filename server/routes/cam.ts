import { Hono } from 'hono'
import { getDb } from '../db/client'
import {
  assertDenominatorCoversPool, assertNoStaleClosedLeases, calculateCAMTrueUp, computeCamPool, CAMTermsError,
  overRecoveryWarning, peakConcurrentLeasedSF, resolveTenantShare, type CAMPool, type CAMRentType, type ResolvedShare,
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
  /** leases.proportionate_share_pct (0021): NUMERIC, may arrive as a string from PostgREST. */
  proportionate_share_pct: number | string | null
}

/** NUMERIC columns can arrive from PostgREST as strings; null stays null. A non-numeric value
 *  becomes NaN, which every consumer in server/lib/cam.ts refuses (fail closed). */
const numOrNull = (v: number | string | null | undefined): number | null => (v == null ? null : Number(v))

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
      .select('id, unit_id, status, start_date, end_date, rent_type, proportionate_share_pct')
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
 *  over-recovery warning (stated shares summing above 100% on some day) — warning only. */
function resolvePoolShares(pool: CAMPool, leases: PoolLeaseRow[], denominatorRSF: number | null): {
  byLease: Map<string, ResolvedShare | CAMTermsError>
  poolWarning: string | null
} {
  const byLease = new Map<string, ResolvedShare | CAMTermsError>()
  const annual = new Map<string, number>()
  for (const l of leases) {
    if (!pool.byLease[l.id]) continue
    try {
      const s = shareForPoolLease(pool, l, denominatorRSF)
      byLease.set(l.id, s)
      annual.set(l.id, s.annualPct)
    } catch (err) {
      if (!(err instanceof CAMTermsError)) throw err
      byLease.set(l.id, err)
    }
  }
  return { byLease, poolWarning: overRecoveryWarning(pool, annual) }
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

  const { pool: camPool, denominatorRSF } = loaded
  const shares = resolvePoolShares(camPool, loaded.leases, denominatorRSF)
  return c.json({
    data: {
      recoverable_total: recoverable.total,
      recoverable_count: recoverable.count,
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
  const cents = (v: unknown) => Math.round(Number(v) * 100)
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
    .select('id, rent_type, expense_stop_amount, base_year, base_year_expense_amount, units(property_id)')
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
  } | null
  const refused = (message: string, httpStatus: 422 | 400 = 422): Computed => ({ kind: 'refused', message, httpStatus })

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

  // Server-side pool: recoverable total, the leases in effect during the year (days in effect,
  // same-unit overlap, stale-end-date and RSF-covers-pool checks) and the property's denominator RSF.
  const recoverable = await loadRecoverableTotal(db, propertyId, reconciliation_year)
  if (recoverable.error) return { kind: 'db_error', error: recoverable.error, label: 'Failed to load recoverable expenses' }
  const total_property_recoverable_expenses = recoverable.total
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
  // makes the sum NaN, which calculateCAMTrueUp refuses (fail closed).
  const estimatedCamPaid = (camCharges ?? []).reduce(
    (cents: number, ch: { amount: number | string }) => cents + Math.round(Number(ch.amount) * 100),
    0,
  ) / 100

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
    return c.json({ error: computed.message }, computed.httpStatus)
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

  const r = rec as { true_up_amount: number; lease_id: string; reconciliation_year: number; share_basis?: string | null; status?: string }
  // CAM ruling 2026-11-08: a draft with no share_basis is not billable. Either it was saved before
  // migration 0021 (priced on the superseded leased-SF denominator) or its last recalculation was
  // refused and /calculate invalidated it (REFUTE H2). Billed/collected rows are unaffected (the
  // conditional update below rejects them).
  if (r.status === 'draft' && (r.share_basis === null || r.share_basis === undefined)) {
    return c.json({
      error: 'This draft has no valid Proportionate Share basis: it was calculated on the superseded '
        + 'leased-SF basis, or its last recalculation was refused. Fix the lease/property data and '
        + 'recalculate it before approving.',
    }, 409)
  }
  const trueUp = Number(r.true_up_amount)
  if (trueUp === 0) return c.json({ message: 'No true-up required (balanced)', true_up_amount: 0 })

  // REFUTE D1/D2 (2026-11-10): a draft is a snapshot. A lease, property, unit or expense edit after
  // it was calculated (base year added, RSF corrected, an expense posted late) leaves it priced on
  // data that no longer holds, and nothing else invalidates it. Before posting anything, recompute
  // the reconciliation from the DB as it is NOW and refuse (409) unless it still matches the draft.
  // Crash recovery: if this draft's true-up charge is already posted (a crash after the insert,
  // before the status update), skip the recompute and only complete the status transition — the
  // money already moved, and the documented retry path must not get stuck on later data edits.
  const idempotencyKey = `cam_true_up:${r.lease_id}:${r.reconciliation_year}`
  const { data: posted, error: postedErr } = await db
    .from('charges')
    .select('id')
    .eq('idempotency_key', idempotencyKey)
    .limit(1)
  if (postedErr) return dbError(c, postedErr, 'Failed to check for an already-posted true-up')
  const alreadyPosted = (posted ?? []).length > 0

  // Only a 'draft' is priced here; a billed/collected row falls through to the conditional status
  // update below, which rejects it ('already billed') exactly as before.
  if (!alreadyPosted && r.status === 'draft') {
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
    // D1: re-read the row immediately before posting, so a recalculation or a refused-recalculation
    // invalidation that landed while the recompute ran is not billed on the old figures.
    const { data: fresh, error: freshErr } = await db
      .from('cam_reconciliations')
      .select('*')
      .eq('id', id)
      .single()
    if (freshErr || !fresh) return dbError(c, freshErr ?? { message: 'reconciliation vanished' }, 'Failed to re-read the CAM reconciliation')
    const drift = draftMismatch(fresh as Record<string, unknown>, rec as Record<string, unknown>)
    if (drift || (fresh as { status?: string }).status !== 'draft') {
      return c.json({ error: `This draft changed while it was being approved (${drift ?? 'status'}). Reload and try again.` }, 409)
    }
  }

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
    idempotency_key: idempotencyKey,
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
