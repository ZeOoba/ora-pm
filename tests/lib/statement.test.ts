import { describe, it, expect } from 'vitest'
import { buildStatement, classifyPayment, type StatementCharge, type StatementPayment } from '../../server/lib/statement'

let seq = 0
const ch = (charge_date: string, amountCents: number, extra: Partial<StatementCharge> = {}): StatementCharge => ({
  id: `c_${String(seq++).padStart(5, '0')}`, charge_date, due_date: charge_date, type: 'rent', description: null, amountCents, ...extra,
})
const pay = (payment_date: string, amountCents: number, extra: Partial<StatementPayment> = {}): StatementPayment => ({
  id: `p_${String(seq++).padStart(5, '0')}`, payment_date, amountCents, method: 'check', stripe_status: null, check_number: null, ...extra,
})

describe('classifyPayment — mirrors ar_ledger payment_totals (0016)', () => {
  it('check/wire/other always count', () => {
    for (const method of ['check', 'wire', 'other'] as const) expect(classifyPayment({ method, stripe_status: null })).toBe('counted')
  })
  it('ach_stripe counts only when succeeded', () => {
    expect(classifyPayment({ method: 'ach_stripe', stripe_status: 'succeeded' })).toBe('counted')
  })
  it('ach_stripe pending/processing is a memo, not a credit', () => {
    expect(classifyPayment({ method: 'ach_stripe', stripe_status: 'pending' })).toBe('pending')
    expect(classifyPayment({ method: 'ach_stripe', stripe_status: 'processing' })).toBe('pending')
  })
  it('ach_stripe failed/returned/canceled/null/unknown is excluded', () => {
    for (const s of ['failed', 'returned', 'canceled', null, 'weird']) {
      expect(classifyPayment({ method: 'ach_stripe', stripe_status: s })).toBe('excluded')
    }
  })
  it('an unknown method is excluded (ar_ledger CASE ELSE 0)', () => {
    expect(classifyPayment({ method: 'bitcoin', stripe_status: null })).toBe('excluded')
  })
})

describe('buildStatement', () => {
  it('opening, period activity, closing and running balance', () => {
    const charges = [ch('2026-09-01', 100000), ch('2026-10-01', 100000), ch('2026-11-01', 100000), ch('2026-12-01', 100000)]
    const payments = [pay('2026-09-05', 100000), pay('2026-10-20', 50000)]
    const s = buildStatement({ charges, payments, start: '2026-10-01', end: '2026-11-30' })
    expect(s.openingCents).toBe(0)
    expect(s.chargesCents).toBe(200000)
    expect(s.paymentsCents).toBe(50000)
    expect(s.closingCents).toBe(150000)
    expect(s.lines.map(l => [l.date, l.kind, l.amountCents, l.balanceCents])).toEqual([
      ['2026-10-01', 'charge', 100000, 100000],
      ['2026-10-20', 'payment', 50000, 50000],
      ['2026-11-01', 'charge', 100000, 150000],
    ])
  })

  it('period bounds are inclusive on both ends', () => {
    const s = buildStatement({ charges: [ch('2026-10-01', 100), ch('2026-10-31', 200)], payments: [pay('2026-10-31', 50)], start: '2026-10-01', end: '2026-10-31' })
    expect(s.chargesCents).toBe(300)
    expect(s.paymentsCents).toBe(50)
    expect(s.openingCents).toBe(0)
  })

  it('same-day ordering: charges before payments, then by id', () => {
    const p = pay('2026-10-01', 100)
    const c = ch('2026-10-01', 100)
    const s = buildStatement({ charges: [c], payments: [p], start: '2026-10-01', end: '2026-10-31' })
    expect(s.lines.map(l => l.kind)).toEqual(['charge', 'payment'])
  })

  it('excluded payments never appear; pending ACH is a memo and does not reduce the balance', () => {
    const charges = [ch('2026-10-01', 100000)]
    const payments = [
      pay('2026-10-02', 100000, { method: 'ach_stripe', stripe_status: 'failed' }),
      pay('2026-10-03', 100000, { method: 'ach_stripe', stripe_status: 'processing' }),
      pay('2026-12-03', 100000, { method: 'ach_stripe', stripe_status: 'pending' }), // after end
    ]
    const s = buildStatement({ charges, payments, start: '2026-10-01', end: '2026-10-31' })
    expect(s.closingCents).toBe(100000)
    expect(s.lines).toHaveLength(1)
    expect(s.pending.map(p => p.amountCents)).toEqual([100000])
    expect(s.pendingCents).toBe(100000)
  })

  it('aging is as of end, oldest-first: the closing balance sits on the newest charges', () => {
    const charges = [ch('2026-07-01', 100000), ch('2026-08-01', 100000), ch('2026-09-01', 100000), ch('2026-10-01', 100000)]
    const payments = [pay('2026-10-15', 150000)]
    const s = buildStatement({ charges, payments, start: '2026-10-01', end: '2026-10-31' })
    expect(s.closingCents).toBe(250000)
    // 10-01 → 30 days (1-30), 09-01 → 60 days (31-60), half of 08-01 → 91 days (90+).
    expect(s.aging).toEqual({ current: 0, d1_30: 100000, d31_60: 100000, d61_90: 0, d90_plus: 50000, unallocated: 0 })
    const sum = Object.values(s.aging).reduce((a, b) => a + b, 0)
    expect(sum).toBe(s.closingCents)
  })

  it('charges posted after end are outside the statement and its aging', () => {
    const s = buildStatement({ charges: [ch('2026-10-01', 100), ch('2026-11-01', 999)], payments: [], start: '2026-10-01', end: '2026-10-31' })
    expect(s.closingCents).toBe(100)
    expect(s.aging.current + s.aging.d1_30).toBe(100)
  })

  it('a charge posted in period but due later ages as current', () => {
    const s = buildStatement({ charges: [ch('2026-10-25', 500, { due_date: '2026-11-05' })], payments: [], start: '2026-10-01', end: '2026-10-31' })
    expect(s.aging.current).toBe(500)
  })

  it('an overpayment closes negative (credit balance) with empty aging', () => {
    const s = buildStatement({ charges: [ch('2026-10-01', 100)], payments: [pay('2026-10-02', 300)], start: '2026-10-01', end: '2026-10-31' })
    expect(s.closingCents).toBe(-200)
    expect(Object.values(s.aging).every(v => v === 0)).toBe(true)
  })

  it('opening carries prior charges and counted payments only', () => {
    const s = buildStatement({
      charges: [ch('2026-08-01', 1000), ch('2026-09-01', 1000)],
      payments: [pay('2026-08-10', 500), pay('2026-09-10', 400, { method: 'ach_stripe', stripe_status: 'returned' })],
      start: '2026-10-01', end: '2026-10-31',
    })
    expect(s.openingCents).toBe(1500)
    expect(s.closingCents).toBe(1500)
  })

  it('rejects malformed or inverted ranges and non-integer amounts', () => {
    expect(() => buildStatement({ charges: [], payments: [], start: '2026-10-31', end: '2026-10-01' })).toThrow(/range/)
    expect(() => buildStatement({ charges: [], payments: [], start: '2026-13-01', end: '2026-10-01' })).toThrow(/date/)
    expect(() => buildStatement({ charges: [ch('2026-10-01', 1.5)], payments: [], start: '2026-10-01', end: '2026-10-31' })).toThrow(/cents/)
    expect(() => buildStatement({ charges: [], payments: [pay('2026-10-01', 0)], start: '2026-10-01', end: '2026-10-31' })).toThrow(/cents/)
    expect(() => buildStatement({ charges: [ch('bad', 1)], payments: [], start: '2026-10-01', end: '2026-10-31' })).toThrow(/date/)
  })

  it('closing = opening + charges − payments, always', () => {
    const charges = Array.from({ length: 20 }, (_, i) => ch(`2026-${String(1 + (i % 12)).padStart(2, '0')}-0${1 + (i % 9)}`, 1234 * (i + 1)))
    const payments = Array.from({ length: 10 }, (_, i) => pay(`2026-${String(1 + (i % 12)).padStart(2, '0')}-15`, 999 * (i + 1)))
    const s = buildStatement({ charges, payments, start: '2026-04-01', end: '2026-09-30' })
    expect(s.closingCents).toBe(s.openingCents + s.chargesCents - s.paymentsCents)
    expect(s.lines.at(-1)?.balanceCents ?? s.openingCents).toBe(s.closingCents)
  })
})
