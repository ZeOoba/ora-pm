import { useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { UnitMatrix } from './UnitMatrix'
import type { Property } from '../../types'

export function UnitsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const propertyId = searchParams.get('property_id') ?? ''

  const { data: properties } = useQuery({
    queryKey: ['properties'],
    queryFn: () => api.get<{ data: Property[] }>('/properties').then(r => r.data),
  })

  return (
    <div>
      <PageHeader title="Unit Matrix" />
      <div className="mb-4">
        <select
          value={propertyId}
          onChange={e => setSearchParams(e.target.value ? { property_id: e.target.value } : {})}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm w-72"
        >
          <option value="">— Select a property —</option>
          {properties?.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      {propertyId ? (
        <UnitMatrix propertyId={propertyId} />
      ) : (
        <p className="text-gray-400 text-sm">Select a property above to view its unit matrix.</p>
      )}
    </div>
  )
}
