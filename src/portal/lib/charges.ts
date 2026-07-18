import type { Charge } from './portal-api'

// A single ACH payment can only be attributed to one `lease_id` (server/routes/stripe.ts writes
// one `payments` row per PaymentIntent), but a tenant can hold 2+ simultaneous active leases
// (`leases_active_unit_unique` is scoped to unit_id, not tenant_id) and `/api/portal/charges`
// pools charges from every active lease into one list. Combining charges from different leases
// into one payment would misattribute the full amount to whichever lease the first selected
// charge happens to belong to.
export function singleLeaseId(charges: Pick<Charge, 'lease_id'>[]): string | null {
  const leaseIds = new Set(charges.map(ch => ch.lease_id))
  return leaseIds.size === 1 ? [...leaseIds][0] : null
}
