import { describe, it, expect } from 'vitest'
import { occupancySplit, expiryLadder, expiryLadderExcluded, expiryExcludedNote } from '../../src/components/charts/derive'
import type { RentRollRow } from '../../src/types'

let n = 0
function row(over: Partial<RentRollRow>): RentRollRow {
  n += 1
  return {
    property_id: 'p1', property_name: 'Test Park', unit_id: `u${n}`, suite: `${n}`, sf: 1000,
    unit_status: 'occupied', tenant_id: null, tenant_name: null,
    lease_id: `l${n}`, start_date: '2024-01-01', end_date: '2027-06-30',
    lease_status: 'active', rent_type: 'nnn',
    base_rent_monthly: 1, cam_estimate_monthly: 1, total_monthly: 2, rent_psf_annual: 1,
    ...over,
  }
}

describe('occupancySplit', () => {
  it('counts occupied and notice as occupied, vacant as vacant, and excludes unavailable', () => {
    const s = occupancySplit([
      row({ sf: 1000, unit_status: 'occupied' }),
      row({ sf: 500, unit_status: 'notice' }),
      row({ sf: 250, unit_status: 'vacant', lease_id: null, end_date: null }),
      row({ sf: 9999, unit_status: 'unavailable', lease_id: null, end_date: null }),
    ])
    expect(s.occupiedSf).toBe(1500)
    expect(s.vacantSf).toBe(250)
    expect(s.unavailableSf).toBe(9999)
    expect(s.totalSf).toBe(1750)
    expect(s.occupiedSf + s.vacantSf).toBe(s.totalSf)
    expect(s.occupiedPct).toBe(86) // 1500/1750 = 85.7
  })

  it('counts a unit once even if the view returns it on several rows', () => {
    const s = occupancySplit([row({ unit_id: 'dup', sf: 800 }), row({ unit_id: 'dup', sf: 800 })])
    expect(s.occupiedSf).toBe(800)
  })

  it('returns zeros and 0% for an empty roll', () => {
    expect(occupancySplit([])).toEqual({ occupiedSf: 0, vacantSf: 0, unavailableSf: 0, totalSf: 0, occupiedPct: 0 })
  })

  it('treats null/NaN sf as zero', () => {
    const s = occupancySplit([row({ sf: null as unknown as number }), row({ sf: 100 })])
    expect(s.totalSf).toBe(100)
  })
})

describe('expiryLadder', () => {
  it('returns 6 consecutive years from fromYear, zero-filled', () => {
    const l = expiryLadder([], 2026)
    expect(l.map((b) => b.year)).toEqual([2026, 2027, 2028, 2029, 2030, 2031])
    expect(l.every((b) => b.sf === 0 && b.leases === 0)).toBe(true)
  })

  it('buckets by end-date year, SF-weighted', () => {
    const l = expiryLadder([
      row({ sf: 1000, end_date: '2027-01-01' }),
      row({ sf: 2000, end_date: '2027-12-31' }),
      row({ sf: 500, end_date: '2029-06-15' }),
    ], 2026)
    expect(l.find((b) => b.year === 2027)).toMatchObject({ sf: 3000, leases: 2 })
    expect(l.find((b) => b.year === 2029)).toMatchObject({ sf: 500, leases: 1 })
    expect(l.find((b) => b.year === 2026)?.sf).toBe(0)
  })

  it('ignores null end dates, vacant rows without a lease, and leases outside the window', () => {
    const rows = [
      row({ sf: 100, end_date: null }),
      row({ sf: 200, lease_id: null, end_date: null, unit_status: 'vacant' }),
      row({ sf: 300, end_date: '2025-12-31' }), // before window
      row({ sf: 400, end_date: '2032-01-01' }), // after window (2031 is last)
      row({ sf: 50, end_date: '2031-12-31' }),
    ]
    const l = expiryLadder(rows, 2026)
    expect(l.reduce((s, b) => s + b.sf, 0)).toBe(50)
    expect(expiryLadderExcluded(rows, 2026)).toEqual({ noEndDate: 1, expiredBeforeWindow: 1, beyondWindow: 1 })
  })

  it('honours a custom years span', () => {
    expect(expiryLadder([], 2026, 3).map((b) => b.year)).toEqual([2026, 2027, 2028])
  })

  it('reads the year from the date string without timezone drift', () => {
    const l = expiryLadder([row({ sf: 10, end_date: '2027-01-01' })], 2026)
    expect(l.find((b) => b.year === 2027)?.sf).toBe(10)
  })
})

describe('expiryExcludedNote', () => {
  it('names both clauses with counts', () => {
    expect(expiryExcludedNote({ noEndDate: 3, expiredBeforeWindow: 2, beyondWindow: 0 }))
      .toBe('Excludes 3 leases with no end date and 2 active leases past their end date (holdover).')
  })
  it('omits zero clauses and pluralises', () => {
    expect(expiryExcludedNote({ noEndDate: 1, expiredBeforeWindow: 0, beyondWindow: 0 })).toBe('Excludes 1 lease with no end date.')
    expect(expiryExcludedNote({ noEndDate: 0, expiredBeforeWindow: 1, beyondWindow: 0 })).toBe('Excludes 1 active lease past its end date (holdover).')
  })
  it('is null when nothing is excluded from the ladder', () => {
    expect(expiryExcludedNote({ noEndDate: 0, expiredBeforeWindow: 0, beyondWindow: 0 })).toBeNull()
  })
})
