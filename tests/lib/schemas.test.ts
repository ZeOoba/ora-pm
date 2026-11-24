// tests/lib/schemas.test.ts
import { describe, it, expect } from 'vitest'
import {
  PropertyInsertSchema,
  TenantInsertSchema,
  LeaseInsertSchema,
  ChargeInsertSchema,
  PaymentInsertSchema,
  ExpenseInsertSchema,
} from '../../server/lib/schemas'

describe('PropertyInsertSchema', () => {
  it('accepts valid property', () => {
    const result = PropertyInsertSchema.safeParse({
      name: '100 Example Rd',
      address: '100 Example Rd',
      city: 'Columbia',
      state: 'MD',
      zip: '00000',
      property_type: 'industrial',
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing required fields', () => {
    const result = PropertyInsertSchema.safeParse({ name: 'X' })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues.length).toBeGreaterThan(0)
  })

  it('rejects invalid property_type', () => {
    const result = PropertyInsertSchema.safeParse({
      name: 'X', address: 'Y', city: 'Z', state: 'MD', zip: '00000',
      property_type: 'skyscraper',
    })
    expect(result.success).toBe(false)
  })
})

describe('ChargeInsertSchema', () => {
  it('accepts valid charge', () => {
    const result = ChargeInsertSchema.safeParse({
      lease_id: '00000000-0000-0000-0000-000000000001',
      charge_date: '2026-06-01',
      due_date: '2026-06-01',
      period_start: '2026-06-01',
      period_end: '2026-06-30',
      type: 'rent',
      amount: 5000,
    })
    expect(result.success).toBe(true)
  })

  it('rejects negative amount', () => {
    const result = ChargeInsertSchema.safeParse({
      lease_id: '00000000-0000-0000-0000-000000000001',
      charge_date: '2026-06-01', due_date: '2026-06-01',
      period_start: '2026-06-01', period_end: '2026-06-30',
      type: 'rent', amount: -1,
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid charge type', () => {
    const result = ChargeInsertSchema.safeParse({
      lease_id: '00000000-0000-0000-0000-000000000001',
      charge_date: '2026-06-01', due_date: '2026-06-01',
      period_start: '2026-06-01', period_end: '2026-06-30',
      type: 'pizza', amount: 100,
    })
    expect(result.success).toBe(false)
  })

  // OI-278 / migration 0016: voided_at / void_reason are audit columns set only by a migration (or a
  // future dedicated void action), never by POST /api/charges. The schema must strip them so a
  // client cannot mass-assign a pre-voided charge (or a half-void the DB CHECK would reject).
  it('strips voided_at and void_reason from an insert payload (void is not a client-settable state)', () => {
    const result = ChargeInsertSchema.safeParse({
      lease_id: '00000000-0000-0000-0000-000000000001',
      charge_date: '2026-06-01', due_date: '2026-06-01',
      period_start: '2026-06-01', period_end: '2026-06-30',
      type: 'late_fee', amount: 50,
      voided_at: '2026-09-13T12:00:00Z', void_reason: 'client-supplied',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).not.toHaveProperty('voided_at')
      expect(result.data).not.toHaveProperty('void_reason')
    }
  })
})

describe('TenantInsertSchema', () => {
  it('accepts valid tenant', () => {
    const result = TenantInsertSchema.safeParse({ name: 'Acme Corp' })
    expect(result.success).toBe(true)
  })

  it('rejects missing name', () => {
    const result = TenantInsertSchema.safeParse({ contact_name: 'John' })
    expect(result.success).toBe(false)
  })
})

describe('LeaseInsertSchema', () => {
  // Audit 2026-11-23 MED (autopay-no-absolute-ceiling): a rent mistyped with extra digits was
  // billed and autopay-debited in the same run. Bounded by the portal's $50,000 ceiling, to the cent.
  const lease = (extra: Record<string, unknown>) => LeaseInsertSchema.safeParse({
    tenant_id: '00000000-0000-0000-0000-000000000001',
    unit_id: '00000000-0000-0000-0000-000000000002',
    start_date: '2026-01-01',
    end_date: '2027-01-01',
    base_rent_monthly: 3500,
    ...extra,
  }).success

  it('bounds base_rent_monthly and cam_estimate_monthly at the payment ceiling and to the cent', () => {
    expect(lease({ base_rent_monthly: 50000 })).toBe(true)
    expect(lease({ base_rent_monthly: 50000.01 })).toBe(false)
    expect(lease({ base_rent_monthly: 350000 })).toBe(false)
    expect(lease({ base_rent_monthly: 3500.25 })).toBe(true)
    expect(lease({ base_rent_monthly: 3500.255 })).toBe(false)
    expect(lease({ cam_estimate_monthly: 50000 })).toBe(true)
    expect(lease({ cam_estimate_monthly: 50000.01 })).toBe(false)
    expect(lease({ cam_estimate_monthly: 12.345 })).toBe(false)
    expect(lease({ cam_estimate_monthly: 0 })).toBe(true)
  })

  it('accepts valid lease', () => {
    const result = LeaseInsertSchema.safeParse({
      tenant_id: '00000000-0000-0000-0000-000000000001',
      unit_id: '00000000-0000-0000-0000-000000000002',
      start_date: '2026-01-01',
      end_date: '2027-01-01',
      base_rent_monthly: 3500,
    })
    expect(result.success).toBe(true)
  })

  it('rejects non-positive base_rent_monthly', () => {
    const result = LeaseInsertSchema.safeParse({
      tenant_id: '00000000-0000-0000-0000-000000000001',
      unit_id: '00000000-0000-0000-0000-000000000002',
      start_date: '2026-01-01',
      end_date: '2027-01-01',
      base_rent_monthly: 0,
    })
    expect(result.success).toBe(false)
  })
})

describe('ExpenseInsertSchema', () => {
  it('accepts valid expense', () => {
    const result = ExpenseInsertSchema.safeParse({
      property_id: '00000000-0000-0000-0000-000000000001',
      expense_date: '2026-06-01',
      amount: 1200,
      category: 'maintenance',
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid category', () => {
    const result = ExpenseInsertSchema.safeParse({
      property_id: '00000000-0000-0000-0000-000000000001',
      expense_date: '2026-06-01',
      amount: 1200,
      category: 'snacks',
    })
    expect(result.success).toBe(false)
  })
})

describe('PaymentInsertSchema', () => {
  it('rejects non-positive amount', () => {
    const result = PaymentInsertSchema.safeParse({
      lease_id: '00000000-0000-0000-0000-000000000001',
      payment_date: '2026-06-01', amount: 0, method: 'check',
    })
    expect(result.success).toBe(false)
  })

  it('accepts valid payment', () => {
    const result = PaymentInsertSchema.safeParse({
      lease_id: '00000000-0000-0000-0000-000000000001',
      payment_date: '2026-06-01', amount: 1000, method: 'check',
    })
    expect(result.success).toBe(true)
  })
})
