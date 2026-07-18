import { describe, it, expect } from 'vitest'
import { singleLeaseId } from '../../src/portal/lib/charges'

// Regression guard found by the 2026-07-18 REFUTE pass on the charge_type/status fix: removing
// the always-false `status === 'open'` filter (portal-api.ts, PortalPayNow.tsx) made the Pay Now
// selection UI reachable for the first time. `leases_active_unit_unique`
// (`supabase/migrations/0001_core_entities.sql:116`) is scoped to unit_id, not tenant_id, so a
// tenant can legitimately have 2+ simultaneous active leases, and `/api/portal/charges` pools
// charges from every active lease into one flat list (`server/routes/portal.ts:39-48`). A single
// ACH payment can only be attributed to one `lease_id` (one `payments` row per PaymentIntent), so
// charges spanning more than one lease must never be combined into one payment.
describe('singleLeaseId', () => {
  it('returns the shared lease_id when every charge belongs to the same lease', () => {
    const charges = [{ lease_id: 'lease_1' }, { lease_id: 'lease_1' }]
    expect(singleLeaseId(charges)).toBe('lease_1')
  })

  it('returns null when charges span more than one lease', () => {
    const charges = [{ lease_id: 'lease_1' }, { lease_id: 'lease_2' }]
    expect(singleLeaseId(charges)).toBeNull()
  })

  it('returns null for an empty selection', () => {
    expect(singleLeaseId([])).toBeNull()
  })
})
