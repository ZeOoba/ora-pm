import { describe, it, expect } from 'vitest'
import { incomeStatementRows, cashFlowRows, monthlyRows, pct } from '../../src/pages/reports/statement-rows'
import type { CashFlow, IncomeStatement } from '../../src/lib/report-types'

const IS = (income: number, opex: number, capital: number): IncomeStatement => ({
  income: [{ key: 'rent', label: 'Rent', amount: income }],
  total_income: income,
  operating_expense: [{ key: 'taxes', label: 'Real estate taxes', amount: opex }],
  total_operating_expense: opex,
  noi: income - opex,
  capital: [{ key: 'capital', label: 'Capital expenditures', amount: capital }],
  total_capital: capital,
  net_income: income - opex - capital,
  excluded: { security_deposits: 0 },
})

describe('pct', () => {
  it('is a 2-decimal share of the base, null when the base is 0', () => {
    expect(pct(27698.96, 28730.7)).toBe(96.41)
    expect(pct(5, 0)).toBeNull()
  })
})

describe('incomeStatementRows', () => {
  it('detail view: sections, lines, totals, NOI and net income with % of total income', () => {
    const rows = incomeStatementRows(IS(1000, 250, 100), IS(4000, 1000, 100), 'detail')
    expect(rows.map((r) => r.label)).toEqual([
      'Income', 'Rent', 'Total Income',
      'Operating Expense', 'Real estate taxes', 'Total Operating Expense',
      'NOI - Net Operating Income',
      'Capital', 'Capital expenditures', 'Total Capital',
      'Net Income',
    ])
    const noi = rows.find((r) => r.label.startsWith('NOI'))!
    expect(noi).toMatchObject({ period: 750, periodPct: 75, fytd: 3000, fytdPct: 75 })
  })
  it('summary view drops the line items', () => {
    const rows = incomeStatementRows(IS(1000, 250, 100), IS(1000, 250, 100), 'summary')
    expect(rows.some((r) => r.kind === 'line')).toBe(false)
    expect(rows.map((r) => r.label)).toContain('Net Income')
  })
})

describe('cashFlowRows', () => {
  const cf: CashFlow = {
    cash_in: [{ key: 'check', label: 'Tenant receipts — check', amount: 800 }],
    total_cash_in: 800,
    cash_out: [{ key: 'other', label: 'Other expense', amount: 200 }],
    total_cash_out: 200,
    net_cash_flow: 600,
    pending_ach: 0,
  }
  it('ends with net cash flow as % of cash in', () => {
    const rows = cashFlowRows(cf, cf, 'detail')
    expect(rows[rows.length - 1]).toMatchObject({ label: 'Net Cash Flow', period: 600, periodPct: 75 })
  })
})

describe('monthlyRows', () => {
  it('carries 12 month values plus the window total per row', () => {
    const months = Array.from({ length: 12 }, (_, i) => IS(i + 1, 0, 0))
    const rows = monthlyRows({ months: [], statements: months, total: IS(78, 0, 0) }, 'detail')
    const rent = rows.find((r) => r.label === 'Rent')!
    expect(rent.values).toHaveLength(13)
    expect(rent.values[0]).toBe(1)
    expect(rent.values[12]).toBe(78)
  })
})
