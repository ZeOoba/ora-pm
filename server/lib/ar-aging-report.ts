// AR aging report: the read + allocation behind GET /api/reports/ar-aging, extracted unchanged from
// server/routes/reports.ts (B13, 2026-11-10) so the tenant portal and the admin "View as tenant"
// preview age a tenant's balance with exactly the same code as the admin report. The only addition
// is the optional tenant filter.
//
// AR aging from the ar_ledger view — only rows with a positive balance — plus aging buckets.
//
// Every existing ar_ledger field is returned unchanged; each row gains `buckets` and the response
// gains portfolio `totals`. ar_ledger has no payment→charge application, so buckets come from the
// OI-234 oldest-first rule (payments retire the oldest charges first; the balance is owed on the
// newest) — see allocateOldestFirst in server/lib/ar-aging.ts. The charge population is exactly
// the one ar_ledger.balance sums: every `charges` row for the lease WHERE voided_at IS NULL.
// Integer cents throughout; Σ buckets (incl. `unallocated`) === balance per row and in totals.
//
// Fail closed (error result, no partial report): any read error, a keyset page that is not
// ascending, or a non-numeric balance/amount or malformed due_date. Both reads are keyset-paged
// (fetchAllPages) — PostgREST truncates at POSTGREST_MAX_ROWS silently, and a truncated charge list
// would push balance into `unallocated` or age it wrongly. A lease's lifetime charges legitimately
// exceed one page per chunk, so the chunk is paged (maxRows: Infinity) rather than row-capped.
//
// Not a transactional snapshot, but cross-checked: each ledger row's total_charged must equal the
// sum of the fetched charges (see readArAging); a mismatch re-runs the read once, then fails.
// A payment landing between the reads still leaves the report on the earlier balance.
//
// Credits: ar_ledger rows with balance <= 0 are excluded, so a tenant's aging `totals.balance` can
// exceed the signed sum of their ar_ledger balances (what /api/portal/me reports). Callers that
// show both must show the difference as a credit, never hide it.
import type { getDb } from '../db/client'
import { fetchChunked, fetchAllPages, POSTGREST_MAX_ROWS } from './postgrest-paging'
import { allocateOldestFirst, balanceForwardAgingCharge, emptyBucketsCents, toCents, AGING_BUCKET_KEYS, type AgingBucketsCents, type AllocationCharge, findChargeTotalMismatch, type ChargeTotalMismatch } from './ar-aging'

type Db = ReturnType<typeof getDb>

// Ids per `.in()` call — keeps the request URL bounded however many leases are read.
const BULK_QUERY_CHUNK_SIZE = 100

export type ArLedgerRow = { lease_id: string; balance: number | string; total_charged: unknown } & Record<string, unknown>
type AgingCharge = { id: string; lease_id: string; amount: number | string; due_date: string }
type BucketKey = (typeof AGING_BUCKET_KEYS)[number]

export interface AgingFilter {
  propertyId?: string
  tenantId?: string
}

type AgingRead =
  | { ok: true; data: ArLedgerRow[]; byLease: Map<string, AllocationCharge[]> }
  | { ok: false; error: { message: string; code?: string }; publicMsg: string }

// One full ledger + charges read, with the snapshot cross-check: ar_ledger.total_charged is
// Σ non-voided charges from the ledger's own snapshot, so the separately-fetched charges must sum
// to it per lease. A difference means a charge was inserted/voided/edited between the two requests
// (or a hosted max_rows silently truncated the charge read) and the buckets would be mis-aged.
async function readArAging(db: Db, filter: AgingFilter): Promise<AgingRead & { mismatch?: ChargeTotalMismatch }> {
  const { data, error } = await fetchAllPages<ArLedgerRow>((after) => {
    let q = db.from('ar_ledger').select('*').gt('balance', 0)
    if (filter.propertyId) q = q.eq('property_id', filter.propertyId)
    if (filter.tenantId) q = q.eq('tenant_id', filter.tenantId)
    if (after !== null) q = q.gt('lease_id', after)
    return q.order('lease_id').limit(POSTGREST_MAX_ROWS)
  }, (r) => r.lease_id)
  if (error) return { ok: false, error, publicMsg: 'Failed to load AR aging report' }

  const { data: charges, error: chargeErr } = await fetchChunked(data.map(r => r.lease_id), BULK_QUERY_CHUNK_SIZE, (chunk) =>
    fetchAllPages<AgingCharge>((after) => {
      let q = db.from('charges').select('id, lease_id, amount, due_date')
        .in('lease_id', chunk)
        .is('voided_at', null)
      if (after !== null) q = q.gt('id', after)
      return q.order('id').limit(POSTGREST_MAX_ROWS)
    }, (ch) => ch.id),
    { maxRows: Infinity })
  if (chargeErr) return { ok: false, error: chargeErr, publicMsg: 'Failed to load AR aging charges' }

  const byLease = new Map<string, AllocationCharge[]>()
  for (const ch of charges) {
    const amountCents = toCents(ch.amount)
    if (amountCents === null || amountCents < 0) {
      return { ok: false, error: { message: `non-numeric or negative charges.amount on charge ${ch.id}` }, publicMsg: 'Failed to load AR aging report' }
    }
    const list = byLease.get(ch.lease_id) ?? []
    list.push({ id: ch.id, due_date: ch.due_date, amountCents })
    byLease.set(ch.lease_id, list)
  }
  const mismatch = findChargeTotalMismatch(data, byLease) ?? undefined
  // 0030: a positive balance forward ages as a charge due on its as_of date (after the
  // total_charged cross-check, which counts charges only). Same ledger row, so same snapshot.
  for (const row of data) {
    const bfCents = toCents(row.balance_forward ?? 0)
    if (bfCents === null) {
      return { ok: false, error: { message: `non-numeric ar_ledger.balance_forward for lease ${row.lease_id}` }, publicMsg: 'Failed to load AR aging report' }
    }
    if (bfCents > 0) {
      if (typeof row.balance_forward_as_of !== 'string') {
        return { ok: false, error: { message: `balance forward without a date for lease ${row.lease_id}` }, publicMsg: 'Failed to load AR aging report' }
      }
      const list = byLease.get(row.lease_id) ?? []
      list.push(balanceForwardAgingCharge({ id: row.lease_id, as_of: row.balance_forward_as_of, amountCents: bfCents }))
      byLease.set(row.lease_id, list)
    }
  }
  return { ok: true, data, byLease, mismatch }
}

function centsToDollars(b: AgingBucketsCents): Record<BucketKey, number> {
  const out = {} as Record<BucketKey, number>
  for (const k of AGING_BUCKET_KEYS) out[k] = b[k] / 100
  return out
}

export type AgingReport = {
  data: (ArLedgerRow & { buckets: Record<BucketKey, number> })[]
  totals: { balance: number } & Record<BucketKey, number>
}

export type AgingReportResult =
  | { ok: true; report: AgingReport }
  | { ok: false; error: { message: string; code?: string }; publicMsg: string }

/** The full aging report (rows + totals) for an optional property or tenant. */
export async function buildAgingReport(db: Db, filter: AgingFilter = {}, asOf: string = new Date().toISOString().slice(0, 10)): Promise<AgingReportResult> {
  // Re-run the whole read ONCE on a snapshot mismatch (a concurrent write is transient); a second
  // mismatch fails closed rather than serving a mis-aged report.
  let read = await readArAging(db, filter)
  if (read.ok && read.mismatch) read = await readArAging(db, filter)
  if (!read.ok) return read
  if (read.mismatch) {
    const m = read.mismatch
    return { ok: false, error: { message: `AR aging snapshot mismatch persisted after retry: lease ${m.leaseId} ar_ledger.total_charged=${m.ledgerCents} cents, fetched charges=${m.chargeCents} cents` }, publicMsg: 'Failed to load AR aging report' }
  }
  const { data, byLease } = read

  // asOf: today, date-only, UTC — the same clock cron.ts delinquency uses.
  const totalsCents = { balance: 0, ...emptyBucketsCents() }
  const rows: AgingReport['data'] = []
  for (const row of data) {
    const balanceCents = toCents(row.balance)
    if (balanceCents === null) {
      return { ok: false, error: { message: `non-numeric ar_ledger.balance for lease ${row.lease_id}` }, publicMsg: 'Failed to load AR aging report' }
    }
    let b: AgingBucketsCents
    try {
      b = allocateOldestFirst(balanceCents, byLease.get(row.lease_id) ?? [], asOf)
    } catch (e) {
      return { ok: false, error: { message: `aging allocation failed for lease ${row.lease_id}: ${(e as Error).message}` }, publicMsg: 'Failed to load AR aging report' }
    }
    totalsCents.balance += balanceCents
    for (const k of AGING_BUCKET_KEYS) totalsCents[k] += b[k]
    rows.push({ ...row, buckets: centsToDollars(b) })
  }

  return { ok: true, report: { data: rows, totals: { balance: totalsCents.balance / 100, ...centsToDollars(totalsCents) } } }
}
