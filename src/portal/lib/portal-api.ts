import { portalSupabase } from './supabase-portal'
import type { Charge as DBCharge, Lease as DBLease } from '../../types'

// OI-064 follow-up: a bare Error discarded the HTTP status, so a caller
// couldn't tell a deterministic 4xx rejection (rate limit, balance cap,
// validation — the charge never reached Stripe) from a network drop or a
// server 5xx (genuinely unknown whether it went through). pay-attempt.ts's
// retry-softening relies on this distinction — see runPayAttempt.
export class PortalApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'PortalApiError'
    this.status = status
  }
}

async function portalFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { data: { session } } = await portalSupabase.auth.getSession()
  const jwt = session?.access_token
  if (!jwt) throw new Error('Not authenticated')

  const res = await fetch(`/api/portal${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${jwt}`,
      ...init?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new PortalApiError(body.error ?? `HTTP ${res.status}`, res.status)
  }
  return res.json() as Promise<T>
}

async function stripeFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { data: { session } } = await portalSupabase.auth.getSession()
  const jwt = session?.access_token
  if (!jwt) throw new Error('Not authenticated')

  const res = await fetch(`/api/stripe${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${jwt}`,
      ...init?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new PortalApiError(body.error ?? `HTTP ${res.status}`, res.status)
  }
  return res.json() as Promise<T>
}

export interface TenantMe {
  tenant: {
    id: string
    name: string
    contact_email: string
    stripe_customer_id: string | null
    auth_user_id: string
  }
  total_balance: number
  /** Part of total_balance brought over from the prior system (QuickBooks), across the tenant's leases. */
  balance_forward?: { amount: number; as_of: string } | null
}

export interface Charge extends DBCharge {
  leases?: { units?: { properties?: { name: string; address: string } } }
}

export interface Payment {
  id: string
  lease_id: string
  amount: number
  payment_date: string
  /** NULL for check/wire/other payments recorded by the admin (0002); only ACH rows carry one. */
  stripe_status: string | null
  notes: string | null
}

// Mirrors PORTAL_LEASE_SELECT in server/routes/portal.ts (M8): the tenant endpoint returns only
// these lease columns, so the type does not promise internal fields the server never sends.
export interface Lease extends Pick<DBLease,
  | 'id' | 'start_date' | 'end_date' | 'status' | 'rent_type' | 'base_rent_monthly'
  | 'cam_estimate_monthly' | 'autopay_enabled' | 'autopay_payment_method_id'> {
  units?: { suite: string; sf: number; properties?: { name: string; address: string; city: string; state: string } }
  lease_amendments?: Array<{ id: string; effective_date: string; description: string }>
}

// GET /api/portal/aging (B13): the tenant's own aging, same allocator as the admin AR report.
// Positive-balance leases only; the gap to TenantMe.total_balance is credit on account.
export interface PortalAgingBuckets {
  current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number; unallocated: number
}
export interface PortalAging {
  data: { lease_id: string; property_name: string; suite: string; balance: number | string; buckets: PortalAgingBuckets }[]
  totals: PortalAgingBuckets & { balance: number }
}

export interface Document {
  id: string
  lease_id: string
  document_type: string
  file_name: string
  storage_path: string
  uploaded_at: string
}

export const portalApi = {
  getMe: () => portalFetch<TenantMe>('/me'),

  getCharges: () => portalFetch<{ data: Charge[] }>('/charges'),

  getPayments: () => portalFetch<{ data: Payment[] }>('/payments'),

  getLease: () => portalFetch<{ data: Lease[] }>('/lease'),

  getDocuments: () => portalFetch<{ data: Document[] }>('/documents'),

  getAging: () => portalFetch<PortalAging>('/aging'),

  setAutopay: (lease_id: string, enabled: boolean, payment_method_id?: string) =>
    portalFetch<{ autopay_enabled: boolean }>('/autopay', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lease_id, enabled, payment_method_id }),
    }),

  createSetupIntent: (tenant_id: string) =>
    stripeFetch<{ client_secret: string }>('/setup-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id }),
    }),

  createPaymentIntent: (body: {
    tenant_id: string
    lease_id: string
    amount_cents: number
    payment_method_id: string
    description?: string
    client_request_id: string
  }) =>
    stripeFetch<{ payment_intent_id: string; status: string; deduped?: boolean }>('/payment-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  ensureStripeCustomer: (tenant_id: string, email?: string, name?: string) =>
    stripeFetch<{ customer_id: string }>('/customer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id, email, name }),
    }),
}
