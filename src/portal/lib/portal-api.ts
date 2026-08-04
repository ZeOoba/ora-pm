import { portalSupabase } from './supabase-portal'
import type { Charge as DBCharge, Lease as DBLease } from '../../types'

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
    throw new Error(body.error ?? `HTTP ${res.status}`)
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
    throw new Error(body.error ?? `HTTP ${res.status}`)
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
}

export interface Charge extends DBCharge {
  leases?: { units?: { properties?: { name: string; address: string } } }
}

export interface Payment {
  id: string
  lease_id: string
  amount: number
  payment_date: string
  stripe_status: string
  notes: string | null
}

export interface Lease extends DBLease {
  units?: { suite: string; sf: number; properties?: { name: string; address: string; city: string; state: string } }
  lease_amendments?: Array<{ id: string; effective_date: string; description: string }>
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
