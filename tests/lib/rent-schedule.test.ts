import { describe, it, expect } from 'vitest'
import {
  addMonthsIso,
  computeScheduledLines,
  expandFixedEscalation,
  hasSchedule,
  type LeaseSchedule,
  type RentScheduleRow,
} from '../../server/lib/rent-schedule'
import { buildMonthlyCharges } from '../../server/lib/billing'

const empty: LeaseSchedule = { rent: [], recurring: [], concessions: [] }
const row = (effective_start: string, effective_end: string, base_rent_monthly: number, superseded_at: string | null = null): RentScheduleRow =>
  ({ effective_start, effective_end, base_rent_monthly, superseded_at })

function lines(schedule: LeaseSchedule, y: number, m: number, term = { start: '2025-01-01', end: '2030-12-31' }, legacyCamMonthly = 0) {
  return computeScheduledLines({ schedule, leaseStartDate: term.start, leaseEndDate: term.end, legacyCamMonthly, periodYear: y, periodMonth: m })
}
function ok(r: ReturnType<typeof computeScheduledLines>) {
  if ('exception' in r) throw new Error(`unexpected exception ${r.exception.code}: ${r.exception.detail}`)
  return r.lines
}
const amt = (ls: ReturnType<typeof ok>, key: string) => ls.find((l) => (l.keySuffix ?? l.type) === key)?.amount

describe('addMonthsIso', () => {
  it('adds months and clamps to the month end (Jan 31 + 1 = Feb 28/29)', () => {
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonthsIso('2028-01-31', 1)).toBe('2028-02-29')
    expect(addMonthsIso('2026-03-15', 12)).toBe('2027-03-15')
    expect(addMonthsIso('2026-11-30', 3)).toBe('2027-02-28')
  })
})

describe('hasSchedule', () => {
  it('is false only for undefined and empty schedules', () => {
    expect(hasSchedule(undefined)).toBe(false)
    expect(hasSchedule(empty)).toBe(false)
  })
  it('is TRUE for a superseded-only schedule, which then fails closed instead of falling back to legacy rent', () => {
    const s: LeaseSchedule = { ...empty, rent: [row('2025-01-01', '2030-12-31', 3000, '2026-06-01T00:00:00Z')] }
    expect(hasSchedule(s)).toBe(true)
    const r = lines(s, 2026, 6)
    expect('exception' in r && r.exception.code).toBe('schedule_missing_rent')
  })
  it('is true when any active row exists in any list', () => {
    expect(hasSchedule({ ...empty, rent: [row('2026-01-01', '2026-12-31', 1)] })).toBe(true)
    expect(hasSchedule({ ...empty, concessions: [{ charge_type: 'rent', period_start: '2026-01-01', period_end: '2026-01-31', kind: 'full_waiver', value: null, reason: 'free' }] })).toBe(true)
  })
})

describe('computeScheduledLines: rent steps', () => {
  const sched: LeaseSchedule = { ...empty, rent: [row('2025-01-01', '2026-06-15', 3000), row('2026-06-16', '2030-12-31', 3090)] }

  it('bills a full month at the row covering it', () => {
    expect(amt(ok(lines(sched, 2026, 5)), 'rent')).toBe(3000)
    expect(amt(ok(lines(sched, 2026, 7)), 'rent')).toBe(3090)
  })
  it('splits a mid-month step by days: 15 days at 3000 + 15 days at 3090 in a 30-day month', () => {
    expect(amt(ok(lines(sched, 2026, 6)), 'rent')).toBe(3045)
  })
  it('does not label a full month split across two steps as prorated', () => {
    expect(ok(lines(sched, 2026, 6)).find((l) => l.type === 'rent')!.description).toBe('Rent – June 2026')
  })
  it('ignores superseded rows', () => {
    const s: LeaseSchedule = { ...empty, rent: [row('2025-01-01', '2030-12-31', 9999, '2026-01-01T00:00:00Z'), row('2025-01-01', '2030-12-31', 4000)] }
    expect(amt(ok(lines(s, 2026, 3)), 'rent')).toBe(4000)
  })
  it('prorates the first month of the term and labels it', () => {
    const s: LeaseSchedule = { ...empty, rent: [row('2026-06-16', '2030-12-31', 3000)] }
    const r = ok(lines(s, 2026, 6, { start: '2026-06-16', end: '2030-12-31' }))
    expect(amt(r, 'rent')).toBe(1500)
    expect(r[0].description).toBe('Rent – June 2026 (prorated)')
  })
})

describe('computeScheduledLines: fail closed', () => {
  it('schedule_gap when an in-term day has no active rent row', () => {
    const s: LeaseSchedule = { ...empty, rent: [row('2025-01-01', '2026-06-10', 3000), row('2026-06-12', '2030-12-31', 3000)] }
    const r = lines(s, 2026, 6)
    expect('exception' in r && r.exception.code).toBe('schedule_gap')
  })
  it('schedule_gap when the schedule ends before the lease term', () => {
    const s: LeaseSchedule = { ...empty, rent: [row('2025-01-01', '2026-05-31', 3000)] }
    expect('exception' in lines(s, 2026, 6) && (lines(s, 2026, 6) as { exception: { code: string } }).exception.code).toBe('schedule_gap')
  })
  it('schedule_overlap when two active rows cover the same day', () => {
    const s: LeaseSchedule = { ...empty, rent: [row('2025-01-01', '2026-06-20', 3000), row('2026-06-15', '2030-12-31', 3100)] }
    const r = lines(s, 2026, 6)
    expect('exception' in r && r.exception.code).toBe('schedule_overlap')
  })
  it('schedule_missing_rent when concessions or recurring rows exist with no rent rows', () => {
    const s: LeaseSchedule = { ...empty, concessions: [{ charge_type: 'rent', period_start: '2026-06-01', period_end: '2026-06-30', kind: 'full_waiver', value: null, reason: 'free' }] }
    const r = lines(s, 2026, 6)
    expect('exception' in r && r.exception.code).toBe('schedule_missing_rent')
  })
  it('concession_conflict when an "all" concession and a "rent" concession cover the same day', () => {
    const s: LeaseSchedule = {
      ...empty,
      rent: [row('2025-01-01', '2030-12-31', 3000)],
      concessions: [
        { charge_type: 'all', period_start: '2026-06-01', period_end: '2026-06-30', kind: 'full_waiver', value: null, reason: 'a' },
        { charge_type: 'rent', period_start: '2026-06-10', period_end: '2026-06-12', kind: 'pct', value: 0.5, reason: 'b' },
      ],
    }
    const r = lines(s, 2026, 6)
    expect('exception' in r && r.exception.code).toBe('concession_conflict')
  })
  it('invalid_row on a malformed date, end before start, or out-of-range concession value', () => {
    const bad: LeaseSchedule[] = [
      { ...empty, rent: [row('2026-02-30', '2030-12-31', 3000)] },
      { ...empty, rent: [row('2026-07-01', '2026-06-01', 3000)] },
      { ...empty, rent: [row('2025-01-01', '2030-12-31', 3000)], concessions: [{ charge_type: 'rent', period_start: '2026-06-01', period_end: '2026-06-30', kind: 'pct', value: 50, reason: 'x' }] },
      { ...empty, rent: [row('2025-01-01', '2030-12-31', -1)] },
    ]
    for (const s of bad) {
      const r = lines(s, 2026, 6)
      expect('exception' in r && r.exception.code).toBe('invalid_row')
    }
  })
  it('recurring_overlap when two active rows of one key cover the same day', () => {
    const s: LeaseSchedule = {
      ...empty,
      rent: [row('2025-01-01', '2030-12-31', 3000)],
      recurring: [
        { id: 'r1', type: 'utility_water', description: 'Water', amount_monthly: 50, effective_start: '2026-01-01', effective_end: '2026-12-31' },
        { id: 'r2', type: 'utility_water', description: 'Water', amount_monthly: 60, effective_start: '2026-06-15', effective_end: '2026-12-31' },
      ],
    }
    const r = lines(s, 2026, 6)
    expect('exception' in r && r.exception.code).toBe('recurring_overlap')
  })
})

describe('computeScheduledLines: concessions', () => {
  const rent = [row('2025-01-01', '2030-12-31', 3000)]
  it('a full waiver for the whole month posts no rent line', () => {
    const r = ok(lines({ ...empty, rent, concessions: [{ charge_type: 'rent', period_start: '2026-06-01', period_end: '2026-06-30', kind: 'full_waiver', value: null, reason: 'Free rent', clause_ref: '§4.3' }] }, 2026, 6))
    expect(r.find((l) => l.type === 'rent')).toBeUndefined()
  })
  it('a 50% abatement halves rent and says why on the line', () => {
    const r = ok(lines({ ...empty, rent, concessions: [{ charge_type: 'rent', period_start: '2026-06-01', period_end: '2026-06-30', kind: 'pct', value: 0.5, reason: 'Abatement', clause_ref: '§4.3' }] }, 2026, 6))
    const l = r.find((x) => x.type === 'rent')!
    expect(l.amount).toBe(1500)
    expect(l.description).toBe('Rent – June 2026 (abatement: Abatement, §4.3)')
  })
  it('a waiver covering half the month waives only those days', () => {
    const r = ok(lines({ ...empty, rent, concessions: [{ charge_type: 'rent', period_start: '2026-06-01', period_end: '2026-06-15', kind: 'full_waiver', value: null, reason: 'Free rent' }] }, 2026, 6))
    expect(amt(r, 'rent')).toBe(1500)
  })
  it('a fixed-dollar waiver is prorated by its days and never takes a line below zero', () => {
    const half = ok(lines({ ...empty, rent, concessions: [{ charge_type: 'rent', period_start: '2026-06-16', period_end: '2026-06-30', kind: 'fixed_amount', value: 1000, reason: 'Credit' }] }, 2026, 6))
    expect(amt(half, 'rent')).toBe(2500) // 3000 − 1000 × 15/30
    const huge = ok(lines({ ...empty, rent, concessions: [{ charge_type: 'rent', period_start: '2026-06-01', period_end: '2026-06-30', kind: 'fixed_amount', value: 99999, reason: 'Credit' }] }, 2026, 6))
    expect(huge.find((l) => l.type === 'rent')).toBeUndefined()
  })
  // REFUTE C4a: the zero floor of a fixed waiver applies across the days it covers, not per segment.
  it('a fixed waiver spanning a mid-month rent step nets against the whole covered gross (550, not 1500)', () => {
    const r = ok(lines({
      ...empty,
      rent: [row('2025-01-01', '2026-06-15', 100), row('2026-06-16', '2030-12-31', 5000)],
      concessions: [{ charge_type: 'rent', period_start: '2026-06-01', period_end: '2026-06-30', kind: 'fixed_amount', value: 2000, reason: 'Credit' }],
    }, 2026, 6))
    expect(amt(r, 'rent')).toBe(550) // gross 50 + 2500 = 2550, minus 2000
  })
  it('a fixed waiver larger than the gross of a stepped month floors the line at zero', () => {
    const r = ok(lines({
      ...empty,
      rent: [row('2025-01-01', '2026-06-15', 100), row('2026-06-16', '2030-12-31', 5000)],
      concessions: [{ charge_type: 'rent', period_start: '2026-06-01', period_end: '2026-06-30', kind: 'fixed_amount', value: 9000, reason: 'Credit' }],
    }, 2026, 6))
    expect(r.find((l) => l.type === 'rent')).toBeUndefined()
  })
  // REFUTE C4b: a concession too small to move the cent-rounded amount writes no note.
  it('omits the abatement note when the concession does not change the billed cents', () => {
    const r = ok(lines({ ...empty, rent, concessions: [{ charge_type: 'rent', period_start: '2026-06-01', period_end: '2026-06-30', kind: 'fixed_amount', value: 0.001, reason: 'tiny' }] }, 2026, 6))
    const l = r.find((x) => x.type === 'rent')!
    expect(l.amount).toBe(3000)
    expect(l.description).toBe('Rent – June 2026')
  })
  // REFUTE C3: enums are whitelisted by the engine, not only by the 0020 CHECKs.
  it('rejects an unknown concession kind or class and a non-recurring charge type as invalid_row', () => {
    const bad: LeaseSchedule[] = [
      { ...empty, rent, concessions: [{ charge_type: 'rent', period_start: '2026-06-01', period_end: '2026-06-30', kind: 'bogus' as never, value: 50, reason: 'x' }] },
      { ...empty, rent, concessions: [{ charge_type: 'Rent' as never, period_start: '2026-06-01', period_end: '2026-06-30', kind: 'full_waiver', value: null, reason: 'x' }] },
      { ...empty, rent, recurring: [{ id: 'x', type: 'late_fee' as never, description: 'x', amount_monthly: 50, effective_start: '2026-01-01', effective_end: '2026-12-31' }] },
    ]
    for (const s of bad) {
      const r = lines(s, 2026, 6)
      expect('exception' in r && r.exception.code).toBe('invalid_row')
    }
  })
  // Re-REFUTE finding: an 'all' fixed waiver was netted once per class (credited twice).
  it('rejects an "all" fixed-dollar concession (no defined rent/CAM split) as invalid_row', () => {
    const r = lines({ ...empty, rent, concessions: [{ charge_type: 'all', period_start: '2026-06-01', period_end: '2026-06-30', kind: 'fixed_amount', value: 500, reason: 'Credit' }] }, 2026, 6, undefined, 1000)
    expect('exception' in r && r.exception.code).toBe('invalid_row')
  })
  it('"all" applies to rent and CAM but not to utilities or other lines', () => {
    const r = ok(lines({
      rent,
      recurring: [
        { id: 'c1', type: 'cam_estimate', description: 'CAM', amount_monthly: 400, effective_start: '2025-01-01', effective_end: '2030-12-31' },
        { id: 'w1', type: 'utility_water', description: 'Water', amount_monthly: 50, effective_start: '2025-01-01', effective_end: '2030-12-31' },
        { id: 'o1', type: 'other', description: 'Tax escrow', amount_monthly: 800, effective_start: '2025-01-01', effective_end: '2030-12-31' },
      ],
      concessions: [{ charge_type: 'all', period_start: '2026-06-01', period_end: '2026-06-30', kind: 'full_waiver', value: null, reason: 'Free rent' }],
    }, 2026, 6))
    expect(r.map((l) => l.keySuffix ?? l.type).sort()).toEqual(['other:o1', 'utility_water'])
  })
  it('a cam_estimate concession does not touch rent', () => {
    const r = ok(lines({ ...empty, rent, concessions: [{ charge_type: 'cam_estimate', period_start: '2026-06-01', period_end: '2026-06-30', kind: 'full_waiver', value: null, reason: 'CAM holiday' }] }, 2026, 6, undefined, 500))
    expect(amt(r, 'rent')).toBe(3000)
    expect(r.find((l) => l.type === 'cam_estimate')).toBeUndefined()
  })
})

describe('computeScheduledLines: CAM source (recurring rows OR the lease field, never both)', () => {
  const rent = [row('2025-01-01', '2030-12-31', 3000)]
  it('uses the lease cam_estimate_monthly when the schedule has no active cam_estimate rows', () => {
    expect(amt(ok(lines({ ...empty, rent }, 2026, 6, undefined, 500)), 'cam_estimate')).toBe(500)
  })
  it('uses the recurring rows, and ignores the lease field, once any active cam_estimate row exists', () => {
    const recurring = [{ id: 'c1', type: 'cam_estimate' as const, description: 'CAM', amount_monthly: 450, effective_start: '2027-01-01', effective_end: '2030-12-31' }]
    expect(amt(ok(lines({ ...empty, rent, recurring }, 2027, 3, undefined, 500)), 'cam_estimate')).toBe(450)
    // Before the recurring row starts: no CAM at all — the lease field is NOT a fallback for gaps.
    expect(ok(lines({ ...empty, rent, recurring }, 2026, 6, undefined, 500)).find((l) => l.type === 'cam_estimate')).toBeUndefined()
  })
  it('a superseded cam row does not switch the source', () => {
    const recurring = [{ id: 'c1', type: 'cam_estimate' as const, description: 'CAM', amount_monthly: 450, effective_start: '2025-01-01', effective_end: '2030-12-31', superseded_at: '2026-01-01T00:00:00Z' }]
    expect(amt(ok(lines({ ...empty, rent, recurring }, 2026, 6, undefined, 500)), 'cam_estimate')).toBe(500)
  })
})

describe('computeScheduledLines: recurring lines', () => {
  it('keys utilities by type and "other" lines by row id, each with its own description', () => {
    const r = ok(lines({
      ...empty,
      rent: [row('2025-01-01', '2030-12-31', 3000)],
      recurring: [
        { id: 'o1', type: 'other', description: 'Tax escrow', amount_monthly: 812.5, effective_start: '2025-01-01', effective_end: '2030-12-31' },
        { id: 'o2', type: 'other', description: 'Insurance escrow', amount_monthly: 120, effective_start: '2025-01-01', effective_end: '2030-12-31' },
        { id: 'e1', type: 'utility_electric', description: 'Electric', amount_monthly: 75, effective_start: '2026-06-11', effective_end: '2030-12-31' },
      ],
    }, 2026, 6))
    expect(amt(r, 'other:o1')).toBe(812.5)
    expect(r.find((l) => l.keySuffix === 'other:o2')!.description).toBe('Insurance escrow – June 2026')
    expect(amt(r, 'utility_electric')).toBe(50) // 20 of 30 days
  })
})

describe('expandFixedEscalation', () => {
  it('3% annual bumps on each anniversary, compounding on the rounded prior rent', () => {
    const rows = expandFixedEscalation({
      termStart: '2026-01-01', termEnd: '2028-12-31', baseRentMonthly: 5000,
      rule: { kind: 'fixed_pct', value: 0.03, cadence_months: 12, first_adjustment_date: '2027-01-01', applies_until: null },
    })
    expect(rows).toEqual([
      { effective_start: '2026-01-01', effective_end: '2026-12-31', base_rent_monthly: 5000 },
      { effective_start: '2027-01-01', effective_end: '2027-12-31', base_rent_monthly: 5150 },
      { effective_start: '2028-01-01', effective_end: '2028-12-31', base_rent_monthly: 5304.5 },
    ])
  })
  it('fixed-dollar bumps stop at applies_until', () => {
    const rows = expandFixedEscalation({
      termStart: '2026-01-01', termEnd: '2029-12-31', baseRentMonthly: 1000,
      rule: { kind: 'fixed_amount', value: 100, cadence_months: 12, first_adjustment_date: '2027-01-01', applies_until: '2027-06-30' },
    })
    expect(rows).toEqual([
      { effective_start: '2026-01-01', effective_end: '2026-12-31', base_rent_monthly: 1000 },
      { effective_start: '2027-01-01', effective_end: '2029-12-31', base_rent_monthly: 1100 },
    ])
  })
  it('anchors every anniversary on the first adjustment date (no month-end drift)', () => {
    const rows = expandFixedEscalation({
      termStart: '2026-01-31', termEnd: '2026-05-30', baseRentMonthly: 100,
      rule: { kind: 'fixed_amount', value: 1, cadence_months: 1, first_adjustment_date: '2026-02-28', applies_until: null },
    }) as RentScheduleRow[]
    expect(rows.map((r) => r.effective_start)).toEqual(['2026-01-31', '2026-02-28', '2026-03-28', '2026-04-28', '2026-05-28'])
  })
  it('produced rows bill without gaps or overlaps across the whole term', () => {
    const rows = expandFixedEscalation({
      termStart: '2026-03-15', termEnd: '2031-03-14', baseRentMonthly: 4321.17,
      rule: { kind: 'fixed_pct', value: 0.035, cadence_months: 12, first_adjustment_date: '2027-03-15', applies_until: null },
    }) as RentScheduleRow[]
    for (let y = 2026; y <= 2031; y++) for (let m = 1; m <= 12; m++) {
      const r = lines({ ...empty, rent: rows }, y, m, { start: '2026-03-15', end: '2031-03-14' })
      expect('exception' in r, `${y}-${m}`).toBe(false)
    }
  })
  it('returns a review item instead of rows for CPI, and rejects a first adjustment on/before the term start', () => {
    expect(expandFixedEscalation({ termStart: '2026-01-01', termEnd: '2028-12-31', baseRentMonthly: 1,
      rule: { kind: 'cpi', value: null, cadence_months: 12, first_adjustment_date: '2027-01-01', applies_until: null } })).toEqual({ needsReview: expect.stringMatching(/CPI/) })
    expect(expandFixedEscalation({ termStart: '2026-01-01', termEnd: '2028-12-31', baseRentMonthly: 1,
      rule: { kind: 'fixed_pct', value: 0.03, cadence_months: 12, first_adjustment_date: '2026-01-01', applies_until: null } })).toEqual({ needsReview: expect.any(String) })
  })
})

// The load-bearing equivalence for the backfill (one schedule row = start..end at the lease's rent):
// billing through the schedule must produce EXACTLY the legacy charges, cent for cent and string for
// string, so switching a lease onto the schedule changes nothing until its schedule changes.
describe('buildMonthlyCharges: a backfilled single-row schedule is identical to legacy billing', () => {
  // Deterministic LCG so failures reproduce.
  let seed = 12345
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  it('matches for 2000 random leases × periods (odd cents, mid-month starts/ends, leap years)', () => {
    for (let i = 0; i < 2000; i++) {
      const start = new Date(Date.UTC(2024 + Math.floor(rnd() * 4), Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28)))
      const end = new Date(start.getTime() + Math.floor(rnd() * 1500) * 86_400_000)
      const rent = Math.round(rnd() * 2_000_000) / 100
      const cam = rnd() < 0.3 ? 0 : Math.round(rnd() * 200_000) / 100
      const pick = new Date(start.getTime() + Math.floor(rnd() * ((end.getTime() - start.getTime()) / 86_400_000 + 1)) * 86_400_000)
      const base = {
        leaseId: `l${i}`, baseRentMonthly: rent, camEstimateMonthly: cam,
        leaseStartDate: iso(start), leaseEndDate: iso(end),
        periodYear: pick.getUTCFullYear(), periodMonth: pick.getUTCMonth() + 1,
      }
      const legacy = buildMonthlyCharges(base)
      const scheduled = buildMonthlyCharges({ ...base, schedule: { rent: [row(iso(start), iso(end), rent)], recurring: [], concessions: [] } })
      expect(scheduled, JSON.stringify(base)).toEqual(legacy)
    }
  })
})

describe('buildMonthlyCharges with a schedule', () => {
  const base = { leaseId: 'L', baseRentMonthly: 1, camEstimateMonthly: 0, leaseStartDate: '2025-01-01', leaseEndDate: '2030-12-31', periodYear: 2026, periodMonth: 6 }
  it('returns no charges and an exception when the schedule is unusable', () => {
    const out = buildMonthlyCharges({ ...base, schedule: { ...empty, rent: [row('2025-01-01', '2026-05-31', 3000)] } })
    expect(out.charges).toEqual([])
    expect(out.exception?.code).toBe('schedule_gap')
  })
  it('ignores leases.base_rent_monthly once a schedule exists', () => {
    const out = buildMonthlyCharges({ ...base, baseRentMonthly: 99999, schedule: { ...empty, rent: [row('2025-01-01', '2030-12-31', 3000)] } })
    expect(out.charges.find((c) => c.type === 'rent')!.amount).toBe(3000)
  })
  it('keys "other" recurring lines per row so two escrows never collide, and keeps rent/cam keys legacy-compatible', () => {
    const out = buildMonthlyCharges({ ...base, schedule: { ...empty, rent: [row('2025-01-01', '2030-12-31', 3000)], recurring: [
      { id: 'o1', type: 'other', description: 'Tax escrow', amount_monthly: 10, effective_start: '2025-01-01', effective_end: '2030-12-31' },
      { id: 'o2', type: 'other', description: 'Ins escrow', amount_monthly: 20, effective_start: '2025-01-01', effective_end: '2030-12-31' },
    ] } })
    expect(out.charges.map((c) => c.idempotency_key).sort()).toEqual([
      'auto:L:2026-06-01:other:o1', 'auto:L:2026-06-01:other:o2', 'auto:L:2026-06-01:rent',
    ])
    expect(new Set(out.charges.map((c) => c.due_date))).toEqual(new Set(['2026-06-05']))
  })
  it('bills nothing outside the term even when schedule rows extend past it', () => {
    const out = buildMonthlyCharges({ ...base, leaseEndDate: '2026-05-31', schedule: { ...empty, rent: [row('2025-01-01', '2030-12-31', 3000)] } })
    expect(out).toEqual({ charges: [] })
  })
})
