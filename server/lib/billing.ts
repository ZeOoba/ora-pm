import { format, endOfMonth } from 'date-fns'

export interface BillingInput {
  leaseId: string
  baseRentMonthly: number
  camEstimateMonthly: number
  leaseStartDate: string   // ISO date e.g. '2026-01-15'
  leaseEndDate: string     // ISO date, INCLUSIVE last day of the term (leases.end_date)
  periodYear: number
  periodMonth: number      // 1–12
}

type AutoChargeType = 'rent' | 'cam_estimate'

export interface AutoCharge {
  lease_id: string
  charge_date: string
  due_date: string
  period_start: string
  period_end: string
  type: AutoChargeType
  amount: number
  description: string
  source: 'auto'
  idempotency_key: string
}

export interface BillingOutput {
  charges: AutoCharge[]
}

export function generateIdempotencyKey(params: {
  leaseId: string
  periodStart: string
  type: string
}): string {
  return `auto:${params.leaseId}:${params.periodStart}:${params.type}`
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Days since the epoch for an ISO calendar date, computed in UTC so the result never depends on
 *  the host time zone (`new Date('2026-06-16').getDate()` reads 15 west of UTC). null if malformed. */
function isoDayNumber(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string') return null
  const m = ISO_DATE_RE.exec(iso)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = Date.UTC(y, mo - 1, d)
  const back = new Date(t)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return Math.round(t / 86_400_000)
}

export type LeaseTermStatus = 'in_term' | 'not_started' | 'ended' | 'invalid'

/**
 * Where a lease's term sits relative to a billing month (audit finding billing-ignores-lease-term).
 * start_date and end_date are both INCLUSIVE (leases.lease_dates_valid: end_date >= start_date).
 *   not_started: start_date after the last day of the month
 *   ended:       end_date before the first day of the month
 *   invalid:     either date missing/malformed, or end before start (fail closed: never billed)
 */
export function leaseTermStatusForPeriod(
  leaseStartDate: string,
  leaseEndDate: string,
  periodYear: number,
  periodMonth: number,
): LeaseTermStatus {
  const start = isoDayNumber(leaseStartDate)
  const end = isoDayNumber(leaseEndDate)
  if (start === null || end === null || end < start) return 'invalid'
  const periodStart = Math.round(Date.UTC(periodYear, periodMonth - 1, 1) / 86_400_000)
  const periodEnd = Math.round(Date.UTC(periodYear, periodMonth, 0) / 86_400_000)
  if (start > periodEnd) return 'not_started'
  if (end < periodStart) return 'ended'
  return 'in_term'
}

export function buildMonthlyCharges(input: BillingInput): BillingOutput {
  const { leaseId, baseRentMonthly, camEstimateMonthly, leaseStartDate, leaseEndDate, periodYear, periodMonth } = input

  const periodStart = new Date(periodYear, periodMonth - 1, 1)
  const periodEnd = endOfMonth(periodStart)
  const periodStartStr = format(periodStart, 'yyyy-MM-dd')
  const periodEndStr = format(periodEnd, 'yyyy-MM-dd')
  const chargeDate = periodStartStr
  const dueDate = format(new Date(periodYear, periodMonth - 1, 5), 'yyyy-MM-dd')

  // Nothing is ever billed outside the lease term: a lease that has not started, has ended, or has
  // unusable dates produces no charges. The cron caller classifies these first (same function) so a
  // past-end lease is surfaced for review instead of silently dropped or silently billed.
  if (leaseTermStatusForPeriod(leaseStartDate, leaseEndDate, periodYear, periodMonth) !== 'in_term') {
    return { charges: [] }
  }

  // Prorate by the days of the month that fall inside the term, at EITHER end: a mid-month start
  // (first month) and a mid-month end (final partial month). Both dates inclusive.
  const monthFirst = Math.round(Date.UTC(periodYear, periodMonth - 1, 1) / 86_400_000)
  const monthLast = Math.round(Date.UTC(periodYear, periodMonth, 0) / 86_400_000)
  const daysInMonth = monthLast - monthFirst + 1
  const occupiedFirst = Math.max(monthFirst, isoDayNumber(leaseStartDate) as number)
  const occupiedLast = Math.min(monthLast, isoDayNumber(leaseEndDate) as number)
  const daysOccupied = occupiedLast - occupiedFirst + 1
  const prorateFactor = daysOccupied >= daysInMonth ? 1 : daysOccupied / daysInMonth

  const prorateSuffix = prorateFactor < 1 ? ' (prorated)' : ''
  const monthLabel = format(periodStart, 'MMMM yyyy')
  const charges: AutoCharge[] = []

  const rentAmount = Math.round(baseRentMonthly * prorateFactor * 100) / 100
  if (rentAmount > 0) {
    charges.push({
      lease_id: leaseId,
      charge_date: chargeDate,
      due_date: dueDate,
      period_start: periodStartStr,
      period_end: periodEndStr,
      type: 'rent',
      amount: rentAmount,
      description: `Rent – ${monthLabel}${prorateSuffix}`,
      source: 'auto',
      idempotency_key: generateIdempotencyKey({ leaseId, periodStart: periodStartStr, type: 'rent' }),
    })
  }

  const camAmount = Math.round(camEstimateMonthly * prorateFactor * 100) / 100
  if (camAmount > 0) {
    charges.push({
      lease_id: leaseId,
      charge_date: chargeDate,
      due_date: dueDate,
      period_start: periodStartStr,
      period_end: periodEndStr,
      type: 'cam_estimate',
      amount: camAmount,
      description: `CAM Estimate – ${monthLabel}${prorateSuffix}`,
      source: 'auto',
      idempotency_key: generateIdempotencyKey({ leaseId, periodStart: periodStartStr, type: 'cam_estimate' }),
    })
  }

  return { charges }
}
