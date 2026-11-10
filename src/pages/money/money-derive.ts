// View derivations for Rent roll (grouped), Renewals (timeline + board) and Collections (work
// queue): prototype screens 3a–3c. Pure functions over the rent_roll view, the renewals list and
// the server-computed AR aging rows. They group, sum and position server figures; nothing here
// re-ages a balance or re-prices a lease.
import type { RenewalStatus, RentRollRow } from '../../types'
import { daysBetween, over30, pastDue, type ArAgingLeaseRow } from '../today/today-queue'

// ── Rent roll ────────────────────────────────────────────────────────────────────────────────

/** Term bars span this window around today; today sits at TERM_TODAY_PCT. */
export const TERM_WINDOW_YEARS = 10
export const TERM_TODAY_PCT = 40

export type RollKind = 'leased' | 'expiring' | 'vacant' | 'other'

export interface RollRow {
  row: RentRollRow
  kind: RollKind
  /** Suite SF as a share of the property's SF (excluding unavailable units). */
  sharePct: number
  abr: number | null
  /** Term bar position inside the window, 0–100 (clamped); null when the unit has no lease. */
  termLeftPct: number | null
  termWidthPct: number | null
}

export interface RollGroup {
  property_id: string
  property_name: string
  rows: RollRow[]
  sf: number
  leasedPct: number | null
  abr: number
  suites: number
}

function windowPct(today: string, date: string): number {
  const startOffsetDays = -(TERM_TODAY_PCT / 100) * TERM_WINDOW_YEARS * 365.25
  const span = TERM_WINDOW_YEARS * 365.25
  const pct = ((daysBetween(today, date) - startOffsetDays) / span) * 100
  return Math.min(100, Math.max(0, pct))
}

export function groupRentRoll(rr: RentRollRow[], today: string): RollGroup[] {
  const byProp = new Map<string, RentRollRow[]>()
  for (const r of rr) byProp.set(r.property_id, [...(byProp.get(r.property_id) ?? []), r])
  return [...byProp.values()].map((rows) => {
    const sf = rows.filter((r) => r.unit_status !== 'unavailable').reduce((s, r) => s + (r.sf ?? 0), 0)
    const leasedSf = rows.filter((r) => r.unit_status === 'occupied' || r.unit_status === 'notice').reduce((s, r) => s + (r.sf ?? 0), 0)
    const out = [...rows]
      .sort((a, b) => a.suite.localeCompare(b.suite, 'en-US', { numeric: true }))
      .map((r): RollRow => {
        const active = r.lease_status === 'active'
        const abr = active && r.base_rent_monthly != null ? r.base_rent_monthly * 12 : null
        const expiring = active && !!r.end_date && daysBetween(today, r.end_date) <= 365
        const kind: RollKind = !r.lease_id ? (r.unit_status === 'unavailable' ? 'other' : 'vacant') : expiring ? 'expiring' : active ? 'leased' : 'other'
        const left = r.start_date ? windowPct(today, r.start_date) : null
        const right = r.end_date ? windowPct(today, r.end_date) : null
        return {
          row: r,
          kind,
          sharePct: sf > 0 && r.unit_status !== 'unavailable' ? ((r.sf ?? 0) / sf) * 100 : 0,
          abr,
          termLeftPct: left,
          termWidthPct: left != null && right != null ? Math.max(0.5, right - left) : null,
        }
      })
    return {
      property_id: rows[0].property_id,
      property_name: rows[0].property_name,
      rows: out,
      sf,
      leasedPct: sf > 0 ? (leasedSf / sf) * 100 : null,
      abr: out.reduce((s, r) => s + (r.abr ?? 0), 0),
      suites: rows.length,
    }
  }).sort((a, b) => b.abr - a.abr)
}

// ── Renewals ─────────────────────────────────────────────────────────────────────────────────

export const TIMELINE_MONTHS = 18

export interface RenewalRecord {
  id: string
  lease_id: string
  status: RenewalStatus
  expiration_date: string
  target_decision_date: string | null
  leases?: { tenants?: { name: string }; units?: { suite: string; properties?: { name: string } } }
}

export interface Lane {
  lease_id: string
  tenant: string
  place: string
  end_date: string
  abr: number | null
  /** Expiry position on the timeline, 0–100. Holdovers sit at 0. */
  expiryPct: number
  /** Decision-window band (target_decision_date → expiry), when the renewal has a decision date. */
  bandLeftPct: number | null
  bandWidthPct: number | null
  renewal: RenewalRecord | null
}

/** First day of the month containing `today`, plus `n` months, as YYYY-MM-DD. */
function monthStart(today: string, n: number): string {
  const d = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1 + n, 1))
  return d.toISOString().slice(0, 10)
}

export function timelineMonths(today: string, n = TIMELINE_MONTHS): { label: string; year: boolean }[] {
  return Array.from({ length: n }, (_, i) => {
    const iso = monthStart(today, i)
    const d = new Date(`${iso}T00:00:00Z`)
    const m = d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })
    return { label: d.getUTCMonth() === 0 ? `${m} '${iso.slice(2, 4)}` : m, year: d.getUTCMonth() === 0 }
  })
}

/**
 * One lane per active lease ending before the end of the timeline (holdovers included), joined
 * to its renewal record by lease_id. Sorted by expiry.
 */
export function renewalLanes(rr: RentRollRow[], renewals: RenewalRecord[], today: string, n = TIMELINE_MONTHS): Lane[] {
  const start = monthStart(today, 0)
  const end = monthStart(today, n)
  const span = Math.max(1, daysBetween(start, end))
  const pos = (d: string) => Math.min(100, Math.max(0, (daysBetween(start, d) / span) * 100))
  const byLease = new Map(renewals.map((r) => [r.lease_id, r]))
  return rr
    .filter((r) => r.lease_id && r.lease_status === 'active' && r.end_date && r.end_date < end)
    .sort((a, b) => (a.end_date as string).localeCompare(b.end_date as string))
    .map((r) => {
      const renewal = byLease.get(r.lease_id as string) ?? null
      const expiryPct = pos(r.end_date as string)
      const decision = renewal?.target_decision_date ?? null
      const bandLeft = decision && decision < (r.end_date as string) ? pos(decision) : null
      return {
        lease_id: r.lease_id as string,
        tenant: r.tenant_name ?? '—',
        place: `${r.property_name} · Ste ${r.suite} · ${(r.sf ?? 0).toLocaleString('en-US')} SF`,
        end_date: r.end_date as string,
        abr: r.base_rent_monthly != null ? r.base_rent_monthly * 12 : null,
        expiryPct,
        bandLeftPct: bandLeft,
        bandWidthPct: bandLeft != null ? Math.max(0.5, expiryPct - bandLeft) : null,
        renewal,
      }
    })
}

export type BoardStage = 'untracked' | RenewalStatus

export const BOARD_STAGES: { key: BoardStage; label: string }[] = [
  { key: 'untracked', label: 'Not tracked' },
  { key: 'tracking', label: 'Tracking' },
  { key: 'proposal_sent', label: 'Proposal sent' },
  { key: 'negotiating', label: 'Negotiating' },
  { key: 'executed', label: 'Executed' },
  { key: 'declined', label: 'Declined' },
]

export interface BoardCard {
  key: string
  lease_id: string
  tenant: string
  place: string
  expires: string
  abr: number | null
  renewal: RenewalRecord | null
}

/**
 * Stage board: every renewal record in its status column, plus a "Not tracked" column for
 * timeline leases that have no renewal record yet. ABR comes from the rent roll by lease_id.
 */
export function renewalBoard(lanes: Lane[], renewals: RenewalRecord[], rr: RentRollRow[]): { key: BoardStage; label: string; cards: BoardCard[]; abr: number }[] {
  const abrByLease = new Map(rr.filter((r) => r.lease_id && r.base_rent_monthly != null).map((r) => [r.lease_id as string, (r.base_rent_monthly as number) * 12]))
  const cards: (BoardCard & { stage: BoardStage })[] = [
    ...renewals.map((r) => ({
      key: r.id,
      stage: r.status as BoardStage,
      lease_id: r.lease_id,
      tenant: r.leases?.tenants?.name ?? '—',
      place: `${r.leases?.units?.properties?.name ?? '—'} · Ste ${r.leases?.units?.suite ?? '—'}`,
      expires: r.expiration_date,
      abr: abrByLease.get(r.lease_id) ?? null,
      renewal: r,
    })),
    ...lanes.filter((l) => !l.renewal).map((l) => ({
      key: `lease:${l.lease_id}`,
      stage: 'untracked' as const,
      lease_id: l.lease_id,
      tenant: l.tenant,
      place: l.place,
      expires: l.end_date,
      abr: l.abr,
      renewal: null,
    })),
  ]
  return BOARD_STAGES.map((s) => {
    const col = cards.filter((c) => c.stage === s.key).sort((a, b) => a.expires.localeCompare(b.expires))
    return { ...s, cards: col, abr: col.reduce((sum, c) => sum + (c.abr ?? 0), 0) }
  })
}

// ── Collections ──────────────────────────────────────────────────────────────────────────────

export type CollectionsTab = 'over30' | 'pastDue' | 'promised' | 'disputed' | 'all'

export const COLLECTIONS_TABS: { key: CollectionsTab; label: string }[] = [
  { key: 'over30', label: 'Over 30 days' },
  { key: 'pastDue', label: 'Past due' },
  { key: 'promised', label: 'Promised' },
  { key: 'disputed', label: 'Disputed' },
  { key: 'all', label: 'All balances' },
]

/** Open promise / dispute per lease (B1 work log); see collections-records.ts. */
export type RecordsByLease = Map<string, { promise: { lapsed: boolean } | null; dispute: unknown | null }>

export function collectionsFilter(rows: ArAgingLeaseRow[], tab: CollectionsTab, records: RecordsByLease = new Map()): ArAgingLeaseRow[] {
  const keep: Record<CollectionsTab, (r: ArAgingLeaseRow) => boolean> = {
    all: () => true,
    pastDue: (r) => pastDue(r.buckets) > 0,
    over30: (r) => over30(r.buckets) > 0,
    promised: (r) => !!records.get(r.lease_id)?.promise,
    disputed: (r) => !!records.get(r.lease_id)?.dispute,
  }
  // A lapsed promise jumps the queue: it is the most concrete broken commitment on the list.
  const lapsed = (r: ArAgingLeaseRow) => (records.get(r.lease_id)?.promise?.lapsed ? 1 : 0)
  return rows.filter(keep[tab]).sort((a, b) =>
    lapsed(b) - lapsed(a) || over30(b.buckets) - over30(a.buckets) || pastDue(b.buckets) - pastDue(a.buckets) || b.balance - a.balance)
}

export function collectionsSummary(rows: ArAgingLeaseRow[]): { balance: number; over30: number; tenants: number; tenantsOver30: number } {
  const tenants = new Set<string>()
  const late = new Set<string>()
  let balance = 0
  let o30 = 0
  for (const r of rows) {
    balance += r.balance
    tenants.add(r.tenant_id)
    const o = over30(r.buckets)
    o30 += o
    if (o > 0) late.add(r.tenant_id)
  }
  return { balance, over30: o30, tenants: tenants.size, tenantsOver30: late.size }
}
