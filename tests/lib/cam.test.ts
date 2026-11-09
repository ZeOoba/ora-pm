import { describe, it, expect } from 'vitest'
import { calculateCAMTrueUp, yearOverlapDays, computeCamPool, CAMTermsError } from '../../server/lib/cam'

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

// ---------------------------------------------------------------------------
// Audit finding cam-denominator-client-snapshot: the pro-rata denominator was
// summed in the browser from TODAY's active leases. It is now computed server-side
// as occupancy-weighted leased SF over the reconciliation year: every lease that
// overlapped the year contributes sf x (days in effect / days in year).
// ---------------------------------------------------------------------------
describe('yearOverlapDays', () => {
  it('counts inclusive days of the lease term inside the calendar year', () => {
    expect(yearOverlapDays('2020-01-01', '2030-12-31', 2025)).toBe(365)
    expect(yearOverlapDays('2020-01-01', '2030-12-31', 2024)).toBe(366) // leap year
    expect(yearOverlapDays('2025-07-01', '2030-12-31', 2025)).toBe(184)
    expect(yearOverlapDays('2020-01-01', '2025-03-31', 2025)).toBe(90)
    expect(yearOverlapDays('2025-01-01', '2025-01-01', 2025)).toBe(1)
  })

  it('is 0 for a lease entirely outside the year', () => {
    expect(yearOverlapDays('2026-01-01', '2030-12-31', 2025)).toBe(0)
    expect(yearOverlapDays('2020-01-01', '2024-12-31', 2025)).toBe(0)
  })

  it('throws CAMTermsError on missing / malformed / inverted dates (fail closed)', () => {
    expect(() => yearOverlapDays('', '2030-12-31', 2025)).toThrow(CAMTermsError)
    expect(() => yearOverlapDays('2025-02-30', '2030-12-31', 2025)).toThrow(CAMTermsError)
    expect(() => yearOverlapDays('2026-01-01', '2025-01-01', 2025)).toThrow(CAMTermsError)
  })
})

describe('computeCamPool', () => {
  it('weights each lease SF by the share of the year it was in effect', () => {
    const pool = computeCamPool([
      { id: 'a', sf: 1000, start_date: '2020-01-01', end_date: '2030-12-31' }, // full year
      { id: 'b', sf: 3650, start_date: '2020-01-01', end_date: '2025-03-31' }, // 90 days
    ], 2025)
    expect(pool.daysInYear).toBe(365)
    expect(pool.byLease.a.weightedSF).toBe(1000)
    expect(pool.byLease.b.weightedSF).toBeCloseTo(900, 9)
    expect(pool.weightedLeasedSF).toBeCloseTo(1900, 9)
  })

  it('drops leases that did not overlap the year', () => {
    const pool = computeCamPool([
      { id: 'a', sf: 1000, start_date: '2020-01-01', end_date: '2030-12-31' },
      { id: 'z', sf: 9999, start_date: '2026-01-01', end_date: '2030-12-31' },
    ], 2025)
    expect(Object.keys(pool.byLease)).toEqual(['a'])
    expect(pool.weightedLeasedSF).toBe(1000)
  })

  it('pro-rata shares derived from the pool sum to 100% of recoverable expenses', () => {
    const leases = [
      { id: 'a', sf: 1000, start_date: '2020-01-01', end_date: '2030-12-31' },
      { id: 'b', sf: 2500, start_date: '2025-04-15', end_date: '2030-12-31' },
      { id: 'c', sf: 1200, start_date: '2019-01-01', end_date: '2025-08-31' },
    ]
    const pool = computeCamPool(leases, 2025)
    const owed = leases.map((l) => calculateCAMTrueUp({
      totalRecoverableExpenses: 100000,
      tenantSF: pool.byLease[l.id].weightedSF,
      totalLeasedSF: pool.weightedLeasedSF,
      estimatedCamPaid: 0,
    }).actualCamOwed)
    expect(owed.reduce((x, y) => x + y, 0)).toBeCloseTo(100000, 1)
  })
})

// REFUTE C4b (refute-orapm/cam-probe.mjs #1): an early-terminated lease that keeps its original
// end_date plus its replacement on the SAME unit double-counted SF (35,041 weighted vs 30,000
// physical). Overlapping in-year terms on one unit now fail closed, naming the unit and leases.
describe('computeCamPool: same-unit overlap (REFUTE C4b)', () => {
  it('throws CAMTermsError naming the unit and both leases when their in-year terms overlap', () => {
    const run = () => computeCamPool([
      { id: 'A_terminated', unit_id: 'unit-7', unit_label: 'Suite 7', sf: 10000, start_date: '2024-01-01', end_date: '2028-12-31' },
      { id: 'B_replacement', unit_id: 'unit-7', unit_label: 'Suite 7', sf: 10000, start_date: '2026-07-01', end_date: '2031-06-30' },
      { id: 'C_other', unit_id: 'unit-9', sf: 20000, start_date: '2020-01-01', end_date: '2030-12-31' },
    ], 2026)
    expect(run).toThrow(CAMTermsError)
    expect(run).toThrow(/Suite 7/)
    expect(run).toThrow(/A_terminated/)
    expect(run).toThrow(/B_replacement/)
  })

  it('back-to-back leases on one unit (no shared day) are fine and sum to the physical SF', () => {
    const pool = computeCamPool([
      { id: 'A', unit_id: 'u', sf: 10000, start_date: '2024-01-01', end_date: '2026-06-30' },
      { id: 'B', unit_id: 'u', sf: 10000, start_date: '2026-07-01', end_date: '2031-06-30' },
    ], 2026)
    expect(pool.weightedLeasedSF).toBeCloseTo(10000, 9)
  })

  it('a same-unit overlap OUTSIDE the reconciliation year does not block that year', () => {
    expect(() => computeCamPool([
      { id: 'A', unit_id: 'u', sf: 10000, start_date: '2020-01-01', end_date: '2025-03-31' },
      { id: 'B', unit_id: 'u', sf: 10000, start_date: '2025-01-01', end_date: '2031-06-30' },
    ], 2026)).not.toThrow()
  })
})
