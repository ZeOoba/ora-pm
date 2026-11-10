import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { QueryState } from '../../components/QueryState'
import { PortalHomeView } from '../../portal/components/PortalHomeView'
import type { Charge, Lease, Payment, PortalAging, TenantMe } from '../../portal/lib/portal-api'

interface PortalPreviewResponse {
  me: TenantMe
  charges: { data: Charge[] }
  payments: { data: Payment[] }
  lease: { data: Lease[] }
  aging: PortalAging
}

/**
 * Admin "View as tenant" (B13): the tenant's portal home rendered from
 * GET /api/tenants/:id/portal-preview, which returns the exact payloads the tenant's own portal
 * endpoints return (same server functions). Read-only; portal links are inert in preview.
 */
export function TenantPortalPreview() {
  const { id } = useParams<{ id: string }>()
  const query = useQuery({
    queryKey: ['tenant-portal-preview', id],
    queryFn: () => api.get<PortalPreviewResponse>(`/tenants/${id}/portal-preview`),
    enabled: !!id,
  })
  const d = query.data

  return (
    <div className="flex flex-col gap-6">
      <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-navy px-4 py-2.5 text-xs text-chart-4">
        <span>
          Previewing {d ? <strong className="text-white">{d.me.tenant.name}</strong> : 'this tenant'}'s portal home: the same data their portal shows them. Links are disabled.
        </span>
        <Link to={`/tenants/${id}`} className="text-gold hover:text-white">Exit tenant view ✕</Link>
      </div>
      <QueryState query={query}>
        {d && (
          <div className="mx-auto w-full max-w-6xl">
            <PortalHomeView preview data={{ me: d.me, charges: d.charges.data, payments: d.payments.data, leases: d.lease.data, aging: d.aging }} />
          </div>
        )}
      </QueryState>
    </div>
  )
}
