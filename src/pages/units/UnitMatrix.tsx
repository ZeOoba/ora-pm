import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { StatusBadge } from '../../components/StatusBadge'
import { formatSF } from '../../lib/format'
import type { Unit } from '../../types'

export function UnitMatrix({ propertyId }: { propertyId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['units', propertyId],
    queryFn: () =>
      api.get<{ data: Unit[] }>(`/units?property_id=${propertyId}`).then(r => r.data),
  })

  if (isLoading) return <p className="text-gray-500 text-sm">Loading units…</p>

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            {['Suite', 'Floor', 'SF', 'Status'].map(h => (
              <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {data?.length === 0 && (
            <tr>
              <td colSpan={4} className="px-4 py-6 text-center text-gray-400 text-sm">
                No units.
              </td>
            </tr>
          )}
          {data?.map(u => (
            <tr key={u.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 font-medium text-gray-900">{u.suite}</td>
              <td className="px-4 py-3 text-sm text-gray-500">{u.floor ?? '—'}</td>
              <td className="px-4 py-3 text-sm text-gray-600">{formatSF(u.sf)}</td>
              <td className="px-4 py-3"><StatusBadge status={u.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
