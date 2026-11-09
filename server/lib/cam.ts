export type CAMRentType = 'nnn' | 'gross' | 'modified_gross'

export interface CAMInput {
  totalRecoverableExpenses: number
  /** The SF an expense stop is applied to: premises SF x days in effect / days in year. */
  tenantSF: number
  /** The tenant's Proportionate Share actually applied for the year, as a fraction in [0, 1]:
   *  resolveTenantShare(...).effectivePct (already prorated for a partial year). */
  tenantSharePct: number
  estimatedCamPaid: number
  /** leases.rent_type. Omitted = 'nnn' (the pre-fix behaviour, kept for existing callers). */
  rentType?: CAMRentType
  /** leases.expense_stop_amount: $/SF per year (LeaseForm "Expense Stop ($/SF/yr)"). */
  expenseStopPerSF?: number | null
  /** leases.base_year (calendar year). Set = recover only the increase over the base year. */
  baseYear?: number | null
  /** leases.base_year_expense_amount: the base year's recoverable total ($, whole pool). */
  baseYearExpenseAmount?: number | null
  /** The calendar year being reconciled. Required when baseYear is set. */
  reconciliationYear?: number
}

/** How actualCamOwed was derived — persisted context for a human reviewing the draft. */
export type CAMRecoveryBasis = 'full_pro_rata' | 'above_expense_stop' | 'none_gross' | 'above_base_year'

/** Which Proportionate Share basis applied (persisted as cam_reconciliations.share_basis). */
export type CAMShareBasis = 'lease_stated_pct' | 'premises_rsf_over_denominator'

export interface CAMOutput {
  tenantProRataSharePct: number
  actualCamOwed: number
  trueUpAmount: number  // positive = tenant owes; negative = credit to tenant
  recoveryBasis: CAMRecoveryBasis
}

/** Lease terms make a recovery uncomputable (e.g. modified_gross with no expense stop). Callers map
 *  this to a 422: it is a lease-data problem a human must fix, not a server error. */
export class CAMTermsError extends Error {}

// ---------------------------------------------------------------------------
// CAM pool: which leases were in effect during the reconciliation year, and for how many days
// (audit finding cam-denominator-client-snapshot: computed server side from the DB, never the
// browser's snapshot of today's rent roll).
//
// The pool is NOT the pro-rata denominator any more. Gabriel ruling 2026-11-08: the denominator is
// the building (or project) RENTABLE SF the lease form names — standard NNN Proportionate Share —
// so the landlord carries the vacancy share and the leases' shares need not sum to 100%. See
// resolveTenantShare. The pool still supplies each lease's days in effect (partial-year proration),
// the same-unit overlap check, and the peak leased SF the denominator RSF must cover.
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 86_400_000

/** UTC day number for an ISO calendar date; throws CAMTermsError if missing or not a real date. */
function isoDay(iso: string | null | undefined, field: string): number {
  const m = typeof iso === 'string' ? ISO_DATE_RE.exec(iso) : null
  if (!m) throw new CAMTermsError(`Lease ${field} is missing or not an ISO date`)
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = Date.UTC(y, mo - 1, d)
  const back = new Date(t)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    throw new CAMTermsError(`Lease ${field} is not a valid date`)
  }
  return Math.round(t / DAY_MS)
}

/** Inclusive days of [startDate, endDate] that fall in calendar `year` (0 if none). */
export function yearOverlapDays(startDate: string, endDate: string, year: number): number {
  const iv = yearInterval(startDate, endDate, year)
  return iv ? iv.last - iv.first + 1 : 0
}

/** The in-year part of a lease term as inclusive UTC day numbers, or null if none. */
function yearInterval(startDate: string, endDate: string, year: number): { first: number; last: number } | null {
  const start = isoDay(startDate, 'start_date')
  const end = isoDay(endDate, 'end_date')
  if (end < start) throw new CAMTermsError('Lease end_date is before its start_date')
  const first = Math.max(start, Math.round(Date.UTC(year, 0, 1) / DAY_MS))
  const last = Math.min(end, Math.round(Date.UTC(year, 11, 31) / DAY_MS))
  return last >= first ? { first, last } : null
}

const isoOfDay = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10)

export interface CAMPoolLeaseInput {
  id: string
  /** Leases sharing a unit_id must not overlap within the year (REFUTE C4b). Omitted = no check. */
  unit_id?: string
  /** Human label for the unit in error messages (e.g. the suite); defaults to unit_id. */
  unit_label?: string
  sf: number
  start_date: string
  end_date: string
}

/**
 * REFUTE C4b': a lease whose status says it is over ('terminated' or 'expired') but whose end_date
 * is on or after the calculation date still carries its ORIGINAL end_date. computeCamPool would
 * weight it as occupying its unit for the whole year even when the unit has sat vacant since the
 * real move-out (no replacement lease, so the same-unit overlap check cannot see it), inflating the
 * denominator and understating every other tenant's share. Fail closed for a human to correct the
 * end_date; the schema has no terminated-on date to use instead (follow-up). `asOf` is an ISO date.
 */
export function assertNoStaleClosedLeases(
  leases: ReadonlyArray<{ id: string; unit_id?: string; status: string; end_date: string }>,
  asOf: string,
): void {
  const stale = leases.filter((l) => (l.status === 'terminated' || l.status === 'expired') && l.end_date >= asOf)
  if (stale.length === 0) return
  const list = stale.map((l) => `${l.id} (${l.status}, end_date ${l.end_date}${l.unit_id ? `, unit ${l.unit_id}` : ''})`).join('; ')
  throw new CAMTermsError(
    `Lease(s) marked terminated/expired still carry an end_date on or after ${asOf}: ${list}. `
    + 'They would be counted as occupying their unit for the rest of the term. Correct the end_date '
    + 'to the actual move-out date, then recalculate.'
  )
}

export interface CAMPool {
  year: number
  daysInYear: number
  /** Σ sf x overlapDays / daysInYear over every lease in the pool (average leased SF). Display
   *  only: it is no longer the pro-rata denominator (building RSF ruling, 2026-11-08). */
  weightedLeasedSF: number
  /** Only leases with overlapDays > 0. from/to: the in-year part of the term (ISO, inclusive). */
  byLease: Record<string, { sf: number; overlapDays: number; weightedSF: number; from: string; to: string }>
}

export function computeCamPool(leases: readonly CAMPoolLeaseInput[], year: number): CAMPool {
  const daysInYear = Math.round((Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / DAY_MS)
  const byLease: CAMPool['byLease'] = {}
  let weightedLeasedSF = 0
  // REFUTE C4b: one unit's SF may be counted by only one lease on any given day. An early
  // termination recorded only as status='terminated' keeps the ORIGINAL end_date (the schema has no
  // terminated-on date), so it and its replacement both "occupy" the unit and the denominator
  // exceeds the physical SF. Detect that and fail closed for a human to correct the end_date,
  // rather than guess which lease really held the space.
  const seenByUnit = new Map<string, Array<{ id: string; first: number; last: number }>>()
  for (const l of leases) {
    const iv = yearInterval(l.start_date, l.end_date, year)
    if (!iv) continue
    const overlapDays = iv.last - iv.first + 1
    if (l.unit_id !== undefined) {
      const prior = seenByUnit.get(l.unit_id) ?? []
      const clash = prior.find((p) => p.first <= iv.last && iv.first <= p.last)
      if (clash) {
        const from = isoOfDay(Math.max(clash.first, iv.first))
        const to = isoOfDay(Math.min(clash.last, iv.last))
        throw new CAMTermsError(
          `Unit ${l.unit_label ?? l.unit_id} has overlapping leases ${clash.id} and ${l.id} during ${year} `
          + `(${from} to ${to}), which would count its SF twice in the CAM denominator. If one was `
          + 'terminated early, correct its end_date to the actual move-out date, then recalculate.'
        )
      }
      prior.push({ id: l.id, ...iv })
      seenByUnit.set(l.unit_id, prior)
    }
    const sf = Number(l.sf)
    if (!Number.isFinite(sf) || sf < 0) throw new CAMTermsError(`Unit SF for lease ${l.id} is not a valid number`)
    const weightedSF = overlapDays === daysInYear ? sf : (sf * overlapDays) / daysInYear
    byLease[l.id] = { sf, overlapDays, weightedSF, from: isoOfDay(iv.first), to: isoOfDay(iv.last) }
    weightedLeasedSF += weightedSF
  }
  return { year, daysInYear, weightedLeasedSF, byLease }
}

const fmtSF = (n: number) => Math.round(n).toLocaleString('en-US')
const fmtPct = (f: number) => `${(f * 100).toFixed(2)}%`

/** The most SF leased on any single day of the pool's year, and the first day it was reached. */
export function peakConcurrentLeasedSF(pool: CAMPool): { sf: number; on: string | null } {
  const { peak, on } = peakConcurrent(pool, (_id, e) => e.sf)
  return { sf: peak, on }
}

/**
 * Over-recovery check (warning only): the sum of the annual shares of the leases in effect on any
 * single day. Above 100% (+ the 0.5 pp tolerance) the landlord would recover more than the pool —
 * possible only via stated percentages (the computed basis is capped by assertDenominatorCoversPool).
 * `annualShareById` holds the resolved annual share of each lease that has one.
 */
export function overRecoveryWarning(pool: CAMPool, annualShareById: ReadonlyMap<string, number>): string | null {
  const { peak, on } = peakConcurrent(pool, (id) => annualShareById.get(id) ?? 0)
  if (peak <= 1 + SHARE_MISMATCH_TOLERANCE + 1e-12) return null
  return `The Proportionate Shares of the leases in effect on ${on} total ${fmtPct(peak)}, more than 100% `
    + 'of recoverable expenses. Check the stated shares and the property\'s rentable SF.'
}

function peakConcurrent(
  pool: CAMPool,
  weight: (id: string, e: CAMPool['byLease'][string]) => number,
): { peak: number; on: string | null } {
  // Sweep: +w on the first day, -w the day after the last. Removals sort before additions on the
  // same day so a back-to-back pair (A ends 06-30, B starts 07-01) never counts both.
  const events: Array<{ day: number; delta: number }> = []
  for (const [id, e] of Object.entries(pool.byLease)) {
    const w = weight(id, e)
    events.push({ day: isoDay(e.from, 'start_date'), delta: w })
    events.push({ day: isoDay(e.to, 'end_date') + 1, delta: -w })
  }
  events.sort((a, b) => a.day - b.day || a.delta - b.delta)
  let cur = 0
  let peak = 0
  let on: number | null = null
  for (const ev of events) {
    cur += ev.delta
    if (cur > peak) { peak = cur; on = ev.day }
  }
  return { peak, on: on === null ? null : isoOfDay(on) }
}

/**
 * The denominator RSF must cover every SF leased on any day of the year: a smaller RSF means the
 * property's cam_denominator_rsf (or a unit's SF) is wrong, and every computed share would be
 * overstated. Fail closed (CAMTermsError -> 422). No RSF (null): nothing to check.
 */
export function assertDenominatorCoversPool(pool: CAMPool, denominatorRSF: number | null): void {
  if (denominatorRSF === null) return
  const peak = peakConcurrentLeasedSF(pool)
  if (peak.sf > denominatorRSF) {
    throw new CAMTermsError(
      `The property's CAM denominator (${fmtSF(denominatorRSF)} rentable SF) is smaller than the SF `
      + `leased in the ${pool.year} CAM pool (${fmtSF(peak.sf)} SF on ${peak.on}). Correct the `
      + 'property\'s building/project rentable SF or the unit SF, then recalculate.'
    )
  }
}

/** Stated and computed annual shares further apart than this (0.5 percentage points) -> warning. */
export const SHARE_MISMATCH_TOLERANCE = 0.005

export interface ShareInput {
  leaseId: string
  /** leases.proportionate_share_pct: the share the lease states, a fraction in (0, 1], or null. */
  statedPct: number | null
  /** The premises' rentable SF (units.sf). */
  premisesSF: number
  /** properties.cam_denominator_rsf: the building or project RSF the lease form names, or null. */
  denominatorRSF: number | null
  overlapDays: number
  daysInYear: number
}

export interface ResolvedShare {
  basis: CAMShareBasis
  /** Full-year share under the basis used. */
  annualPct: number
  /** annualPct x overlapDays / daysInYear: what is applied to the recoverable pool. */
  effectivePct: number
  /** premisesSF / denominatorRSF when an RSF exists (the cross-check), else null. */
  computedPct: number | null
  warnings: string[]
}

/**
 * Tenant's Proportionate Share (Gabriel ruling 2026-11-08):
 *   1. the lease-stated % (v3.1 §36 "stated in the Basic Lease Information"; v2.8 §47 "estimated
 *      to be [X]%"; the single-tenant form's 100%), when set;
 *   2. otherwise premises RSF / the building or project RSF the lease form names
 *      (v2.8 §47 "the proportion that the rentable square footage of the Demised Premises bears to
 *      the total rentable square footage of the Building");
 *   3. neither -> CAMTermsError (422).
 * Both present and more than 0.5 pp apart (annual shares) -> a warning, never a refusal.
 * Prorated by days in effect (v3.1 §35 "prorated for a partial year"; v2.8 §40 "or portion
 * thereof").
 */
export function resolveTenantShare(input: ShareInput): ResolvedShare {
  const { leaseId, statedPct, premisesSF, denominatorRSF, overlapDays, daysInYear } = input
  if (statedPct !== null && !(Number.isFinite(statedPct) && statedPct > 0 && statedPct <= 1)) {
    throw new CAMTermsError(`Lease ${leaseId}: the stated Proportionate Share must be a fraction above 0 and at most 1 (100%)`)
  }
  if (denominatorRSF !== null && !(Number.isFinite(denominatorRSF) && denominatorRSF > 0)) {
    throw new CAMTermsError(`Lease ${leaseId}: the property's CAM denominator rentable SF must be a positive number`)
  }
  if (!Number.isFinite(premisesSF) || premisesSF < 0) {
    throw new CAMTermsError(`Lease ${leaseId}: the premises SF is not a valid number`)
  }
  if (!(Number.isInteger(overlapDays) && overlapDays > 0 && overlapDays <= daysInYear)) {
    throw new CAMTermsError(`Lease ${leaseId}: days in effect must be between 1 and ${daysInYear}`)
  }

  const computedPct = denominatorRSF === null ? null : premisesSF / denominatorRSF
  const warnings: string[] = []
  let basis: CAMShareBasis
  let annualPct: number
  if (statedPct !== null) {
    basis = 'lease_stated_pct'
    annualPct = statedPct
    if (computedPct !== null && Math.abs(statedPct - computedPct) > SHARE_MISMATCH_TOLERANCE + 1e-12) {
      warnings.push(
        `Lease ${leaseId}: the stated Proportionate Share ${fmtPct(statedPct)} differs from premises `
        + `${fmtSF(premisesSF)} SF / ${fmtSF(denominatorRSF as number)} rentable SF = ${fmtPct(computedPct)} by more `
        + 'than 0.5 percentage points. The stated share was used; check the lease and the property\'s rentable SF.'
      )
    }
  } else if (computedPct !== null) {
    if (computedPct > 1) {
      throw new CAMTermsError(
        `Lease ${leaseId}: premises ${fmtSF(premisesSF)} SF exceeds the property's CAM denominator `
        + `(${fmtSF(denominatorRSF as number)} rentable SF). Correct the unit SF or the property's rentable SF.`
      )
    }
    basis = 'premises_rsf_over_denominator'
    annualPct = computedPct
  } else {
    throw new CAMTermsError(
      `Lease ${leaseId} has no stated Proportionate Share and its property has no CAM denominator `
      + '(building or project rentable SF). Enter the lease\'s stated share or the property\'s rentable SF '
      + 'from the lease form, then recalculate.'
    )
  }
  const effectivePct = overlapDays === daysInYear ? annualPct : (annualPct * overlapDays) / daysInYear
  return { basis, annualPct, effectivePct, computedPct, warnings }
}

/**
 * CAM true-up for one lease.
 *
 * Recovery by rent type (audit finding cam-ignores-rent-type-expense-stop), using the schema's own
 * fields — leases.rent_type IN ('nnn','gross','modified_gross') and leases.expense_stop_amount
 * ($/SF/yr, entered "for gross / modified-gross leases"):
 *   - nnn:            full pro-rata share of recoverable expenses. A stop, if present, is ignored.
 *   - modified_gross: only the share ABOVE the stop: max(0, share - stop x tenantSF). A null stop
 *                     fails closed (CAMTermsError): without it the recoverable amount is unknown.
 *   - gross, stop set: same above-stop recovery as modified_gross.
 *   - gross, no stop: full-service gross: recovers nothing (owed 0; any CAM estimate that was billed
 *                     comes back as a credit through the negative true-up).
 * `tenantSF` is the SF the stop is applied to, so a caller that occupancy-weights tenantSF for a
 * partial year prorates the stop by the same factor.
 *
 * Base year (Gabriel ruling 2026-11-08; ORA form v3.1 §35 / v2.8 §40: "Tenant's Proportionate Share
 * of the amount by which Operating Costs and Taxes for that year exceed those for the Base Year").
 * When leases.base_year is set, for ANY rent_type:
 *     owed = share% x max(0, current recoverable - base_year_expense_amount)
 * The forms compare Operating Costs and Taxes together, matching the single recoverable pool here.
 * Fails closed (CAMTermsError) on: a base year with no base amount; a base amount with no base year;
 * a negative/non-finite amount; a reconciliation year before the base year; a gross/modified-gross
 * lease that also carries an expense stop (two conflicting recovery terms).
 * Gross-up is NOT applied: both forms make it permissive ("Landlord may ... gross up"), so it is a
 * landlord election, not a lease requirement. CAM caps and admin fees are not modelled (no fields).
 */
export function calculateCAMTrueUp(input: CAMInput): CAMOutput {
  const { totalRecoverableExpenses, tenantSF, tenantSharePct, estimatedCamPaid } = input
  const rentType: CAMRentType = input.rentType ?? 'nnn'
  const stop = input.expenseStopPerSF ?? null
  const baseYear = input.baseYear ?? null
  const baseAmount = input.baseYearExpenseAmount ?? null

  if (!(Number.isFinite(tenantSharePct) && tenantSharePct >= 0 && tenantSharePct <= 1)) {
    throw new Error('tenant share must be a fraction between 0 and 1')
  }
  if (!Number.isFinite(tenantSF) || tenantSF < 0) throw new Error('tenantSF cannot be negative')
  if (stop !== null && (!Number.isFinite(stop) || stop < 0)) {
    throw new CAMTermsError('Lease expense stop must be a non-negative $/SF amount')
  }

  const tenantProRataSharePct = tenantSharePct
  const share = totalRecoverableExpenses * tenantProRataSharePct

  let owed: number
  let recoveryBasis: CAMRecoveryBasis
  if (baseYear === null && baseAmount !== null) {
    throw new CAMTermsError(
      'Lease has a base-year expense amount but no base year. Enter the base year (or clear the amount), then recalculate.'
    )
  }
  if (baseYear !== null) {
    if (baseAmount === null) {
      throw new CAMTermsError(
        `Lease has base year ${baseYear} but no base-year expense amount (the ${baseYear} recoverable `
        + 'Operating Costs and Taxes total). Enter it on the lease, then recalculate.'
      )
    }
    if (!Number.isFinite(baseAmount) || baseAmount < 0) {
      throw new CAMTermsError('Lease base-year expense amount must be a non-negative dollar amount')
    }
    if (input.reconciliationYear === undefined || !Number.isInteger(input.reconciliationYear)) {
      throw new CAMTermsError('A base-year lease needs the reconciliation year')
    }
    if (input.reconciliationYear < baseYear) {
      throw new CAMTermsError(
        `Reconciliation year ${input.reconciliationYear} is before the lease's base year ${baseYear}; there is no increase to recover.`
      )
    }
    if (rentType !== 'nnn' && stop !== null) {
      throw new CAMTermsError(
        'Lease has both a base year and an expense stop; only one recovery term can apply. Clear the '
        + 'one the lease does not contain, then recalculate.'
      )
    }
    owed = tenantProRataSharePct * Math.max(0, totalRecoverableExpenses - baseAmount)
    recoveryBasis = 'above_base_year'
  } else if (rentType === 'nnn') {
    owed = share
    recoveryBasis = 'full_pro_rata'
  } else if (stop !== null) {
    // REFUTE C4d: expense_stop_amount is $/SF per YEAR. A stop whose dollar value exceeds the
    // tenant's pro-rata share by more than 1x (stop$ > 2 x share) is almost certainly a unit error
    // (a total, or an annual figure typed where a monthly one was meant) that would silently zero
    // the recovery, so it is refused for a human to check. Up to 2x is allowed: expenses can
    // legitimately fall well below the stop. Skipped when there is no share at all (nothing is
    // recoverable either way).
    const stopDollars = stop * tenantSF
    if (share > 0 && stopDollars > 2 * share) {
      const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`
      throw new CAMTermsError(
        `Expense stop $${stop}/SF/yr x ${Math.round(tenantSF).toLocaleString('en-US')} SF = ${usd(stopDollars)}, `
        + `more than twice this tenant's pro-rata share (${usd(share)}). The stop must be entered in `
        + '$/SF/yr; check whether a total or monthly amount was entered, correct the lease, then recalculate.'
      )
    }
    owed = Math.max(0, share - stopDollars)
    recoveryBasis = 'above_expense_stop'
  } else if (rentType === 'modified_gross') {
    throw new CAMTermsError(
      'Modified-gross lease has no expense stop set — the recoverable amount cannot be computed. '
      + 'Enter the lease\'s expense stop ($/SF) and recalculate.'
    )
  } else {
    owed = 0
    recoveryBasis = 'none_gross'
  }

  const actualCamOwed = Math.round(owed * 100) / 100
  const trueUpAmount = Math.round((actualCamOwed - estimatedCamPaid) * 100) / 100

  return { tenantProRataSharePct, actualCamOwed, trueUpAmount, recoveryBasis }
}
