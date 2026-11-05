import { describe, it, expect } from 'vitest'
import { allocateOldestFirst, toCents, daysPastDue, bucketByAge, buildAgingRow, type AllocationCharge, type AgingBucketsCents } from '../../server/lib/ar-aging'

// Payments apply OLDEST-FIRST (OI-234, ruled 2026-09-12 — same rule as cron.ts delinquency), so
// whatever balance remains is owed on the NEWEST charges. These tests pin that allocation.

const AS_OF = '2026-11-05'
const sum = (b: AgingBucketsCents) => b.current + b.d1_30 + b.d31_60 + b.d61_90 + b.d90_plus + b.unallocated

// A charge due `days` days before AS_OF (date-only, UTC calendar arithmetic).
function dueDaysAgo(days: number): string {
  const d = new Date(Date.UTC(2026, 10, 5) - days * 86_400_000)
  return d.toISOString().slice(0, 10)
}
let n = 0
const ch = (days: number, amountCents: number, id = `c_${String(n++).padStart(4, '0')}`): AllocationCharge =>
  ({ id, due_date: dueDaysAgo(days), amountCents })

describe('existing exports unchanged', () => {
  it('bucketByAge / buildAgingRow still behave as before', () => {
    expect(bucketByAge(0).bucket).toBe('current')
    expect(bucketByAge(91).bucket).toBe('90_plus')
    const row = buildAgingRow({ lease_id: 'l', tenant_name: 't', property_name: 'p', suite: 's' },
      [{ amount: 1000, due_date: '2026-06-01', paid_amount: 400 }], new Date('2026-06-15'))
    expect(row.days_1_30).toBe(600)
  })
})

describe('daysPastDue', () => {
  it('is whole calendar days, date-only', () => {
    expect(daysPastDue('2026-11-05', AS_OF)).toBe(0)
    expect(daysPastDue('2026-11-06', AS_OF)).toBe(-1)
    expect(daysPastDue('2026-10-06', AS_OF)).toBe(30)
    expect(daysPastDue('2026-10-05', AS_OF)).toBe(31)
    // across a US DST boundary (2026-11-01) — UTC arithmetic, no 23/25-hour day drift
    expect(daysPastDue('2026-10-31', AS_OF)).toBe(5)
  })
  it('returns NaN for a malformed date', () => {
    expect(Number.isNaN(daysPastDue('not-a-date', AS_OF))).toBe(true)
    expect(Number.isNaN(daysPastDue('2026-13-45', AS_OF))).toBe(true)
  })
})

describe('toCents', () => {
  it('converts numbers and PostgREST NUMERIC strings to integer cents', () => {
    expect(toCents('1234.10')).toBe(123410)
    expect(toCents(1234.1)).toBe(123410)
    expect(toCents('0.1')).toBe(10)
    expect(toCents(0.29)).toBe(29) // 0.29*100 = 28.999999999999996 in floating point
    expect(toCents('100')).toBe(10000)
    expect(toCents(0)).toBe(0)
  })
  it('returns null for non-numeric input (caller fails closed)', () => {
    expect(toCents('abc')).toBeNull()
    expect(toCents(null)).toBeNull()
    expect(toCents(undefined)).toBeNull()
    expect(toCents('')).toBeNull()
    expect(toCents(Number.NaN)).toBeNull()
    expect(toCents(Infinity)).toBeNull()
  })
})

describe('allocateOldestFirst', () => {
  it('nothing paid: every charge sits in its own age bucket (0/15/45/75/120 days)', () => {
    const charges = [ch(0, 100_00), ch(15, 200_00), ch(45, 300_00), ch(75, 400_00), ch(120, 500_00)]
    const b = allocateOldestFirst(1500_00, charges, AS_OF)
    expect(b).toEqual({ current: 100_00, d1_30: 200_00, d31_60: 300_00, d61_90: 400_00, d90_plus: 500_00, unallocated: 0 })
    expect(sum(b)).toBe(1500_00)
  })

  it('partial payment leaving a balance inside the newest charge: all of it is current', () => {
    // Charged 1000 (120 days ago) + 1000 (today); paid 1250 → balance 750, owed on today's charge.
    const b = allocateOldestFirst(750_00, [ch(120, 1000_00), ch(0, 1000_00)], AS_OF)
    expect(b).toEqual({ current: 750_00, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, unallocated: 0 })
  })

  it('balance spanning multiple charges fills newest first, remainder in the oldest touched', () => {
    // 5 charges × 1000; balance 2500 → today 1000, 15d 1000, 45d 500; 75d and 120d fully paid.
    const charges = [ch(120, 1000_00), ch(75, 1000_00), ch(45, 1000_00), ch(15, 1000_00), ch(0, 1000_00)]
    const b = allocateOldestFirst(2500_00, charges, AS_OF)
    expect(b).toEqual({ current: 1000_00, d1_30: 1000_00, d31_60: 500_00, d61_90: 0, d90_plus: 0, unallocated: 0 })
    expect(sum(b)).toBe(2500_00)
  })

  it('is independent of input order (sorts by due_date DESC itself)', () => {
    const charges = [ch(0, 1000_00), ch(45, 1000_00), ch(120, 1000_00), ch(15, 1000_00)]
    const shuffled = [charges[2], charges[0], charges[3], charges[1]]
    expect(allocateOldestFirst(1500_00, shuffled, AS_OF)).toEqual(allocateOldestFirst(1500_00, charges, AS_OF))
    expect(allocateOldestFirst(1500_00, shuffled, AS_OF)).toEqual({ current: 1000_00, d1_30: 500_00, d31_60: 0, d61_90: 0, d90_plus: 0, unallocated: 0 })
  })

  it('same due_date: tie-break on id DESC (deterministic)', () => {
    const due = dueDaysAgo(10)
    const a = { id: 'c_a', due_date: due, amountCents: 300_00 }
    const z = { id: 'c_z', due_date: due, amountCents: 300_00 }
    // Same bucket either way; prove determinism via a split across an older charge.
    const old = { id: 'c_m', due_date: dueDaysAgo(100), amountCents: 300_00 }
    expect(allocateOldestFirst(700_00, [a, old, z], AS_OF)).toEqual(allocateOldestFirst(700_00, [z, a, old], AS_OF))
    expect(allocateOldestFirst(700_00, [a, old, z], AS_OF)).toEqual({ current: 0, d1_30: 600_00, d31_60: 0, d61_90: 0, d90_plus: 100_00, unallocated: 0 })
  })

  it('balance greater than Σ charges: the excess is reported as unallocated, never hidden in current', () => {
    const b = allocateOldestFirst(1200_00, [ch(15, 500_00), ch(45, 500_00)], AS_OF)
    expect(b).toEqual({ current: 0, d1_30: 500_00, d31_60: 500_00, d61_90: 0, d90_plus: 0, unallocated: 200_00 })
    expect(sum(b)).toBe(1200_00)
  })

  it('no charges at all: the whole balance is unallocated', () => {
    expect(allocateOldestFirst(99_99, [], AS_OF)).toEqual({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, unallocated: 99_99 })
  })

  it('zero or negative balance allocates nothing', () => {
    const zero = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, unallocated: 0 }
    expect(allocateOldestFirst(0, [ch(10, 100_00)], AS_OF)).toEqual(zero)
    expect(allocateOldestFirst(-500, [ch(10, 100_00)], AS_OF)).toEqual(zero)
  })

  it('future-dated charges are current', () => {
    const b = allocateOldestFirst(100_00, [ch(-20, 100_00)], AS_OF)
    expect(b.current).toBe(100_00)
  })

  it('bucket edges: 30 → 1–30, 31 → 31–60, 60 → 31–60, 61 → 61–90, 90 → 61–90, 91 → 90+', () => {
    const charges = [ch(30, 1), ch(31, 10), ch(60, 100), ch(61, 1000), ch(90, 10000), ch(91, 100000)]
    const b = allocateOldestFirst(111111, charges, AS_OF)
    expect(b).toEqual({ current: 0, d1_30: 1, d31_60: 110, d61_90: 11000, d90_plus: 100000, unallocated: 0 })
  })

  it('cents: string NUMERIC amounts round-trip exactly and the buckets sum to the balance', () => {
    const charges = [
      { id: 'c1', due_date: dueDaysAgo(5), amountCents: toCents('1234.10')! },
      { id: 'c2', due_date: dueDaysAgo(40), amountCents: toCents('0.29')! },
      { id: 'c3', due_date: dueDaysAgo(70), amountCents: toCents('333.33')! },
    ]
    const balance = toCents('1234.10')! + toCents('0.29')! + toCents('100.01')!
    const b = allocateOldestFirst(balance, charges, AS_OF)
    expect(b).toEqual({ current: 0, d1_30: 123410, d31_60: 29, d61_90: 10001, d90_plus: 0, unallocated: 0 })
    expect(sum(b)).toBe(balance)
    for (const v of Object.values(b)) expect(Number.isInteger(v)).toBe(true)
  })

  it('throws on a non-integer cents amount or a malformed due_date (caller turns it into a 500)', () => {
    expect(() => allocateOldestFirst(100, [{ id: 'x', due_date: dueDaysAgo(1), amountCents: 1.5 }], AS_OF)).toThrow()
    expect(() => allocateOldestFirst(100, [{ id: 'x', due_date: 'garbage', amountCents: 100 }], AS_OF)).toThrow()
    expect(() => allocateOldestFirst(1.5, [], AS_OF)).toThrow()
    expect(() => allocateOldestFirst(100, [{ id: 'x', due_date: dueDaysAgo(1), amountCents: -100 }], AS_OF)).toThrow()
  })
})
