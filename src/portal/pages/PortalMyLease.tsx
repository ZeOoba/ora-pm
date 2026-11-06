import { useQuery } from '@tanstack/react-query'
import { portalApi } from '../lib/portal-api'
import { formatCurrency } from '../../lib/format'
import type { Lease } from '../lib/portal-api'
import { Card } from '../../components/ui/Card'
import { QueryState } from '../../components/QueryState'

export function PortalMyLease() {
  const query = useQuery({ queryKey: ['portal-lease'], queryFn: portalApi.getLease })
  const leases = (query.data?.data ?? []) as Lease[]

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <h1 className="font-display text-2xl text-navy">My Lease</h1>
      <QueryState query={query}>
        {leases.length === 0 ? (
          <p className="text-status-neutral">No active lease found.</p>
        ) : (
          leases.map(lease => (
            <Card key={lease.id} className="p-6 space-y-4">
              {lease.units && (
                <div>
                  <h2 className="font-semibold text-navy">{lease.units.properties?.name}</h2>
                  <p className="text-sm text-status-neutral">
                    {lease.units.properties?.address}, {lease.units.properties?.city}, {lease.units.properties?.state}
                  </p>
                  <p className="text-sm text-status-neutral">Suite {lease.units.suite} · {lease.units.sf.toLocaleString()} SF</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-status-neutral">Lease term</span>
                  <br />
                  <span className="font-medium">{lease.start_date} – {lease.end_date}</span>
                </div>
                <div>
                  <span className="text-status-neutral">Base rent</span>
                  <br />
                  <span className="font-medium">{formatCurrency(lease.base_rent_monthly)}/mo</span>
                </div>
                {lease.cam_estimate_monthly != null && (
                  <div>
                    <span className="text-status-neutral">CAM estimate</span>
                    <br />
                    <span className="font-medium">{formatCurrency(lease.cam_estimate_monthly)}/mo</span>
                  </div>
                )}
                {lease.rent_type && (
                  <div>
                    <span className="text-status-neutral">Lease type</span>
                    <br />
                    <span className="font-medium uppercase">{lease.rent_type}</span>
                  </div>
                )}
              </div>
              {(lease.lease_amendments?.length ?? 0) > 0 && (
                <div>
                  <p className="text-sm font-medium text-navy mb-2">Amendments</p>
                  {lease.lease_amendments!.map(a => (
                    <div key={a.id} className="text-xs text-status-neutral border-l-2 border-border pl-3 mb-1">
                      <span className="font-medium">{a.effective_date}</span> — {a.description}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          ))
        )}
      </QueryState>
    </div>
  )
}
