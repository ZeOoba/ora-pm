// tests/lib/financial-report.test.ts
//
// Pure report math behind the AppFolio-style dashboard, Transactions page and report library
// (server/lib/financial-report.ts). Money is summed in integer cents; any non-numeric amount or
// malformed date fails closed (throws) rather than being read as 0.

import { describe, it, expect } from 'vitest'
import {
  parseReportRange,
  parsePropertyIds,
  fiscalYearStart,
  isCashReceived,
  isPendingAch,
  buildIncomeStatement,
  buildCashFlow,
  buildCashActivity,
  trailingMonths,
  buildMonthlyIncomeStatement,
} from '../../server/lib/financial-report'

const R = { from: '2026-11-01', to: '2026-11-30' }

describe('parseReportRange', () => {
  it('accepts a valid inclusive range', () => {
    expect(parseReportRange('2026-11-01', '2026-11-09')).toEqual({ ok: true, from: '2026-11-01', to: '2026-11-09' })
  })
  it('accepts a single day', () => {
    expect(parseReportRange('2026-11-09', '2026-11-09').ok).toBe(true)
  })
  it('rejects missing, malformed, rolled-over and reversed dates', () => {
    expect(parseReportRange(undefined, '2026-11-09').ok).toBe(false)
    expect(parseReportRange('2026-11-1', '2026-11-09').ok).toBe(false)
    expect(parseReportRange('2026-02-30', '2026-03-01').ok).toBe(false)
    expect(parseReportRange('2026-11-10', '2026-11-09').ok).toBe(false)
  })
  it('rejects a span over two years', () => {
    expect(parseReportRange('2024-01-01', '2026-11-09').ok).toBe(false)
  })
})

describe('parsePropertyIds', () => {
  const A = '11111111-1111-4111-8111-111111111111'
  const B = '22222222-2222-4222-8222-222222222222'
  it('treats absent/empty as all properties', () => {
    expect(parsePropertyIds(undefined)).toEqual({ ok: true, ids: null })
    expect(parsePropertyIds('')).toEqual({ ok: true, ids: null })
  })
  it('parses and de-duplicates a comma list', () => {
    expect(parsePropertyIds(`${A},${B},${A}`)).toEqual({ ok: true, ids: [A, B] })
  })
  it('rejects a non-empty value that parses to zero ids', () => {
    expect(parsePropertyIds(',').ok).toBe(false)
    expect(parsePropertyIds(' , ').ok).toBe(false)
  })
  it('rejects a non-uuid', () => {
    expect(parsePropertyIds(`${A},nope`).ok).toBe(false)
  })
  it('rejects more than 100 ids', () => {
    const many = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    expect(parsePropertyIds(many.join(',')).ok).toBe(false)
  })
})

describe('fiscalYearStart', () => {
  it('is Jan 1 of the end date year (calendar fiscal year)', () => {
    expect(fiscalYearStart('2026-11-09')).toBe('2026-01-01')
  })
})

describe('payment classification mirrors ar_ledger (migration 0016)', () => {
  it('counts succeeded ACH and every check/wire/other payment as cash received', () => {
    expect(isCashReceived({ method: 'ach_stripe', stripe_status: 'succeeded' })).toBe(true)
    expect(isCashReceived({ method: 'check', stripe_status: null })).toBe(true)
    expect(isCashReceived({ method: 'wire', stripe_status: null })).toBe(true)
    expect(isCashReceived({ method: 'other', stripe_status: null })).toBe(true)
  })
  it('does not count pending, processing, failed, returned, disputed or canceled ACH', () => {
    for (const s of ['pending', 'processing', 'failed', 'returned', 'disputed', 'canceled', null]) {
      expect(isCashReceived({ method: 'ach_stripe', stripe_status: s })).toBe(false)
    }
  })
  it('flags only pending/processing ACH as in flight', () => {
    expect(isPendingAch({ method: 'ach_stripe', stripe_status: 'pending' })).toBe(true)
    expect(isPendingAch({ method: 'ach_stripe', stripe_status: 'processing' })).toBe(true)
    expect(isPendingAch({ method: 'ach_stripe', stripe_status: 'failed' })).toBe(false)
    expect(isPendingAch({ method: 'check', stripe_status: 'pending' })).toBe(false)
  })
})

describe('buildIncomeStatement', () => {
  const charges = [
    { id: 'c1', charge_date: '2026-11-01', type: 'rent', amount: '1000.10' },
    { id: 'c2', charge_date: '2026-11-01', type: 'rent', amount: 0.2 },
    { id: 'c3', charge_date: '2026-11-01', type: 'cam_estimate', amount: '150.00' },
    { id: 'c4', charge_date: '2026-11-06', type: 'late_fee', amount: '50' },
    { id: 'c5', charge_date: '2026-11-02', type: 'security_deposit', amount: '2000' },
    { id: 'c6', charge_date: '2026-10-31', type: 'rent', amount: '999' }, // out of range
    { id: 'c7', charge_date: '2026-11-03', type: 'utility_water', amount: '57.81' },
  ]
  const expenses = [
    { id: 'e1', expense_date: '2026-11-04', category: 'taxes', amount: '300.00' },
    { id: 'e2', expense_date: '2026-11-04', category: 'capital', amount: '1990.00' },
    { id: 'e3', expense_date: '2026-12-01', category: 'taxes', amount: '5' }, // out of range
  ]

  it('sums income by charge type in cents, excluding deposits and out-of-range rows', () => {
    const s = buildIncomeStatement(charges, expenses, R)
    const line = (k: string) => s.income.find((l) => l.key === k)?.amount
    expect(line('rent')).toBe(1000.3)
    expect(line('cam_estimate')).toBe(150)
    expect(line('late_fee')).toBe(50)
    expect(line('utility_water')).toBe(57.81)
    expect(s.income.find((l) => l.key === 'security_deposit')).toBeUndefined()
    expect(s.total_income).toBe(1258.11)
    expect(s.excluded.security_deposits).toBe(2000)
  })

  it('puts capital below NOI', () => {
    const s = buildIncomeStatement(charges, expenses, R)
    expect(s.total_operating_expense).toBe(300)
    expect(s.noi).toBe(958.11)
    expect(s.total_capital).toBe(1990)
    expect(s.net_income).toBe(-1031.89)
    expect(s.operating_expense.find((l) => l.key === 'capital')).toBeUndefined()
  })

  it('lists every known line in a fixed order even when zero', () => {
    const s = buildIncomeStatement([], [], R)
    expect(s.income.map((l) => l.key)[0]).toBe('rent')
    expect(s.income.every((l) => l.amount === 0)).toBe(true)
    expect(s.operating_expense.map((l) => l.key)).toEqual(['taxes', 'insurance', 'maintenance', 'utilities', 'management', 'other'])
    expect(s.total_income).toBe(0)
    expect(s.noi).toBe(0)
  })

  it('fails closed on a non-numeric amount, a malformed date, or an unknown type', () => {
    expect(() => buildIncomeStatement([{ id: 'x', charge_date: '2026-11-01', type: 'rent', amount: '' }], [], R)).toThrow(/amount/)
    expect(() => buildIncomeStatement([{ id: 'x', charge_date: '11/01/2026', type: 'rent', amount: '1' }], [], R)).toThrow(/date/)
    expect(() => buildIncomeStatement([{ id: 'x', charge_date: '2026-11-01', type: 'mystery', amount: '1' }], [], R)).toThrow(/type/)
    expect(() => buildIncomeStatement([], [{ id: 'y', expense_date: '2026-11-01', category: 'mystery', amount: '1' }], R)).toThrow(/category/)
  })
})

describe('buildCashFlow', () => {
  const payments = [
    { id: 'p1', payment_date: '2026-11-05', method: 'check', stripe_status: null, amount: '795.00' },
    { id: 'p2', payment_date: '2026-11-06', method: 'ach_stripe', stripe_status: 'succeeded', amount: '240.00' },
    { id: 'p3', payment_date: '2026-11-07', method: 'ach_stripe', stripe_status: 'processing', amount: '500.00' },
    { id: 'p4', payment_date: '2026-11-07', method: 'ach_stripe', stripe_status: 'returned', amount: '1050.00' },
    { id: 'p5', payment_date: '2026-10-31', method: 'wire', stripe_status: null, amount: '9.00' },
  ]
  const expenses = [{ id: 'e1', expense_date: '2026-11-04', category: 'other', amount: '240.00' }]

  it('counts only received cash, by method, and reports in-flight ACH separately', () => {
    const cf = buildCashFlow(payments, expenses, R)
    expect(cf.cash_in.find((l) => l.key === 'check')?.amount).toBe(795)
    expect(cf.cash_in.find((l) => l.key === 'ach_stripe')?.amount).toBe(240)
    expect(cf.total_cash_in).toBe(1035)
    expect(cf.total_cash_out).toBe(240)
    expect(cf.net_cash_flow).toBe(795)
    expect(cf.pending_ach).toBe(500)
  })
})

describe('buildCashActivity', () => {
  const meta = new Map([['L1', { tenant_name: 'Adkins Towing', property_id: 'P1', property_name: 'nbc-a', suite: '08A' }]])
  const payments = [
    { id: 'p1', lease_id: 'L1', payment_date: '2026-11-09', method: 'check', stripe_status: null, amount: '705.55', check_number: '1001', notes: null },
    { id: 'p2', lease_id: 'L1', payment_date: '2026-11-02', method: 'ach_stripe', stripe_status: 'failed', amount: '705.55', check_number: null, notes: null },
  ]
  const expenses = [
    { id: 'e1', property_id: 'P1', expense_date: '2026-11-04', category: 'other', amount: '240.00', vendor: 'Host Co', description: 'Yearly Web Hosting', properties: { name: 'nbc-a' } },
  ]

  it('merges received payments and expenses newest-first with a running period net', () => {
    const a = buildCashActivity(payments, expenses, meta, R)
    expect(a.rows.map((r) => r.id)).toEqual(['p1', 'e1'])
    expect(a.rows[0]).toMatchObject({ kind: 'cash_in', party: 'Adkins Towing', property_name: 'nbc-a', suite: '08A', amount: 705.55, running_net: 465.55 })
    expect(a.rows[1]).toMatchObject({ kind: 'cash_out', party: 'Host Co', amount: -240, running_net: -240 })
    expect(a.totals).toEqual({ cash_in: 705.55, cash_out: 240, net: 465.55, pending_ach: 0 })
  })

  it('fails closed when a payment lease has no metadata', () => {
    expect(() => buildCashActivity([{ ...payments[0], lease_id: 'L9' }], [], meta, R)).toThrow(/lease/)
  })
})

describe('trailing months + monthly statement', () => {
  it('returns 12 months ending at the given month', () => {
    const m = trailingMonths('2026-11', 12)
    expect(m[0]).toBe('2025-12')
    expect(m[11]).toBe('2026-11')
    expect(m).toHaveLength(12)
  })
  it('rejects years outside 1900–2100 and bad months', () => {
    expect(() => trailingMonths('0000-06', 12)).toThrow()
    expect(() => trailingMonths('0999-12', 12)).toThrow()
    expect(() => trailingMonths('2026-00', 12)).toThrow()
  })
  it('buckets by month and totals across the window', () => {
    const charges = [
      { id: 'a', charge_date: '2026-10-01', type: 'rent', amount: '100' },
      { id: 'b', charge_date: '2026-11-01', type: 'rent', amount: '110' },
      { id: 'c', charge_date: '2025-11-30', type: 'rent', amount: '999' }, // before window
    ]
    const out = buildMonthlyIncomeStatement(charges, [], trailingMonths('2026-11', 12))
    expect(out.months).toHaveLength(12)
    expect(out.statements[10].total_income).toBe(100)
    expect(out.statements[11].total_income).toBe(110)
    expect(out.total.total_income).toBe(210)
  })
})
