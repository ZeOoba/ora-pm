export type CAMRentType = 'nnn' | 'gross' | 'modified_gross'

export interface CAMInput {
  totalRecoverableExpenses: number
  tenantSF: number
  totalLeasedSF: number
  estimatedCamPaid: number
  /** leases.rent_type. Omitted = 'nnn' (the pre-fix behaviour, kept for existing callers). */
  rentType?: CAMRentType
  /** leases.expense_stop_amount: $/SF per year (LeaseForm "Expense Stop ($/SF)"). */
  expenseStopPerSF?: number | null
}

/** How actualCamOwed was derived — persisted context for a human reviewing the draft. */
export type CAMRecoveryBasis = 'full_pro_rata' | 'above_expense_stop' | 'none_gross'

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
// CAM pool: the pro-rata denominator (audit finding cam-denominator-client-snapshot).
//
// The denominator used to be summed in the browser from TODAY's active rent-roll rows and trusted
// by /calculate, so a tenant that left mid-year vanished from it (every remaining tenant's share
// went up) and a tenant that arrived after year-end was counted in it. It is now computed server
// side, preserving the existing basis (leased SF, not building SF) but occupancy-weighted over the
// reconciliation year: each lease that was in effect at any point in the year contributes
//   sf x (days in effect during the year / days in the year)
// and the tenant's own numerator is weighted the same way, so the shares of every lease in the
// pool sum to exactly 100% of recoverable expenses.
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

export interface CAMPool {
  year: number
  daysInYear: number
  /** The pro-rata denominator: Σ sf x overlapDays / daysInYear over every lease in the pool. */
  weightedLeasedSF: number
  /** Only leases with overlapDays > 0. */
  byLease: Record<string, { sf: number; overlapDays: number; weightedSF: number }>
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
    byLease[l.id] = { sf, overlapDays, weightedSF }
    weightedLeasedSF += weightedSF
  }
  return { year, daysInYear, weightedLeasedSF, byLease }
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
 * Base-year stops, CAM caps, admin-fee and gross-up provisions are NOT modelled: the schema has no
 * fields for them.
 */
export function calculateCAMTrueUp(input: CAMInput): CAMOutput {
  const { totalRecoverableExpenses, tenantSF, totalLeasedSF, estimatedCamPaid } = input
  const rentType: CAMRentType = input.rentType ?? 'nnn'
  const stop = input.expenseStopPerSF ?? null

  if (totalLeasedSF === 0) throw new Error('totalLeasedSF cannot be zero')
  if (tenantSF < 0) throw new Error('tenantSF cannot be negative')
  if (tenantSF > totalLeasedSF) throw new Error('tenantSF cannot exceed totalLeasedSF')
  if (stop !== null && (!Number.isFinite(stop) || stop < 0)) {
    throw new CAMTermsError('Lease expense stop must be a non-negative $/SF amount')
  }

  const tenantProRataSharePct = tenantSF / totalLeasedSF
  const share = totalRecoverableExpenses * tenantProRataSharePct

  let owed: number
  let recoveryBasis: CAMRecoveryBasis
  if (rentType === 'nnn') {
    owed = share
    recoveryBasis = 'full_pro_rata'
  } else if (stop !== null) {
    owed = Math.max(0, share - stop * tenantSF)
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
