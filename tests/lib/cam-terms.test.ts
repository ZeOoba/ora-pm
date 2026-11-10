import { describe, it, expect } from 'vitest'
import {
  CAM_CATEGORIES, CAM_CATEGORY_PRESETS, camTermsFormFromLease, camTermsPayload, fractionToPercentText, validateCamTerms, type CamTermsForm,
} from '../../src/lib/cam-terms'
import { LeaseUpdateSchema } from '../../server/lib/schemas'
import { EXPENSE_CATEGORIES } from '../../server/lib/cam'

// REFUTE M2 (2026-11-10): the CAM terms of an existing lease are edited on Lease Detail. These pin
// the percent <-> fraction round trip and that every payload the editor can produce is one the
// server's LeaseUpdateSchema (and the 0021 CHECKs behind it) accepts.
const blank: CamTermsForm = {
  rent_type: 'nnn', proportionate_share_percent: '', base_year: '', base_year_expense_amount: '', expense_stop_amount: '',
  cam_reconciled: true, cam_exclusion_reason: '', recoverable_categories: null, cam_annual_cap: '', cam_cap_through: '',
  saved_base_year_categories: null, saved_base_year_expense_amount: '',
}
// 0024 defaults in a payload: every recoverable expense, no cap, reconciled.
const P0024 = { recoverable_categories: null, base_year_categories: null, cam_annual_cap: null, cam_cap_through: null, cam_reconciled: true, cam_exclusion_reason: null }

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
    expect(p).toEqual({ rent_type: 'nnn', proportionate_share_pct: 0.1111, base_year: 2022, base_year_expense_amount: 185700, expense_stop_amount: null, ...P0024 })
  })

  it('blank fields clear to null (a share removed falls back to premises SF / building RSF)', () => {
    expect(camTermsPayload(blank)).toEqual({ rent_type: 'nnn', proportionate_share_pct: null, base_year: null, base_year_expense_amount: null, expense_stop_amount: null, ...P0024 })
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

  it('REFUTE C6: a base year needs its amount, above $0 (the engine refuses both otherwise)', () => {
    expect(validateCamTerms({ ...blank, base_year: '2024' }).base_year_expense_amount).toMatch(/Required with a base year/)
    expect(validateCamTerms({ ...blank, base_year: '2024', base_year_expense_amount: '0' }).base_year_expense_amount).toMatch(/above \$0/)
  })

  it('REFUTE C6: modified gross with a base year and no stop is valid (the engine accepts it)', () => {
    expect(validateCamTerms({ ...blank, rent_type: 'modified_gross', base_year: '2022', base_year_expense_amount: '50000' })).toEqual({})
  })

  it('REFUTE D4: a share that rounds to a zero fraction is rejected up front', () => {
    expect(validateCamTerms({ ...blank, proportionate_share_percent: '0.0000001' }).proportionate_share_percent).toBeDefined()
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
      { ...blank, proportionate_share_percent: '33.94', base_year: '2016', base_year_expense_amount: '120000' },
      { ...blank, rent_type: 'modified_gross', base_year: '2022', base_year_expense_amount: '50000' },
      { ...blank, rent_type: 'gross' },
      { ...blank, rent_type: 'modified_gross', expense_stop_amount: '6.25' },
    ]
    for (const f of valid) {
      expect(validateCamTerms(f)).toEqual({})
      expect(LeaseUpdateSchema.safeParse(camTermsPayload(f)).success).toBe(true)
    }
  })
})

// 0024 (Gabriel rulings 2026-11-10): recoverable categories, annual cap, not-reconciled flag.
describe('0024 CAM terms: categories, cap, not reconciled', () => {
  it('the client category list mirrors the server engine', () => {
    expect([...CAM_CATEGORIES]).toEqual([...EXPENSE_CATEGORIES])
  })

  it('a lease read before 0024 (no columns) opens as reconciled, all categories, no cap', () => {
    const f = camTermsFormFromLease({ rent_type: 'nnn', proportionate_share_pct: null, base_year: null, base_year_expense_amount: null, expense_stop_amount: null })
    expect(f).toMatchObject({ cam_reconciled: true, recoverable_categories: null, cam_annual_cap: '', cam_cap_through: '', cam_exclusion_reason: '' })
  })

  it('round trip: suite 507 cap, taxes-only, excluded lease', () => {
    const lease = {
      rent_type: 'nnn' as const, proportionate_share_pct: 0.125, base_year: null, base_year_expense_amount: null, expense_stop_amount: null,
      recoverable_categories: ['taxes', 'insurance', 'maintenance'], cam_annual_cap: 15000, cam_cap_through: '2029-06-30',
      cam_reconciled: true, cam_exclusion_reason: null,
    }
    expect(camTermsPayload(camTermsFormFromLease(lease))).toMatchObject({
      recoverable_categories: ['taxes', 'insurance', 'maintenance'], cam_annual_cap: 15000, cam_cap_through: '2029-06-30', cam_reconciled: true, cam_exclusion_reason: null,
    })
  })

  it('categories are saved in canonical order whatever order they were ticked', () => {
    expect(camTermsPayload({ ...blank, recoverable_categories: ['utilities', 'maintenance'] }).recoverable_categories).toEqual(['maintenance', 'utilities'])
  })

  it('presets: All stores NULL; Taxes only; CAM only excludes taxes and insurance', () => {
    expect(CAM_CATEGORY_PRESETS.map((p) => p.categories)).toEqual([null, ['taxes'], ['maintenance', 'utilities', 'other']])
  })

  it('not reconciled needs a reason; the reason is dropped when reconciled', () => {
    expect(validateCamTerms({ ...blank, cam_reconciled: false }).cam_exclusion_reason).toBeDefined()
    expect(validateCamTerms({ ...blank, cam_reconciled: false, cam_exclusion_reason: '  ' }).cam_exclusion_reason).toBeDefined()
    expect(validateCamTerms({ ...blank, cam_reconciled: false, cam_exclusion_reason: 'Direct pay' })).toEqual({})
    expect(camTermsPayload({ ...blank, cam_reconciled: true, cam_exclusion_reason: 'stale' }).cam_exclusion_reason).toBeNull()
  })

  it('an empty category list is refused (use not-reconciled instead)', () => {
    expect(validateCamTerms({ ...blank, recoverable_categories: [] }).recoverable_categories).toBeDefined()
  })

  it('cap must be > 0; cap end date must be a real date and needs a cap', () => {
    expect(validateCamTerms({ ...blank, cam_annual_cap: '0' }).cam_annual_cap).toBeDefined()
    expect(validateCamTerms({ ...blank, cam_annual_cap: 'abc' }).cam_annual_cap).toBeDefined()
    expect(validateCamTerms({ ...blank, cam_annual_cap: '0.001' }).cam_annual_cap).toBeDefined()
    expect(validateCamTerms({ ...blank, cam_cap_through: '2029-06-30' }).cam_cap_through).toMatch(/needs the annual cap/)
    expect(validateCamTerms({ ...blank, cam_annual_cap: '15000', cam_cap_through: '2029-02-30' }).cam_cap_through).toBeDefined()
    expect(validateCamTerms({ ...blank, cam_annual_cap: '15000', cam_cap_through: '2029-06-30' })).toEqual({})
  })

  it('every valid 0024 payload is accepted by the server LeaseUpdateSchema; invalid ones are not', () => {
    const valid: CamTermsForm[] = [
      { ...blank, recoverable_categories: ['taxes'] },
      { ...blank, recoverable_categories: ['maintenance', 'utilities', 'other'] },
      { ...blank, cam_annual_cap: '15000', cam_cap_through: '2029-06-30' },
      { ...blank, cam_annual_cap: '15000' },
      { ...blank, cam_reconciled: false, cam_exclusion_reason: 'Tenant pays taxes directly (Second Amendment)' },
    ]
    for (const f of valid) {
      expect(validateCamTerms(f)).toEqual({})
      expect(LeaseUpdateSchema.safeParse(camTermsPayload(f)).success).toBe(true)
    }
    expect(LeaseUpdateSchema.safeParse({ cam_reconciled: false, cam_exclusion_reason: null }).success).toBe(false)
    expect(LeaseUpdateSchema.safeParse({ cam_annual_cap: null, cam_cap_through: '2029-06-30' }).success).toBe(false)
    expect(LeaseUpdateSchema.safeParse({ recoverable_categories: [] }).success).toBe(false)
    expect(LeaseUpdateSchema.safeParse({ recoverable_categories: ['taxes', 'taxes'] }).success).toBe(false)
    expect(LeaseUpdateSchema.safeParse({ recoverable_categories: ['cam'] }).success).toBe(false)
    expect(LeaseUpdateSchema.safeParse({ cam_annual_cap: 0 }).success).toBe(false)
  })
})

describe('REFUTE 0024: base-year amount tied to its categories; cap/date bounds', () => {
  const baseLease = {
    rent_type: 'nnn' as const, proportionate_share_pct: null, base_year: 2024, base_year_expense_amount: 41000, expense_stop_amount: null,
    recoverable_categories: ['taxes'], base_year_categories: ['taxes'],
  }

  it('the payload stamps base_year_categories with the current categories (none without a base year)', () => {
    expect(camTermsPayload({ ...blank, base_year: '2024', base_year_expense_amount: '41000', recoverable_categories: ['taxes'] }).base_year_categories).toEqual(['taxes'])
    expect(camTermsPayload({ ...blank, base_year: '2024', base_year_expense_amount: '41000' }).base_year_categories).toBeNull()
    expect(camTermsPayload({ ...blank, recoverable_categories: ['taxes'] }).base_year_categories).toBeNull()
  })

  it('changing the categories of a base-year lease requires re-entering the base amount', () => {
    const f = camTermsFormFromLease(baseLease)
    expect(validateCamTerms(f)).toEqual({})
    expect(validateCamTerms({ ...f, recoverable_categories: null }).base_year_expense_amount).toMatch(/re-enter/)
    expect(validateCamTerms({ ...f, recoverable_categories: null, base_year_expense_amount: '120000' })).toEqual({})
    // same set, different order: unchanged
    expect(validateCamTerms({ ...camTermsFormFromLease({ ...baseLease, recoverable_categories: ['taxes', 'insurance'], base_year_categories: ['insurance', 'taxes'] }) })).toEqual({})
  })

  it('cap: at most 2 decimals and within NUMERIC(12,2), on the client and the server', () => {
    for (const bad of ['0.001', '15000.999', '99999999999']) {
      expect(validateCamTerms({ ...blank, cam_annual_cap: bad }).cam_annual_cap).toBeDefined()
    }
    for (const bad of [0.001, 15000.999, 1e13]) expect(LeaseUpdateSchema.safeParse({ cam_annual_cap: bad }).success).toBe(false)
    expect(LeaseUpdateSchema.safeParse({ cam_annual_cap: 15000.5 }).success).toBe(true)
  })

  it('cap end date must be a real date on the server too', () => {
    expect(LeaseUpdateSchema.safeParse({ cam_annual_cap: 15000, cam_cap_through: '2026-02-30' }).success).toBe(false)
    expect(LeaseUpdateSchema.safeParse({ cam_annual_cap: 15000, cam_cap_through: '2028-02-29' }).success).toBe(true)
  })
})
