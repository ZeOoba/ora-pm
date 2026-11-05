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

/**
 * What the charges read may hide on the Pay Now page. Only the select step can be replaced by the
 * skeleton / error panel, and only for a first load or a first-load failure. A failed background
 * refetch (isError with data kept) and any step past 'select' (processing, done, error) must never
 * be hidden by the charges query state: a tenant returning to the tab mid-payment keeps the
 * "Payment Initiated" / Stripe error screen.
 */
export function chargesGate(
  step: 'select' | 'processing' | 'done' | 'error',
  q: { isLoading: boolean; isError: boolean; data: unknown },
): 'blocking' | 'content' {
  if (step !== 'select') return 'content'
  return q.isLoading || (q.isError && q.data === undefined) ? 'blocking' : 'content'
}
