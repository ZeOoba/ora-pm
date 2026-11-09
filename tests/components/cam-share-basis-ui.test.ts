/// <reference types="node" />
// CAM ruling 2026-11-08 (building RSF denominator, lease-stated share, base year): every capture
// point labels its unit, the share is typed as a percent and stored as a fraction, and the CAM page
// shows the basis. Source scans (no React-rendering harness in this repo), same approach as
// tests/components/expense-stop-unit-label.test.ts.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildExtractionRequest, parseExtractionResponse } from '../../server/lib/lease-extract'
import { LeaseInsertSchema, PropertyInsertSchema } from '../../server/lib/schemas'

const read = (p: string) => readFileSync(join(__dirname, '../..', p), 'utf-8')

describe('LeaseForm: Proportionate Share and base year', () => {
  const src = read('src/pages/leases/LeaseForm.tsx')
  it('labels each new field with its unit', () => {
    expect(src).toContain('label="Proportionate Share (%)"')
    expect(src).toContain('label="Base Year (calendar year)"')
    expect(src).toContain('label="Base-Year Expenses ($ total, whole pool)"')
  })
  it('sends the typed percent as a fraction (divided by 100)', () => {
    expect(src).toMatch(/proportionate_share_pct:\s*form\.proportionate_share_percent === '' \? null : Number\(form\.proportionate_share_percent\) \/ 100/)
  })
})

describe('PropertyForm: CAM denominator', () => {
  it('labels the field as rentable SF from the lease form, not summed unit SF', () => {
    const src = read('src/pages/properties/PropertyForm.tsx')
    expect(src).toContain('label="CAM Denominator (rentable SF)"')
    expect(src).toMatch(/Not the sum of unit SF/)
  })
})

describe('lease-extract: share and base-year fields', () => {
  const tool = buildExtractionRequest(['page'], 'model').tools[0]
  const props = tool.input_schema.properties as Record<string, { description?: string }>
  it('asks for the share as a PERCENT and the base amount as total dollars (never $/SF)', () => {
    expect(props.proportionate_share_percent.description).toMatch(/PERCENT/)
    expect(props.base_year.description).toMatch(/calendar year/)
    expect(props.base_year_expense_amount.description).toMatch(/TOTAL in dollars/)
    expect(props.base_year_expense_amount.description).toMatch(/Never a \$\/SF/)
  })
  it('keeps in-range values and drops out-of-range ones', () => {
    const r = (input: Record<string, unknown>) => parseExtractionResponse({ content: [{ type: 'tool_use', name: 'extract_lease', input }] }).fields
    expect(r({ proportionate_share_percent: 12.5, base_year: 2026, base_year_expense_amount: 90000 }))
      .toEqual({ proportionate_share_percent: 12.5, base_year: 2026, base_year_expense_amount: 90000 })
    expect(r({ proportionate_share_percent: 0, base_year: 26, base_year_expense_amount: -1 })).toEqual({})
    expect(r({ proportionate_share_percent: 125 })).toEqual({})
  })
})

describe('API schemas', () => {
  const lease = { tenant_id: '11111111-1111-4111-8111-111111111111', unit_id: '11111111-1111-4111-8111-111111111112', start_date: '2026-01-01', end_date: '2027-01-01', base_rent_monthly: 100 }
  it('lease proportionate_share_pct is a fraction in (0, 1] (a percent typed as 12.5 is refused)', () => {
    expect(LeaseInsertSchema.safeParse({ ...lease, proportionate_share_pct: 0.125 }).success).toBe(true)
    expect(LeaseInsertSchema.safeParse({ ...lease, proportionate_share_pct: 1 }).success).toBe(true)
    expect(LeaseInsertSchema.safeParse({ ...lease, proportionate_share_pct: 12.5 }).success).toBe(false)
    expect(LeaseInsertSchema.safeParse({ ...lease, proportionate_share_pct: 0 }).success).toBe(false)
  })
  it('lease base_year is an integer year and base_year_expense_amount is >= 0', () => {
    expect(LeaseInsertSchema.safeParse({ ...lease, base_year: 2026, base_year_expense_amount: 0 }).success).toBe(true)
    expect(LeaseInsertSchema.safeParse({ ...lease, base_year: 2026.5 }).success).toBe(false)
    expect(LeaseInsertSchema.safeParse({ ...lease, base_year_expense_amount: -1 }).success).toBe(false)
  })
  it('property cam_denominator_rsf must be positive or null', () => {
    const p = { name: 'P', address: 'A', city: 'C', state: 'OH', property_type: 'industrial' as const }
    expect(PropertyInsertSchema.safeParse({ ...p, cam_denominator_rsf: 31200 }).success).toBe(true)
    expect(PropertyInsertSchema.safeParse({ ...p, cam_denominator_rsf: null }).success).toBe(true)
    expect(PropertyInsertSchema.safeParse({ ...p, cam_denominator_rsf: 0 }).success).toBe(false)
  })
})

describe('CAMList shows the share basis', () => {
  const src = read('src/pages/cam/CAMList.tsx')
  it('shows the building-RSF denominator from /cam/pool and each lease\'s basis', () => {
    expect(src).toMatch(/denominator_rsf/)
    expect(src).toMatch(/SHARE_BASIS_LABEL\[l\.share_basis\]/)
    expect(src).toMatch(/l\.share_error/)
  })
  it('shows each saved reconciliation\'s share and recovery basis and its warnings', () => {
    expect(src).toMatch(/SHARE_BASIS_LABEL\[row\.share_basis\]/)
    expect(src).toMatch(/RECOVERY_BASIS_LABEL\[row\.recovery_basis\]/)
    expect(src).toMatch(/row\.basis_warnings/)
  })
  it('surfaces non-blocking warnings returned by /cam/calculate', () => {
    expect(src).toMatch(/setCalcWarnings/)
  })
})

// REFUTE D2: the extractor is told PERCENT; a value under 1 is most likely a fraction (0.125 for
// 12.5%) and is dropped rather than stored 100x too small. LeaseForm flags a typed value under 1.
describe('fraction-for-percent guard (REFUTE D2)', () => {
  it('lease-extract drops a proportionate_share_percent under 1', () => {
    const r = (input: Record<string, unknown>) => parseExtractionResponse({ content: [{ type: 'tool_use', name: 'extract_lease', input }] }).fields
    expect(r({ proportionate_share_percent: 0.125 })).toEqual({})
    expect(r({ proportionate_share_percent: 1 })).toEqual({ proportionate_share_percent: 1 })
  })
  it('LeaseForm warns when the typed percent is under 1', () => {
    expect(read('src/pages/leases/LeaseForm.tsx')).toMatch(/Under 1%/)
  })
})
