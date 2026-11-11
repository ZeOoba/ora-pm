import { describe, it, expect } from 'vitest'
import { centralDate, exactCents, planArRun, type ArCharge, type ArPayment, type ArPlanInput } from '../../server/lib/gl-ar-posting'

const L = 'lease-1'
const START = '2027-01-01'
const ROLES = { ar: 'acct-ar', undeposited_funds: 'acct-uf', rent: 'acct-rent', security_deposit: 'acct-dep', late_fee: 'acct-late', cam_estimate: 'acct-cam' }
const ch = (id: string, charge_date: string, amount: number | string, type = 'rent', voided_at: string | null = null): ArCharge => ({ id, lease_id: L, charge_date, type, amount, voided_at })
const pay = (id: string, payment_date: string, amount: number | string, method = 'check', stripe_status: string | null = null, status_changed_at: string | null = null): ArPayment =>
  ({ id, lease_id: L, payment_date, amount, method, stripe_status, status_changed_at })
const run = (over: Partial<ArPlanInput>) => planArRun({ startDate: START, through: '2027-01-31', charges: [], payments: [], postings: [], tieoutItems: [], roles: ROLES, ...over })
const kinds = (p: ReturnType<typeof run>) => p.items.map((i) => [i.kind, i.source_id, i.date, i.cents])

describe('helpers', () => {
  it('exactCents: exact NUMERIC dollars only', () => {
    expect(exactCents(1234.56)).toBe(123456)
    expect(exactCents('20192.50')).toBe(2019250)
    expect(exactCents('1000.500')).toBe(100050)
    expect(exactCents(0)).toBe(0)
    for (const bad of [1234.567, '1.005', '-5', 'abc', '1e3']) expect(exactCents(bad)).toBeNull()
  })
  it('centralDate: the US Central calendar day', () => {
    expect(centralDate('2027-01-01T05:30:00Z')).toBe('2026-12-31')
    expect(centralDate('2027-01-01T06:30:00Z')).toBe('2027-01-01')
  })
})

describe('planArRun (accrual)', () => {
  it('charges and payments in the window post once, in date order; deposits go to the liability role', () => {
    const p = run({
      charges: [ch('c2', '2027-01-01', 2000, 'security_deposit'), ch('c1', '2027-01-01', 1000.5), ch('c3', '2027-02-01', 1000)],
      payments: [pay('p1', '2027-01-03', 3000), pay('p2', '2027-01-06', 500, 'ach_stripe', 'processing')],
    })
    expect(p.errors).toEqual([])
    expect(kinds(p)).toEqual([['charge', 'c1', '2027-01-01', 100050], ['charge', 'c2', '2027-01-01', 200000], ['payment', 'p1', '2027-01-03', 300000]])
    expect(p.items[1]).toMatchObject({ debit_role: 'ar', credit_role: 'security_deposit' })
    expect(p.by_role).toEqual({ ar: 100050 + 200000 - 300000, rent: -100050, security_deposit: -200000, undeposited_funds: 300000 })
  })

  it('nothing posts twice', () => {
    const p = run({ charges: [ch('c1', '2027-01-01', 1000)], payments: [pay('p1', '2027-01-03', 1000)], postings: [{ kind: 'charge', source_id: 'c1' }, { kind: 'payment', source_id: 'p1' }] })
    expect(p.items).toEqual([])
  })

  it('a charge voided before it ever posted is skipped; a posted one gets its void; a void after through waits', () => {
    const p = run({
      charges: [
        ch('never', '2027-01-05', 100, 'late_fee', '2027-01-07T15:00:00Z'),
        ch('posted', '2027-01-01', 1000, 'rent', '2027-01-20T15:00:00Z'),
        ch('later', '2027-01-10', 75, 'late_fee', '2027-02-03T15:00:00Z'),
      ],
      postings: [{ kind: 'charge', source_id: 'posted' }],
    })
    expect(kinds(p)).toEqual([['charge', 'later', '2027-01-10', 7500], ['charge_void', 'posted', '2027-01-20', 100000]])
    expect(p.skipped).toBe(1)
  })

  it('a charge posted and voided in the same run posts both, charge first', () => {
    const p = run({ charges: [ch('c', '2027-01-15', 50, 'late_fee', '2027-01-15T20:00:00Z')] })
    // voided the day it was billed, but the void is ON the through window: it was never posted, so it is skipped
    expect(p.items).toEqual([])
    const q = run({ through: '2027-01-15', charges: [ch('c', '2027-01-10', 50, 'late_fee', '2027-01-20T20:00:00Z')] })
    expect(kinds(q)).toEqual([['charge', 'c', '2027-01-10', 5000]])
  })

  it('pre-start: counted charges never post; their voids do (opening AR); uncounted are attention', () => {
    const p = run({
      charges: [ch('dec', '2026-12-01', 1000, 'rent', '2027-01-12T15:00:00Z'), ch('backdated', '2026-12-15', 40, 'late_fee')],
      tieoutItems: [{ kind: 'charge', source_id: 'dec', counted: true }],
    })
    expect(kinds(p)).toEqual([['charge_void_pre', 'dec', '2027-01-12', 100000]])
    expect(p.items[0]).toMatchObject({ debit_role: 'rent', credit_role: 'ar' })
    expect(p.attention.map((a) => a.source_id)).toEqual(['backdated'])
  })

  it('pre-start payments: counted stay in the opening balance; uncounted that cleared post on the start date; counted then returned reverse', () => {
    const p = run({
      payments: [
        pay('counted', '2026-12-20', 300, 'check'),
        pay('cleared-late', '2026-12-30', 100, 'ach_stripe', 'succeeded', '2027-01-03T15:00:00Z'),
        pay('returned', '2026-12-22', 200, 'ach_stripe', 'returned', '2027-01-09T15:00:00Z'),
        pay('stuck', '2026-12-28', 50, 'ach_stripe', 'processing'),
        pay('new', '2026-12-29', 25, 'check'),
      ],
      tieoutItems: [
        { kind: 'payment', source_id: 'counted', counted: true },
        { kind: 'payment', source_id: 'cleared-late', counted: false },
        { kind: 'payment', source_id: 'returned', counted: true },
        { kind: 'payment', source_id: 'stuck', counted: true },
      ],
    })
    expect(kinds(p)).toEqual([['payment', 'cleared-late', START, 10000], ['payment_return_pre', 'returned', '2027-01-09', 20000]])
    expect(p.attention.map((a) => a.source_id).sort()).toEqual(['new', 'stuck'])
  })

  it('a posted ACH that fails is reversed on its status date, never before its own posting', () => {
    const p = run({
      payments: [pay('p', '2027-01-06', 500, 'ach_stripe', 'returned', '2027-01-14T15:00:00Z'), pay('q', '2027-01-20', 80, 'ach_stripe', 'failed', null)],
      postings: [{ kind: 'payment', source_id: 'p' }, { kind: 'payment', source_id: 'q' }],
    })
    expect(kinds(p)).toEqual([['payment_return', 'p', '2027-01-14', 50000], ['payment_return', 'q', '2027-01-31', 8000]])
    expect(p.items[0]).toMatchObject({ debit_role: 'ar', credit_role: 'undeposited_funds' })
  })

  it('blocking errors: an unmapped role in use, or an amount that is not whole cents', () => {
    const p = run({ charges: [ch('c', '2027-01-02', 10, 'utility_water'), ch('d', '2027-01-03', '1.005')] })
    expect(p.errors).toEqual([
      'charge d (rent, 2027-01-03): amount 1.005 is not a whole number of cents',
      'map an account to "utility water" before posting (Books › AR posting › Accounts)',
    ])
  })

  it('zero-amount charges are skipped', () => {
    const p = run({ charges: [ch('z', '2027-01-02', 0)] })
    expect(p.items).toEqual([])
    expect(p.skipped).toBe(1)
  })
})
