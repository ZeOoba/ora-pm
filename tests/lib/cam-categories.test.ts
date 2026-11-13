// tests/lib/cam-categories.test.ts
//
// Lease-level recoverable categories, the annual CAM cap and the not-reconciled flag (Gabriel
// rulings 2026-11-10; migration 0026). Cases mirror the leases the 2026-11-10 extraction found (synthetic addresses):
// 200 Sample Ave (taxes only), 400 Example Ct (CAM + water/sewer, no taxes or
// insurance), 300 Example Ln 507 ($15,000/yr cap on taxes + insurance + CAM for the initial
// term), 600 Sample Way (direct pay, never reconciled).
import { describe, it, expect } from 'vitest'
import {
  assertBaseYearCategoriesMatch, assertCamReconciled, calculateCAMTrueUp, CAMTermsError, computeCamPool, EXPENSE_CATEGORIES,
  overRecoveryWarningByCategory, poolForCategories, type ExpenseCategory,
} from '../../server/lib/cam'

const totals = (over: Partial<Record<ExpenseCategory, number>> = {}): Record<ExpenseCategory, number> => ({
  taxes: 40_000, insurance: 10_000, maintenance: 20_000, utilities: 5_000,
  management: 3_000, capital: 7_000, other: 1_000, ...over,
})

describe('EXPENSE_CATEGORIES', () => {
  it('matches the expenses.category CHECK in 0002 exactly', () => {
    expect([...EXPENSE_CATEGORIES]).toEqual(['taxes', 'insurance', 'maintenance', 'utilities', 'management', 'capital', 'other'])
  })
})

describe('poolForCategories', () => {
  it('null categories = every recoverable expense (pre-0026 behaviour)', () => {
    expect(poolForCategories(totals(), null)).toBe(86_000)
  })

  it('taxes only (200 Sample Ave)', () => {
    expect(poolForCategories(totals(), ['taxes'])).toBe(40_000)
  })

  it('CAM without taxes or insurance (400 Example Ct s.36 + water/sewer)', () => {
    expect(poolForCategories(totals(), ['maintenance', 'utilities', 'other'])).toBe(26_000)
  })

  it('sums in cents (no float drift)', () => {
    expect(poolForCategories(totals({ taxes: 0.1, insurance: 0.2 }), ['taxes', 'insurance'])).toBe(0.3)
  })

  it('refuses an empty set: use cam_reconciled = false instead', () => {
    expect(() => poolForCategories(totals(), [])).toThrow(CAMTermsError)
  })

  it('refuses an unknown category (fail closed, never silently drops it)', () => {
    expect(() => poolForCategories(totals(), ['taxes', 'cam' as ExpenseCategory])).toThrow(/cam/)
  })

  it('refuses a duplicate category (would count it twice)', () => {
    expect(() => poolForCategories(totals(), ['taxes', 'taxes'])).toThrow(CAMTermsError)
  })

  it('refuses a non-finite category total', () => {
    expect(() => poolForCategories(totals({ taxes: NaN }), ['taxes'])).toThrow(CAMTermsError)
    expect(() => poolForCategories(totals({ utilities: NaN }), null)).toThrow(CAMTermsError)
  })
})

describe('assertCamReconciled', () => {
  it('passes a reconciled lease', () => {
    expect(() => assertCamReconciled('L1', true, null)).not.toThrow()
  })

  it('refuses a not-reconciled lease with its recorded reason (600 Sample Way direct pay)', () => {
    expect(() => assertCamReconciled('L1', false, 'Direct pay: tenant pays taxes to the county'))
      .toThrow(/not CAM-reconciled.*Direct pay: tenant pays taxes to the county/)
  })

  it('still refuses when the reason is missing', () => {
    expect(() => assertCamReconciled('L1', false, null)).toThrow(CAMTermsError)
  })
})

describe('calculateCAMTrueUp: annual cap (300 Example Ln 507)', () => {
  const base = {
    totalRecoverableExpenses: 160_000, // taxes + insurance + CAM pool
    tenantSF: 6000,
    tenantSharePct: 0.125,
    estimatedCamPaid: 15_000,
    reconciliationYear: 2027,
    daysInEffect: 365,
    daysInYear: 365,
  }

  it('no cap: unchanged ($20,000 owed)', () => {
    const r = calculateCAMTrueUp(base)
    expect(r.actualCamOwed).toBe(20_000)
    expect(r.capApplied).toBeNull()
    expect(r.warnings).toEqual([])
  })

  it('cap binds: owed = $15,000, true-up 0', () => {
    const r = calculateCAMTrueUp({ ...base, annualCap: 15_000, capThrough: '2029-06-30' })
    expect(r.actualCamOwed).toBe(15_000)
    expect(r.trueUpAmount).toBe(0)
    expect(r.capApplied).toBe(15_000)
    expect(r.recoveryBasis).toBe('full_pro_rata')
  })

  it('cap does not bind when owed is below it', () => {
    const r = calculateCAMTrueUp({ ...base, totalRecoverableExpenses: 80_000, annualCap: 15_000 })
    expect(r.actualCamOwed).toBe(10_000)
    expect(r.capApplied).toBeNull()
  })

  it('no end date: the cap applies every year', () => {
    const r = calculateCAMTrueUp({ ...base, reconciliationYear: 2040, annualCap: 15_000, capThrough: null })
    expect(r.actualCamOwed).toBe(15_000)
  })

  it('prorated for a partial year (move-in 2024-07-01: 184 of 366 days)', () => {
    const r = calculateCAMTrueUp({
      ...base, reconciliationYear: 2024, daysInEffect: 184, daysInYear: 366,
      tenantSharePct: 0.125 * 184 / 366, annualCap: 15_000,
    })
    const cap = Math.round(15_000 * 184 / 366 * 100) / 100
    expect(r.actualCamOwed).toBe(cap)
    expect(r.capApplied).toBe(cap)
  })

  it('cap ended before the year: no cap', () => {
    const r = calculateCAMTrueUp({ ...base, reconciliationYear: 2030, annualCap: 15_000, capThrough: '2029-06-30' })
    expect(r.actualCamOwed).toBe(20_000)
    expect(r.capApplied).toBeNull()
    expect(r.warnings).toEqual([])
  })

  it('cap ends inside the year: capped for the whole year, with a warning (ruling)', () => {
    const r = calculateCAMTrueUp({ ...base, reconciliationYear: 2029, annualCap: 15_000, capThrough: '2029-06-30' })
    expect(r.actualCamOwed).toBe(15_000)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toMatch(/2029-06-30/)
  })

  it('cap ending on Dec 31 is a full year, no warning', () => {
    const r = calculateCAMTrueUp({ ...base, reconciliationYear: 2029, annualCap: 15_000, capThrough: '2029-12-31' })
    expect(r.warnings).toEqual([])
    expect(r.actualCamOwed).toBe(15_000)
  })

  it('cap applies after the base year increase', () => {
    const r = calculateCAMTrueUp({
      ...base, baseYear: 2024, baseYearExpenseAmount: 100_000, annualCap: 5_000,
    })
    // 12.5% x (160,000 - 100,000) = 7,500 -> capped at 5,000
    expect(r.actualCamOwed).toBe(5_000)
    expect(r.recoveryBasis).toBe('above_base_year')
    expect(r.capApplied).toBe(5_000)
  })

  it('refuses a cap without days in effect (cannot prorate)', () => {
    expect(() => calculateCAMTrueUp({ ...base, daysInEffect: undefined, annualCap: 15_000 })).toThrow(CAMTermsError)
  })

  it('refuses a non-positive or non-finite cap', () => {
    expect(() => calculateCAMTrueUp({ ...base, annualCap: 0 })).toThrow(CAMTermsError)
    expect(() => calculateCAMTrueUp({ ...base, annualCap: NaN })).toThrow(CAMTermsError)
  })

  it('refuses a cap-through date with no cap, and an invalid date', () => {
    expect(() => calculateCAMTrueUp({ ...base, capThrough: '2029-06-30' })).toThrow(CAMTermsError)
    expect(() => calculateCAMTrueUp({ ...base, annualCap: 15_000, capThrough: '2029-02-30' })).toThrow(CAMTermsError)
  })

  it('a credit is never increased by the cap (owed below cap)', () => {
    const r = calculateCAMTrueUp({ ...base, totalRecoverableExpenses: 40_000, estimatedCamPaid: 15_000, annualCap: 15_000 })
    expect(r.actualCamOwed).toBe(5_000)
    expect(r.trueUpAmount).toBe(-10_000)
  })
})

describe('overRecoveryWarningByCategory', () => {
  const pool = computeCamPool([
    { id: 'A', sf: 1000, start_date: '2025-01-01', end_date: '2025-12-31' },
    { id: 'B', sf: 1000, start_date: '2025-01-01', end_date: '2025-12-31' },
  ], 2025)

  it('two 60% leases on different categories do not over-recover', () => {
    const w = overRecoveryWarningByCategory(pool, new Map([
      ['A', { annualPct: 0.6, categories: ['taxes'] as ExpenseCategory[] }],
      ['B', { annualPct: 0.6, categories: ['maintenance'] as ExpenseCategory[] }],
    ]))
    expect(w).toEqual([])
  })

  it('two 60% leases both recovering taxes do, and the warning names the category', () => {
    const w = overRecoveryWarningByCategory(pool, new Map([
      ['A', { annualPct: 0.6, categories: ['taxes'] as ExpenseCategory[] }],
      ['B', { annualPct: 0.6, categories: null }],
    ]))
    expect(w).toHaveLength(1)
    expect(w[0]).toMatch(/taxes/)
    expect(w[0]).toMatch(/120\.00%/)
  })

  it('null categories on both = one combined warning (pre-0026 behaviour, unlabelled per category)', () => {
    const w = overRecoveryWarningByCategory(pool, new Map([
      ['A', { annualPct: 0.6, categories: null }],
      ['B', { annualPct: 0.6, categories: null }],
    ]))
    expect(w).toHaveLength(1)
  })
})

describe('assertBaseYearCategoriesMatch (REFUTE 0026)', () => {
  it('no base year: nothing to check', () => {
    expect(() => assertBaseYearCategoriesMatch(null, ['taxes'], null)).not.toThrow()
  })
  it('matching sets (order-insensitive, or both all) pass', () => {
    expect(() => assertBaseYearCategoriesMatch(2024, null, null)).not.toThrow()
    expect(() => assertBaseYearCategoriesMatch(2024, ['taxes', 'insurance'], ['insurance', 'taxes'])).not.toThrow()
  })
  it('a taxes-only base amount against an all-category pool is refused (the ~$34.5k overbill case)', () => {
    expect(() => assertBaseYearCategoriesMatch(2024, null, ['taxes'])).toThrow(/re-enter the base-year recoverable total/i)
  })
  it('a whole-pool base amount against a CAM-only pool is refused (the silent $0 case)', () => {
    expect(() => assertBaseYearCategoriesMatch(2024, ['maintenance', 'utilities'], null)).toThrow(CAMTermsError)
  })
  it('invalid stored base-year categories fail closed', () => {
    expect(() => assertBaseYearCategoriesMatch(2024, ['taxes'], ['cam'])).toThrow(CAMTermsError)
  })
})
