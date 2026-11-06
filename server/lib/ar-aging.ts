export type AgingBucket = 'current' | '1_30' | '31_60' | '61_90' | '90_plus'

export function bucketByAge(daysPastDue: number): { bucket: AgingBucket } {
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
    const { bucket } = bucketByAge(daysPast)
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

// ── Oldest-first allocation (AR aging report buckets) ──────────────────────────────────────────
//
// There is no payment→charge application table: a lease's AR is only ar_ledger.balance =
// Σ non-voided charges − Σ counted payments (supabase/migrations/0016_charges_void.sql). Payments
// apply to the OLDEST charges first (OI-234, ruled 2026-09-12 — the same rule cron.ts delinquency
// uses), so whatever balance remains is owed on the NEWEST charges. allocateOldestFirst walks a
// lease's non-voided charges newest→oldest (due_date DESC, id DESC) and assigns
// min(charge, remaining balance) to each charge's age bucket until the balance is used up.
//
// If the charges cannot explain the whole balance (Σ charges < balance), the remainder goes to
// `unallocated` rather than being hidden in any age bucket. That is a defensive branch: a
// consistent ledger+charges snapshot cannot produce it (balance = Σ non-voided charges − Σ payments,
// and payments.amount has CHECK > 0). A charge voided between the two reads is caught by the
// route's total_charged cross-check (retry once, then 500), not here. By construction the six buckets
// always sum to the balance exactly. Everything is integer cents.

export interface AllocationCharge {
  id: string
  due_date: string // 'YYYY-MM-DD' (Postgres DATE as PostgREST serializes it)
  amountCents: number
}

export interface AgingBucketsCents {
  current: number
  d1_30: number
  d31_60: number
  d61_90: number
  d90_plus: number
  unallocated: number
}

export const AGING_BUCKET_KEYS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus', 'unallocated'] as const

export function emptyBucketsCents(): AgingBucketsCents {
  return { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, unallocated: 0 }
}

const BUCKET_FIELD: Record<AgingBucket, keyof AgingBucketsCents> = {
  current: 'current', '1_30': 'd1_30', '31_60': 'd31_60', '61_90': 'd61_90', '90_plus': 'd90_plus',
}

// Dollars (JSON number, or the string PostgREST may emit for NUMERIC) → integer cents. null for
// anything non-numeric — including '' and null, which Number() would silently read as 0. The caller
// must fail closed on null. Math.round(n * 100) is exact for 2-decimal values (0.29 → 29).
export function toCents(v: unknown): number | null {
  let n: number
  if (typeof v === 'number') n = v
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v)
  else return null
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
function utcDay(iso: string): number {
  const m = ISO_DATE.exec(iso)
  if (!m) return Number.NaN
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = Date.UTC(y, mo - 1, d)
  const back = new Date(t)
  // Reject dates Date.UTC would roll over (2026-13-45 → 2027-02-14).
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return Number.NaN
  return t / 86_400_000
}

// Whole calendar days from dueDate to asOf (both 'YYYY-MM-DD'); positive = past due. UTC calendar
// arithmetic, so no DST drift. NaN when either date is malformed.
export function daysPastDue(dueDate: string, asOf: string): number {
  return utcDay(asOf) - utcDay(dueDate)
}

export function allocateOldestFirst(balanceCents: number, charges: AllocationCharge[], asOf: string): AgingBucketsCents {
  if (!Number.isInteger(balanceCents)) throw new Error(`balance is not integer cents: ${balanceCents}`)
  if (Number.isNaN(utcDay(asOf))) throw new Error(`malformed as-of date: ${asOf}`)
  for (const c of charges) {
    if (!Number.isInteger(c.amountCents) || c.amountCents < 0) throw new Error(`charge ${c.id}: amount is not non-negative integer cents: ${c.amountCents}`)
    if (Number.isNaN(utcDay(c.due_date))) throw new Error(`charge ${c.id}: malformed due_date: ${c.due_date}`)
  }

  const out = emptyBucketsCents()
  if (balanceCents <= 0) return out

  // Newest first: due_date DESC, then id DESC (ISO dates and uuids both compare correctly as strings).
  const newestFirst = [...charges].sort((a, b) =>
    a.due_date !== b.due_date ? (a.due_date < b.due_date ? 1 : -1) : (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))

  let remaining = balanceCents
  for (const c of newestFirst) {
    if (remaining === 0) break
    const take = Math.min(c.amountCents, remaining)
    if (take === 0) continue
    out[BUCKET_FIELD[bucketByAge(daysPastDue(c.due_date, asOf)).bucket]] += take
    remaining -= take
  }
  out.unallocated = remaining
  return out
}

// ── Snapshot cross-check ────────────────────────────────────────────────────────────────────────
//
// ar_ledger and charges are read in separate requests, so a charge inserted/voided/edited between
// them — or a hosted PostgREST max_rows below the page size silently truncating the charge read —
// can mis-age a balance with no signal. Each ar_ledger row carries total_charged = Σ non-voided
// charges for the lease from the ledger's own snapshot (0016_charges_void.sql), so the fetched
// charges must sum to it exactly. Returns the first lease that does not (both values in cents;
// ledgerCents is null when total_charged is not numeric), or null when every lease ties.
export interface ChargeTotalMismatch {
  leaseId: string
  ledgerCents: number | null
  chargeCents: number
}

export function findChargeTotalMismatch(
  ledgerRows: ReadonlyArray<{ lease_id: string; total_charged: unknown }>,
  chargesByLease: ReadonlyMap<string, ReadonlyArray<AllocationCharge>>
): ChargeTotalMismatch | null {
  for (const row of ledgerRows) {
    const ledgerCents = toCents(row.total_charged)
    let chargeCents = 0
    for (const c of chargesByLease.get(row.lease_id) ?? []) chargeCents += c.amountCents
    if (ledgerCents === null || ledgerCents !== chargeCents) return { leaseId: row.lease_id, ledgerCents, chargeCents }
  }
  return null
}
