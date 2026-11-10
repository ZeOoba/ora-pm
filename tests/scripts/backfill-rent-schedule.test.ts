import { describe, it, expect } from 'vitest'
import { planBackfill, type BackfillLease } from '../../scripts/backfill-rent-schedule'

const lease = (over: Partial<BackfillLease> = {}): BackfillLease =>
  ({ id: 'L1', status: 'active', start_date: '2025-01-01', end_date: '2029-12-31', base_rent_monthly: 4250.5, ...over })

describe('planBackfill', () => {
  it('writes one full-term row at the lease rent, tagged backfill', () => {
    const { rows, skipped } = planBackfill([lease()], new Set())
    expect(skipped).toEqual([])
    expect(rows).toEqual([expect.objectContaining({
      lease_id: 'L1', effective_start: '2025-01-01', effective_end: '2029-12-31', base_rent_monthly: 4250.5, source: 'backfill',
    })])
  })
  it('skips a lease that already has any schedule row (idempotent re-run)', () => {
    expect(planBackfill([lease()], new Set(['L1']))).toEqual({ rows: [], skipped: [{ lease_id: 'L1', reason: 'has_schedule' }] })
  })
  it('skips expired/terminated leases and keeps pending ones', () => {
    const { rows, skipped } = planBackfill(
      [lease({ id: 'A', status: 'expired' }), lease({ id: 'B', status: 'terminated' }), lease({ id: 'C', status: 'pending' })],
      new Set(),
    )
    expect(rows.map((r) => r.lease_id)).toEqual(['C'])
    expect(skipped.map((s) => s.reason)).toEqual(['not_active_or_pending', 'not_active_or_pending'])
  })
  // REFUTE C2: NUMERIC(12,2) would round a sub-cent rent on insert and prorated months would drift a
  // cent from legacy billing, so it is never backfilled.
  it('refuses a sub-cent rent (52000/12) and keeps a whole-cent one', () => {
    const { rows, skipped } = planBackfill([lease({ id: 'A', base_rent_monthly: 52000 / 12 }), lease({ id: 'B', base_rent_monthly: 4333.33 })], new Set())
    expect(rows.map((r) => r.lease_id)).toEqual(['B'])
    expect(skipped).toEqual([{ lease_id: 'A', reason: 'sub_cent_rent' }])
  })
  it('flags invalid dates and invalid rent for review instead of writing them', () => {
    const { rows, skipped } = planBackfill(
      [lease({ id: 'A', start_date: '2025-02-30' }), lease({ id: 'B', end_date: '2024-01-01' }), lease({ id: 'C', base_rent_monthly: -1 }), lease({ id: 'D', base_rent_monthly: Number.NaN })],
      new Set(),
    )
    expect(rows).toEqual([])
    expect(skipped).toEqual([
      { lease_id: 'A', reason: 'invalid_dates' },
      { lease_id: 'B', reason: 'invalid_dates' },
      { lease_id: 'C', reason: 'invalid_rent' },
      { lease_id: 'D', reason: 'invalid_rent' },
    ])
  })
})
