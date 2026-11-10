import { describe, it, expect } from 'vitest'
import { camTermsFormFromLease, camTermsPayload, fractionToPercentText, validateCamTerms, type CamTermsForm } from '../../src/lib/cam-terms'
import { LeaseUpdateSchema } from '../../server/lib/schemas'

// REFUTE M2 (2026-11-10): the CAM terms of an existing lease are edited on Lease Detail. These pin
// the percent <-> fraction round trip and that every payload the editor can produce is one the
// server's LeaseUpdateSchema (and the 0021 CHECKs behind it) accepts.
const blank: CamTermsForm = { rent_type: 'nnn', proportionate_share_percent: '', base_year: '', base_year_expense_amount: '', expense_stop_amount: '' }

describe('fractionToPercentText', () => {
  it('shows stored fractions as clean percents', () => {
    expect(fractionToPercentText(0.1111)).toBe('11.11')
    expect(fractionToPercentText(0.0625)).toBe('6.25')
    expect(fractionToPercentText(0.03125)).toBe('3.125')
    expect(fractionToPercentText(1)).toBe('100')
    expect(fractionToPercentText(null)).toBe('')
  })
})

describe('camTermsFormFromLease -> camTermsPayload round trip', () => {
  it('a stated 11.11% share and a base year survive unchanged', () => {
    const lease = { rent_type: 'nnn' as const, proportionate_share_pct: 0.1111, base_year: 2022, base_year_expense_amount: 185700, expense_stop_amount: null }
    const p = camTermsPayload(camTermsFormFromLease(lease))
    expect(p).toEqual({ rent_type: 'nnn', proportionate_share_pct: 0.1111, base_year: 2022, base_year_expense_amount: 185700, expense_stop_amount: null })
  })

  it('blank fields clear to null (a share removed falls back to premises SF / building RSF)', () => {
    expect(camTermsPayload(blank)).toEqual({ rent_type: 'nnn', proportionate_share_pct: null, base_year: null, base_year_expense_amount: null, expense_stop_amount: null })
  })

  it('a percent typed as 12.5 is stored as the fraction 0.125, never 12.5', () => {
    expect(camTermsPayload({ ...blank, proportionate_share_percent: '12.5' }).proportionate_share_pct).toBe(0.125)
  })
})

describe('validateCamTerms', () => {
  it('accepts the shapes the leases actually use', () => {
    expect(validateCamTerms({ ...blank, proportionate_share_percent: '5.56' })).toEqual({})
    expect(validateCamTerms({ ...blank, base_year: '2022', base_year_expense_amount: '185700' })).toEqual({})
    expect(validateCamTerms({ ...blank, rent_type: 'gross' })).toEqual({})
    expect(validateCamTerms({ ...blank, rent_type: 'modified_gross', expense_stop_amount: '4.5' })).toEqual({})
  })

  it('rejects a share outside (0, 100] %', () => {
    expect(validateCamTerms({ ...blank, proportionate_share_percent: '0' }).proportionate_share_percent).toBeDefined()
    expect(validateCamTerms({ ...blank, proportionate_share_percent: '100.5' }).proportionate_share_percent).toBeDefined()
    expect(validateCamTerms({ ...blank, proportionate_share_percent: 'abc' }).proportionate_share_percent).toBeDefined()
  })

  it('rejects a non-calendar base year, and a base-year amount with no base year', () => {
    expect(validateCamTerms({ ...blank, base_year: '22' }).base_year).toBeDefined()
    expect(validateCamTerms({ ...blank, base_year: '2022.5' }).base_year).toBeDefined()
    expect(validateCamTerms({ ...blank, base_year_expense_amount: '1000' }).base_year).toMatch(/Required/)
  })

  it('rejects a base year combined with an expense stop, and modified gross without a stop', () => {
    expect(validateCamTerms({ ...blank, base_year: '2022', expense_stop_amount: '4' }).expense_stop_amount).toMatch(/not both/)
    expect(validateCamTerms({ ...blank, rent_type: 'modified_gross' }).expense_stop_amount).toMatch(/needs an expense stop/)
  })

  it('every payload that passes validation is accepted by the server LeaseUpdateSchema', () => {
    const valid: CamTermsForm[] = [
      blank,
      { ...blank, proportionate_share_percent: '100' },
      { ...blank, proportionate_share_percent: '0.5' },
      { ...blank, proportionate_share_percent: '33.94', base_year: '2016', base_year_expense_amount: '0' },
      { ...blank, rent_type: 'gross' },
      { ...blank, rent_type: 'modified_gross', expense_stop_amount: '6.25' },
    ]
    for (const f of valid) {
      expect(validateCamTerms(f)).toEqual({})
      expect(LeaseUpdateSchema.safeParse(camTermsPayload(f)).success).toBe(true)
    }
  })
})
