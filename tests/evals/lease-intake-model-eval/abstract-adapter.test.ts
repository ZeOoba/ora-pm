import { describe, it, expect } from 'vitest'
import { abstractToLegacyFields } from '../../../evals/lease-intake-model-eval/abstract-adapter'
import { emptyAbstract } from '../../../server/lib/lease-abstract'

const src = { page: 1, quote: 'q', confidence: 1 }

describe('abstractToLegacyFields', () => {
  it('maps term dates, first rent period, first CAM line, deposit, rent type and expense stop', () => {
    const a = emptyAbstract()
    a.commencement_date = { value: '2026-03-01', ...src }
    a.expiration_date = { value: '2031-02-28', ...src }
    a.rent_type = { value: 'nnn', ...src }
    a.security_deposit = { value: 9000, ...src }
    a.expense_stop_psf_annual = { value: 4.5, ...src }
    a.rent_schedule = [
      { start: '2027-03-01', end: '2031-02-28', base_rent_monthly: 4635, rent_psf_annual: null, ...src },
      { start: '2026-03-01', end: '2027-02-28', base_rent_monthly: 4500, rent_psf_annual: null, ...src },
    ]
    a.recurring_charges = [{ type: 'cam_estimate', description: 'CAM', amount_monthly: 600, effective_start: '2026-03-01', effective_end: '2031-02-28', ...src }]
    expect(abstractToLegacyFields(a)).toEqual({
      start_date: '2026-03-01', end_date: '2031-02-28', rent_type: 'nnn', security_deposit: 9000,
      expense_stop_amount: 4.5, base_rent_monthly: 4500, cam_estimate_monthly: 600,
    })
  })
  it('omits fields the abstract left null, so they score as silent, not wrong', () => {
    expect(abstractToLegacyFields(emptyAbstract())).toEqual({})
  })
})
