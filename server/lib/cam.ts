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
  /** leases.base_year_expense_amount: Base-year TOTAL recoverable expenses ($/yr) for the same pool
   *  the lease is billed on — its recoverable categories, or the whole building/project pool when it
   *  has none (0025; see assertBaseYearCategoriesMatch) — not the tenant's share. */
  baseYearExpenseAmount?: number | null
  /** The calendar year being reconciled. Required when baseYear or annualCap is set. */
  reconciliationYear?: number
  /** leases.cam_annual_cap (0025): annual $ cap on what the tenant owes. Null/omitted = no cap. */
  annualCap?: number | null
  /** leases.cam_cap_through (0025): last ISO date the cap applies. Null = no end. Needs annualCap. */
  capThrough?: string | null
  /** Days the lease was in effect in the year, and the year's length: prorate the cap. Required
   *  when annualCap is set. */
  daysInEffect?: number
  daysInYear?: number
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
  /** The prorated annual cap when it bound (actualCamOwed was reduced to it), else null. */
  capApplied: number | null
  /** Non-blocking warnings (e.g. the cap ends inside the reconciliation year). */
  warnings: string[]
}

/** Lease terms make a recovery uncomputable (e.g. modified_gross with no expense stop). Callers map
 *  this to a 422: it is a lease-data problem a human must fix, not a server error. */
export class CAMTermsError extends Error {}

// ---------------------------------------------------------------------------
// Recoverable categories (migration 0025; Gabriel rulings 2026-11-10)
//
// A lease passes through a subset of the expense categories (expenses.category, 0002). NULL = every
// recoverable expense — the pre-0025 behaviour every existing lease keeps until a human enters its
// categories. The 2026-11-10 extraction found taxes-only (55 New Plant Ct) and CAM-without-taxes
// (2008/2026 Zettler, 4595 E 5th: "Landlord shall pay all real estate taxes" plus a share of common
// area maintenance and water/storm/sewer) leases that a whole-pool share overbills.
// ---------------------------------------------------------------------------

/** expenses.category CHECK values (0002), in that order. */
export const EXPENSE_CATEGORIES = ['taxes', 'insurance', 'maintenance', 'utilities', 'management', 'capital', 'other'] as const
export type ExpenseCategory = typeof EXPENSE_CATEGORIES[number]
const CATEGORY_SET: ReadonlySet<string> = new Set(EXPENSE_CATEGORIES)

/** Throws CAMTermsError unless `categories` is null or a non-empty, duplicate-free subset of
 *  EXPENSE_CATEGORIES (the 0025 CHECK). */
export function assertValidCategories(categories: readonly string[] | null): asserts categories is readonly ExpenseCategory[] | null {
  if (categories === null) return
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new CAMTermsError('Lease recoverable categories are empty. Pick at least one category, or mark the lease not CAM-reconciled.')
  }
  const bad = categories.filter((c) => !CATEGORY_SET.has(c))
  if (bad.length > 0) throw new CAMTermsError(`Lease recoverable categories include unknown value(s): ${bad.join(', ')}`)
  if (new Set(categories).size !== categories.length) {
    throw new CAMTermsError('Lease recoverable categories list a category more than once')
  }
}

/**
 * The recoverable pool a lease is billed a share of: the sum of the year's recoverable expenses in
 * its categories (every category when null). Summed in integer cents. Fails closed on an invalid
 * category list or a non-finite total in any category it would include.
 */
export function poolForCategories(
  totalsByCategory: Readonly<Record<ExpenseCategory, number>>,
  categories: readonly ExpenseCategory[] | null,
): number {
  assertValidCategories(categories)
  const included = categories ?? EXPENSE_CATEGORIES
  let cents = 0
  for (const c of included) {
    const v = Number(totalsByCategory[c] ?? 0)
    if (!Number.isFinite(v)) throw new CAMTermsError(`Recoverable ${c} total is not a number`)
    cents += Math.round(v * 100)
  }
  return cents / 100
}

const catKey = (c: readonly string[] | null) => (c === null ? null : [...c].sort().join(','))

/**
 * REFUTE (0025 pass, 2026-11-10): the base-year amount is a total for ONE set of categories. Compared
 * against a different category pool, the 3x plausibility guard does not catch it, and recovery is
 * silently zeroed or overbilled (taxes base of $41k against an all-category pool billed ~$34.5k too
 * much). leases.base_year_categories records which categories the amount covers (null = every
 * recoverable expense); a base-year lease whose categories differ from it is refused for a human to
 * re-enter the base-year amount for the current categories. No base year: nothing to check.
 */
export function assertBaseYearCategoriesMatch(
  baseYear: number | null,
  recoverableCategories: readonly string[] | null,
  baseYearCategories: readonly string[] | null,
): void {
  if (baseYear === null) return
  assertValidCategories(baseYearCategories)
  if (catKey(recoverableCategories) === catKey(baseYearCategories)) return
  const show = (c: readonly string[] | null) => (c === null ? 'all recoverable categories' : [...c].sort().join(', '))
  throw new CAMTermsError(
    `The lease's base-year amount was entered for ${show(baseYearCategories)}, but the lease now recovers `
    + `${show(recoverableCategories)}. Re-enter the base-year recoverable total for the current categories, then recalculate.`
  )
}

/** A lease marked not CAM-reconciled (leases.cam_reconciled = false, 0025: tenant pays expenses
 *  directly, or a fixed charge is bundled in rent) is refused with its recorded reason. */
export function assertCamReconciled(leaseId: string, reconciled: boolean, reason: string | null): void {
  if (reconciled) return
  throw new CAMTermsError(
    `Lease ${leaseId} is marked not CAM-reconciled${reason && reason.trim() !== '' ? `: ${reason.trim()}` : ''}. `
    + 'No CAM reconciliation is computed for it. Any CAM estimate billed to it must be credited manually.'
  )
}

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

/**
 * overRecoveryWarning per category (0025): a lease only takes a share of its own categories, so the
 * shares are summed per category — two 60% leases on taxes-only and CAM-only never over-recover,
 * two on taxes do. `byId` holds each reconciled lease's annual share and categories (null = all);
 * leases marked not CAM-reconciled must be left out by the caller. Returns at most one warning,
 * naming every category whose concurrent shares exceed 100% (+ tolerance), with the highest total.
 */
export function overRecoveryWarningByCategory(
  pool: CAMPool,
  byId: ReadonlyMap<string, { annualPct: number; categories: readonly ExpenseCategory[] | null }>,
): string[] {
  let worst: { peak: number; on: string | null } | null = null
  const over: ExpenseCategory[] = []
  for (const cat of EXPENSE_CATEGORIES) {
    const { peak, on } = peakConcurrent(pool, (id) => {
      const e = byId.get(id)
      return e && (e.categories === null || e.categories.includes(cat)) ? e.annualPct : 0
    })
    if (peak <= 1 + SHARE_MISMATCH_TOLERANCE + 1e-12) continue
    over.push(cat)
    if (worst === null || peak > worst.peak) worst = { peak, on }
  }
  if (worst === null) return []
  const cats = over.length === EXPENSE_CATEGORIES.length ? 'recoverable expenses' : `recoverable ${over.join(', ')}`
  return [`The Proportionate Shares of the leases in effect on ${worst.on} total ${fmtPct(worst.peak)}, more than 100% `
    + `of ${cats}. Check the stated shares, the leases' recoverable categories and the property's rentable SF.`]
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

/** REFUTE D2/D2a: a stated share at or below this (1%) is most often a fraction typed as a percent
 *  (0.125 for 12.5%, or 1 for a single tenant's 100%). Warning (inclusive). */
export const LOW_STATED_SHARE = 0.01

/** REFUTE D1: base-year amount more than this many times away from the year's total -> 422. */
export const BASE_YEAR_RATIO_LIMIT = 3

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
    if (statedPct <= LOW_STATED_SHARE) {
      warnings.push(
        `Lease ${leaseId}: the stated Proportionate Share is ${fmtPct(statedPct)}, 1% or less. Confirm it `
        + 'was entered as a percent (12.5 for 12.5%; 100 for a single tenant), not a fraction (0.125 or 1).'
      )
    }
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
 * landlord election, not a lease requirement. Admin fees are not modelled (no fields).
 *
 * 0025 (rulings 2026-11-10): `totalRecoverableExpenses` is the LEASE's pool — the recoverable
 * expenses in its categories (poolForCategories), so a base-year amount must be the base year's
 * total for those same categories. An annual cap (annualCap / capThrough) is applied last.
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
    // REFUTE D1: the amount is a TOTAL in dollars for the whole pool. A $/SF figure typed into it
    // ($5.25 against ~$120,000) bills nearly the full share; an extra digit zeroes recovery. Same
    // class as the 2x expense-stop guard: more than BASE_YEAR_RATIO_LIMIT x away from this year's
    // recoverable total, either way (or 0), is refused for a human to check. Skipped when the year
    // has no recoverable expenses (nothing is owed either way).
    if (totalRecoverableExpenses > 0
      && (baseAmount * BASE_YEAR_RATIO_LIMIT < totalRecoverableExpenses
        || baseAmount > BASE_YEAR_RATIO_LIMIT * totalRecoverableExpenses)) {
      const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
      throw new CAMTermsError(
        `Base-year expense amount ${usd(baseAmount)} is more than ${BASE_YEAR_RATIO_LIMIT}x away from the `
        + `${input.reconciliationYear} recoverable total (${usd(totalRecoverableExpenses)}). It must be the base `
        + `year's recoverable total in total dollars for the lease's recoverable categories (the whole pool when none are set; not $/SF); check `
        + 'the lease and correct it, then recalculate.'
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

  // Annual cap (0025; ruling 2026-11-10), applied LAST — after rent type, expense stop and base
  // year — because the lease caps what the tenant pays ("Taxes, Insurance, and CAM expense incurred
  // by the tenant shall not exceed $15,000 annually", 29000 Information Lane 507).
  const uncapped = Math.round(owed * 100) / 100
  const { capApplied, warnings } = applyAnnualCap(input, uncapped)
  const actualCamOwed = capApplied ?? uncapped
  const trueUpAmount = Math.round((actualCamOwed - estimatedCamPaid) * 100) / 100

  return { tenantProRataSharePct, actualCamOwed, trueUpAmount, recoveryBasis, capApplied, warnings }
}

/**
 * The cap for the year, prorated by days in effect: cap x daysInEffect / daysInYear (ruling
 * 2026-11-10, matching how the share itself is prorated). Returns capApplied = the prorated cap
 * when it is below `owedRounded` (the cap binds), else null.
 *   - capThrough before Jan 1 of the year: the cap no longer applies.
 *   - capThrough inside the year: the cap applies to the WHOLE year (ruling: tenant-favourable,
 *     never overbills) and a warning asks the reviewer to adjust if the lease says otherwise.
 * Fails closed on a non-positive cap, a capThrough with no cap, an invalid date, or missing days.
 */
function applyAnnualCap(input: CAMInput, owedRounded: number): { capApplied: number | null; warnings: string[] } {
  const cap = input.annualCap ?? null
  const capThrough = input.capThrough ?? null
  if (cap === null) {
    if (capThrough !== null) {
      throw new CAMTermsError('Lease has a CAM cap end date but no annual cap. Enter the cap (or clear the date), then recalculate.')
    }
    return { capApplied: null, warnings: [] }
  }
  if (!(Number.isFinite(cap) && cap > 0)) throw new CAMTermsError('Lease annual CAM cap must be a positive dollar amount')
  const year = input.reconciliationYear
  if (year === undefined || !Number.isInteger(year)) throw new CAMTermsError('A capped lease needs the reconciliation year')
  const { daysInEffect, daysInYear } = input
  if (!(daysInYear !== undefined && daysInEffect !== undefined
    && Number.isInteger(daysInYear) && daysInYear > 0
    && Number.isInteger(daysInEffect) && daysInEffect > 0 && daysInEffect <= daysInYear)) {
    throw new CAMTermsError('A capped lease needs its days in effect for the year to prorate the cap')
  }
  const warnings: string[] = []
  if (capThrough !== null) {
    const through = isoDay(capThrough, 'cam_cap_through')
    const jan1 = Math.round(Date.UTC(year, 0, 1) / DAY_MS)
    const dec31 = Math.round(Date.UTC(year, 11, 31) / DAY_MS)
    if (through < jan1) return { capApplied: null, warnings: [] }
    if (through < dec31) {
      warnings.push(
        `The lease's annual CAM cap ends ${capThrough}, inside ${year}. The cap was applied to the whole of `
        + `${year} (never overbills). If the lease uncaps the rest of the year, adjust before Approve & Bill.`
      )
    }
  }
  const prorated = Math.round(((cap * daysInEffect) / daysInYear) * 100) / 100
  return { capApplied: owedRounded > prorated ? prorated : null, warnings }
}
