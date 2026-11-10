import { describe, it, expect } from 'vitest'
import {
  buildQueue,
  compactMoney,
  computeVitals,
  dueLabel,
  pastDueAtStake,
  type ArAgingLeaseRow,
} from '../../src/pages/today/today-queue'
import type { CriticalDateRow, RentRollRow } from '../../src/types'

const TODAY = '2026-11-10'
const zero = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 }

function ar(id: string, buckets: Partial<typeof zero>, tenant = `T${id}`): ArAgingLeaseRow {
  const b = { ...zero, ...buckets }
  const balance = Object.values(b).reduce((s, v) => s + v, 0)
  return { lease_id: `L${id}`, tenant_id: tenant, tenant_name: `Tenant ${id}`, property_name: 'Raytown Flex', suite: id, balance, buckets: b }
}

function rr(p: Partial<RentRollRow>): RentRollRow {
  return {
    property_id: 'P', property_name: 'Raytown Flex', unit_id: `U${p.suite ?? '1'}`, suite: '1', sf: 1000,
    unit_status: 'occupied', tenant_id: 'T', tenant_name: 'Tenant', lease_id: 'L', start_date: '2020-01-01',
    end_date: '2030-01-01', lease_status: 'active', rent_type: 'nnn', base_rent_monthly: 1000,
    cam_estimate_monthly: 0, total_monthly: 1000, rent_psf_annual: 12, ...p,
  } as RentRollRow
}

function coi(id: string, days: number): CriticalDateRow {
  return { date_type: 'insurance_expiry', reference_id: id, tenant_name: `Tenant ${id}`, property_name: null, suite: null,
    critical_date: '2026-12-01', days_until: days, urgency: 'notice' }
}

describe('today queue', () => {
  it('only queues balances with a past-due part; current-only balances are not work', () => {
    const q = buildQueue({ ar: [ar('1', { current: 500 }), ar('2', { current: 100, d1_30: 200 })], rentRoll: [], dates: [], today: TODAY })
    expect(q.map((i) => i.key)).toEqual(['collect:L2'])
    expect(q[0].amount).toBe(200)
    expect(q[0].to).toBe('/tenants/T2')
  })

  it('ranks urgent items first, then by dollars at stake', () => {
    const q = buildQueue({
      ar: [ar('small-old', { d90_plus: 100 }), ar('big-new', { d1_30: 9000 })],
      rentRoll: [rr({ lease_id: 'R1', suite: '9', end_date: '2026-11-20', base_rent_monthly: 5000 })],
      dates: [coi('C1', 3)],
      today: TODAY,
    })
    // urgent: renew in 10 days ($60k/yr), 90+ collect ($100), COI in 3 days (no $); then the 1–30 collect
    expect(q.map((i) => i.key)).toEqual(['renew:R1', 'collect:Lsmall-old', 'comply:C1', 'collect:Lbig-new'])
  })

  it('queues renewals inside 180 days only, at annual base rent, including holdovers', () => {
    const q = buildQueue({
      ar: [], dates: [], today: TODAY,
      rentRoll: [
        rr({ lease_id: 'in', end_date: '2027-03-01' }),
        rr({ lease_id: 'out', end_date: '2027-12-01' }),
        rr({ lease_id: 'held', end_date: '2026-10-01' }),
        rr({ lease_id: 'ended', end_date: '2027-01-01', lease_status: 'expired' }),
      ],
    })
    expect(q.map((i) => i.key).sort()).toEqual(['renew:held', 'renew:in'])
    expect(q.find((i) => i.key === 'renew:in')?.amount).toBe(12000)
    expect(q.find((i) => i.key === 'renew:held')?.title).toContain('holding over')
  })

  it('queues COIs inside 30 days (and expired ones), never lease rows from critical dates', () => {
    const lease: CriticalDateRow = { ...coi('X', 5), date_type: 'lease_expiration' }
    const q = buildQueue({ ar: [], rentRoll: [], dates: [coi('soon', 12), coi('late', -4), coi('far', 60), lease], today: TODAY })
    expect(q.map((i) => i.key).sort()).toEqual(['comply:late', 'comply:soon'])
  })

  it('headline at-stake figure sums Collect only (annual rent is not past due)', () => {
    const q = buildQueue({ ar: [ar('1', { d31_60: 300 })], rentRoll: [rr({ lease_id: 'R', end_date: '2026-12-01' })], dates: [], today: TODAY })
    expect(pastDueAtStake(q)).toBe(300)
  })
})

describe('today vitals', () => {
  it('SF occupancy counts notice as leased and excludes unavailable units', () => {
    const v = computeVitals([
      rr({ sf: 600, unit_status: 'occupied' }),
      rr({ sf: 200, unit_status: 'notice' }),
      rr({ sf: 200, unit_status: 'vacant', lease_id: null, lease_status: null, base_rent_monthly: null }),
      rr({ sf: 5000, unit_status: 'unavailable', lease_id: null, lease_status: null, base_rent_monthly: null }),
    ], [], TODAY)
    expect(v.sfOccupancyPct).toBe(80)
    expect(v.totalSf).toBe(1000)
  })

  it('ABR and the share expiring within 12 months', () => {
    const v = computeVitals([
      rr({ base_rent_monthly: 1000, end_date: '2027-06-30' }),
      rr({ base_rent_monthly: 3000, end_date: '2029-06-30' }),
    ], [], TODAY)
    expect(v.abr).toBe(48000)
    expect(v.abrExpiring12).toBe(12000)
    expect(v.abrExpiring12Pct).toBe(25)
    expect(v.leasesExpiring12).toBe(1)
  })

  it('AR over 30 uses server buckets and counts distinct tenants', () => {
    const v = computeVitals([], [ar('1', { d1_30: 50, d31_60: 100 }, 'A'), ar('2', { d90_plus: 25 }, 'A'), ar('3', { d1_30: 999 }, 'B')], TODAY)
    expect(v.arOver30).toBe(125)
    expect(v.tenantsOver30).toBe(1)
  })

  it('no units → no occupancy figure (not 0%)', () => {
    expect(computeVitals([], [], TODAY).sfOccupancyPct).toBeNull()
  })
})

describe('formatting', () => {
  it('dueLabel', () => {
    expect([dueLabel(-3), dueLabel(-1), dueLabel(0), dueLabel(1), dueLabel(6)]).toEqual(['3 days ago', 'Yesterday', 'Today', 'Tomorrow', 'in 6 days'])
  })
  it('compactMoney', () => {
    expect([compactMoney(9410.4), compactMoney(38420), compactMoney(412880), compactMoney(5740000)]).toEqual(['$9,410', '$38.4k', '$413k', '$5.74M'])
  })
})
