import { describe, it, expect } from 'vitest'
import { generateIdempotencyKey, buildMonthlyCharges } from '../../server/lib/billing'

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
