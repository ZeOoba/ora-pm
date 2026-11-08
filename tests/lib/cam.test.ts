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

// ---------------------------------------------------------------------------
// Audit finding cam-ignores-rent-type-expense-stop: the true-up billed every lease
// its full pro-rata share regardless of leases.rent_type / expense_stop_amount
// (0001_core_entities.sql). Schema semantics: rent_type in nnn | gross |
// modified_gross; expense_stop_amount is $/SF per year ("Expense Stop ($/SF) -
// For gross / modified-gross leases", LeaseForm.tsx).
// Example pool: $100,000 recoverable, tenant 5,000 SF of 25,000 SF -> 20% -> $20,000 share.
// ---------------------------------------------------------------------------
describe('calculateCAMTrueUp: rent type and expense stop', () => {
  const pool = { totalRecoverableExpenses: 100000, tenantSF: 5000, totalLeasedSF: 25000, estimatedCamPaid: 0 }

  it('nnn recovers the full pro-rata share and ignores any expense stop', () => {
    const r = calculateCAMTrueUp({ ...pool, rentType: 'nnn', expenseStopPerSF: 3 })
    expect(r.actualCamOwed).toBe(20000)
    expect(r.recoveryBasis).toBe('full_pro_rata')
  })

  it('omitting rentType keeps the legacy nnn behaviour (back-compat for existing callers)', () => {
    expect(calculateCAMTrueUp(pool).actualCamOwed).toBe(20000)
  })

  it('modified_gross recovers only the share ABOVE the expense stop ($/SF x tenant SF)', () => {
    // $20,000 share - $3/SF x 5,000 SF ($15,000 stop) = $5,000
    const r = calculateCAMTrueUp({ ...pool, rentType: 'modified_gross', expenseStopPerSF: 3, estimatedCamPaid: 1000 })
    expect(r.actualCamOwed).toBe(5000)
    expect(r.trueUpAmount).toBe(4000)
    expect(r.recoveryBasis).toBe('above_expense_stop')
  })

  it('modified_gross whose stop exceeds its share owes nothing (never negative recovery)', () => {
    const r = calculateCAMTrueUp({ ...pool, rentType: 'modified_gross', expenseStopPerSF: 5 })
    expect(r.actualCamOwed).toBe(0)
  })

  it('modified_gross with NO expense stop fails closed (cannot tell what is recoverable)', () => {
    expect(() => calculateCAMTrueUp({ ...pool, rentType: 'modified_gross', expenseStopPerSF: null }))
      .toThrow(/expense stop/i)
  })

  it('gross with no expense stop is full-service gross: recovers nothing, and credits any estimate billed', () => {
    const r = calculateCAMTrueUp({ ...pool, rentType: 'gross', expenseStopPerSF: null, estimatedCamPaid: 600 })
    expect(r.actualCamOwed).toBe(0)
    expect(r.trueUpAmount).toBe(-600)
    expect(r.recoveryBasis).toBe('none_gross')
  })

  it('gross WITH an expense stop recovers only above the stop', () => {
    const r = calculateCAMTrueUp({ ...pool, rentType: 'gross', expenseStopPerSF: 3 })
    expect(r.actualCamOwed).toBe(5000)
    expect(r.recoveryBasis).toBe('above_expense_stop')
  })

  it('rejects a negative expense stop', () => {
    expect(() => calculateCAMTrueUp({ ...pool, rentType: 'modified_gross', expenseStopPerSF: -1 })).toThrow(/expense stop/i)
  })

  it('the pro-rata share pct is reported unchanged for every rent type', () => {
    for (const rentType of ['nnn', 'gross', 'modified_gross'] as const) {
      expect(calculateCAMTrueUp({ ...pool, rentType, expenseStopPerSF: 3 }).tenantProRataSharePct).toBeCloseTo(0.2)
    }
  })
})
