import { describe, it, expect } from 'vitest'
import { bucketByAge, buildAgingRow } from '../../server/lib/ar-aging'

describe('bucketByAge', () => {
  it('returns current for 0 days past due', () => expect(bucketByAge(0).bucket).toBe('current'))
  it('returns current for negative (not yet due)', () => expect(bucketByAge(-5).bucket).toBe('current'))
  it('returns 1_30 for 15 days past due', () => expect(bucketByAge(15).bucket).toBe('1_30'))
  it('returns 31_60 for 45 days past due', () => expect(bucketByAge(45).bucket).toBe('31_60'))
  it('returns 61_90 for 75 days past due', () => expect(bucketByAge(75).bucket).toBe('61_90'))
  it('returns 90_plus for 91 days past due', () => expect(bucketByAge(91).bucket).toBe('90_plus'))
  it('returns 1_30 for exactly 30 days past due', () => expect(bucketByAge(30).bucket).toBe('1_30'))
  it('returns 31_60 for exactly 31 days', () => expect(bucketByAge(31).bucket).toBe('31_60'))
})

describe('buildAgingRow', () => {
  const lease = { lease_id: 'l1', tenant_name: 'Acme', property_name: 'REDACTED-020', suite: 'A1' }
  const today = new Date('2026-06-15')

  it('places unpaid charge in correct bucket', () => {
    const charges = [{ amount: 1000, due_date: '2026-06-01', paid_amount: 0 }]
    const row = buildAgingRow(lease, charges, today)
    expect(row.days_1_30).toBe(1000)
    expect(row.balance).toBe(1000)
  })

  it('ignores fully paid charges', () => {
    const charges = [{ amount: 1000, due_date: '2026-06-01', paid_amount: 1000 }]
    const row = buildAgingRow(lease, charges, today)
    expect(row.balance).toBe(0)
  })

  it('partially outstanding charge goes to correct bucket', () => {
    const charges = [{ amount: 1000, due_date: '2026-06-01', paid_amount: 400 }]
    const row = buildAgingRow(lease, charges, today)
    expect(row.balance).toBe(600)
    expect(row.days_1_30).toBe(600)
  })
})
