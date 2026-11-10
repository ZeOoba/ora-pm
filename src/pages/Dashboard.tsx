import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '../lib/api'
import { PageHeader } from '../components/PageHeader'
import { StatusBadge } from '../components/StatusBadge'
import { KpiStat } from '../components/ui/KpiStat'
import { EmptyState } from '../components/ui/EmptyState'
import { QueryState } from '../components/QueryState'
import { ReportFilters } from '../components/ReportFilters'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { formatCurrency, formatDate } from '../lib/format'
import { useReportFilters, reportQuery } from '../lib/report-filters'
import { Gauge } from '../components/charts/Gauge'
import { AgingChart } from '../components/charts/AgingChart'
import { OccupancyDonut } from '../components/charts/OccupancyDonut'
import { ExpiryLadderChart } from '../components/charts/ExpiryLadderChart'
import { expiryLadder, expiryLadderExcluded, occupancySplit } from '../components/charts/derive'
import type { AgingTotals } from './ar/ar-aging-view'
import type { RentRollRow, CriticalDateRow } from '../types'
import type { CashActivityResponse, CashActivityRow, FinancialsResponse } from '../lib/report-types'

const RECENT_ROWS = 10

export function Dashboard() {
  const filters = useReportFilters()
  const { propertyId, range } = filters
  const qs = reportQuery(filters)
  const propertyParam = propertyId ? `?property_id=${encodeURIComponent(propertyId)}` : ''

  const rentRoll  = useQuery({
    queryKey: ['rent-roll', propertyId],
    queryFn: () => api.get<{ data: RentRollRow[] }>(`/reports/rent-roll${propertyParam}`).then(r => r.data),
  })
  const critDates = useQuery({
    queryKey: ['critical-dates'],
    queryFn: () => api.get<{ data: CriticalDateRow[] }>('/reports/critical-dates').then(r => r.data),
  })
  // Same key prefix + response shape as the AR page: invalidateQueries(['ar-aging']) prefix-matches it.
  const arAging = useQuery({
    queryKey: ['ar-aging', 'buckets', propertyId],
    queryFn: () => api.get<{ data: unknown[]; totals: AgingTotals }>(`/reports/ar-aging${propertyParam}`),
  })
  const financials = useQuery({
    queryKey: ['financials', qs],
    queryFn: () => api.get<FinancialsResponse>(`/reports/financials?${qs}`),
  })
  const activity = useQuery({
    queryKey: ['cash-activity', qs],
    queryFn: () => api.get<CashActivityResponse>(`/reports/cash-activity?${qs}`),
  })

  // Derived stats (display only; every money figure is server-computed)
  const units        = rentRoll.data ?? []
  const occupied     = units.filter(u => u.unit_status === 'occupied').length
  const totalUnits   = units.length
  const occupancyPct = totalUnits > 0 ? Math.round((occupied / totalUnits) * 100) : 0
  const arTotals     = arAging.data?.totals
  const totalAR      = arTotals?.balance ?? 0
  const split        = occupancySplit(units)
  const thisYear     = new Date().getFullYear()
  const ladder       = expiryLadder(units, thisYear)
  const ladderExcluded = expiryLadderExcluded(units, thisYear)
  // critical_dates carries property_name only; scope it by the selected property's name.
  const selectedName = propertyId ? units[0]?.property_name : undefined
  const urgentDates  = (critDates.data ?? []).filter(
    d => (d.urgency === 'urgent' || d.urgency === 'overdue') && (!propertyId || d.property_name === selectedName)
  )
  const totals       = activity.data?.totals
  // Receipts can't be split by charge type (no payment application yet), so the denominator must
  // include billed security deposits too, or a deposit receipt reads as >100% collected.
  const periodIS     = financials.data?.income_statement.period
  const billed       = periodIS ? periodIS.total_income + periodIS.excluded.security_deposits : 0
  const received     = financials.data?.cash_flow.period.total_cash_in ?? 0
  const collectedPct = billed > 0 ? Math.round((received / billed) * 100) : 0
  const asOf         = formatDate(range.to)
  const rows         = activity.data?.data ?? []
  const recentIn     = rows.filter(r => r.kind === 'cash_in').slice(0, RECENT_ROWS)
  const recentOut    = rows.filter(r => r.kind === 'cash_out').slice(0, RECENT_ROWS)
  const seeMore      = (kind: string) => `/transactions?${new URLSearchParams([...new URLSearchParams(filters.search), ['type', kind]])}`

  // Any failed first read shows the error banner instead of KPIs: a failed AR, rent-roll or cash
  // query used to render as $0 / 0%, indistinguishable from a healthy portfolio.
  return (
    <div>
      <PageHeader title="Dashboard" subtitle={range.label} />
      <ReportFilters filters={filters} />
      <QueryState query={[rentRoll, critDates, arAging, financials, activity]}>

      {/* Money tiles (AppFolio-style colored rule) */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiStat accent="positive" label="Cash In" value={formatCurrency(totals?.cash_in)}
          sub={totals && totals.pending_ach > 0 ? `${formatCurrency(totals.pending_ach)} ACH in flight not counted` : 'Payments received'} />
        <KpiStat accent="negative" label="Cash Out" value={formatCurrency(totals?.cash_out)} sub="Expenses recorded" />
        <KpiStat accent="navy" label="Net Cash Flow" value={formatCurrency(totals?.net)} sub="Cash in − cash out" />
        <KpiStat accent="warning" label="Outstanding AR" value={formatCurrency(totalAR)} sub="Unpaid charges, all dates" />
      </div>

      {/* Gauges */}
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Gauge
          title="Rent Collected"
          tone="positive"
          caption={billed > 0 ? `${collectedPct}% of billed (incl. deposits) collected as of ${asOf}` : `Nothing billed in this period as of ${asOf}`}
          value={received}
          max={billed}
          centerValue={formatCurrency(received)}
          centerLabel="Collected"
          minLabel="$0.00"
          maxLabel={formatCurrency(billed)}
          action={<Link to={`/reports/cash-flow?${filters.search}`} className="text-sm text-primary hover:underline">See more</Link>}
        />
        <Gauge
          title="% Occupied"
          caption={`${occupied} of ${totalUnits} units rented as of ${asOf} · occupied units ÷ all units`}
          value={occupied}
          max={totalUnits}
          centerValue={`${occupancyPct}%`}
          centerLabel="Occupied"
          minLabel="0"
          maxLabel="100%"
          action={<Link to="/units" className="text-sm text-primary hover:underline">See more</Link>}
        />
      </div>

      {/* Recent cash in / out */}
      <RecentActivity title="Cash In" rows={recentIn} seeMore={seeMore('cash_in')} empty="No cash received in this period." />
      <RecentActivity title="Cash Out" rows={recentOut} seeMore={seeMore('cash_out')} empty="No expenses recorded in this period." />

      {/* Portfolio charts (rent roll + AR aging; not date-filtered) */}
      <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <OccupancyDonut split={split} />
        <ExpiryLadderChart ladder={ladder} excluded={ladderExcluded} />
        {arTotals && <AgingChart totals={arTotals} className="" />}
      </div>

      {/* Urgent critical dates */}
      {urgentDates.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              Action Required
            </h2>
            <Link to="/critical-dates" className="text-sm text-primary hover:underline">
              View all →
            </Link>
          </div>
          <div className="space-y-2">
            {urgentDates.slice(0, 5).map(d => (
              <div
                key={`${d.date_type}-${d.reference_id}`}
                className={`flex items-center justify-between p-3 rounded-lg border ${
                  d.urgency === 'overdue'
                    ? 'border-status-danger/30 bg-status-danger/10'
                    : 'border-status-warning/30 bg-status-warning/10'
                }`}
              >
                <div>
                  <p className="font-medium text-foreground text-sm">{d.tenant_name}</p>
                  <p className="text-xs text-muted-foreground">
                    {d.date_type.replace(/_/g, ' ')}
                    {d.property_name ? ` · ${d.property_name}` : ''}
                    {d.suite ? ` · ${d.suite}` : ''}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium text-foreground">{formatDate(d.critical_date)}</p>
                  <div className="mt-1"><StatusBadge status={d.urgency} /></div>
                </div>
              </div>
            ))}
            {urgentDates.length > 5 && (
              <Link to="/critical-dates" className="text-sm text-primary hover:underline block text-center py-1">
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

function RecentActivity({ title, rows, seeMore, empty }: { title: string; rows: CashActivityRow[]; seeMore: string; empty: string }) {
  return (
    <section className="mb-6 rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="font-display text-base text-navy">{title}</h2>
        <Link to={seeMore} className="text-sm text-primary hover:underline">See more</Link>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="px-4 py-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Property</TableHead>
                <TableHead>Party</TableHead>
                <TableHead className="hidden md:table-cell">Description</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(r => (
                <TableRow key={r.id}>
                  <TableCell>{r.property_name ?? '—'}{r.suite ? ` - ${r.suite}` : ''}</TableCell>
                  <TableCell>{r.party}</TableCell>
                  <TableCell className="hidden max-w-md truncate md:table-cell">{r.description}</TableCell>
                  <TableCell className="text-right font-mono">{formatCurrency(Math.abs(r.amount))}</TableCell>
                  <TableCell className="text-right">{formatDate(r.date)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="py-2 text-xs italic text-muted-foreground">Showing the {rows.length} most recent transactions</p>
        </div>
      )}
    </section>
  )
}
