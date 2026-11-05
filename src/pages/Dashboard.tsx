import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '../lib/api'
import { PageHeader } from '../components/PageHeader'
import { StatusBadge } from '../components/StatusBadge'
import { KpiStat } from '../components/ui/KpiStat'
import { EmptyState } from '../components/ui/EmptyState'
import { QueryState } from '../components/QueryState'
import { formatCurrency, formatDate } from '../lib/format'
import { AgingChart } from '../components/charts/AgingChart'
import { OccupancyDonut } from '../components/charts/OccupancyDonut'
import { ExpiryLadderChart } from '../components/charts/ExpiryLadderChart'
import { expiryLadder, occupancySplit } from '../components/charts/derive'
import type { AgingTotals } from './ar/ar-aging-view'
import type { RentRollRow, CriticalDateRow } from '../types'

export function Dashboard() {
  const rentRoll  = useQuery({
    queryKey: ['rent-roll'],
    queryFn: () => api.get<{ data: RentRollRow[] }>('/reports/rent-roll').then(r => r.data),
  })
  const critDates = useQuery({
    queryKey: ['critical-dates'],
    queryFn: () => api.get<{ data: CriticalDateRow[] }>('/reports/critical-dates').then(r => r.data),
  })
  // Same key + response shape as the AR page: the whole response (rows + server-computed totals).
  // invalidateQueries(['ar-aging']) elsewhere prefix-matches it.
  const arAging = useQuery({
    queryKey: ['ar-aging', 'buckets'],
    queryFn: () => api.get<{ data: unknown[]; totals: AgingTotals }>('/reports/ar-aging'),
  })

  // Derived stats
  const units       = rentRoll.data ?? []
  const occupied    = units.filter(u => u.unit_status === 'occupied').length
  const totalUnits  = units.length
  const occupancyPct = totalUnits > 0 ? Math.round((occupied / totalUnits) * 100) : 0
  const totalRentRoll = units.reduce((s, u) => s + (u.total_monthly ?? 0), 0)
  const arTotals      = arAging.data?.totals
  const totalAR       = arTotals?.balance ?? 0
  const split         = occupancySplit(units)
  const ladder        = expiryLadder(units, new Date().getFullYear())
  const urgentDates   = (critDates.data ?? []).filter(
    d => d.urgency === 'urgent' || d.urgency === 'overdue'
  )

  // Any failed read shows the error banner instead of KPIs: a failed AR or rent-roll query used to
  // render as $0 outstanding / 0% occupancy, indistinguishable from a healthy portfolio.
  return (
    <div>
      <PageHeader title="Portfolio Overview" />
      <QueryState query={[rentRoll, critDates, arAging]}>

      {/* KPI strip */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
        <KpiStat label="Occupancy" value={`${occupancyPct}%`} sub={`${occupied} of ${totalUnits} units`} />
        <KpiStat label="Monthly Rent Roll" value={formatCurrency(totalRentRoll)} sub="Active leases" />
        <KpiStat label="Outstanding AR" value={formatCurrency(totalAR)} sub="Unpaid charges" warn={totalAR > 0} />
        <KpiStat label="Critical Dates" value={urgentDates.length} sub="Urgent or overdue" warn={urgentDates.length > 0} />
      </div>

      {/* Charts: all derived from the already-fetched rent roll and AR aging responses (no extra endpoints) */}
      <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <OccupancyDonut split={split} />
        <ExpiryLadderChart ladder={ladder} />
        {arTotals && <AgingChart totals={arTotals} className="" />}
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
        <EmptyState title="Portfolio is healthy" message="No urgent dates or outstanding AR." />
      )}
      </QueryState>
    </div>
  )
}
