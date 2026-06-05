import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { formatCurrency, formatSF, formatPSF } from '../../lib/format'
import { StatusBadge } from '../../components/StatusBadge'
import type { RentRollRow } from '../../types'

export function RentRoll() {
  const [propertyFilter, setPropertyFilter] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['rent-roll'],
    queryFn: () => api.get<{ data: RentRollRow[] }>('/reports/rent-roll').then(r => r.data),
  })

  const rows = (data ?? []).filter(r =>
    !propertyFilter || r.property_name.toLowerCase().includes(propertyFilter.toLowerCase())
  )

  const totalMonthly = rows.reduce((s, r) => s + (r.total_monthly ?? 0), 0)
  const occupied = rows.filter(r => r.lease_status === 'active').length

  return (
    <div>
      <PageHeader title="Rent Roll" />
      <div className="flex items-center gap-4 mb-4">
        <input
          type="text"
          placeholder="Filter by property…"
          value={propertyFilter}
          onChange={e => setPropertyFilter(e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm w-56"
        />
        <span className="text-sm text-gray-500">
          {occupied} occupied · {formatCurrency(totalMonthly)}/mo total
        </span>
      </div>
      {isLoading ? (
        <p className="text-gray-500">Loading…</p>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-auto">
          <table className="min-w-full text-sm divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                {['Property', 'Suite', 'SF', 'Tenant', 'Lease End', 'Base Rent', 'CAM', 'Total/mo', '$/SF/yr', 'Status'].map(h => (
                  <th key={h} className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map(r => (
                <tr key={r.unit_id} className="hover:bg-gray-50">
                  <td className="px-3 py-2 font-medium text-gray-900">{r.property_name}</td>
                  <td className="px-3 py-2">{r.suite}</td>
                  <td className="px-3 py-2 text-gray-600">{r.sf ? formatSF(r.sf) : '—'}</td>
                  <td className="px-3 py-2 text-gray-700">{r.tenant_name ?? <span className="text-gray-400 italic">Vacant</span>}</td>
                  <td className="px-3 py-2 text-gray-600">{r.end_date ?? '—'}</td>
                  <td className="px-3 py-2">{r.base_rent_monthly != null ? formatCurrency(r.base_rent_monthly) : '—'}</td>
                  <td className="px-3 py-2 text-gray-600">{r.cam_estimate_monthly != null ? formatCurrency(r.cam_estimate_monthly) : '—'}</td>
                  <td className="px-3 py-2 font-medium">{r.total_monthly != null ? formatCurrency(r.total_monthly) : '—'}</td>
                  <td className="px-3 py-2 text-gray-600">{r.rent_psf_annual != null ? formatPSF(r.rent_psf_annual) : '—'}</td>
                  <td className="px-3 py-2">
                    {r.lease_status ? <StatusBadge status={r.lease_status} /> : <StatusBadge status={r.unit_status} />}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={10} className="px-3 py-8 text-center text-gray-400">No data.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
