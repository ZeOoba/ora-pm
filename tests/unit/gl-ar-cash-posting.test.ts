import { describe, it, expect } from 'vitest'
import { allocateCash, planCashArRun, type CashCharge, type CashPlanInput } from '../../server/lib/gl-ar-cash-posting'
import type { ArPayment } from '../../server/lib/gl-ar-posting'

// The same scenario as supabase/tests/gl_ar_cash_posting.test.sql, so the preview and the database
// are held to the same numbers. Start 2026-10-01; L1 owes 400 at the tie-out, L2 holds a 200 credit.
const START = '2026-10-01'
const L1 = 'lease-1', L2 = 'lease-2'
const ROLES = { undeposited_funds: 'uf', prepaid_rent: 'pp', security_deposit: 'dep', rent: 'rent', late_fee: 'late' }
const ch = (id: string, lease: string, date: string, type: string, amount: number, voided_at: string | null = null, due = date): CashCharge =>
  ({ id, lease_id: lease, charge_date: date, due_date: due, type, amount, voided_at })
const pay = (id: string, lease: string, date: string, amount: number, method = 'check', stripe_status: string | null = null, status_changed_at: string | null = null): ArPayment =>
  ({ id, lease_id: lease, payment_date: date, amount, method, stripe_status, status_changed_at })

const SEP_RENT_1 = ch('c01', L1, '2026-09-01', 'rent', 1000)
const SEP_RENT_2 = ch('c02', L2, '2026-09-01', 'rent', 500)
const OCT = [ch('c11', L1, '2026-10-01', 'rent', 1000), ch('c12', L1, '2026-10-06', 'late_fee', 50), ch('c21', L2, '2026-10-01', 'rent', 500), ch('c22', L2, '2026-10-01', 'security_deposit', 300)]
const TIEOUT = [
  { kind: 'charge' as const, source_id: 'c01', counted: true }, { kind: 'charge' as const, source_id: 'c02', counted: true },
  { kind: 'payment' as const, source_id: 'p01', counted: true }, { kind: 'payment' as const, source_id: 'p02', counted: false },
  { kind: 'payment' as const, source_id: 'p03', counted: true },
]
const base = (over: Partial<CashPlanInput>): CashPlanInput => ({
  startDate: START, through: '2026-10-31', charges: [SEP_RENT_1, SEP_RENT_2, ...OCT],
  payments: [pay('p01', L1, '2026-09-05', 600), pay('p02', L1, '2026-09-28', 100, 'ach_stripe', 'succeeded', '2026-11-11T15:00:00Z'), pay('p03', L2, '2026-09-25', 700), pay('p11', L1, '2026-10-10', 1200)],
  events: [], tieoutItems: TIEOUT, roles: ROLES, ...over,
})
const kinds = (p: ReturnType<typeof planCashArRun>) => p.items.map((i) => [i.kind, i.source_id, i.date])

describe('allocateCash (billing order; oldest due date, then deposit, rent … late fees last)', () => {
  it('fills oldest first, then same-date by ratified priority, rest is credit', () => {
    const live = '2026-10-01'
    const charges = [
      { id: 'b', type: 'rent', due_date: '2026-10-01', live, cents: 50000 }, { id: 'a', type: 'security_deposit', due_date: '2026-10-01', live, cents: 30000 },
      { id: 'z', type: 'late_fee', due_date: '2026-10-01', live, cents: 5000 }, { id: 's', type: 'rent', due_date: '2026-09-01', live, cents: 50000 },
    ]
    expect(Object.fromEntries(allocateCash(110000, charges))).toEqual({ rent: 80000, security_deposit: 30000 })
    expect(Object.fromEntries(allocateCash(140000, charges))).toEqual({ rent: 100000, security_deposit: 30000, late_fee: 5000, prepaid_rent: 5000 })
    expect(allocateCash(0, charges).size).toBe(0)
  })
  it('REFUTE-7 M5: a charge billed later never takes cash ahead of earlier-billed ones, whatever its due date', () => {
    const charges = [
      { id: 'r', type: 'rent', due_date: '2026-11-05', live: '2026-11-05', cents: 100000 },
      { id: 'd', type: 'security_deposit', due_date: '2026-10-01', live: '2026-11-07', cents: 30000 },
    ]
    expect(Object.fromEntries(allocateCash(100000, charges))).toEqual({ rent: 100000 })
    expect(Object.fromEntries(allocateCash(130000, charges))).toEqual({ rent: 100000, security_deposit: 30000 })
  })
})

describe('planCashArRun', () => {
  it('October: every live charge enters the replay before the cash that pays it; the preview matches the database', () => {
    const p = planCashArRun(base({}))
    expect(p.errors).toEqual([])
    expect(kinds(p)).toEqual([
      ['charge', 'c11', '2026-10-01'], ['charge', 'c21', '2026-10-01'], ['charge', 'c22', '2026-10-01'],
      ['payment', 'p02', '2026-10-01'], ['charge', 'c12', '2026-10-06'], ['payment', 'p11', '2026-10-10'],
    ])
    // Database: UF 130000, rent −130000, deposits −20000, prepaid 0 (its opening −20000 used: +20000).
    expect(p.by_role).toEqual({ undeposited_funds: 130000, rent: -130000, security_deposit: -20000, prepaid_rent: 20000 })
  })

  it('a paid charge voided, and an ACH returned: cash moves on, credit absorbs the rest (matches the database)', () => {
    const ev = (kind: 'charge' | 'payment', id: string, lease: string, date: string) => ({ kind, source_id: id, lease_id: lease, event_date: date, alloc_date: date })
    const done: CashPlanInput['events'] = [
      ev('charge', 'c11', L1, '2026-10-01'), ev('charge', 'c12', L1, '2026-10-06'), ev('charge', 'c21', L2, '2026-10-01'), ev('charge', 'c22', L2, '2026-10-01'),
      ev('payment', 'p02', L1, '2026-10-01'), ev('payment', 'p11', L1, '2026-10-10'),
    ]
    const p = planCashArRun(base({
      through: '2026-11-11', events: done,
      charges: [{ ...SEP_RENT_1, voided_at: '2026-10-20T15:00:00Z' }, SEP_RENT_2, ...OCT],
      payments: [pay('p01', L1, '2026-09-05', 600), pay('p02', L1, '2026-09-28', 100, 'ach_stripe', 'returned', '2026-11-11T15:00:00Z'), pay('p03', L2, '2026-09-25', 700), pay('p11', L1, '2026-10-10', 1200)],
    }))
    expect(kinds(p)).toEqual([['charge_void', 'c01', '2026-10-20'], ['payment_return', 'p02', '2026-11-11']])
    expect(p.by_role).toEqual({ rent: 90000, late_fee: -5000, prepaid_rent: -75000, undeposited_funds: -10000 })
  })

  it('a charge voided on or before it went live never enters; one voided later enters then voids', () => {
    const p = planCashArRun(base({ charges: [SEP_RENT_1, SEP_RENT_2, ch('x1', L1, '2026-10-02', 'rent', 10, '2026-10-02T20:00:00Z'), ch('x2', L1, '2026-10-02', 'rent', 10, '2026-10-05T20:00:00Z')], payments: [] }))
    expect(kinds(p)).toEqual([['charge', 'x2', '2026-10-02'], ['charge_void', 'x2', '2026-10-05']])
    expect(p.skipped).toBe(1)
  })

  it('locked months shift dates to the next open month; shifted past through waits', () => {
    const p = planCashArRun(base({ through: '2026-11-11', lockedMonths: ['2026-10-01'], charges: [SEP_RENT_1, SEP_RENT_2], payments: [pay('p01', L1, '2026-09-05', 600), pay('p03', L2, '2026-09-25', 700), pay('late', L2, '2026-10-25', 50)] }))
    expect(kinds(p)).toEqual([['payment', 'late', '2026-11-01']])
    expect(kinds(planCashArRun(base({ lockedMonths: ['2026-10-01'] })))).toEqual([])
  })

  it('attention: pre-start items added after the tie-out; ledger cash now disputed', () => {
    const p = planCashArRun(base({
      charges: [SEP_RENT_1, SEP_RENT_2, ch('late-add', L1, '2026-09-15', 'rent', 10)],
      payments: [pay('p01', L1, '2026-09-05', 600), pay('p03', L2, '2026-09-25', 700, 'ach_stripe', 'disputed', '2026-10-03T15:00:00Z')],
    }))
    expect(p.attention.map((a) => a.source_id).sort()).toEqual(['late-add', 'p03'])
    expect(p.items).toEqual([])
  })

  it('unmapped roles the run touches block it; roles it does not touch do not', () => {
    const p = planCashArRun(base({ roles: { undeposited_funds: 'uf', prepaid_rent: 'pp', rent: 'rent' } }))
    expect(p.errors).toEqual(['map an account to "security deposit" before posting (Books › AR posting › Accounts)'])
    const noLate = planCashArRun(base({ roles: { undeposited_funds: 'uf', prepaid_rent: 'pp', rent: 'rent', security_deposit: 'dep' } }))
    expect(noLate.errors).toEqual([]) // the late fee is never paid in October, so late_fee is untouched
  })

  it('non-cent amounts block only items that would enter', () => {
    expect(planCashArRun(base({ charges: [SEP_RENT_1, SEP_RENT_2, ch('f', L1, '2026-10-03', 'rent', 10.005)], payments: [] })).errors[0]).toMatch(/not a whole number of cents/)
    expect(planCashArRun(base({ charges: [SEP_RENT_1, SEP_RENT_2, ch('f', L1, '2026-11-03', 'rent', 10.005)], payments: [] })).errors).toEqual([])
  })

  it("REFUTE-7 H1: a backdated payment keeps its cash date but replays after the lease's last event (matches the database)", () => {
    const L3 = 'lease-3'
    const p = planCashArRun(base({
      through: '2026-11-06', tieoutItems: [], charges: [ch('c31', L3, '2026-11-05', 'rent', 1000)],
      payments: [pay('p41', L3, '2026-11-03', 1000, 'ach_stripe', 'succeeded', '2026-11-11T15:00:00Z')],
      events: [{ kind: 'charge', source_id: 'c31', lease_id: L3, event_date: '2026-11-05', alloc_date: '2026-11-05' }],
    }))
    expect(p.items.map((i) => [i.kind, i.source_id, i.date, i.alloc_date])).toEqual([['payment', 'p41', '2026-11-03', '2026-11-05']])
    expect(p.by_role).toEqual({ undeposited_funds: 100000, rent: -100000 })
  })

  it("REFUTE-7 H1: a backdated charge replays on the lease's last date; its void follows from there; a through date before it waits", () => {
    const L4 = 'lease-4'
    const events = [{ kind: 'payment' as const, source_id: 'p42', lease_id: L4, event_date: '2026-11-06', alloc_date: '2026-11-06' }]
    const p = planCashArRun(base({
      through: '2026-11-08', tieoutItems: [], charges: [ch('c42', L4, '2026-11-02', 'rent', 500, '2026-11-04T15:00:00Z')],
      payments: [pay('p42', L4, '2026-11-06', 500)], events,
    }))
    expect(p.items.map((i) => [i.kind, i.date, i.alloc_date])).toEqual([['charge', '2026-11-02', '2026-11-06'], ['charge_void', '2026-11-06', '2026-11-06']])
    expect(planCashArRun(base({ through: '2026-11-05', tieoutItems: [], charges: [ch('c42', L4, '2026-11-02', 'rent', 500)], payments: [pay('p42', L4, '2026-11-06', 500)], events })).items).toEqual([])
  })
})

// 0032: balance forwards from QuickBooks in the cash replay. The same numbers as
// supabase/tests/gl_balance_forwards.test.sql (cash entity CB, CB2).
describe('balance forwards (0032 BF3)', () => {
  const T = '0001-01-01'
  it('a positive forward is due on its date, after a deposit due that day and before rent', () => {
    // L3: 1,500 deposit and a +1,000 forward, both due 09-30; 1,000 of cash fills the deposit first.
    const l3 = [{ id: 'bf3', type: 'balance_forward', due_date: '2026-09-30', live: T, cents: 100000 }, { id: 'dep3', type: 'security_deposit', due_date: '2026-09-30', live: T, cents: 150000 }]
    expect(Object.fromEntries(allocateCash(100000, l3))).toEqual({ security_deposit: 100000 })
    expect(Object.fromEntries(allocateCash(200000, l3))).toEqual({ security_deposit: 150000, balance_forward: 50000 })
    // …and ahead of rent due the same day.
    const sameDay = [{ id: 'r', type: 'rent', due_date: '2026-09-30', live: T, cents: 10000 }, { id: 'bf', type: 'balance_forward', due_date: '2026-09-30', live: T, cents: 10000 }]
    expect(Object.fromEntries(allocateCash(10000, sameDay))).toEqual({ balance_forward: 10000 })
    // L1: September rent (due 09-01) is older than the forward (due 09-30), so it is paid first.
    const l1 = [{ id: 'bf1', type: 'balance_forward', due_date: '2026-09-30', live: T, cents: 50000 }, { id: 'r1', type: 'rent', due_date: '2026-09-01', live: T, cents: 100000 }]
    expect(Object.fromEntries(allocateCash(60000, l1))).toEqual({ rent: 60000 })
  })

  it('refuses a negative charge (a credit forward is cash, never a charge)', () => {
    expect(() => allocateCash(0, [{ id: 'x', type: 'balance_forward', due_date: '2026-09-30', live: T, cents: -1 }])).toThrow(/negative cents/)
  })

  const L = 'lease-bf'
  const bfInput = (over: Partial<CashPlanInput> = {}): CashPlanInput => ({
    startDate: START, through: '2026-10-31',
    charges: [ch('r09', L, '2026-09-01', 'rent', 1000), ch('r10', L, '2026-10-01', 'rent', 1000)],
    payments: [pay('p09', L, '2026-09-05', 600), pay('p10', L, '2026-10-05', 1200)],
    events: [], tieoutItems: [{ kind: 'charge', source_id: 'r09', counted: true }, { kind: 'payment', source_id: 'p09', counted: true }, { kind: 'balance_forward', source_id: 'bf1', counted: true, cents: 50000 }],
    roles: { undeposited_funds: 'uf', prepaid_rent: 'pp', rent: 'rent' },
    balanceForwards: [{ id: 'bf1', lease_id: L, as_of: '2026-09-30', cents: 50000 }],
    ...over,
  })

  it('later cash pays the forward after older charges, before newer ones; income to rent unless mapped', () => {
    const plan = planCashArRun(bfInput())
    expect(plan.errors).toEqual([])
    expect(plan.items.map((i) => [i.kind, i.source_id])).toEqual([['charge', 'r10'], ['payment', 'p10']])
    // 1,200: Sep rent's last 400, the 500 forward, October 300 — all Rental Income here (the forward
    // falls back to rent, and the preview nets per account like the ledger: REFUTE-9 F8).
    expect(plan.by_role).toEqual({ undeposited_funds: 120000, rent: -120000 })
    // With its own account mapped, the forward's 500 shows separately.
    expect(planCashArRun(bfInput({ roles: { undeposited_funds: 'uf', prepaid_rent: 'pp', rent: 'rent', balance_forward: 'bfacct' } })).by_role)
      .toEqual({ undeposited_funds: 120000, rent: -70000, balance_forward: -50000 })
  })

  it('needs balance_forward or rent mapped; either one is enough', () => {
    expect(planCashArRun(bfInput({ roles: { undeposited_funds: 'uf', prepaid_rent: 'pp' } })).errors.join()).toMatch(/"balance forward" \(or "rent", its default\)/)
    expect(planCashArRun(bfInput({ roles: { undeposited_funds: 'uf', prepaid_rent: 'pp', balance_forward: 'bfacct', rent: 'rent' } })).errors).toEqual([])
    const mapped = planCashArRun(bfInput({ charges: [ch('r09', L, '2026-09-01', 'rent', 1000)], payments: [pay('p09', L, '2026-09-05', 600), pay('p10', L, '2026-10-05', 900)],
      roles: { undeposited_funds: 'uf', prepaid_rent: 'pp', balance_forward: 'bfacct', rent: 'rent' } }))
    expect(mapped.by_role).toEqual({ undeposited_funds: 90000, rent: -40000, balance_forward: -50000 })
  })

  it('a credit forward is cash on account: a later charge takes it', () => {
    // L2: check 200 + a −300 forward = 500 of credit; October rent 400 uses it.
    const plan = planCashArRun({
      startDate: START, through: '2026-10-31', charges: [ch('r2', 'l2', '2026-10-01', 'rent', 400)], payments: [pay('p2', 'l2', '2026-09-10', 200)],
      events: [], tieoutItems: [{ kind: 'payment', source_id: 'p2', counted: true }, { kind: 'balance_forward', source_id: 'bf2', counted: true, cents: -30000 }],
      roles: { undeposited_funds: 'uf', prepaid_rent: 'pp', rent: 'rent' }, balanceForwards: [{ id: 'bf2', lease_id: 'l2', as_of: '2026-09-30', cents: -30000 }],
    })
    expect(plan.by_role).toEqual({ prepaid_rent: 40000, rent: -40000 })
  })

  it('REFUTE-9 F8: a void that only moves cash between rent and an unmapped forward shows no change', () => {
    // Counted +500 forward (due 09-10) and a counted 400 rent (due 09-01) paid by a counted 400 check;
    // voiding the rent moves the 400 to the forward: same Rental Income account, so the ledger posts nothing.
    const plan = planCashArRun({
      startDate: START, through: '2026-10-31', charges: [ch('r', 'lv', '2026-09-20', 'rent', 400, '2026-10-05T15:00:00Z', '2026-09-01')], payments: [pay('pc', 'lv', '2026-09-21', 400)],
      events: [], tieoutItems: [{ kind: 'charge', source_id: 'r', counted: true }, { kind: 'payment', source_id: 'pc', counted: true }, { kind: 'balance_forward', source_id: 'bfv', counted: true, cents: 50000 }],
      roles: { undeposited_funds: 'uf', prepaid_rent: 'pp', rent: 'rent' }, balanceForwards: [{ id: 'bfv', lease_id: 'lv', as_of: '2026-09-10', cents: 50000 }],
    })
    expect(plan.items.map((i) => i.kind)).toEqual(['charge_void'])
    expect(plan.by_role).toEqual({})
  })

  it('a live forward the tie-out did not count needs attention and posts nothing', () => {
    const plan = planCashArRun(bfInput({ balanceForwards: [], liveBalanceForwards: [{ id: 'bfx', lease_id: L, as_of: '2026-10-15', amount: '25.00' }] }))
    expect(plan.attention).toContainEqual(expect.objectContaining({ source_id: 'bfx', kind: 'balance_forward' }))
    expect(plan.items.some((i) => i.source_id === 'bfx')).toBe(false)
  })
})
