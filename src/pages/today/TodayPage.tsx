import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { QueryState } from '../../components/QueryState'
import { formatCurrency, formatDate } from '../../lib/format'
import { resolvePreset } from '../../lib/date-range'
import { cn } from '../../lib/utils'
import type { CriticalDateRow, RentRollRow } from '../../types'
import type { AgingTotals } from '../ar/ar-aging-view'
import type { FinancialsResponse } from '../../lib/report-types'
import {
  QUEUE_KINDS,
  buildQueue,
  compactMoney,
  computeVitals,
  dueLabel,
  pastDueAtStake,
  readSnoozed,
  writeSnoozed,
  type ArAgingLeaseRow,
  type QueueItem,
  type QueueKind,
} from './today-queue'
import { indexByLease, useOpenCollectionsRecords } from '../money/collections-records'

const KIND_TONE: Record<QueueKind, string> = {
  Collect: 'text-status-danger',
  Renew: 'text-gold-600',
  Comply: 'text-status-warning',
}

type Tab = 'All' | QueueKind

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function longDate(d: Date): string {
  const weekday = d.toLocaleDateString('en-US', { weekday: 'long' })
  const rest = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  return `${weekday} · ${rest}`
}

function pct(v: number | null, digits = 1): string {
  return v == null ? '—' : `${v.toFixed(digits)}%`
}

export function TodayPage() {
  const today = todayIso()
  const mtd = resolvePreset('mtd', new Date())

  const rentRoll = useQuery({
    queryKey: ['rent-roll', ''],
    queryFn: () => api.get<{ data: RentRollRow[] }>('/reports/rent-roll').then((r) => r.data),
  })
  const arAging = useQuery({
    queryKey: ['ar-aging', 'buckets', ''],
    queryFn: () => api.get<{ data: ArAgingLeaseRow[]; totals: AgingTotals }>('/reports/ar-aging'),
  })
  const critDates = useQuery({
    queryKey: ['critical-dates'],
    queryFn: () => api.get<{ data: CriticalDateRow[] }>('/reports/critical-dates').then((r) => r.data),
  })
  const financials = useQuery({
    queryKey: ['financials', `from=${mtd.from}&to=${mtd.to}`],
    queryFn: () => api.get<FinancialsResponse>(`/reports/financials?from=${mtd.from}&to=${mtd.to}`),
  })

  const [tab, setTab] = useState<Tab>('All')
  const [snoozed, setSnoozed] = useState<Set<string>>(readSnoozed)

  // B1 promises/disputes annotate Collect items. Not part of the blocking QueryState: a failed
  // work-log read degrades to plain balances rather than hiding the queue.
  const { promises, disputes } = useOpenCollectionsRecords()
  const queue = useMemo(
    () => buildQueue({
      ar: arAging.data?.data ?? [], rentRoll: rentRoll.data ?? [], dates: critDates.data ?? [], today,
      records: indexByLease(promises.data, disputes.data),
    }),
    [arAging.data, rentRoll.data, critDates.data, today, promises.data, disputes.data],
  )
  const live = queue.filter((q) => !snoozed.has(q.key))
  const shown = live.filter((q) => tab === 'All' || q.kind === tab)
  const vitals = computeVitals(rentRoll.data ?? [], arAging.data?.data ?? [], today)
  const atStake = pastDueAtStake(live)

  // Collected MTD: receipts ÷ billed (incl. billed deposits, since receipts can't be split by
  // charge type until payment application exists — same definition the old Dashboard used).
  const periodIS = financials.data?.income_statement.period
  const billed = periodIS ? periodIS.total_income + periodIS.excluded.security_deposits : 0
  const received = financials.data?.cash_flow.period.total_cash_in ?? 0
  const collectedPct = billed > 0 ? (received / billed) * 100 : null

  function snooze(key: string) {
    const next = new Set(snoozed)
    next.add(key)
    setSnoozed(next)
    writeSnoozed(next)
  }
  function unsnooze() {
    const next = new Set<string>()
    setSnoozed(next)
    writeSnoozed(next)
  }

  const upcoming = (critDates.data ?? []).filter((d) => d.days_until >= 0).slice(0, 5)
  const totals = arAging.data?.totals

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-xs uppercase tracking-[0.1em] text-gold-600">{longDate(new Date())}</span>
          <h1 className="font-display text-3xl leading-tight text-navy text-pretty md:text-[42px]">
            {live.length === 1 ? '1 thing needs you.' : `${live.length} things need you.`}{' '}
            {atStake > 0 && (
              <>
                <span className="text-gold-600">{formatCurrency(atStake).replace(/\.\d\d$/, '')}</span> is past due.
              </>
            )}
          </h1>
        </div>
        <div className="flex gap-2">
          <Link to="/payments" className="rounded-lg border border-border bg-card px-3.5 py-2 text-sm text-navy hover:bg-muted">
            Record payment
          </Link>
          <Link to="/leases/new" className="rounded-lg bg-primary px-3.5 py-2 text-sm text-primary-foreground hover:bg-navy-700">
            + New lease
          </Link>
        </div>
      </div>

      <QueryState query={[rentRoll, arAging, critDates, financials]}>
        <div className="grid grid-cols-2 gap-x-4 border-y border-b-border border-t-navy sm:grid-cols-[repeat(auto-fit,minmax(180px,1fr))] sm:gap-x-0">
          <Vital to="/ar" label="Collected, month to date" value={pct(collectedPct)} tone="neutral"
            sub={`${compactMoney(received)} of ${compactMoney(billed)} billed (incl. deposits)`} />
          <Vital to="/rent-roll" label="Leased, by SF" value={pct(vitals.sfOccupancyPct)} tone="neutral"
            sub={`${vitals.leasedSf.toLocaleString('en-US')} of ${vitals.totalSf.toLocaleString('en-US')} SF · occupied + notice SF, excluding unavailable units`} />
          <Vital to="/rent-roll" label="Annualized base rent" value={compactMoney(vitals.abr)} tone="neutral" sub="Active leases, base rent × 12" />
          <Vital to="/ar" label="AR over 30 days" value={compactMoney(vitals.arOver30)} tone={vitals.arOver30 > 0 ? 'danger' : 'neutral'}
            sub={vitals.tenantsOver30 === 1 ? '1 tenant' : `${vitals.tenantsOver30} tenants`} />
          <Vital to="/renewals" label="ABR expiring, 12 months" value={pct(vitals.abrExpiring12Pct)} tone="neutral"
            sub={`${compactMoney(vitals.abrExpiring12)} · ${vitals.leasesExpiring12} ${vitals.leasesExpiring12 === 1 ? 'lease' : 'leases'}`} />
        </div>

        <div className="mt-7 flex flex-wrap items-start gap-8">
          <section aria-label="Work queue" className="flex min-w-0 flex-[999_1_520px] flex-col gap-3.5">
            <div role="tablist" aria-label="Filter queue" className="flex flex-wrap gap-1.5">
              {(['All', ...QUEUE_KINDS] as Tab[]).map((t) => {
                const n = t === 'All' ? live.length : live.filter((q) => q.kind === t).length
                const on = tab === t
                return (
                  <button key={t} type="button" role="tab" aria-selected={on} onClick={() => setTab(t)}
                    className={cn('rounded-full border px-3.5 py-1.5 text-[13px]',
                      on ? 'border-navy bg-navy text-white' : 'border-border bg-card text-navy hover:bg-muted')}>
                    {t} <span className="font-mono text-[11px] opacity-75">{n}</span>
                  </button>
                )
              })}
            </div>
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {shown.map((q) => <QueueRow key={q.key} item={q} onSnooze={() => snooze(q.key)} />)}
              {shown.length === 0 && (
                <div className="p-7 text-center text-sm text-muted-foreground">
                  Nothing left in this queue.
                  {snoozed.size > 0 && (
                    <> <button type="button" onClick={unsnooze} className="underline">Restore {snoozed.size} snoozed</button></>
                  )}
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Collect = balances past due (server aging buckets). Renew = active leases ending within 180 days, at annual base rent.
              Comply = COIs ending within 30 days. Snooze is saved in this browser only.
            </p>
          </section>

          <aside className="flex min-w-0 flex-[1_1_300px] flex-col gap-5">
            {totals && (
              <Link to="/ar" className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4.5 hover:border-gold">
                <div className="flex items-baseline justify-between">
                  <span className="font-display text-xl text-navy">Receivables</span>
                  <span className="font-mono text-sm">{formatCurrency(totals.balance)}</span>
                </div>
                <AgingBar totals={totals} />
              </Link>
            )}
            <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4.5">
              <div className="flex items-baseline justify-between">
                <span className="font-display text-xl text-navy">Coming up</span>
                <Link to="/critical-dates" className="text-xs text-muted-foreground hover:text-navy">All dates →</Link>
              </div>
              {upcoming.length === 0 && <span className="text-sm text-muted-foreground">No lease or COI dates in the next 90 days.</span>}
              {upcoming.map((d) => (
                <div key={`${d.date_type}-${d.reference_id}`} className="grid grid-cols-[52px_1fr] items-center gap-3">
                  <div className="flex flex-col items-center rounded-md border border-border py-1">
                    <span className="text-[10px] uppercase text-muted-foreground">{formatDate(d.critical_date).slice(0, 3)}</span>
                    <span className="font-display text-xl leading-none">{Number(d.critical_date.slice(8, 10))}</span>
                  </div>
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-[13px] font-semibold">
                      {d.date_type === 'lease_expiration' ? 'Lease expires' : 'COI expires'}: {d.tenant_name}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {[d.property_name, d.suite && `Suite ${d.suite}`, dueLabel(d.days_until)].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </aside>
        </div>
      </QueryState>
    </div>
  )
}

function Vital({ to, label, value, sub, tone }: { to: string; label: string; value: string; sub: string; tone: 'neutral' | 'danger' }) {
  return (
    <Link to={to} className="flex min-w-0 flex-col gap-1.5 py-3 hover:bg-muted/40 sm:mr-4.5 sm:border-r sm:border-border sm:py-4 sm:pr-4.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('font-display text-[28px] leading-none sm:text-[34px]', tone === 'danger' ? 'text-status-danger' : 'text-navy')}>{value}</span>
      <span className="text-xs text-muted-foreground">{sub}</span>
    </Link>
  )
}

function QueueRow({ item: q, onSnooze }: { item: QueueItem; onSnooze: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-b border-border/60 px-4.5 py-3.5 last:border-b-0">
      <span className={cn('w-[70px] shrink-0 font-mono text-[10px] uppercase tracking-[0.1em]', KIND_TONE[q.kind])}>{q.kind}</span>
      <Link to={q.to} className="flex min-w-0 flex-[1_1_240px] flex-col gap-0.5">
        <span className="text-sm font-semibold text-navy">{q.title}</span>
        <span className="text-xs text-muted-foreground">{q.context}</span>
      </Link>
      <div className="ml-auto flex items-center gap-3.5">
        <span className="whitespace-nowrap text-right font-mono text-sm">
          {q.amount == null ? '—' : `${formatCurrency(q.amount)}${q.amountSuffix ?? ''}`}
        </span>
        <span className={cn('min-w-16 whitespace-nowrap text-right text-xs', q.urgent ? 'text-status-danger' : 'text-muted-foreground')}>{q.due}</span>
        <div className="flex gap-1.5">
          <Link to={q.to} className="whitespace-nowrap rounded-md bg-primary px-2.5 py-1.5 text-xs text-primary-foreground hover:bg-navy-700">{q.action}</Link>
          <button type="button" onClick={onSnooze} className="rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted">
            Snooze
          </button>
        </div>
      </div>
    </div>
  )
}

const AGING_SEGMENTS: { key: keyof AgingTotals; label: string; cls: string }[] = [
  { key: 'current', label: 'Current', cls: 'bg-chart-4' },
  { key: 'd1_30', label: '1–30', cls: 'bg-chart-3' },
  { key: 'd31_60', label: '31–60', cls: 'bg-gold' },
  { key: 'd61_90', label: '61–90', cls: 'bg-status-warning' },
  { key: 'd90_plus', label: '90+', cls: 'bg-status-danger' },
]

function AgingBar({ totals }: { totals: AgingTotals }) {
  const segs = AGING_SEGMENTS.filter((s) => totals[s.key] > 0)
  const summary = segs.map((s) => `${s.label} ${formatCurrency(totals[s.key])}`).join(', ')
  return (
    <div className="flex flex-col gap-1.5">
      <div role="img" aria-label={`AR aging: ${summary || 'no open balance'}`} className="flex h-3 overflow-hidden rounded-sm bg-muted">
        {segs.map((s) => <div key={s.key} className={s.cls} style={{ flex: totals[s.key] }} />)}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
        {segs.map((s) => <span key={s.key}>{s.label} · {compactMoney(totals[s.key])}</span>)}
      </div>
    </div>
  )
}
