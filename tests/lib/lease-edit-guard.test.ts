import { describe, it, expect } from 'vitest'
import { scheduledLeaseEditProblem } from '../../server/lib/lease-edit-guard'

const cur = { base_rent_monthly: 5000, cam_estimate_monthly: 300, start_date: '2026-01-01', end_date: '2028-12-31' }
const rows = { rent: [{ effective_start: '2026-01-01', effective_end: '2026-12-31', superseded_at: null }, { effective_start: '2027-01-01', effective_end: '2028-12-31', superseded_at: null }], hasActiveCam: false }

describe('scheduledLeaseEditProblem (plan §5a item 2)', () => {
  it('allows anything on a lease with no schedule (legacy billing reads the fields)', () => {
    expect(scheduledLeaseEditProblem(cur, { base_rent_monthly: 9000, end_date: '2035-12-31' }, { rent: [], hasActiveCam: false })).toBeNull()
  })
  it('refuses a base-rent change on a scheduled lease, but allows re-sending the same value', () => {
    expect(scheduledLeaseEditProblem(cur, { base_rent_monthly: 5100 }, rows)).toMatch(/rent schedule/)
    expect(scheduledLeaseEditProblem(cur, { base_rent_monthly: '5000.00' }, rows)).toBeNull()
  })
  it('refuses a base-rent change even when every rent row is superseded (billing still uses the schedule path)', () => {
    expect(scheduledLeaseEditProblem(cur, { base_rent_monthly: 5100 }, { rent: [{ ...rows.rent[0], superseded_at: '2026-06-01T00:00:00Z' }], hasActiveCam: false })).not.toBeNull()
  })
  it('refuses a CAM change only when CAM bills from recurring rows', () => {
    expect(scheduledLeaseEditProblem(cur, { cam_estimate_monthly: 350 }, rows)).toBeNull()
    expect(scheduledLeaseEditProblem(cur, { cam_estimate_monthly: 350 }, { ...rows, hasActiveCam: true })).toMatch(/CAM/)
  })
  it('refuses extending the term past the schedule; allows shortening it', () => {
    expect(scheduledLeaseEditProblem(cur, { end_date: '2029-12-31' }, rows)).toMatch(/2028-12-31/)
    expect(scheduledLeaseEditProblem(cur, { end_date: '2027-06-30' }, rows)).toBeNull()
  })
  it('refuses moving the start before the schedule; allows a later start', () => {
    expect(scheduledLeaseEditProblem(cur, { start_date: '2025-12-01' }, rows)).toMatch(/2026-01-01/)
    expect(scheduledLeaseEditProblem(cur, { start_date: '2026-02-01' }, rows)).toBeNull()
  })
  it('ignores fields not in the patch (an edit of notes only)', () => {
    expect(scheduledLeaseEditProblem(cur, {}, { ...rows, hasActiveCam: true })).toBeNull()
  })
})
