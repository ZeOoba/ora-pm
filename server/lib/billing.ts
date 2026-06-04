import { format, endOfMonth, getDaysInMonth } from 'date-fns'

export interface BillingInput {
  leaseId: string
  baseRentMonthly: number
  camEstimateMonthly: number
  leaseStartDate: string   // ISO date e.g. '2026-01-15'
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

export function buildMonthlyCharges(input: BillingInput): BillingOutput {
  const { leaseId, baseRentMonthly, camEstimateMonthly, leaseStartDate, periodYear, periodMonth } = input

  const periodStart = new Date(periodYear, periodMonth - 1, 1)
  const periodEnd = endOfMonth(periodStart)
  const periodStartStr = format(periodStart, 'yyyy-MM-dd')
  const periodEndStr = format(periodEnd, 'yyyy-MM-dd')
  const chargeDate = periodStartStr
  const dueDate = format(new Date(periodYear, periodMonth - 1, 5), 'yyyy-MM-dd')

  // Prorate if lease starts mid-month in this period
  let prorateFactor = 1
  const leaseStart = new Date(leaseStartDate)
  if (
    leaseStart.getFullYear() === periodYear &&
    leaseStart.getMonth() === periodMonth - 1 &&
    leaseStart.getDate() > 1
  ) {
    const daysInMonth = getDaysInMonth(periodStart)
    const daysOccupied = daysInMonth - leaseStart.getDate() + 1
    prorateFactor = daysOccupied / daysInMonth
  }

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
