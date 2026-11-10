import { describe, it, expect } from 'vitest'
import {
  TERM_TODAY_PCT,
  collectionsFilter,
  collectionsSummary,
  groupRentRoll,
  renewalBoard,
  renewalLanes,
  timelineMonths,
  type RenewalRecord,
} from '../../src/pages/money/money-derive'
import type { ArAgingLeaseRow } from '../../src/pages/today/today-queue'
import type { RentRollRow } from '../../src/types'

const TODAY = '2026-11-10'

function rr(p: Partial<RentRollRow>): RentRollRow {
  const suite = p.suite ?? '1'
  return {
    property_id: 'P1', property_name: 'Raytown Flex', unit_id: `U${suite}`, suite, sf: 1000,
    unit_status: 'occupied', tenant_id: `T${suite}`, tenant_name: `Tenant ${suite}`, lease_id: `L${suite}`, start_date: '2022-01-01',
    end_date: '2030-01-01', lease_status: 'active', rent_type: 'nnn', base_rent_monthly: 1000,
    cam_estimate_monthly: 0, total_monthly: 1000, rent_psf_annual: 12, ...p,
  } as RentRollRow
}
const vacant = (suite: string, sf: number): RentRollRow =>
  rr({ suite, sf, unit_status: 'vacant', tenant_id: null, tenant_name: null, lease_id: null, start_date: null, end_date: null, lease_status: null, base_rent_monthly: null })

function ar(lease: string, tenant: string, b: Partial<ArAgingLeaseRow['buckets']>): ArAgingLeaseRow {
  const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, ...b }
  return { lease_id: lease, tenant_id: tenant, tenant_name: tenant, property_id: 'P1', property_name: 'x', suite: '1',
    balance: Object.values(buckets).reduce((s, v) => s + v, 0), buckets }
}

function renewal(lease: string, status: RenewalRecord['status'], extra: Partial<RenewalRecord> = {}): RenewalRecord {
  return { id: `R${lease}`, lease_id: lease, status, expiration_date: '2027-03-31', target_decision_date: null,
    leases: { tenants: { name: `Tenant of ${lease}` }, units: { suite: '9', properties: { name: 'Columbia' } } }, ...extra }
}

describe('groupRentRoll', () => {
  it('groups by property with SF share, leased %, ABR subtotal, numeric suite order; largest ABR first', () => {
    const g = groupRentRoll([
      rr({ suite: '10', sf: 600, base_rent_monthly: 1000 }),
      rr({ suite: '2', sf: 200, base_rent_monthly: 500, end_date: '2027-06-30' }),
      vacant('3', 200),
      rr({ property_id: 'P2', property_name: 'Columbia', suite: '7', base_rent_monthly: 9000 }),
    ], TODAY)
    expect(g.map((x) => x.property_id)).toEqual(['P2', 'P1'])
    const p1 = g[1]
    expect(p1.rows.map((r) => [r.row.suite, r.kind])).toEqual([['2', 'expiring'], ['3', 'vacant'], ['10', 'leased']])
    expect(p1.rows.map((r) => r.sharePct)).toEqual([20, 20, 60])
    expect(p1.leasedPct).toBe(80)
    expect(p1.abr).toBe(18000)
  })

  it('term bars sit on a 10-year window with today at the rule; clamped at the edges', () => {
    const [g] = groupRentRoll([rr({ suite: '1', start_date: TODAY, end_date: '2027-11-10' }), rr({ suite: '2', start_date: '1990-01-01', end_date: '2050-01-01' })], TODAY)
    expect(g.rows[0].termLeftPct).toBeCloseTo(TERM_TODAY_PCT, 1)
    expect(g.rows[0].termWidthPct).toBeCloseTo(10, 0)
    expect(g.rows[1].termLeftPct).toBe(0)
    expect(g.rows[1].termWidthPct).toBe(100)
  })
})

describe('renewal timeline and board', () => {
  const roll = [
    rr({ suite: 'a', end_date: '2027-03-31', base_rent_monthly: 2000 }),
    rr({ suite: 'b', end_date: '2026-09-30' }), // holdover
    rr({ suite: 'c', end_date: '2028-12-31' }), // beyond 18 months
    rr({ suite: 'd', end_date: '2027-02-28', lease_status: 'expired' }),
  ]

  it('months start at the current month and label year turns', () => {
    const m = timelineMonths(TODAY)
    expect(m).toHaveLength(18)
    expect(m[0].label).toBe('Nov')
    expect(m[2]).toEqual({ label: "Jan '27", year: true })
  })

  it('lanes: active leases ending inside the window, holdovers pinned left, joined to renewals', () => {
    const lanes = renewalLanes(roll, [renewal('La', 'negotiating', { target_decision_date: '2026-12-31' })], TODAY)
    expect(lanes.map((l) => l.lease_id)).toEqual(['Lb', 'La'])
    expect(lanes[0].expiryPct).toBe(0)
    expect(lanes[0].renewal).toBeNull()
    const a = lanes[1]
    expect(a.renewal?.status).toBe('negotiating')
    expect(a.abr).toBe(24000)
    expect(a.bandLeftPct).not.toBeNull()
    expect((a.bandLeftPct as number) + (a.bandWidthPct as number)).toBeCloseTo(a.expiryPct, 5)
  })

  it('board: renewal records by status, untracked expiring leases in their own column, ABR per column', () => {
    const recs = [renewal('La', 'negotiating'), renewal('Lz', 'executed')]
    const cols = renewalBoard(renewalLanes(roll, recs, TODAY), recs, roll)
    const by = Object.fromEntries(cols.map((c) => [c.key, c]))
    expect(by.untracked.cards.map((c) => c.lease_id)).toEqual(['Lb'])
    expect(by.negotiating.cards.map((c) => c.lease_id)).toEqual(['La'])
    expect(by.negotiating.abr).toBe(24000)
    expect(by.executed.cards).toHaveLength(1)
    expect(by.executed.abr).toBe(0)
  })
})

describe('collections', () => {
  const rows = [
    ar('L1', 'A', { current: 500 }),
    ar('L2', 'B', { d1_30: 900 }),
    ar('L3', 'C', { d31_60: 100 }),
    ar('L4', 'C', { d90_plus: 400, d1_30: 50 }),
  ]
  it('tabs filter and order by amount over 30 days first', () => {
    expect(collectionsFilter(rows, 'over30').map((r) => r.lease_id)).toEqual(['L4', 'L3'])
    expect(collectionsFilter(rows, 'pastDue').map((r) => r.lease_id)).toEqual(['L4', 'L3', 'L2'])
    expect(collectionsFilter(rows, 'all')).toHaveLength(4)
  })
  it('summary counts distinct tenants', () => {
    expect(collectionsSummary(rows)).toEqual({ balance: 1950, over30: 500, tenants: 3, tenantsOver30: 1 })
  })
})
