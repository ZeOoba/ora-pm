import { useState } from 'react'
import { Link } from 'react-router'
import { cn } from '../../lib/utils'
import { formatDate } from '../../lib/format'
import { compactMoney } from '../today/today-queue'
import type { RentRollRow } from '../../types'
import { TERM_TODAY_PCT, groupRentRoll, type RollKind } from './money-derive'

const GRID = 'grid grid-cols-[56px_minmax(0,1.5fr)_84px_130px_70px_96px_90px_160px] gap-3.5'

const SHARE_CLASS: Record<RollKind, string> = { leased: 'bg-navy', expiring: 'bg-gold', vacant: 'bg-border', other: 'bg-chart-4' }
const TERM_CLASS: Record<RollKind, string> = { leased: 'bg-chart-3', expiring: 'bg-gold', vacant: 'bg-transparent', other: 'bg-chart-4' }

function psf(v: number | null): string {
  return v == null ? '—' : `$${v.toFixed(2)}`
}

/**
 * Rent roll grouped by property with subtotals (prototype screen 3b): share-of-property bar and a
 * term bar on a fixed 10-year window with today as the red rule. Groups collapse.
 */
export function RentRollGrouped({ rows, today }: { rows: RentRollRow[]; today: string }) {
  const groups = groupRentRoll(rows, today)
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const toggle = (id: string) => setClosed((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    return n
  })
  const totalSf = groups.reduce((s, g) => s + g.sf, 0)
  const leasedSf = groups.reduce((s, g) => s + (g.leasedPct ?? 0) / 100 * g.sf, 0)
  const totalAbr = groups.reduce((s, g) => s + g.abr, 0)
  const suites = groups.reduce((s, g) => s + g.suites, 0)

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <div className="min-w-[1040px]">
        <div className={cn(GRID, 'bg-muted px-4 py-2 text-[11px] uppercase tracking-[0.08em] text-muted-foreground')}>
          <span>Suite</span><span>Tenant</span><span className="text-right">SF</span><span>Share of property</span>
          <span className="text-right">$/SF</span><span className="text-right">ABR</span><span>Type</span><span>Term</span>
        </div>
        {groups.map((g) => {
          const isClosed = closed.has(g.property_id)
          return (
            <div key={g.property_id}>
              <button type="button" onClick={() => toggle(g.property_id)} aria-expanded={!isClosed}
                className="flex w-full items-baseline justify-between gap-3.5 border-t border-navy bg-background px-4 py-3 text-left">
                <span className="flex items-baseline gap-3">
                  <span className="font-display text-xl text-navy">{isClosed ? '▸' : '▾'} {g.property_name}</span>
                  <span className="text-xs text-muted-foreground">{g.suites} {g.suites === 1 ? 'suite' : 'suites'}</span>
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {g.sf.toLocaleString('en-US')} SF · {g.leasedPct == null ? '—' : `${g.leasedPct.toFixed(1)}%`} · {compactMoney(g.abr)} ABR
                </span>
              </button>
              {!isClosed && g.rows.map(({ row: r, kind, sharePct, abr, termLeftPct, termWidthPct }) => (
                <div key={r.unit_id} className={cn(GRID, 'items-center border-t border-border/60 px-4 py-2 text-[13px]', kind === 'vacant' && 'text-muted-foreground')}>
                  <span className="font-mono">{r.suite}</span>
                  <span className="truncate">
                    {r.lease_id ? (
                      <Link to={`/leases/${r.lease_id}`} className="text-navy underline-offset-2 hover:underline">{r.tenant_name ?? '—'}</Link>
                    ) : <span className="capitalize">{r.unit_status}</span>}
                  </span>
                  <span className="text-right font-mono">{(r.sf ?? 0).toLocaleString('en-US')}</span>
                  <div className="h-2 bg-muted"><div className={cn('h-full', SHARE_CLASS[kind])} style={{ width: `${sharePct}%` }} /></div>
                  <span className="text-right font-mono">{psf(r.rent_psf_annual)}</span>
                  <span className="text-right font-mono">{abr == null ? '—' : compactMoney(abr)}</span>
                  <span className="text-xs uppercase">{r.rent_type ?? '—'}</span>
                  <div className="relative h-3.5" title={r.lease_id ? `${formatDate(r.start_date)} → ${formatDate(r.end_date)}` : undefined}
                    aria-label={r.lease_id ? `Term ${formatDate(r.start_date)} to ${formatDate(r.end_date)}` : undefined}>
                    <div className="absolute inset-x-0 top-[5px] h-1 bg-muted" />
                    {termLeftPct != null && termWidthPct != null && (
                      <div className={cn('absolute top-[5px] h-1', TERM_CLASS[kind])} style={{ left: `${termLeftPct}%`, width: `${termWidthPct}%` }} />
                    )}
                    <div className="absolute top-0 h-3.5 w-px bg-status-danger" style={{ left: `${TERM_TODAY_PCT}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )
        })}
        <div className={cn(GRID, 'border-t-[3px] border-double border-navy px-4 py-3 text-[13px] font-semibold')}>
          <span />
          <span>Portfolio total · {suites} suites</span>
          <span className="text-right font-mono">{totalSf.toLocaleString('en-US')}</span>
          <span className="text-xs font-normal text-muted-foreground">{totalSf > 0 ? `${((leasedSf / totalSf) * 100).toFixed(1)}% leased` : '—'}</span>
          <span />
          <span className="text-right font-mono">{compactMoney(totalAbr)}</span>
          <span />
          <span className="text-xs font-normal text-muted-foreground">10-yr window · red rule = today</span>
        </div>
      </div>
    </div>
  )
}
