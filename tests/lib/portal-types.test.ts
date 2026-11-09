import { describe, it, expect } from 'vitest'
import type { Charge, Lease } from '../../src/portal/lib/portal-api'

// Regression guard for the 2026-07-16 audit finding #7 (re-confirmed by REFUTE pass 2026-07-18):
// portal-api.ts hand-rolled Charge/Lease interfaces that diverged from the real Supabase schema
// (`supabase/migrations/0002_financial_tables.sql`). `charges` has no `status` column and its
// type column is named `type`, not `charge_type`; `leases` has `base_rent_monthly`, not
// `monthly_rent`. The divergence meant `ch.status === 'open'` (charges.status doesn't exist)
// silently returned an empty list, and `ch.charge_type.replace(...)` on the surviving code path
// would have thrown on any charge lacking a description. These literals use ONLY real schema
// field names — if portal-api.ts's Charge/Lease interfaces reintroduce a bogus field, or drop
// a real one, `tsc --noEmit` fails on this file (excess/missing property checks on the object
// literals below), independent of any runtime harness.
describe('portal-api Charge/Lease — schema-derived, no reintroduced field drift', () => {
  it('Charge accepts only real charges-table columns (no charge_type, no status)', () => {
    const charge: Charge = {
      id: 'c1',
      lease_id: 'l1',
      charge_date: '2026-07-01',
      due_date: '2026-07-01',
      period_start: '2026-07-01',
      period_end: '2026-07-31',
      type: 'rent',
      amount: 3000,
      description: null,
      source: 'auto',
      idempotency_key: null,
      created_at: '2026-07-01T00:00:00Z',
      voided_at: null,
      void_reason: null,
    }
    expect(charge.type).toBe('rent')
  })

  // M8 (2026-11-08): the portal Lease type is the tenant-safe projection the server returns
  // (PORTAL_LEASE_SELECT), a Pick of real leases columns. Internal fields (notes, options, TI,
  // expense stop) are excess properties here, so a page reaching for one fails tsc.
  it('Lease accepts only the tenant-safe leases columns the portal endpoint returns', () => {
    const lease: Lease = {
      id: 'l1',
      status: 'active',
      start_date: '2026-01-01',
      end_date: '2027-01-01',
      rent_type: 'nnn',
      base_rent_monthly: 3000,
      cam_estimate_monthly: 300,
      autopay_enabled: false,
      autopay_payment_method_id: null,
    }
    expect(lease.base_rent_monthly).toBe(3000)
    // @ts-expect-error internal landlord notes are not part of the tenant projection
    const withNotes: Lease = { ...lease, notes: 'internal' }
    expect(withNotes.id).toBe('l1')
  })
})
