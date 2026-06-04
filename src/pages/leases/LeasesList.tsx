import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { StatusBadge } from '../../components/StatusBadge'
import { formatCurrency, formatDate } from '../../lib/format'
import type { Lease, Tenant, Unit, Property } from '../../types'

type LeaseRow = Lease & {
  tenants: Pick<Tenant, 'name'>
  units: Pick<Unit, 'suite' | 'sf'> & { properties: Pick<Property, 'name'> }
}

export function LeasesList() {
  const { data, isLoading } = useQuery({
    queryKey: ['leases', 'active'],
    queryFn: () => api.get<{ data: LeaseRow[] }>('/leases?status=active').then(r => r.data),
  })

  if (isLoading) return <p className="text-gray-500 p-4">Loading…</p>

  return (
    <div>
      <PageHeader
        title="Leases"
        action={
          <Link to="/leases/new" className="bg-blue-600 hover:bg-blue-700 text-white text-sm px-3 py-1.5 rounded">
            + Add Lease
          </Link>
        }
      />
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              {['Tenant', 'Property', 'Suite', 'End Date', 'Rent/mo', 'Status'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {data?.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No active leases.</td></tr>
            )}
            {data?.map(l => (
              <tr key={l.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-blue-600">
                  <Link to={`/leases/${l.id}`}>{l.tenants.name}</Link>
                </td>
                <td className="px-4 py-3 text-sm text-gray-600">{l.units.properties.name}</td>
                <td className="px-4 py-3 text-sm text-gray-600">{l.units.suite}</td>
                <td className="px-4 py-3 text-sm text-gray-600">{formatDate(l.end_date)}</td>
                <td className="px-4 py-3 text-sm font-medium">{formatCurrency(l.base_rent_monthly)}</td>
                <td className="px-4 py-3"><StatusBadge status={l.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
