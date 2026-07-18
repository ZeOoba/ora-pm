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
    }
    expect(charge.type).toBe('rent')
  })

  it('Lease accepts only real leases-table columns (no monthly_rent)', () => {
    const lease: Lease = {
      id: 'l1',
      tenant_id: 't1',
      unit_id: 'u1',
      status: 'active',
      start_date: '2026-01-01',
      end_date: '2027-01-01',
      rent_type: 'nnn',
      base_rent_monthly: 3000,
      cam_estimate_monthly: 300,
      security_deposit: 6000,
      expense_stop_amount: null,
      ti_allowance: null,
      ti_reimbursement_schedule: null,
      percentage_rent_terms: null,
      options: null,
      notes: null,
      created_at: '2026-01-01T00:00:00Z',
      autopay_enabled: false,
      autopay_payment_method_id: null,
    }
    expect(lease.base_rent_monthly).toBe(3000)
  })
})
