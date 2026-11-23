import { describe, it, expect } from 'vitest'
import { autopayVarianceHold, groupSchedules, leaseAmount, priorPeriod, toNumber } from '../../server/lib/billing-run'
import { buildMonthlyCharges } from '../../server/lib/billing'

describe('toNumber / leaseAmount (plan §5a item 5: NUMERIC may arrive as a string)', () => {
  it('parses numeric strings and keeps numbers', () => {
    expect(toNumber('1234.50')).toBe(1234.5)
    expect(toNumber(7)).toBe(7)
  })
  it('keeps null as null and makes garbage NaN (never a silent 0)', () => {
    expect(toNumber(null)).toBeNull()
    expect(toNumber(undefined)).toBeNull()
    expect(Number.isNaN(toNumber('abc'))).toBe(true)
    expect(Number.isNaN(toNumber(''))).toBe(true)
  })
  it('lease-row amounts treat null as 0, exactly like the legacy path', () => {
    expect(leaseAmount(null)).toBe(0)
    expect(leaseAmount('500.00')).toBe(500)
  })
})

describe('groupSchedules', () => {
  it('groups rows per lease and coerces string numerics so the engine bills them', () => {
    const m = groupSchedules(
      [{ lease_id: 'A', effective_start: '2025-01-01', effective_end: '2030-12-31', base_rent_monthly: '3000.00', superseded_at: null }],
      [{ lease_id: 'A', id: 'r1', type: 'other', description: 'Tax escrow', amount_monthly: '100.25', effective_start: '2025-01-01', effective_end: '2030-12-31', superseded_at: null }],
      [{ lease_id: 'A', charge_type: 'rent', period_start: '2026-06-01', period_end: '2026-06-30', kind: 'pct', value: '0.5', reason: 'Half rent', clause_ref: null, superseded_at: null }],
    )
    const s = m.get('A')!
    const out = buildMonthlyCharges({ leaseId: 'A', baseRentMonthly: 1, camEstimateMonthly: 0, leaseStartDate: '2025-01-01', leaseEndDate: '2030-12-31', periodYear: 2026, periodMonth: 6, schedule: s })
    expect(out.exception).toBeUndefined()
    expect(out.charges.map((c) => [c.type, c.amount])).toEqual([['rent', 1500], ['other', 100.25]])
  })
  it('a null required amount fails closed (invalid_row), it is not billed as 0', () => {
    const m = groupSchedules([{ lease_id: 'A', effective_start: '2025-01-01', effective_end: '2030-12-31', base_rent_monthly: null, superseded_at: null }], [], [])
    const out = buildMonthlyCharges({ leaseId: 'A', baseRentMonthly: 5000, camEstimateMonthly: 0, leaseStartDate: '2025-01-01', leaseEndDate: '2030-12-31', periodYear: 2026, periodMonth: 6, schedule: m.get('A') })
    expect(out.charges).toEqual([])
    expect(out.exception?.code).toBe('invalid_row')
  })
  it('keeps superseded-only leases on the schedule path so they fail closed (plan §5a item 3)', () => {
    const m = groupSchedules([{ lease_id: 'A', effective_start: '2025-01-01', effective_end: '2030-12-31', base_rent_monthly: 3000, superseded_at: '2026-01-01T00:00:00Z' }], [], [])
    const out = buildMonthlyCharges({ leaseId: 'A', baseRentMonthly: 5000, camEstimateMonthly: 0, leaseStartDate: '2025-01-01', leaseEndDate: '2030-12-31', periodYear: 2026, periodMonth: 6, schedule: m.get('A') })
    expect(out.charges).toEqual([])
    expect(out.exception?.code).toBe('schedule_missing_rent')
  })
  it('has no entry for a lease with no rows (legacy path)', () => {
    expect(groupSchedules([], [], []).has('A')).toBe(false)
  })
})

describe('autopayVarianceHold (plan §5: never debit a surprise amount)', () => {
  it('allows a big move the lease inputs explain (abatement ends, step, prorated first month)', () => {
    expect(autopayVarianceHold({ current: 10000, priorPosted: 0, priorExpected: 0 })).toBeNull()
    expect(autopayVarianceHold({ current: 6000, priorPosted: 3000, priorExpected: 3000 })).toBeNull()
  })
  it('allows an unexplained move of 15% or less', () => {
    expect(autopayVarianceHold({ current: 5750, priorPosted: 5000, priorExpected: 5100 })).toBeNull()
  })
  it('holds an unexplained move over 15%', () => {
    expect(autopayVarianceHold({ current: 5751, priorPosted: 5000, priorExpected: 5751 })).toMatch(/15%/)
    expect(autopayVarianceHold({ current: 4000, priorPosted: 5000, priorExpected: 4000 })).toMatch(/15%/)
  })
  it('holds any unexplained move off a $0 month', () => {
    expect(autopayVarianceHold({ current: 100, priorPosted: 0, priorExpected: 5000 })).not.toBeNull()
  })
  it('holds when the lease inputs cannot bill last month at all', () => {
    expect(autopayVarianceHold({ current: 9000, priorPosted: 5000, priorExpected: null })).toMatch(/cannot bill last month/)
  })
  it('does not hold when last month has no monthly auto charge at all (no baseline: first month, QuickBooks cutover)', () => {
    expect(autopayVarianceHold({ current: 9000, priorPosted: null, priorExpected: 5000 })).toBeNull()
  })
  it('does not hold when nothing changed', () => {
    expect(autopayVarianceHold({ current: 5000, priorPosted: 5000, priorExpected: null })).toBeNull()
  })
})

describe('priorPeriod', () => {
  it('wraps January to the previous December', () => {
    expect(priorPeriod(2027, 1)).toEqual({ year: 2026, month: 12, start: '2026-12-01' })
    expect(priorPeriod(2026, 6)).toEqual({ year: 2026, month: 5, start: '2026-05-01' })
  })
})
