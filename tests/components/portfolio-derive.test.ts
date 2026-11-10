import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/lib/supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }))

import { rentAtRiskByQuarter, stackingPlan, summarizeProperties, walt } from '../../src/pages/portfolio/portfolio-derive'
import { termGeometry } from '../../src/pages/leases/lease-term'
import { ledgerWindow } from '../../src/pages/tenants/ledger-window'
import type { ArAgingLeaseRow } from '../../src/pages/today/today-queue'
import type { RentRollRow } from '../../src/types'

const TODAY = '2026-11-10'

function rr(p: Partial<RentRollRow>): RentRollRow {
  return {
    property_id: 'P1', property_name: 'Raytown Flex', unit_id: `U${p.suite ?? '1'}`, suite: '1', sf: 1000,
    unit_status: 'occupied', tenant_id: 'T', tenant_name: 'Tenant', lease_id: `L${p.suite ?? '1'}`, start_date: '2020-01-01',
    end_date: '2030-01-01', lease_status: 'active', rent_type: 'nnn', base_rent_monthly: 1000,
    cam_estimate_monthly: 0, total_monthly: 1000, rent_psf_annual: 12, ...p,
  } as RentRollRow
}
const vacant = (suite: string, sf: number, pid = 'P1'): RentRollRow =>
  rr({ suite, sf, property_id: pid, unit_status: 'vacant', tenant_id: null, tenant_name: null, lease_id: null, end_date: null, lease_status: null, base_rent_monthly: null })

function ar(lease: string, pid: string, b: Partial<ArAgingLeaseRow['buckets']>): ArAgingLeaseRow {
  const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, ...b }
  return { lease_id: lease, tenant_id: 'T', tenant_name: 'Tenant', property_id: pid, property_name: 'x', suite: '1',
    balance: Object.values(buckets).reduce((s, v) => s + v, 0), buckets }
}

describe('walt', () => {
  it('weights remaining term by base rent; holdovers count as zero', () => {
    const w = walt([
      rr({ suite: '1', base_rent_monthly: 1000, end_date: '2028-11-10' }), // ~2 yr
      rr({ suite: '2', base_rent_monthly: 3000, end_date: '2026-01-01' }), // holdover → 0
    ], TODAY)
    expect(w).toBeCloseTo(0.5, 1)
  })
  it('null with no rent-bearing leases', () => {
    expect(walt([vacant('1', 100)], TODAY)).toBeNull()
  })
})

describe('summarizeProperties', () => {
  it('groups by property: SF occupancy, ABR, AR over 30, next roll; sorted by ABR', () => {
    const rows = [
      rr({ suite: '1', sf: 600, base_rent_monthly: 1000, end_date: '2027-03-31' }),
      rr({ suite: '2', sf: 200, base_rent_monthly: 500, end_date: '2028-06-30' }),
      vacant('3', 200),
      rr({ property_id: 'P2', property_name: 'Columbia', suite: '7', sf: 1000, base_rent_monthly: 5000 }),
    ]
    const s = summarizeProperties(rows, [ar('L1', 'P1', { d1_30: 50, d61_90: 80 })], TODAY)
    expect(s.map((p) => p.property_id)).toEqual(['P2', 'P1'])
    const p1 = s[1]
    expect(p1.occupancyPct).toBe(80)
    expect(p1.abr).toBe(18000)
    expect(p1.arBalance).toBe(130)
    expect(p1.arOver30).toBe(80)
    expect(p1.nextRoll).toBe('Ste 1 · Mar 2027')
  })
})

describe('rentAtRiskByQuarter', () => {
  it('buckets ABR by calendar quarter from the current one; holdovers land in the first', () => {
    const q = rentAtRiskByQuarter([
      rr({ suite: '1', end_date: '2026-12-31', base_rent_monthly: 100 }),
      rr({ suite: '2', end_date: '2026-03-31', base_rent_monthly: 200 }),
      rr({ suite: '3', end_date: '2027-05-15', base_rent_monthly: 300 }),
      rr({ suite: '4', end_date: '2040-01-01', base_rent_monthly: 999 }),
    ], TODAY, 12)
    expect(q[0].label).toBe("Q4 '26")
    expect(q[0].abr).toBe(3600)
    expect(q[0].leases).toBe(2)
    expect(q[2].label).toBe("Q2 '27")
    expect(q[2].abr).toBe(3600)
    expect(q.reduce((s, b) => s + b.abr, 0)).toBe(7200)
    expect(q.filter((b) => b.near)).toHaveLength(4)
  })
})

describe('stackingPlan', () => {
  it('past due beats expiring beats leased; vacant from unit status; numeric suite order', () => {
    const plan = stackingPlan([
      rr({ suite: '10', end_date: '2030-01-01' }),
      rr({ suite: '2', end_date: '2027-03-01' }),
      rr({ suite: '3', end_date: '2027-03-01' }),
      vacant('1', 400),
    ], [ar('L3', 'P1', { d1_30: 99 })], TODAY)
    expect(plan.map((s) => [s.suite, s.state])).toEqual([['1', 'vacant'], ['2', 'expiring'], ['3', 'delinquent'], ['10', 'leased']])
    expect(plan[2].detail).toContain('$99 past due')
  })
})

describe('termGeometry', () => {
  it('places today and option deadlines on the term; clamps outside dates', () => {
    const g = termGeometry('2020-01-01', '2030-01-01', '2025-01-01', [
      { type: 'renewal', exercise_deadline: '2029-07-01', description: '' },
      { type: 'termination', exercise_deadline: '2019-01-01', description: '' },
    ])
    expect(g.todayPct).toBeCloseTo(50, 0)
    expect(g.deadlines.map((d) => [d.label, Math.round(d.pct), d.passed])).toEqual([['termination notice', 0, true], ['renewal notice', 95, false]])
    expect(g.monthsRemaining).toBe(60)
  })
})

describe('ledgerWindow', () => {
  it('six full months back to today', () => {
    expect(ledgerWindow(new Date('2026-11-10T12:00:00Z'))).toEqual({ start: '2026-05-01', end: '2026-11-10' })
  })
})
