export type AgingBucket = 'current' | '1_30' | '31_60' | '61_90' | '90_plus'

export function bucketByAge(_amount: number, daysPastDue: number): { bucket: AgingBucket } {
  if (daysPastDue <= 0) return { bucket: 'current' }
  if (daysPastDue <= 30) return { bucket: '1_30' }
  if (daysPastDue <= 60) return { bucket: '31_60' }
  if (daysPastDue <= 90) return { bucket: '61_90' }
  return { bucket: '90_plus' }
}

export interface ChargeForAging {
  amount: number
  due_date: string
  paid_amount: number
}

export interface AgingRow {
  leaseId: string
  tenantName: string
  propertyName: string
  suite: string
  balance: number
  current: number
  days_1_30: number
  days_31_60: number
  days_61_90: number
  days_90_plus: number
}

export function buildAgingRow(
  lease: { lease_id: string; tenant_name: string; property_name: string; suite: string },
  charges: ChargeForAging[],
  asOfDate: Date = new Date()
): AgingRow {
  const row: AgingRow = {
    leaseId: lease.lease_id,
    tenantName: lease.tenant_name,
    propertyName: lease.property_name,
    suite: lease.suite,
    balance: 0,
    current: 0,
    days_1_30: 0,
    days_31_60: 0,
    days_61_90: 0,
    days_90_plus: 0,
  }

  for (const charge of charges) {
    const outstanding = Math.round((charge.amount - charge.paid_amount) * 100) / 100
    if (outstanding <= 0) continue
    const dueDate = new Date(charge.due_date + 'T00:00:00')
    const daysPast = Math.floor((asOfDate.getTime() - dueDate.getTime()) / 86_400_000)
    const { bucket } = bucketByAge(outstanding, daysPast)
    row.balance += outstanding
    if (bucket === 'current')    row.current      += outstanding
    else if (bucket === '1_30')  row.days_1_30    += outstanding
    else if (bucket === '31_60') row.days_31_60   += outstanding
    else if (bucket === '61_90') row.days_61_90   += outstanding
    else                         row.days_90_plus += outstanding
  }

  // Round all buckets
  const keys = ['balance', 'current', 'days_1_30', 'days_31_60', 'days_61_90', 'days_90_plus'] as const
  for (const k of keys) {
    row[k] = Math.round(row[k] * 100) / 100
  }

  return row
}
