import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { StatusBadge } from '../../components/StatusBadge'
import { formatDate } from '../../lib/format'
import type { Renewal } from '../../types'

type RenewalRow = Renewal & {
  leases: {
    tenants: { name: string }
    units: { suite: string; properties: { name: string } }
  }
}

export function RenewalsPipeline() {
  const { data, isLoading } = useQuery({
    queryKey: ['renewals'],
    queryFn: () => api.get<{ data: RenewalRow[] }>('/renewals').then(r => r.data),
  })

  if (isLoading) return <p className="text-gray-500 p-4">Loading…</p>

  return (
    <div>
      <PageHeader title="Renewals" />
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {['Tenant', 'Property / Suite', 'Expiration', 'Status'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {data?.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">No renewals tracked.</td></tr>
            )}
            {data?.map(r => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium">{r.leases?.tenants?.name ?? '—'}</td>
                <td className="px-4 py-3 text-gray-500">
                  {r.leases?.units?.properties?.name} · {r.leases?.units?.suite}
                </td>
                <td className="px-4 py-3">{formatDate(r.expiration_date)}</td>
                <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
