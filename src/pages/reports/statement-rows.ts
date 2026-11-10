// Display rows for the financial statements (AppFolio-style: Account Name · Selected Period ·
// % of Selected Period · Fiscal Year To Date · % of FYTD). Figures come from the server as-is;
// this only lays them out and computes display percentages.

import type { CashFlow, IncomeStatement, MonthlyIncomeStatementResponse, ReportLine } from '../../lib/report-types'

export type Detail = 'detail' | 'summary'
export type RowKind = 'section' | 'line' | 'total' | 'grand'
export type StatementRow = {
  label: string
  kind: RowKind
  period: number | null
  periodPct: number | null
  fytd: number | null
  fytdPct: number | null
}

export function pct(amount: number, base: number): number | null {
  if (base === 0) return null
  return Math.round((amount / base) * 10000) / 100
}

function build<S>(
  period: S,
  fytd: S,
  detail: Detail,
  base: (s: S) => number,
  parts: (
    | { section: string; lines: (s: S) => ReportLine[]; total: (s: S) => number; totalLabel: string }
    | { grand: string; value: (s: S) => number }
  )[],
): StatementRow[] {
  const pb = base(period)
  const fb = base(fytd)
  const row = (label: string, kind: RowKind, p: number, f: number): StatementRow => ({
    label, kind, period: p, periodPct: pct(p, pb), fytd: f, fytdPct: pct(f, fb),
  })
  const out: StatementRow[] = []
  for (const part of parts) {
    if ('grand' in part) {
      out.push(row(part.grand, 'grand', part.value(period), part.value(fytd)))
      continue
    }
    out.push({ label: part.section, kind: 'section', period: null, periodPct: null, fytd: null, fytdPct: null })
    if (detail === 'detail') {
      const fy = part.lines(fytd)
      part.lines(period).forEach((l, i) => out.push(row(l.label, 'line', l.amount, fy[i]?.amount ?? 0)))
    }
    out.push(row(part.totalLabel, 'total', part.total(period), part.total(fytd)))
  }
  return out
}

export function incomeStatementRows(period: IncomeStatement, fytd: IncomeStatement, detail: Detail): StatementRow[] {
  return build(period, fytd, detail, (s) => s.total_income, [
    { section: 'Income', lines: (s) => s.income, total: (s) => s.total_income, totalLabel: 'Total Income' },
    { section: 'Operating Expense', lines: (s) => s.operating_expense, total: (s) => s.total_operating_expense, totalLabel: 'Total Operating Expense' },
    { grand: 'NOI - Net Operating Income', value: (s) => s.noi },
    { section: 'Capital', lines: (s) => s.capital, total: (s) => s.total_capital, totalLabel: 'Total Capital' },
    { grand: 'Net Income', value: (s) => s.net_income },
  ])
}

export function cashFlowRows(period: CashFlow, fytd: CashFlow, detail: Detail): StatementRow[] {
  return build(period, fytd, detail, (s) => s.total_cash_in, [
    { section: 'Cash In', lines: (s) => s.cash_in, total: (s) => s.total_cash_in, totalLabel: 'Total Cash In' },
    { section: 'Cash Out', lines: (s) => s.cash_out, total: (s) => s.total_cash_out, totalLabel: 'Total Cash Out' },
    { grand: 'Net Cash Flow', value: (s) => s.net_cash_flow },
  ])
}

export type MonthlyRow = { label: string; kind: RowKind; values: (number | null)[] }

/** 12 monthly columns + a window-total column per row. */
export function monthlyRows(resp: MonthlyIncomeStatementResponse, detail: Detail): MonthlyRow[] {
  const cols = [...resp.statements, resp.total]
  const blank = cols.map(() => null)
  const out: MonthlyRow[] = []
  const section = (label: string, lines: (s: IncomeStatement) => ReportLine[], total: (s: IncomeStatement) => number, totalLabel: string) => {
    out.push({ label, kind: 'section', values: blank })
    if (detail === 'detail') {
      const n = lines(cols[0]).length
      for (let i = 0; i < n; i++) out.push({ label: lines(cols[0])[i].label, kind: 'line', values: cols.map((s) => lines(s)[i].amount) })
    }
    out.push({ label: totalLabel, kind: 'total', values: cols.map(total) })
  }
  section('Income', (s) => s.income, (s) => s.total_income, 'Total Income')
  section('Operating Expense', (s) => s.operating_expense, (s) => s.total_operating_expense, 'Total Operating Expense')
  out.push({ label: 'NOI - Net Operating Income', kind: 'grand', values: cols.map((s) => s.noi) })
  section('Capital', (s) => s.capital, (s) => s.total_capital, 'Total Capital')
  out.push({ label: 'Net Income', kind: 'grand', values: cols.map((s) => s.net_income) })
  return out
}
