// Today: the operator's work queue, ranked by what is at stake (Claude Design "ORA PM" prototype,
// screen 1a). Pure derivation over three existing read endpoints — no new server math:
//   - GET /reports/ar-aging       (server-computed oldest-first aging buckets per lease)
//   - GET /reports/rent-roll      (rent_roll view)
//   - GET /reports/critical-dates (critical_dates view)
// Every dollar figure shown is a server-computed amount passed through, or a sum of them. The
// client never re-ages a balance or re-prices a lease.
import type { CriticalDateRow, RentRollRow } from '../../types'
import type { AgingBuckets } from '../ar/ar-aging-view'

export type QueueKind = 'Collect' | 'Renew' | 'Comply'
export const QUEUE_KINDS: QueueKind[] = ['Collect', 'Renew', 'Comply']

export interface QueueItem {
  /** Stable key (kind + record id) — React key and per-browser snooze key. */
  key: string
  kind: QueueKind
  title: string
  context: string
  /** Dollars at stake: past-due balance (Collect) or annual base rent (Renew). null = none. */
  amount: number | null
  /** Shown after the amount ('/yr' for Renew). */
  amountSuffix?: string
  due: string
  /** Overdue, or due within a week (Comply) / 30 days (Renew), or >30 days past due (Collect). */
  urgent: boolean
  action: string
  to: string
}

export interface ArAgingLeaseRow {
  lease_id: string
  tenant_id: string
  tenant_name: string
  property_id: string
  property_name: string
  suite: string
  balance: number
  buckets: Omit<AgingBuckets, 'unallocated'> & { unallocated?: number }
}

/** Renewals enter the queue this many days before expiry. */
export const RENEW_HORIZON_DAYS = 180
/** COIs enter the queue this many days before expiry. */
export const COMPLY_HORIZON_DAYS = 30

const DAY_MS = 86_400_000

/** Whole days from `fromIso` to `toIso` (date-only, UTC — same clock as the server views). */
export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10))
  const b = Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10))
  return Math.round((b - a) / DAY_MS)
}

export function dueLabel(days: number): string {
  if (days < -1) return `${-days} days ago`
  if (days === -1) return 'Yesterday'
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  return `in ${days} days`
}

/** Past-due part of a lease balance: everything outside the `current` bucket. */
export function pastDue(b: ArAgingLeaseRow['buckets']): number {
  return b.d1_30 + b.d31_60 + b.d61_90 + b.d90_plus
}

/** Over-30 part of a lease balance (31–60 + 61–90 + 90+). */
export function over30(b: ArAgingLeaseRow['buckets']): number {
  return b.d31_60 + b.d61_90 + b.d90_plus
}

/** Oldest non-empty bucket as a label. */
export function oldestBucketLabel(b: ArAgingLeaseRow['buckets']): string {
  if (b.d90_plus > 0) return '90+ days'
  if (b.d61_90 > 0) return '61–90 days'
  if (b.d31_60 > 0) return '31–60 days'
  if (b.d1_30 > 0) return '1–30 days'
  return 'current'
}

function usd(v: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v)
}

function collectItems(ar: ArAgingLeaseRow[]): QueueItem[] {
  return ar
    .filter((r) => pastDue(r.buckets) > 0)
    .map((r) => {
      const oldest = oldestBucketLabel(r.buckets)
      return {
        key: `collect:${r.lease_id}`,
        kind: 'Collect' as const,
        title: `${r.tenant_name}: ${oldest} past due`,
        context: `${r.property_name} · Suite ${r.suite} · total balance ${usd(r.balance)}`,
        amount: pastDue(r.buckets),
        due: oldest,
        urgent: over30(r.buckets) > 0,
        action: 'Open ledger',
        to: `/tenants/${r.tenant_id}`,
      }
    })
}

function renewItems(rr: RentRollRow[], today: string): QueueItem[] {
  return rr
    .filter((r) => r.lease_id && r.end_date && r.lease_status === 'active')
    .map((r) => ({ r, days: daysBetween(today, r.end_date as string) }))
    .filter(({ days }) => days <= RENEW_HORIZON_DAYS)
    .map(({ r, days }) => ({
      key: `renew:${r.lease_id}`,
      kind: 'Renew' as const,
      title: days < 0 ? `${r.tenant_name}: lease ended, holding over` : `${r.tenant_name}: lease expires ${dueLabel(days)}`,
      context: `${r.property_name} · Suite ${r.suite} · ${r.sf.toLocaleString('en-US')} SF`,
      amount: r.base_rent_monthly != null ? r.base_rent_monthly * 12 : null,
      amountSuffix: '/yr',
      due: dueLabel(days),
      urgent: days <= 30,
      action: 'Open lease',
      to: `/leases/${r.lease_id}`,
    }))
}

function complyItems(dates: CriticalDateRow[]): QueueItem[] {
  return dates
    .filter((d) => d.date_type === 'insurance_expiry' && d.days_until <= COMPLY_HORIZON_DAYS)
    .map((d) => ({
      key: `comply:${d.reference_id}`,
      kind: 'Comply' as const,
      title: d.days_until < 0 ? `COI expired: ${d.tenant_name}` : `COI expires: ${d.tenant_name}`,
      context: 'Certificate of insurance on file is ending',
      amount: null,
      due: dueLabel(d.days_until),
      urgent: d.days_until <= 7,
      action: 'Request COI',
      to: '/insurance',
    }))
}

/**
 * The whole queue, ranked: urgent items first, then by dollars at stake (largest first); items
 * with no dollar figure sort last within their urgency band.
 */
export function buildQueue(input: { ar: ArAgingLeaseRow[]; rentRoll: RentRollRow[]; dates: CriticalDateRow[]; today: string }): QueueItem[] {
  const all = [...collectItems(input.ar), ...renewItems(input.rentRoll, input.today), ...complyItems(input.dates)]
  return all.sort((a, b) => {
    if (a.urgent !== b.urgent) return a.urgent ? -1 : 1
    return (b.amount ?? -1) - (a.amount ?? -1)
  })
}

/** Headline figure: past-due dollars across the Collect items in the queue. */
export function pastDueAtStake(items: QueueItem[]): number {
  return items.filter((i) => i.kind === 'Collect').reduce((s, i) => s + (i.amount ?? 0), 0)
}

export interface Vitals {
  /** Leased SF ÷ (leased + vacant SF). 'notice' counts as leased; 'unavailable' is excluded. */
  sfOccupancyPct: number | null
  leasedSf: number
  totalSf: number
  /** Annualized base rent of active leases (base_rent_monthly × 12). */
  abr: number
  /** Share of ABR whose lease ends within 365 days. */
  abrExpiring12Pct: number | null
  abrExpiring12: number
  leasesExpiring12: number
  /** AR over 30 days (31–60 + 61–90 + 90+), server buckets. */
  arOver30: number
  tenantsOver30: number
}

export function computeVitals(rr: RentRollRow[], ar: ArAgingLeaseRow[], today: string): Vitals {
  let leasedSf = 0
  let totalSf = 0
  let abr = 0
  let abrExpiring12 = 0
  let leasesExpiring12 = 0
  for (const r of rr) {
    if (r.unit_status === 'unavailable') continue
    totalSf += r.sf ?? 0
    if (r.unit_status === 'occupied' || r.unit_status === 'notice') leasedSf += r.sf ?? 0
    if (r.lease_status === 'active' && r.base_rent_monthly != null) {
      const annual = r.base_rent_monthly * 12
      abr += annual
      if (r.end_date && daysBetween(today, r.end_date) <= 365) {
        abrExpiring12 += annual
        leasesExpiring12 += 1
      }
    }
  }
  const tenants = new Set<string>()
  let arOver30 = 0
  for (const r of ar) {
    const o = over30(r.buckets)
    arOver30 += o
    if (o > 0) tenants.add(r.tenant_id)
  }
  return {
    sfOccupancyPct: totalSf > 0 ? (leasedSf / totalSf) * 100 : null,
    leasedSf,
    totalSf,
    abr,
    abrExpiring12Pct: abr > 0 ? (abrExpiring12 / abr) * 100 : null,
    abrExpiring12,
    leasesExpiring12,
    arOver30,
    tenantsOver30: tenants.size,
  }
}

/** Compact money for headlines and tiles: $9,410 · $38.4k · $412k · $5.74M. */
export function compactMoney(v: number): string {
  const a = Math.abs(v)
  const sign = v < 0 ? '−' : ''
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(2)}M`
  if (a >= 100_000) return `${sign}$${Math.round(a / 1000)}k`
  if (a >= 10_000) return `${sign}$${(a / 1000).toFixed(1)}k`
  return `${sign}${usd(a).replace(/\.\d\d$/, '')}`
}

const SNOOZE_KEY = 'ora-pm.today.snoozed'

/** Per-browser snooze (convenience only; shared snooze/assignment is backend epic B2). */
export function readSnoozed(): Set<string> {
  try {
    const raw = localStorage.getItem(SNOOZE_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

export function writeSnoozed(s: Set<string>): void {
  try {
    localStorage.setItem(SNOOZE_KEY, JSON.stringify([...s]))
  } catch {
    /* storage unavailable: snooze lasts for this page view only */
  }
}
