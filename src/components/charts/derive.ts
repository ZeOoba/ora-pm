// Pure derivations for the Home charts, computed from GET /api/reports/rent-roll rows.
// rent_roll (supabase/migrations/0004) is one row per unit LEFT JOINed to its single *active* lease,
// so `sf` is the unit's SF, `unit_status` is the unit's status and `end_date` is the active lease's
// end. The view does not expose a month-to-month / holdover flag.
import type { RentRollRow } from '../../types'

export interface OccupancySplit {
  occupiedSf: number
  vacantSf: number
  unavailableSf: number
  /** occupiedSf + vacantSf (unavailable units are in neither bucket). */
  totalSf: number
  occupiedPct: number
}

function sfOf(r: Pick<RentRollRow, 'sf'>): number {
  const n = Number(r.sf)
  return Number.isFinite(n) ? n : 0
}

// Each unit is counted once even if the view ever yields several rows for it.
function uniqueByUnit(rows: RentRollRow[]): RentRollRow[] {
  const seen = new Set<string>()
  const out: RentRollRow[] = []
  for (const r of rows) {
    if (seen.has(r.unit_id)) continue
    seen.add(r.unit_id)
    out.push(r)
  }
  return out
}

/** Occupied vs vacant SF. 'notice' units are still occupied; 'unavailable' units are excluded from both. */
export function occupancySplit(rows: RentRollRow[]): OccupancySplit {
  let occupiedSf = 0
  let vacantSf = 0
  let unavailableSf = 0
  for (const r of uniqueByUnit(rows)) {
    const sf = sfOf(r)
    if (r.unit_status === 'occupied' || r.unit_status === 'notice') occupiedSf += sf
    else if (r.unit_status === 'vacant') vacantSf += sf
    else unavailableSf += sf
  }
  const totalSf = occupiedSf + vacantSf
  return {
    occupiedSf,
    vacantSf,
    unavailableSf,
    totalSf,
    occupiedPct: totalSf > 0 ? Math.round((occupiedSf / totalSf) * 100) : 0,
  }
}

export interface ExpiryBucket {
  year: number
  sf: number
  leases: number
}

// 'YYYY-MM-DD' (or ISO timestamp) -> calendar year without constructing a Date (no timezone drift).
function yearOf(date: string | null): number | null {
  if (!date) return null
  const y = Number(date.slice(0, 4))
  return Number.isInteger(y) && y > 0 ? y : null
}

/** SF expiring per calendar year, `years` consecutive years starting at `fromYear`, zero-filled. */
export function expiryLadder(rows: RentRollRow[], fromYear: number, years = 6): ExpiryBucket[] {
  const buckets: ExpiryBucket[] = Array.from({ length: years }, (_, i) => ({ year: fromYear + i, sf: 0, leases: 0 }))
  for (const r of uniqueByUnit(rows)) {
    if (!r.lease_id) continue
    const y = yearOf(r.end_date)
    if (y === null) continue
    const b = buckets[y - fromYear]
    if (!b || y < fromYear) continue
    b.sf += sfOf(r)
    b.leases += 1
  }
  return buckets
}

export interface ExpiryExcluded {
  noEndDate: number
  /** Active leases whose end date is before the first ladder year (effectively holdover). */
  expiredBeforeWindow: number
  beyondWindow: number
}

/** Counts of active leases left out of the ladder, by reason. */
export function expiryLadderExcluded(rows: RentRollRow[], fromYear: number, years = 6): ExpiryExcluded {
  const out: ExpiryExcluded = { noEndDate: 0, expiredBeforeWindow: 0, beyondWindow: 0 }
  for (const r of uniqueByUnit(rows)) {
    if (!r.lease_id) continue
    const y = yearOf(r.end_date)
    if (y === null) out.noEndDate += 1
    else if (y < fromYear) out.expiredBeforeWindow += 1
    else if (y >= fromYear + years) out.beyondWindow += 1
  }
  return out
}
