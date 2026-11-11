import { describe, it, expect } from 'vitest'
import { abstractToLegacyFields } from '../../../evals/lease-intake-model-eval/abstract-adapter'
import { emptyAbstract } from '../../../server/lib/lease-abstract'

const src = { page: 1, quote: 'q', confidence: 1 }
const rentRow = (start: string, end: string, monthly: number | null) =>
  ({ start, end, amount_as_written: '$1.00', amount_period: 'month' as const, base_rent_monthly: monthly, rent_psf_annual: null, ...src })
const charge = (type: 'cam_estimate' | 'utility_water' | 'other', start: string, monthly: number | null) =>
  ({ type, description: type, amount_as_written: '$1.00', amount_period: 'month' as const, amount_monthly: monthly, effective_start: start, effective_end: '2031-02-28', ...src })

describe('abstractToLegacyFields', () => {
  it('maps term dates, first rent period, first CAM line, deposit, rent type and expense stop', () => {
    const a = emptyAbstract()
    a.commencement_date = { value: '2026-03-01', ...src }
    a.expiration_date = { value: '2031-02-28', ...src }
    a.rent_type = { value: 'nnn', ...src }
    a.security_deposit = { value: 9000, ...src }
    a.expense_stop_psf_annual = { value: 4.5, ...src }
    a.rent_schedule = [rentRow('2027-03-01', '2031-02-28', 4635), rentRow('2026-03-01', '2027-02-28', 4500)]
    a.recurring_charges = [charge('cam_estimate', '2026-03-01', 600)]
    expect(abstractToLegacyFields(a)).toEqual({
      start_date: '2026-03-01', end_date: '2031-02-28', rent_type: 'nnn', security_deposit: 9000,
      expense_stop_amount: 4.5, base_rent_monthly: 4500, cam_estimate_monthly: 600,
    })
  })
  // Round-1 survivors AD02/AD03: only CAM lines count, and the EARLIEST CAM line wins.
  it('takes the earliest cam_estimate line and ignores other recurring types', () => {
    const a = emptyAbstract()
    a.recurring_charges = [
      charge('utility_water', '2026-01-01', 75),
      charge('cam_estimate', '2027-03-01', 650),
      charge('other', '2025-01-01', 900),
      charge('cam_estimate', '2026-03-01', 600),
    ]
    expect(abstractToLegacyFields(a).cam_estimate_monthly).toBe(600)
  })
  // AD05 (round-3 survivor): the legacy start_date is the lease commencement, not the rent commencement.
  it('start_date is the commencement date even when rent commences later', () => {
    const a = emptyAbstract()
    a.commencement_date = { value: '2026-03-01', ...src }
    a.rent_commencement_date = { value: '2026-06-01', ...src }
    expect(abstractToLegacyFields(a).start_date).toBe('2026-03-01')
  })
  // AD04: an unresolved (null) amount is omitted, never reported as a value.
  it('omits unresolved amounts and fields the abstract left null', () => {
    const a = emptyAbstract()
    a.rent_schedule = [rentRow('2026-03-01', '2027-02-28', null)]
    a.recurring_charges = [charge('cam_estimate', '2026-03-01', null)]
    expect(abstractToLegacyFields(a)).toEqual({})
    expect(abstractToLegacyFields(emptyAbstract())).toEqual({})
  })
})
