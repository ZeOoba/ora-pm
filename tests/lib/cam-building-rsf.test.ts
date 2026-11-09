import { describe, it, expect } from 'vitest'
import {
  calculateCAMTrueUp, computeCamPool, CAMTermsError,
  resolveTenantShare, peakConcurrentLeasedSF, assertDenominatorCoversPool, SHARE_MISMATCH_TOLERANCE, overRecoveryWarning,
} from '../../server/lib/cam'

// ---------------------------------------------------------------------------
// Gabriel ruling 2026-11-08: the pro-rata denominator is BUILDING (or project) RENTABLE SF as the
// lease form names it, not leased SF. The landlord carries the vacancy share. ORA forms:
//   v2.8 §47  "the proportion that the rentable square footage of the Demised Premises bears to the
//             total rentable square footage of the Building, being [BUILDING RSF] ..."
//   v3.1 §36  "Tenant's Proportionate Share is stated in the Basic Lease Information"
// So: the lease-stated % (leases.proportionate_share_pct, a fraction in (0,1]) comes first; when it
// is null, premises SF / properties.cam_denominator_rsf. Both present and > 0.5 pp apart -> warning.
// Neither -> CAMTermsError (422). Partial year: share x days in effect / days in year.
// ---------------------------------------------------------------------------
describe('resolveTenantShare (building RSF ruling)', () => {
  const full = { leaseId: 'L1', premisesSF: 5000, overlapDays: 365, daysInYear: 365 }

  it('falls back to premises SF / denominator RSF when the lease states no %', () => {
    const r = resolveTenantShare({ ...full, statedPct: null, denominatorRSF: 50000 })
    expect(r.basis).toBe('premises_rsf_over_denominator')
    expect(r.annualPct).toBeCloseTo(0.1, 12)
    expect(r.effectivePct).toBeCloseTo(0.1, 12)
    expect(r.computedPct).toBeCloseTo(0.1, 12)
    expect(r.warnings).toEqual([])
  })

  it('the landlord carries vacancy: an empty building does not raise the share', () => {
    // Only 5,000 of 50,000 RSF is leased; the old leased-SF basis would have billed 100%.
    expect(resolveTenantShare({ ...full, statedPct: null, denominatorRSF: 50000 }).effectivePct).toBeCloseTo(0.1, 12)
  })

  it('the lease-stated % overrides the computed share', () => {
    const r = resolveTenantShare({ ...full, statedPct: 0.098, denominatorRSF: 50000 })
    expect(r.basis).toBe('lease_stated_pct')
    expect(r.annualPct).toBe(0.098)
    expect(r.computedPct).toBeCloseTo(0.1, 12)
    expect(r.warnings).toEqual([]) // 0.2 pp apart: within tolerance
  })

  it('warns (never throws) when stated and computed differ by more than 0.5 percentage points', () => {
    expect(SHARE_MISMATCH_TOLERANCE).toBe(0.005)
    const r = resolveTenantShare({ ...full, statedPct: 0.12, denominatorRSF: 50000 })
    expect(r.basis).toBe('lease_stated_pct')
    expect(r.annualPct).toBe(0.12)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toMatch(/12\.00%/)
    expect(r.warnings[0]).toMatch(/10\.00%/)
    expect(r.warnings[0]).toMatch(/L1/)
  })

  it('exactly 0.5 pp apart does not warn', () => {
    expect(resolveTenantShare({ ...full, statedPct: 0.105, denominatorRSF: 50000 }).warnings).toEqual([])
  })

  it('a stated % with no denominator RSF is used without a cross-check (e.g. the 100% single-tenant form)', () => {
    const r = resolveTenantShare({ ...full, statedPct: 1, denominatorRSF: null })
    expect(r.basis).toBe('lease_stated_pct')
    expect(r.annualPct).toBe(1)
    expect(r.computedPct).toBeNull()
  })

  it('neither a stated % nor a denominator RSF: CAMTermsError naming the lease', () => {
    const run = () => resolveTenantShare({ ...full, statedPct: null, denominatorRSF: null })
    expect(run).toThrow(CAMTermsError)
    expect(run).toThrow(/L1/)
    expect(run).toThrow(/rentable SF/i)
  })

  it('refuses a stated % outside (0, 1] and a non-positive RSF (fail closed, never a guess)', () => {
    for (const statedPct of [0, -0.1, 1.01, NaN]) {
      expect(() => resolveTenantShare({ ...full, statedPct, denominatorRSF: 50000 })).toThrow(CAMTermsError)
    }
    for (const denominatorRSF of [0, -1, NaN]) {
      expect(() => resolveTenantShare({ ...full, statedPct: null, denominatorRSF })).toThrow(CAMTermsError)
    }
  })

  it('refuses premises SF larger than the denominator RSF on the computed basis', () => {
    expect(() => resolveTenantShare({ ...full, premisesSF: 60000, statedPct: null, denominatorRSF: 50000 })).toThrow(CAMTermsError)
  })

  it('prorates both bases by days in effect (v3.1 §35 "prorated for a partial year")', () => {
    const part = { ...full, overlapDays: 184 }
    expect(resolveTenantShare({ ...part, statedPct: null, denominatorRSF: 50000 }).effectivePct).toBeCloseTo(0.1 * 184 / 365, 12)
    const s = resolveTenantShare({ ...part, statedPct: 0.1, denominatorRSF: null })
    expect(s.annualPct).toBe(0.1)
    expect(s.effectivePct).toBeCloseTo(0.1 * 184 / 365, 12)
  })

  it('the stated-vs-computed cross-check compares ANNUAL shares, not prorated ones', () => {
    // A half-year tenant must not warn just because its prorated share is half its stated share.
    expect(resolveTenantShare({ ...full, overlapDays: 182, statedPct: 0.1, denominatorRSF: 50000 }).warnings).toEqual([])
  })
})

describe('peakConcurrentLeasedSF / assertDenominatorCoversPool', () => {
  it('reports the largest SF leased on any single day of the year (not the weighted average)', () => {
    const pool = computeCamPool([
      { id: 'a', unit_id: 'u1', sf: 30000, start_date: '2020-01-01', end_date: '2025-03-31' },
      { id: 'b', unit_id: 'u2', sf: 15000, start_date: '2025-03-01', end_date: '2030-12-31' },
      { id: 'c', unit_id: 'u3', sf: 10000, start_date: '2020-01-01', end_date: '2030-12-31' },
    ], 2025)
    const peak = peakConcurrentLeasedSF(pool)
    expect(peak.sf).toBe(55000)
    expect(peak.on).toBe('2025-03-01')
  })

  it('back-to-back leases on one unit count once', () => {
    const pool = computeCamPool([
      { id: 'a', unit_id: 'u', sf: 10000, start_date: '2024-01-01', end_date: '2025-06-30' },
      { id: 'b', unit_id: 'u', sf: 10000, start_date: '2025-07-01', end_date: '2030-12-31' },
    ], 2025)
    expect(peakConcurrentLeasedSF(pool).sf).toBe(10000)
  })

  it('an empty pool peaks at 0', () => {
    expect(peakConcurrentLeasedSF(computeCamPool([], 2025)).sf).toBe(0)
  })

  it('throws CAMTermsError when the denominator RSF is smaller than the leased SF on some day', () => {
    const pool = computeCamPool([
      { id: 'a', unit_id: 'u1', sf: 30000, start_date: '2020-01-01', end_date: '2030-12-31' },
      { id: 'b', unit_id: 'u2', sf: 25000, start_date: '2020-01-01', end_date: '2030-12-31' },
    ], 2025)
    const run = () => assertDenominatorCoversPool(pool, 50000)
    expect(run).toThrow(CAMTermsError)
    expect(run).toThrow(/50,000/)
    expect(run).toThrow(/55,000/)
  })

  it('passes when the RSF equals or exceeds the peak, and when there is no RSF at all', () => {
    const pool = computeCamPool([{ id: 'a', unit_id: 'u1', sf: 50000, start_date: '2020-01-01', end_date: '2030-12-31' }], 2025)
    expect(() => assertDenominatorCoversPool(pool, 50000)).not.toThrow()
    expect(() => assertDenominatorCoversPool(pool, null)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Base year (Gabriel ruling 2026-11-08; v3.1 §35, v2.8 §40): "Tenant's Proportionate Share of the
// amount by which Operating Costs and Taxes for that year exceed those for the Base Year". One
// combined pool, so: owed = share x max(0, current recoverable - base-year amount). Gross-up is
// permissive in both forms ("Landlord may") and is NOT applied.
// ---------------------------------------------------------------------------
describe('calculateCAMTrueUp: base year', () => {
  const by = { totalRecoverableExpenses: 120000, tenantSF: 5000, tenantSharePct: 0.1, estimatedCamPaid: 0, reconciliationYear: 2026 }

  it('owes the share of the increase over the base-year amount', () => {
    const r = calculateCAMTrueUp({ ...by, rentType: 'modified_gross', baseYear: 2024, baseYearExpenseAmount: 100000, estimatedCamPaid: 500 })
    expect(r.actualCamOwed).toBe(2000)
    expect(r.trueUpAmount).toBe(1500)
    expect(r.recoveryBasis).toBe('above_base_year')
  })

  it('applies to nnn and gross rent types too when a base year is set', () => {
    for (const rentType of ['nnn', 'gross'] as const) {
      expect(calculateCAMTrueUp({ ...by, rentType, baseYear: 2024, baseYearExpenseAmount: 100000 }).actualCamOwed).toBe(2000)
    }
  })

  it('never negative: expenses below the base year owe 0 (and any estimate comes back as a credit)', () => {
    const r = calculateCAMTrueUp({ ...by, rentType: 'nnn', baseYear: 2024, baseYearExpenseAmount: 130000, estimatedCamPaid: 300 })
    expect(r.actualCamOwed).toBe(0)
    expect(r.trueUpAmount).toBe(-300)
  })

  it('in the base year itself, owes only any excess over the recorded base amount', () => {
    expect(calculateCAMTrueUp({ ...by, reconciliationYear: 2024, baseYear: 2024, baseYearExpenseAmount: 120000 }).actualCamOwed).toBe(0)
  })

  it('a base year with no base amount: CAMTermsError (422)', () => {
    expect(() => calculateCAMTrueUp({ ...by, baseYear: 2024, baseYearExpenseAmount: null })).toThrow(CAMTermsError)
    expect(() => calculateCAMTrueUp({ ...by, baseYear: 2024 })).toThrow(/base.year/i)
  })

  it('a base amount with no base year: CAMTermsError (orphan figure, fail closed)', () => {
    expect(() => calculateCAMTrueUp({ ...by, baseYear: null, baseYearExpenseAmount: 100000 })).toThrow(CAMTermsError)
  })

  it('refuses a negative / non-finite base amount, a reconciliation before the base year, or no reconciliation year', () => {
    expect(() => calculateCAMTrueUp({ ...by, baseYear: 2024, baseYearExpenseAmount: -1 })).toThrow(CAMTermsError)
    expect(() => calculateCAMTrueUp({ ...by, baseYear: 2024, baseYearExpenseAmount: NaN })).toThrow(CAMTermsError)
    expect(() => calculateCAMTrueUp({ ...by, reconciliationYear: 2023, baseYear: 2024, baseYearExpenseAmount: 1 })).toThrow(CAMTermsError)
    expect(() => calculateCAMTrueUp({ ...by, reconciliationYear: undefined, baseYear: 2024, baseYearExpenseAmount: 1 })).toThrow(CAMTermsError)
  })

  it('refuses a gross / modified-gross lease carrying BOTH a base year and an expense stop (ambiguous)', () => {
    expect(() => calculateCAMTrueUp({ ...by, rentType: 'modified_gross', expenseStopPerSF: 3, baseYear: 2024, baseYearExpenseAmount: 100000 }))
      .toThrow(/base year.*expense stop|expense stop.*base year/i)
  })

  it('nnn with no base year: full share, unchanged', () => {
    const r = calculateCAMTrueUp({ ...by, rentType: 'nnn', baseYear: null, baseYearExpenseAmount: null })
    expect(r.actualCamOwed).toBe(12000)
    expect(r.recoveryBasis).toBe('full_pro_rata')
  })

  it('the prorated share applies to the increase (partial-year tenant)', () => {
    const r = calculateCAMTrueUp({ ...by, tenantSharePct: 0.1 * 184 / 365, baseYear: 2024, baseYearExpenseAmount: 100000 })
    expect(r.actualCamOwed).toBeCloseTo(20000 * 0.1 * 184 / 365, 2)
  })
})

describe('overRecoveryWarning', () => {
  const pool = computeCamPool([
    { id: 'a', unit_id: 'u1', sf: 1, start_date: '2020-01-01', end_date: '2025-06-30' },
    { id: 'b', unit_id: 'u2', sf: 1, start_date: '2025-07-01', end_date: '2030-12-31' },
    { id: 'c', unit_id: 'u3', sf: 1, start_date: '2020-01-01', end_date: '2030-12-31' },
  ], 2025)

  it('is null when the concurrent shares never exceed 100% (sequential leases are not summed)', () => {
    expect(overRecoveryWarning(pool, new Map([['a', 0.6], ['b', 0.6], ['c', 0.4]]))).toBeNull()
  })

  it('tolerates rounding up to 100.5%', () => {
    expect(overRecoveryWarning(pool, new Map([['a', 0.605], ['c', 0.4]]))).toBeNull()
  })

  it('warns, naming the day and the total, above 100.5%', () => {
    const w = overRecoveryWarning(pool, new Map([['a', 0.7], ['c', 0.4]]))
    expect(w).toMatch(/110\.00%/)
    expect(w).toMatch(/2025-01-01/)
  })
})
