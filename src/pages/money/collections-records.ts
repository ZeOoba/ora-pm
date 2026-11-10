// Client side of the B1 collections workflow (server/routes/collections.ts): promises to pay and
// AR disputes. Work-log records only — they move no money and change no balance.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'

export type PromiseStatus = 'open' | 'kept' | 'broken' | 'cancelled'
export type DisputeStatus = 'open' | 'resolved' | 'withdrawn'

interface LeaseContext {
  id: string
  tenant_id: string
  tenants?: { name: string } | null
  units?: { suite: string; properties?: { name: string } | null } | null
}

export interface PromiseRecord {
  id: string
  lease_id: string
  amount: number
  promised_date: string
  status: PromiseStatus
  notes: string | null
  created_by: string | null
  created_at: string
  resolved_at: string | null
  /** Open and the promised date has passed (server-derived). */
  lapsed: boolean
  leases?: LeaseContext
}

export interface DisputeRecord {
  id: string
  lease_id: string
  amount: number | null
  reason: string
  status: DisputeStatus
  resolution: string | null
  created_by: string | null
  created_at: string
  resolved_at: string | null
  leases?: LeaseContext
}

export const COLLECTIONS_KEY = ['collections'] as const

/** Open promises and disputes, optionally narrowed to one tenant. */
export function useOpenCollectionsRecords(tenantId?: string) {
  const qs = tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}` : ''
  const promises = useQuery({
    queryKey: ['collections', 'promises', tenantId ?? ''],
    queryFn: () => api.get<{ data: PromiseRecord[] }>(`/collections/promises${qs}`).then((r) => r.data),
  })
  const disputes = useQuery({
    queryKey: ['collections', 'disputes', tenantId ?? ''],
    queryFn: () => api.get<{ data: DisputeRecord[] }>(`/collections/disputes${qs}`).then((r) => r.data),
  })
  return { promises, disputes }
}

export interface LeaseCollectionsState {
  promise: PromiseRecord | null
  dispute: DisputeRecord | null
}

/**
 * Per-lease view of open records. When a lease has several open promises, the earliest-dated one
 * is the one that matters (it lapses first); likewise the oldest open dispute.
 */
export function indexByLease(promises: PromiseRecord[] = [], disputes: DisputeRecord[] = []): Map<string, LeaseCollectionsState> {
  const out = new Map<string, LeaseCollectionsState>()
  const get = (id: string) => out.get(id) ?? { promise: null, dispute: null }
  for (const p of [...promises].filter((x) => x.status === 'open').sort((a, b) => a.promised_date.localeCompare(b.promised_date))) {
    const s = get(p.lease_id)
    if (!s.promise) out.set(p.lease_id, { ...s, promise: p })
  }
  for (const d of [...disputes].filter((x) => x.status === 'open').sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const s = get(d.lease_id)
    if (!s.dispute) out.set(d.lease_id, { ...s, dispute: d })
  }
  return out
}

export function useResolveRecord(kind: 'promises' | 'disputes') {
  const qc = useQueryClient()
  return useMutation<unknown, Error, { id: string; body: Record<string, unknown> }>({
    mutationFn: ({ id, body }) => api.put(`/collections/${kind}/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: COLLECTIONS_KEY }),
  })
}
