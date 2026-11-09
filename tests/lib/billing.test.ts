import { describe, it, expect } from 'vitest'
import { generateIdempotencyKey, buildMonthlyCharges, leaseTermStatusForPeriod } from '../../server/lib/billing'

describe('generateIdempotencyKey', () => {
  it('is deterministic for the same inputs', () => {
    const k1 = generateIdempotencyKey({ leaseId: 'abc', periodStart: '2026-06-01', type: 'rent' })
    const k2 = generateIdempotencyKey({ leaseId: 'abc', periodStart: '2026-06-01', type: 'rent' })
    expect(k1).toBe(k2)
  })

  it('differs by charge type', () => {
    const rent = generateIdempotencyKey({ leaseId: 'abc', periodStart: '2026-06-01', type: 'rent' })
    const cam = generateIdempotencyKey({ leaseId: 'abc', periodStart: '2026-06-01', type: 'cam_estimate' })
    expect(rent).not.toBe(cam)
  })

  it('differs by lease', () => {
    const k1 = generateIdempotencyKey({ leaseId: 'aaa', periodStart: '2026-06-01', type: 'rent' })
    const k2 = generateIdempotencyKey({ leaseId: 'bbb', periodStart: '2026-06-01', type: 'rent' })
    expect(k1).not.toBe(k2)
  })
})

describe('buildMonthlyCharges', () => {
  const base = {
    leaseId: 'lease-1',
    baseRentMonthly: 5000,
    camEstimateMonthly: 500,
    leaseStartDate: '2025-01-01',
    leaseEndDate: '2030-12-31',
    periodYear: 2026,
    periodMonth: 6,
  }

  it('generates rent and CAM charges for a full month', () => {
    const { charges } = buildMonthlyCharges(base)
    expect(charges).toHaveLength(2)
    expect(charges[0].type).toBe('rent')
    expect(charges[0].amount).toBe(5000)
    expect(charges[1].type).toBe('cam_estimate')
    expect(charges[1].amount).toBe(500)
  })

  it('prorates when lease starts mid-month', () => {
    const { charges } = buildMonthlyCharges({
      ...base,
      leaseStartDate: '2026-06-16', // 15 of 30 days remaining
      periodYear: 2026,
      periodMonth: 6,
    })
    const rentCharge = charges.find(c => c.type === 'rent')!
    expect(rentCharge.amount).toBeLessThan(5000)
    expect(rentCharge.description).toContain('prorated')
  })

  it('does not prorate when lease started in prior month', () => {
    const { charges } = buildMonthlyCharges({ ...base, leaseStartDate: '2026-05-01' })
    expect(charges.find(c => c.type === 'rent')!.amount).toBe(5000)
  })

  it('skips CAM charge when cam_estimate_monthly is 0', () => {
    const { charges } = buildMonthlyCharges({ ...base, camEstimateMonthly: 0 })
    expect(charges.every(c => c.type !== 'cam_estimate')).toBe(true)
  })

  it('sets period_start to first of month', () => {
    const { charges } = buildMonthlyCharges(base)
    expect(charges[0].period_start).toBe('2026-06-01')
  })

  it('assigns idempotency_key to every charge', () => {
    const { charges } = buildMonthlyCharges(base)
    for (const c of charges) {
      expect(c.idempotency_key).toBeTruthy()
    }
  })
})

// ---------------------------------------------------------------------------
// Audit finding billing-ignores-lease-term: charges must respect BOTH ends of
// the lease term, not just a mid-month start.
// ---------------------------------------------------------------------------
describe('buildMonthlyCharges: lease term (start AND end)', () => {
  const base = {
    leaseId: 'lease-1',
    baseRentMonthly: 5000,
    camEstimateMonthly: 500,
    leaseStartDate: '2025-01-01',
    leaseEndDate: '2030-12-31',
    periodYear: 2026,
    periodMonth: 6, // June 2026: 30 days
  }

  it('posts NOTHING for a lease whose start_date is after the period end (future start)', () => {
    expect(buildMonthlyCharges({ ...base, leaseStartDate: '2026-07-01' }).charges).toEqual([])
  })

  it('posts NOTHING for a lease whose end_date is before the period start (past end)', () => {
    expect(buildMonthlyCharges({ ...base, leaseEndDate: '2026-05-31' }).charges).toEqual([])
  })

  it('prorates the final partial month when the lease ends mid-period (inclusive end date)', () => {
    const { charges } = buildMonthlyCharges({ ...base, leaseEndDate: '2026-06-15' }) // 15 of 30 days
    const rent = charges.find(c => c.type === 'rent')!
    const cam = charges.find(c => c.type === 'cam_estimate')!
    expect(rent.amount).toBe(2500)
    expect(cam.amount).toBe(250)
    expect(rent.description).toContain('prorated')
  })

  it('bills the full month when the lease ends on the last day of the period', () => {
    const { charges } = buildMonthlyCharges({ ...base, leaseEndDate: '2026-06-30' })
    expect(charges.find(c => c.type === 'rent')!.amount).toBe(5000)
    expect(charges.find(c => c.type === 'rent')!.description).not.toContain('prorated')
  })

  it('prorates a lease that both starts and ends inside the period', () => {
    const { charges } = buildMonthlyCharges({ ...base, leaseStartDate: '2026-06-11', leaseEndDate: '2026-06-20' }) // 10 days
    expect(charges.find(c => c.type === 'rent')!.amount).toBe(Math.round(5000 * 10 / 30 * 100) / 100)
  })

  it('prorates a mid-month start exactly, independent of the host time zone (string date math)', () => {
    const { charges } = buildMonthlyCharges({ ...base, leaseStartDate: '2026-06-16' }) // 15 of 30 days
    expect(charges.find(c => c.type === 'rent')!.amount).toBe(2500)
  })

  it('a one-day lease on the first of the month bills one day', () => {
    const { charges } = buildMonthlyCharges({ ...base, leaseStartDate: '2026-06-01', leaseEndDate: '2026-06-01' })
    expect(charges.find(c => c.type === 'rent')!.amount).toBe(Math.round(5000 / 30 * 100) / 100)
  })
})

describe('leaseTermStatusForPeriod', () => {
  it('classifies a lease against a billing month', () => {
    expect(leaseTermStatusForPeriod('2026-07-01', '2030-12-31', 2026, 6)).toBe('not_started')
    expect(leaseTermStatusForPeriod('2025-01-01', '2026-05-31', 2026, 6)).toBe('ended')
    expect(leaseTermStatusForPeriod('2025-01-01', '2026-06-01', 2026, 6)).toBe('in_term')
    expect(leaseTermStatusForPeriod('2026-06-30', '2030-12-31', 2026, 6)).toBe('in_term')
  })

  it('treats a missing or malformed date as invalid (fail closed: never billed silently)', () => {
    expect(leaseTermStatusForPeriod('2025-01-01', '', 2026, 6)).toBe('invalid')
    expect(leaseTermStatusForPeriod('2025-01-01', null as unknown as string, 2026, 6)).toBe('invalid')
    expect(leaseTermStatusForPeriod('06/01/2025', '2030-12-31', 2026, 6)).toBe('invalid')
  })
})
