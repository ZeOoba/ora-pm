import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { formatSF } from '../../lib/format'
import type { Property } from '../../types'

export function PropertiesList() {
  const { data, isLoading } = useQuery({
    queryKey: ['properties'],
    queryFn: () => api.get<{ data: Property[] }>('/properties').then(r => r.data),
  })

  if (isLoading) return <p className="text-gray-500 p-4">Loading…</p>

  return (
    <div>
      <PageHeader title="Properties" />
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              {['Name', 'Address', 'Type', 'SF', 'Entity LLC'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {data?.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                  No properties yet.
                </td>
              </tr>
            )}
            {data?.map(p => (
              <tr key={p.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-blue-600">
                  <Link to={`/properties/${p.id}`}>{p.name}</Link>
                </td>
                <td className="px-4 py-3 text-sm text-gray-600">
                  {p.address}, {p.city}, {p.state}
                </td>
                <td className="px-4 py-3 text-sm capitalize text-gray-600">{p.property_type}</td>
                <td className="px-4 py-3 text-sm text-gray-600">{formatSF(p.total_sf)}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{p.entity_llc ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
