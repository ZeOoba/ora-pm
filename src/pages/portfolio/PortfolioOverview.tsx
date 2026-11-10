import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { QueryState } from '../../components/QueryState'
import { EmptyState } from '../../components/ui/EmptyState'
import { cn } from '../../lib/utils'
import type { RentRollRow } from '../../types'
import type { AgingTotals } from '../ar/ar-aging-view'
import { compactMoney, computeVitals, type ArAgingLeaseRow } from '../today/today-queue'
import { rentAtRiskByQuarter, summarizeProperties, walt } from './portfolio-derive'

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function longDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

const GRID = 'grid grid-cols-[minmax(0,1.6fr)_90px_minmax(0,1.2fr)_96px_100px_64px_140px] gap-4'

/** Owner's view: one row per property, then rent at risk by quarter (prototype screen 1c). */
export function PortfolioOverview() {
  const today = todayIso()
  const rentRoll = useQuery({
    queryKey: ['rent-roll', ''],
    queryFn: () => api.get<{ data: RentRollRow[] }>('/reports/rent-roll').then((r) => r.data),
  })
  const arAging = useQuery({
    queryKey: ['ar-aging', 'buckets', ''],
    queryFn: () => api.get<{ data: ArAgingLeaseRow[]; totals: AgingTotals }>('/reports/ar-aging'),
  })

  const rr = rentRoll.data ?? []
  const ar = arAging.data?.data ?? []
  const props = summarizeProperties(rr, ar, today)
  const vitals = computeVitals(rr, ar, today)
  const portfolioWalt = walt(rr, today)
  const quarters = rentAtRiskByQuarter(rr, today, 12)
  const maxQ = Math.max(1, ...quarters.map((q) => q.abr))
  const vacantSf = vitals.totalSf - vitals.leasedSf

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-1.5 border-b-[3px] border-double border-navy pb-4">
        <div className="flex flex-wrap justify-between gap-3 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
          <span>Portfolio overview</span>
          <span>{props.length} properties · {vitals.totalSf.toLocaleString('en-US')} SF</span>
          <span>{longDate(new Date())}</span>
        </div>
        <h1 className="text-center font-display text-5xl leading-none text-navy md:text-[68px]">The Portfolio</h1>
      </div>

      <QueryState query={[rentRoll, arAging]} isEmpty={() => rr.length === 0}
        empty={<EmptyState title="No units yet" message="Add a property and its units to see the portfolio." />}>
        <div className="grid grid-cols-1 border-b border-border sm:grid-cols-3">
          <Head label="Annualized base rent" value={compactMoney(vitals.abr)} sub="Active leases, base rent × 12" />
          <Head label="Leased, by SF" value={vitals.sfOccupancyPct == null ? '—' : `${vitals.sfOccupancyPct.toFixed(1)}%`}
            sub={`${vacantSf.toLocaleString('en-US')} SF vacant · occupied + notice SF, excluding unavailable units`} />
          <Head label="Weighted avg lease term" value={portfolioWalt == null ? '—' : `${portfolioWalt.toFixed(1)} yr`} sub="Remaining term, weighted by base rent" />
        </div>

        <div className="mt-6 overflow-x-auto">
          <div className={cn(GRID, 'min-w-[960px] border-b border-navy py-2 text-[11px] uppercase tracking-[0.08em] text-muted-foreground')}>
            <span>Property</span><span className="text-right">SF</span><span>Leased (SF)</span>
            <span className="text-right">ABR</span><span className="text-right">AR &gt;30</span><span className="text-right">WALT</span><span>Next roll</span>
          </div>
          {props.map((p) => (
            <Link key={p.property_id} to={`/properties/${p.property_id}`}
              className={cn(GRID, 'min-w-[960px] items-center border-b border-border py-3 text-sm hover:bg-muted')}>
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-display text-[19px] text-navy">{p.property_name}</span>
                <span className="text-xs text-muted-foreground">{p.suites} {p.suites === 1 ? 'suite' : 'suites'}</span>
              </div>
              <span className="text-right font-mono text-[13px]">{p.totalSf.toLocaleString('en-US')}</span>
              <Bar pct={p.occupancyPct} />
              <span className="text-right font-mono text-[13px]">{compactMoney(p.abr)}</span>
              <span className={cn('text-right font-mono text-[13px]', p.arOver30 > 0 ? 'text-status-danger' : 'text-muted-foreground')}>
                {compactMoney(p.arOver30)}
              </span>
              <span className="text-right font-mono text-[13px]">{p.walt == null ? '—' : p.walt.toFixed(1)}</span>
              <span className="text-xs">{p.nextRoll ?? '—'}</span>
            </Link>
          ))}
        </div>

        <section className="mt-7 flex flex-col gap-2.5" aria-label="Rent at risk by quarter">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <Link to="/renewals" className="font-display text-2xl text-navy hover:text-gold-600">Rent at risk: base rent expiring by quarter →</Link>
            <span className="text-xs text-muted-foreground">Gold = next 12 months · hollow = later · holdovers count in the current quarter</span>
          </div>
          <div role="img" aria-label={`Annual base rent expiring by quarter: ${quarters.map((q) => `${q.label} ${compactMoney(q.abr)}`).join(', ')}`}
            className="flex h-32 items-end gap-2 border-b border-navy">
            {quarters.map((q) => (
              <div key={q.label} className="flex h-full flex-1 flex-col justify-end gap-0.5">
                <span className="text-center font-mono text-[10px] text-muted-foreground">{q.abr > 0 ? compactMoney(q.abr) : ''}</span>
                <div className={cn(q.near ? 'bg-gold' : 'border border-chart-4')} style={{ height: `${(q.abr / maxQ) * 80}%` }} />
              </div>
            ))}
          </div>
          <div className="flex gap-2 font-mono text-[11px] text-muted-foreground">
            {quarters.map((q) => <span key={q.label} className="flex-1 text-center">{q.label}</span>)}
          </div>
        </section>
      </QueryState>
    </div>
  )
}

function Head({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="flex flex-col gap-1.5 border-border py-5 sm:border-r sm:px-6 sm:first:pl-0 sm:last:border-r-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-display text-5xl leading-none text-navy">{value}</span>
      <span className="text-[13px] text-muted-foreground">{sub}</span>
    </div>
  )
}

function Bar({ pct }: { pct: number | null }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 bg-muted"><div className="h-full bg-navy" style={{ width: `${pct ?? 0}%` }} /></div>
      <span className="w-11 text-right font-mono text-xs">{pct == null ? '—' : `${Math.round(pct)}%`}</span>
    </div>
  )
}
