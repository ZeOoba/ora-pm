import { useState } from 'react'
import { Link } from 'react-router'
import { cn } from '../../lib/utils'
import { formatCurrency } from '../../lib/format'
import { downloadCsv, toCsv } from '../../components/data-table/csv'
import { csvFilename } from '../../components/data-table/csv'
import { oldestBucketLabel, over30, type ArAgingLeaseRow } from '../today/today-queue'
import { COLLECTIONS_TABS, collectionsFilter, type CollectionsTab } from './money-derive'

const GRID = 'grid grid-cols-[28px_minmax(0,1.4fr)_110px_150px_minmax(0,1fr)_110px] gap-3.5'

const SEGS: { key: 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus'; label: string; cls: string }[] = [
  { key: 'd1_30', label: '1–30', cls: 'bg-chart-4' },
  { key: 'd31_60', label: '31–60', cls: 'bg-gold' },
  { key: 'd61_90', label: '61–90', cls: 'bg-status-warning' },
  { key: 'd90_plus', label: '90+', cls: 'bg-status-danger' },
]

function statusOf(r: ArAgingLeaseRow): { label: string; tone: string } {
  const b = r.buckets
  if (b.d90_plus > 0) return { label: '90+ DAYS', tone: 'text-status-danger' }
  if (b.d61_90 > 0) return { label: '61–90 DAYS', tone: 'text-status-warning' }
  if (b.d31_60 > 0) return { label: '31–60 DAYS', tone: 'text-status-warning' }
  if (b.d1_30 > 0) return { label: '1–30 DAYS', tone: 'text-gold-600' }
  return { label: 'CURRENT', tone: 'text-muted-foreground' }
}

/**
 * Collections as a work queue (prototype screen 3a): tabs, risk-first order (most over 30 days),
 * per-lease aging bars, and multi-select with a batch bar. Batch actions are limited to what the
 * app can do today (CSV of the selection, statements); reminders, late fees and demand letters
 * arrive with backend epics B1/B9/B11.
 */
export function CollectionsQueue({ rows }: { rows: ArAgingLeaseRow[] }) {
  const [tab, setTab] = useState<CollectionsTab>('over30')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const shown = collectionsFilter(rows, tab)
  const selected = rows.filter((r) => sel.has(r.lease_id))
  const toggle = (id: string) => setSel((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    return n
  })
  const allShownSelected = shown.length > 0 && shown.every((r) => sel.has(r.lease_id))
  const toggleAll = () => setSel(allShownSelected ? new Set() : new Set(shown.map((r) => r.lease_id)))

  function exportSelected() {
    const csv = toCsv(selected, [
      { header: 'Tenant', accessor: (r) => r.tenant_name },
      { header: 'Property', accessor: (r) => r.property_name },
      { header: 'Suite', accessor: (r) => r.suite },
      { header: 'Balance', accessor: (r) => r.balance },
      { header: 'Current', accessor: (r) => r.buckets.current },
      { header: '1-30', accessor: (r) => r.buckets.d1_30 },
      { header: '31-60', accessor: (r) => r.buckets.d31_60 },
      { header: '61-90', accessor: (r) => r.buckets.d61_90 },
      { header: '90+', accessor: (r) => r.buckets.d90_plus },
    ])
    downloadCsv(csvFilename('collections'), csv)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        {COLLECTIONS_TABS.map((t) => {
          const n = collectionsFilter(rows, t.key).length
          return (
            <button key={t.key} type="button" aria-pressed={tab === t.key} onClick={() => setTab(t.key)}
              className={cn('rounded-full border px-3 py-1', tab === t.key ? 'border-navy bg-navy text-white' : 'border-border bg-card text-navy hover:bg-muted')}>
              {t.label} · {n}
            </button>
          )
        })}
        <span className="ml-auto text-muted-foreground">Sorted by amount over 30 days</span>
      </div>

      {selected.length > 0 && (
        <div role="region" aria-label="Batch actions" className="flex flex-wrap items-center gap-3 rounded-xl bg-navy px-4 py-2.5 text-[13px] text-white">
          <span className="font-semibold">{selected.length} {selected.length === 1 ? 'lease' : 'leases'} selected · {formatCurrency(selected.reduce((s, r) => s + r.balance, 0))}</span>
          <button type="button" onClick={exportSelected} className="rounded-md border border-chart-3 px-2.5 py-1 hover:bg-navy-700">Export selected (CSV)</button>
          <Link to="/statements" className="rounded-md bg-gold px-2.5 py-1 font-semibold text-navy hover:opacity-90">Run statements →</Link>
          <span className="text-xs text-chart-4">Reminders, late fees and demand letters: not yet available</span>
          <button type="button" onClick={() => setSel(new Set())} className="ml-auto text-chart-4 hover:text-white">Clear</button>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <div className={cn(GRID, 'min-w-[820px] items-center bg-muted px-4 py-2 text-[11px] uppercase tracking-[0.08em] text-muted-foreground')}>
          <Check on={allShownSelected} onClick={toggleAll} label="Select all shown" />
          <span>Tenant</span><span className="text-right">Balance</span><span>Aging</span><span>Oldest past due</span><span />
        </div>
        {shown.length === 0 && <p className="px-4 py-8 text-center text-sm text-muted-foreground">Nothing in this view.</p>}
        {shown.map((r) => {
          const on = sel.has(r.lease_id)
          const s = statusOf(r)
          const segs = SEGS.filter((x) => r.buckets[x.key] > 0)
          return (
            <div key={r.lease_id} className={cn(GRID, 'min-w-[820px] items-center border-t border-border/60 px-4 py-3', on ? 'bg-gold/10' : 'bg-card')}>
              <Check on={on} onClick={() => toggle(r.lease_id)} label={`Select ${r.tenant_name}`} />
              <Link to={`/tenants/${r.tenant_id}`} className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-semibold text-navy">{r.tenant_name}</span>
                <span className="truncate text-xs text-muted-foreground">{r.property_name} · Ste {r.suite}</span>
              </Link>
              <span className="text-right font-mono text-sm">{formatCurrency(r.balance)}</span>
              <div role="img" aria-label={`Past due by bucket: ${segs.map((x) => `${x.label} days ${formatCurrency(r.buckets[x.key])}`).join(', ') || 'none'}`}
                className="flex h-2.5 gap-px bg-muted">
                {segs.map((x) => <div key={x.key} className={x.cls} style={{ flex: r.buckets[x.key] }} />)}
              </div>
              <div className="flex min-w-0 flex-col">
                <span className={cn('font-mono text-[11px]', s.tone)}>{s.label}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {over30(r.buckets) > 0 ? `${formatCurrency(over30(r.buckets))} over 30 days` : oldestBucketLabel(r.buckets) === 'current' ? 'Not yet due' : 'Under 30 days'}
                </span>
              </div>
              <Link to={`/tenants/${r.tenant_id}`} className="rounded-md border border-navy py-1.5 text-center text-xs text-navy hover:bg-muted">Open ledger</Link>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Check({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} aria-label={label} onClick={onClick}
      className={cn('flex size-[18px] items-center justify-center rounded border text-[11px] text-white', on ? 'border-navy bg-navy' : 'border-chart-4 bg-card')}>
      {on ? '✓' : ''}
    </button>
  )
}
