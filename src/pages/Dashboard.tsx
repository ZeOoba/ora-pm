import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { PageHeader } from '../components/PageHeader'
import { StatusBadge } from '../components/StatusBadge'
import { formatCurrency, formatDate } from '../lib/format'
import type { RentRollRow, CriticalDateRow, ARLedgerRow } from '../types'

export function Dashboard() {
  const rentRoll  = useQuery({
    queryKey: ['rent-roll'],
    queryFn: () => api.get<{ data: RentRollRow[] }>('/reports/rent-roll').then(r => r.data),
  })
  const critDates = useQuery({
    queryKey: ['critical-dates'],
    queryFn: () => api.get<{ data: CriticalDateRow[] }>('/reports/critical-dates').then(r => r.data),
  })
  const arAging = useQuery({
    queryKey: ['ar-aging'],
    queryFn: () => api.get<{ data: ARLedgerRow[] }>('/reports/ar-aging').then(r => r.data),
  })

  // Derived stats
  const units       = rentRoll.data ?? []
  const occupied    = units.filter(u => u.unit_status === 'occupied').length
  const totalUnits  = units.length
  const occupancyPct = totalUnits > 0 ? Math.round((occupied / totalUnits) * 100) : 0
  const totalRentRoll = units.reduce((s, u) => s + (u.total_monthly ?? 0), 0)
  const totalAR       = (arAging.data ?? []).reduce((s, r) => s + r.balance, 0)
  const urgentDates   = (critDates.data ?? []).filter(
    d => d.urgency === 'urgent' || d.urgency === 'overdue'
  )

  const isLoading = rentRoll.isLoading || critDates.isLoading || arAging.isLoading

  if (isLoading) return <p className="text-gray-500 p-4">Loading portfolio…</p>

  return (
    <div>
      <PageHeader title="Portfolio Overview" />

      {/* KPI strip */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        {[
          {
            label: 'Occupancy',
            value: `${occupancyPct}%`,
            sub: `${occupied} of ${totalUnits} units`,
            warn: false,
          },
          {
            label: 'Monthly Rent Roll',
            value: formatCurrency(totalRentRoll),
            sub: 'Active leases',
            warn: false,
          },
          {
            label: 'Outstanding AR',
            value: formatCurrency(totalAR),
            sub: 'Unpaid charges',
            warn: totalAR > 0,
          },
          {
            label: 'Critical Dates',
            value: String(urgentDates.length),
            sub: 'Urgent or overdue',
            warn: urgentDates.length > 0,
          },
        ].map(({ label, value, sub, warn }) => (
          <div
            key={label}
            className={`rounded-lg border p-4 ${warn ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-white'}`}
          >
            <p className="text-xs text-gray-500 uppercase tracking-wider">{label}</p>
            <p className={`text-2xl font-bold mt-1 ${warn ? 'text-red-700' : 'text-gray-900'}`}>{value}</p>
            <p className="text-xs text-gray-400 mt-0.5">{sub}</p>
          </div>
        ))}
      </div>

      {/* Urgent critical dates */}
      {urgentDates.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">
              Action Required
            </h2>
            <Link to="/critical-dates" className="text-sm text-blue-600 hover:underline">
              View all →
            </Link>
          </div>
          <div className="space-y-2">
            {urgentDates.slice(0, 5).map(d => (
              <div
                key={`${d.date_type}-${d.reference_id}`}
                className={`flex items-center justify-between p-3 rounded-lg border ${
                  d.urgency === 'overdue'
                    ? 'border-red-300 bg-red-50'
                    : 'border-orange-300 bg-orange-50'
                }`}
              >
                <div>
                  <p className="font-medium text-gray-900 text-sm">{d.tenant_name}</p>
                  <p className="text-xs text-gray-500">
                    {d.date_type.replace(/_/g, ' ')}
                    {d.property_name ? ` · ${d.property_name}` : ''}
                    {d.suite ? ` · ${d.suite}` : ''}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium text-gray-900">{formatDate(d.critical_date)}</p>
                  <div className="mt-1"><StatusBadge status={d.urgency} /></div>
                </div>
              </div>
            ))}
            {urgentDates.length > 5 && (
              <Link to="/critical-dates" className="text-sm text-blue-600 hover:underline block text-center py-1">
                +{urgentDates.length - 5} more critical dates
              </Link>
            )}
          </div>
        </div>
      )}

      {/* Empty state when everything is healthy */}
      {urgentDates.length === 0 && totalAR === 0 && (
        <div className="text-center py-12 text-gray-400">
          <p className="text-lg">✓ Portfolio is healthy</p>
          <p className="text-sm mt-1">No urgent dates or outstanding AR.</p>
        </div>
      )}
    </div>
  )
}
