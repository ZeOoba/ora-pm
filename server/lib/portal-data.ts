// The tenant portal's reads, keyed by tenant id (B13, 2026-11-10). Used by the tenant's own portal
// routes (server/routes/portal.ts, tenant resolved from the JWT) AND by the admin-only
// GET /api/tenants/:id/portal-preview, so "View as tenant" shows exactly what the tenant sees:
// same queries, same tenant-safe projections, same balance rule.
//
// Read-only. Moves no money.
import type { getDb } from '../db/client'
import { buildAgingReport, type AgingReport } from './ar-aging-report'

type Db = ReturnType<typeof getDb>

/** 'raw' = the portal's historical generic 500 body; `text` is that fixed public string, never a DB message. 'db' = dbError(). */
export type PortalFail =
  | { ok: false; kind: 'raw'; text: string }
  | { ok: false; kind: 'db'; error: { message: string; code?: string }; publicMsg: string }
export type PortalResult<T> = { ok: true; data: T } | PortalFail

const raw = (text = 'DB error'): PortalFail => ({ ok: false, kind: 'raw', text })
const db = (error: { message: string; code?: string }, publicMsg: string): PortalFail => ({ ok: false, kind: 'db', error, publicMsg })

export const PORTAL_TENANT_SELECT = 'id, name, contact_email, stripe_customer_id, auth_user_id'

// M8 (2026-11-08 audit): an explicit tenant-safe projection, never `*`. leases.* carried the
// landlord's internal `notes`, renewal `options`, TI and expense-stop terms (and any column a
// future migration adds); lease_amendments(*) carried the raw `changes` JSON and storage path.
// These are exactly the fields the portal renders (src/portal/pages/PortalMyLease.tsx,
// PortalAccount.tsx); autopay_payment_method_id is the tenant's own saved method, tested only
// for presence. Add a column here deliberately, with the page that needs it.
export const PORTAL_LEASE_SELECT = [
  'id',
  'start_date',
  'end_date',
  'status',
  'rent_type',
  'base_rent_monthly',
  'cam_estimate_monthly',
  'autopay_enabled',
  'autopay_payment_method_id',
  'units(suite, sf, properties(name, address, city, state))',
  'lease_amendments(id, effective_date, description)',
].join(', ')

/**
 * Signed sum of every ar_ledger row for the tenant (credits included). Fails closed: a failed
 * read used to report a $0 balance, indistinguishable from "paid up" (B13 fix).
 */
export async function portalBalance(d: Db, tenantId: string): Promise<PortalResult<number>> {
  const { data, error } = await d.from('ar_ledger').select('balance').eq('tenant_id', tenantId)
  if (error) return db(error, 'Failed to load balance')
  // Integer cents: NUMERIC can arrive as a string, and float dollar sums drift.
  let cents = 0
  for (const r of (data ?? []) as { balance: number | string | null }[]) {
    const n = Number(r.balance ?? 0)
    if (!Number.isFinite(n)) return db({ message: `non-numeric ar_ledger.balance for tenant ${tenantId}` }, 'Failed to load balance')
    cents += Math.round(n * 100)
  }
  return { ok: true, data: cents / 100 }
}

async function leaseIds(d: Db, tenantId: string, activeOnly: boolean): Promise<PortalResult<string[]>> {
  let q = d.from('leases').select('id').eq('tenant_id', tenantId)
  if (activeOnly) q = q.eq('status', 'active')
  const { data, error } = await q
  if (error) return raw()
  return { ok: true, data: (data ?? []).map((l: { id: string }) => l.id) }
}

/** Non-voided charges on the tenant's ACTIVE leases, newest due first. */
export async function portalCharges(d: Db, tenantId: string): Promise<PortalResult<unknown[]>> {
  const ids = await leaseIds(d, tenantId, true)
  if (!ids.ok) return ids
  if (!ids.data.length) return { ok: true, data: [] }
  // OI-278 / migration 0016: voided charges are audit rows — never shown to (or payable by) the
  // tenant, and never part of the balance ar_ledger reports.
  const { data, error } = await d
    .from('charges')
    .select('*, leases(units(properties(name,address)))')
    .in('lease_id', ids.data)
    .is('voided_at', null)
    .order('due_date', { ascending: false })
  if (error) return db(error, 'Failed to load charges')
  return { ok: true, data: data ?? [] }
}

/** Payments on ANY of the tenant's leases, newest first. */
export async function portalPayments(d: Db, tenantId: string): Promise<PortalResult<unknown[]>> {
  const ids = await leaseIds(d, tenantId, false)
  if (!ids.ok) return ids
  if (!ids.data.length) return { ok: true, data: [] }
  const { data, error } = await d
    .from('payments')
    .select('*')
    .in('lease_id', ids.data)
    .order('payment_date', { ascending: false })
  if (error) return db(error, 'Failed to load payment history')
  return { ok: true, data: data ?? [] }
}

/** Active leases, tenant-safe projection only. */
export async function portalLeases(d: Db, tenantId: string): Promise<PortalResult<unknown[]>> {
  const { data, error } = await d
    .from('leases')
    .select(PORTAL_LEASE_SELECT)
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
  if (error) return db(error, 'Failed to load lease information')
  return { ok: true, data: data ?? [] }
}

/** Fields of an aging row a tenant may see: their own lease's figures, nothing internal. */
export type PortalAgingRow = {
  lease_id: string
  property_name: unknown
  suite: unknown
  balance: number | string
  buckets: AgingReport['data'][number]['buckets']
}

/** The tenant's aging (same allocator as /api/reports/ar-aging), projected to tenant-safe fields. */
export async function portalAging(d: Db, tenantId: string): Promise<PortalResult<{ data: PortalAgingRow[]; totals: AgingReport['totals'] }>> {
  const r = await buildAgingReport(d, { tenantId })
  if (!r.ok) return db(r.error, r.publicMsg)
  return {
    ok: true,
    data: {
      data: r.report.data.map((row) => ({
        lease_id: row.lease_id,
        property_name: row.property_name,
        suite: row.suite,
        balance: row.balance,
        buckets: row.buckets,
      })),
      totals: r.report.totals,
    },
  }
}
