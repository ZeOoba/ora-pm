import { useQuery } from '@tanstack/react-query'
import { portalApi } from '../lib/portal-api'
import { formatCurrency } from '../../lib/format'
import type { Lease } from '../lib/portal-api'

interface LeaseRow extends Lease {
  base_rent_monthly: number
  cam_estimate_monthly: number
  rent_type: string
  lease_amendments: Array<{ id: string; effective_date: string; description: string }>
}

export function PortalMyLease() {
  const { data, isLoading } = useQuery({ queryKey: ['portal-lease'], queryFn: portalApi.getLease })
  const leases = (data?.data ?? []) as LeaseRow[]

  if (isLoading) return <div className="p-6 text-gray-500">Loading…</div>
  if (leases.length === 0) return <div className="p-6 text-gray-500">No active lease found.</div>

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <h1 className="text-2xl font-serif" style={{ color: '#1B2A4A' }}>My Lease</h1>
      {leases.map(lease => (
        <div key={lease.id} className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
          {lease.units && (
            <div>
              <h2 className="font-semibold text-gray-900">{lease.units.properties?.name}</h2>
              <p className="text-sm text-gray-500">
                {lease.units.properties?.address}, {lease.units.properties?.city}, {lease.units.properties?.state}
              </p>
              <p className="text-sm text-gray-500">Suite {lease.units.suite} · {lease.units.sf.toLocaleString()} SF</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-500">Lease term</span>
              <br />
              <span className="font-medium">{lease.start_date} – {lease.end_date}</span>
            </div>
            <div>
              <span className="text-gray-500">Base rent</span>
              <br />
              <span className="font-medium">{formatCurrency(lease.base_rent_monthly ?? lease.monthly_rent)}/mo</span>
            </div>
            {lease.cam_estimate_monthly != null && (
              <div>
                <span className="text-gray-500">CAM estimate</span>
                <br />
                <span className="font-medium">{formatCurrency(lease.cam_estimate_monthly)}/mo</span>
              </div>
            )}
            {lease.rent_type && (
              <div>
                <span className="text-gray-500">Lease type</span>
                <br />
                <span className="font-medium uppercase">{lease.rent_type}</span>
              </div>
            )}
          </div>
          {lease.lease_amendments?.length > 0 && (
            <div>
              <p className="text-sm font-medium text-gray-700 mb-2">Amendments</p>
              {lease.lease_amendments.map(a => (
                <div key={a.id} className="text-xs text-gray-600 border-l-2 border-gray-200 pl-3 mb-1">
                  <span className="font-medium">{a.effective_date}</span> — {a.description}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
