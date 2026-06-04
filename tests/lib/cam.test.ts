import { describe, it, expect } from 'vitest'
import { calculateCAMTrueUp } from '../../server/lib/cam'

describe('calculateCAMTrueUp', () => {
  it('calculates positive true-up when tenant owes more than estimated', () => {
    const r = calculateCAMTrueUp({
      totalRecoverableExpenses: 100000,
      tenantSF: 5000,
      totalLeasedSF: 25000,
      estimatedCamPaid: 3500,
    })
    expect(r.tenantProRataSharePct).toBeCloseTo(0.2)
    expect(r.actualCamOwed).toBe(20000)
    expect(r.trueUpAmount).toBe(16500)
  })

  it('calculates negative true-up (credit) when tenant overpaid', () => {
    const r = calculateCAMTrueUp({
      totalRecoverableExpenses: 50000,
      tenantSF: 5000,
      totalLeasedSF: 25000,
      estimatedCamPaid: 12000,
    })
    expect(r.actualCamOwed).toBe(10000)
    expect(r.trueUpAmount).toBe(-2000)
  })

  it('handles 100% occupancy by single tenant', () => {
    const r = calculateCAMTrueUp({
      totalRecoverableExpenses: 40000,
      tenantSF: 10000,
      totalLeasedSF: 10000,
      estimatedCamPaid: 40000,
    })
    expect(r.tenantProRataSharePct).toBe(1)
    expect(r.trueUpAmount).toBe(0)
  })

  it('rounds to two decimal places', () => {
    const r = calculateCAMTrueUp({
      totalRecoverableExpenses: 100000,
      tenantSF: 1,
      totalLeasedSF: 3,
      estimatedCamPaid: 0,
    })
    const str = r.actualCamOwed.toString()
    const decimals = str.includes('.') ? str.split('.')[1].length : 0
    expect(decimals).toBeLessThanOrEqual(2)
  })

  it('throws when totalLeasedSF is zero', () => {
    expect(() =>
      calculateCAMTrueUp({
        totalRecoverableExpenses: 100,
        tenantSF: 0,
        totalLeasedSF: 0,
        estimatedCamPaid: 0,
      })
    ).toThrow('totalLeasedSF cannot be zero')
  })

  it('throws when tenantSF exceeds totalLeasedSF', () => {
    expect(() =>
      calculateCAMTrueUp({
        totalRecoverableExpenses: 100,
        tenantSF: 200,
        totalLeasedSF: 100,
        estimatedCamPaid: 0,
      })
    ).toThrow()
  })
})
