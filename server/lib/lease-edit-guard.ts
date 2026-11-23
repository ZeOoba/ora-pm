// Lease edits on a lease billed from its schedule (lease abstraction plan §5a item 2). PURE: no I/O.
//
// Once a lease has rows in lease_rent_schedule, monthly billing bills the schedule and ignores
// leases.base_rent_monthly; once it has an active cam_estimate recurring row, it ignores cam_estimate_monthly
// too (rent-schedule.ts). Editing those fields on the lease form would change nothing billed while looking
// like it did, and moving the term past the schedule makes billing stop for that lease (schedule_gap). So the
// lease PUT refuses such edits with a reason; the schedule is changed through an abstract/amendment instead.

export interface LeaseMoneyFields {
  base_rent_monthly?: number | string | null
  cam_estimate_monthly?: number | string | null
  start_date?: string | null
  end_date?: string | null
}

export interface LeaseScheduleShape {
  /** Every rent row, superseded or not (any row puts the lease on the schedule path). */
  rent: { effective_start: string; effective_end: string; superseded_at: string | null }[]
  /** Whether an ACTIVE cam_estimate recurring row exists (CAM single-source rule). */
  hasActiveCam: boolean
}

const sameMoney = (a: unknown, b: unknown) => Math.round(Number(a ?? 0) * 100) === Math.round(Number(b ?? 0) * 100)

/** A reason to refuse the edit, or null when it is safe. Only fields present in `patch` are considered. */
export function scheduledLeaseEditProblem(current: LeaseMoneyFields, patch: LeaseMoneyFields, s: LeaseScheduleShape): string | null {
  if (s.rent.length === 0) return null
  if ('base_rent_monthly' in patch && !sameMoney(patch.base_rent_monthly, current.base_rent_monthly)) {
    return 'This lease bills from its rent schedule; base rent on the lease record is display only. Change the rent through a lease amendment.'
  }
  if (s.hasActiveCam && 'cam_estimate_monthly' in patch && !sameMoney(patch.cam_estimate_monthly, current.cam_estimate_monthly)) {
    return 'This lease bills CAM from its recurring charges; CAM on the lease record is display only. Change it through a lease amendment.'
  }
  const active = s.rent.filter((r) => r.superseded_at === null)
  if (active.length === 0) return null
  const first = active.reduce((m, r) => (r.effective_start < m ? r.effective_start : m), active[0].effective_start)
  const last = active.reduce((m, r) => (r.effective_end > m ? r.effective_end : m), active[0].effective_end)
  if ('end_date' in patch && patch.end_date && patch.end_date !== current.end_date && patch.end_date > last) {
    return `The rent schedule ends ${last}; extending the lease past it would stop billing. Add the renewal rent through a lease amendment.`
  }
  if ('start_date' in patch && patch.start_date && patch.start_date !== current.start_date && patch.start_date < first) {
    return `The rent schedule starts ${first}; moving the lease start earlier would stop billing for those days. Change it through a lease amendment.`
  }
  return null
}
