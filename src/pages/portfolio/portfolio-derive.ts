// View derivations for Portfolio Overview and the Property stacking plan (Claude Design "ORA PM"
// prototype, screens 1c and 2a). Pure functions over the rent_roll view and the server-computed
// AR aging rows. Nothing here re-prices a lease or re-ages a balance: it groups, sums and buckets
// server figures.
import type { RentRollRow } from '../../types'
import { daysBetween, over30, pastDue, type ArAgingLeaseRow } from '../today/today-queue'

const YEAR_DAYS = 365.25

function isLeased(r: RentRollRow): boolean {
  return r.unit_status === 'occupied' || r.unit_status === 'notice'
}

function annualBase(r: RentRollRow): number {
  return r.lease_status === 'active' && r.base_rent_monthly != null ? r.base_rent_monthly * 12 : 0
}

/**
 * ABR-weighted average remaining lease term, in years, over active leases with an end date.
 * Holdovers (end date passed) count as 0 remaining. null when no lease carries ABR.
 */
export function walt(rows: RentRollRow[], today: string): number | null {
  let w = 0
  let total = 0
  for (const r of rows) {
    const abr = annualBase(r)
    if (abr <= 0 || !r.end_date) continue
    w += abr * Math.max(0, daysBetween(today, r.end_date)) / YEAR_DAYS
    total += abr
  }
  return total > 0 ? w / total : null
}

export interface PropertySummary {
  property_id: string
  property_name: string
  totalSf: number
  leasedSf: number
  occupancyPct: number | null
  abr: number
  arBalance: number
  arOver30: number
  walt: number | null
  /** Earliest active lease end on or after today: "Ste 104 · Mar 2027". */
  nextRoll: string | null
  suites: number
}

function monthYear(iso: string): string {
  const [y, m] = iso.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

export function summarizeProperties(rr: RentRollRow[], ar: ArAgingLeaseRow[], today: string): PropertySummary[] {
  const byProp = new Map<string, RentRollRow[]>()
  for (const r of rr) {
    const list = byProp.get(r.property_id) ?? []
    list.push(r)
    byProp.set(r.property_id, list)
  }
  const arByProp = new Map<string, { bal: number; o30: number }>()
  for (const a of ar) {
    const pid = a.property_id
    const cur = arByProp.get(pid) ?? { bal: 0, o30: 0 }
    cur.bal += a.balance
    cur.o30 += over30(a.buckets)
    arByProp.set(pid, cur)
  }
  return [...byProp.entries()].map(([pid, rows]) => {
    let totalSf = 0
    let leasedSf = 0
    let abr = 0
    let next: RentRollRow | null = null
    for (const r of rows) {
      if (r.unit_status !== 'unavailable') totalSf += r.sf ?? 0
      if (isLeased(r)) leasedSf += r.sf ?? 0
      abr += annualBase(r)
      if (r.lease_status === 'active' && r.end_date && r.end_date >= today && (!next || r.end_date < (next.end_date as string))) next = r
    }
    const a = arByProp.get(pid)
    return {
      property_id: pid,
      property_name: rows[0].property_name,
      totalSf,
      leasedSf,
      occupancyPct: totalSf > 0 ? (leasedSf / totalSf) * 100 : null,
      abr,
      arBalance: a?.bal ?? 0,
      arOver30: a?.o30 ?? 0,
      walt: walt(rows, today),
      nextRoll: next ? `Ste ${next.suite} · ${monthYear(next.end_date as string)}` : null,
      suites: rows.length,
    }
  }).sort((x, y) => y.abr - x.abr)
}

export interface QuarterBucket {
  /** "Q1 '27" */
  label: string
  abr: number
  leases: number
  /** Quarter starts within the next 12 months. */
  near: boolean
}

/**
 * Annual base rent of active leases expiring in each of the next `n` calendar quarters, starting
 * with the quarter containing today. Leases already past their end date (holdovers) land in the
 * first quarter: that rent is at risk now.
 */
export function rentAtRiskByQuarter(rr: RentRollRow[], today: string, n = 12): QuarterBucket[] {
  const y0 = +today.slice(0, 4)
  const q0 = Math.floor((+today.slice(5, 7) - 1) / 3)
  const buckets: QuarterBucket[] = Array.from({ length: n }, (_, i) => {
    const q = q0 + i
    const year = y0 + Math.floor(q / 4)
    return { label: `Q${(q % 4) + 1} '${String(year).slice(2)}`, abr: 0, leases: 0, near: i < 4 }
  })
  for (const r of rr) {
    const abr = annualBase(r)
    if (abr <= 0 || !r.end_date) continue
    const idx = Math.max(0, (+r.end_date.slice(0, 4) - y0) * 4 + Math.floor((+r.end_date.slice(5, 7) - 1) / 3) - q0)
    if (idx >= n) continue
    buckets[idx].abr += abr
    buckets[idx].leases += 1
  }
  return buckets
}

export type SuiteState = 'leased' | 'expiring' | 'delinquent' | 'vacant' | 'unavailable'

export interface StackSuite {
  unit_id: string
  suite: string
  sf: number
  state: SuiteState
  tenant: string
  detail: string
  tenant_id: string | null
  lease_id: string | null
}

/**
 * Stacking-plan blocks for one property, in suite order. Precedence: delinquent (any past-due
 * balance) > expiring within 12 months > leased; vacant and unavailable from unit status.
 */
export function stackingPlan(rr: RentRollRow[], ar: ArAgingLeaseRow[], today: string): StackSuite[] {
  const late = new Map(ar.map((a) => [a.lease_id, pastDue(a.buckets)]))
  return [...rr]
    .sort((a, b) => a.suite.localeCompare(b.suite, 'en-US', { numeric: true }))
    .map((r) => {
      const base = { unit_id: r.unit_id, suite: r.suite, sf: r.sf ?? 0, tenant_id: r.tenant_id, lease_id: r.lease_id }
      if (r.unit_status === 'unavailable') return { ...base, state: 'unavailable' as const, tenant: 'Unavailable', detail: '' }
      if (!r.lease_id || r.unit_status === 'vacant') return { ...base, state: 'vacant' as const, tenant: 'Vacant', detail: '' }
      const owed = late.get(r.lease_id) ?? 0
      const days = r.end_date ? daysBetween(today, r.end_date) : null
      const thru = r.end_date ? `thru ${monthYear(r.end_date)}` : 'no end date'
      if (owed > 0) {
        return { ...base, state: 'delinquent' as const, tenant: r.tenant_name ?? '—',
          detail: `${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(owed)} past due · ${thru}` }
      }
      if (days != null && days <= 365) return { ...base, state: 'expiring' as const, tenant: r.tenant_name ?? '—', detail: thru }
      return { ...base, state: 'leased' as const, tenant: r.tenant_name ?? '—', detail: thru }
    })
}
