// Response shapes of the read-only report endpoints (server/lib/financial-report.ts).

export type ReportLine = { key: string; label: string; amount: number }

export type IncomeStatement = {
  income: ReportLine[]
  total_income: number
  operating_expense: ReportLine[]
  total_operating_expense: number
  noi: number
  capital: ReportLine[]
  total_capital: number
  net_income: number
  excluded: { security_deposits: number }
}

export type CashFlow = {
  cash_in: ReportLine[]
  total_cash_in: number
  cash_out: ReportLine[]
  total_cash_out: number
  net_cash_flow: number
  pending_ach: number
}

export type FinancialsResponse = {
  range: { from: string; to: string }
  fytd_range: { from: string; to: string }
  income_statement: { period: IncomeStatement; fytd: IncomeStatement }
  cash_flow: { period: CashFlow; fytd: CashFlow }
}

export type CashActivityRow = {
  id: string
  kind: 'cash_in' | 'cash_out'
  date: string
  party: string
  property_id: string
  property_name: string | null
  suite: string | null
  description: string
  amount: number
  running_net: number
}

export type CashActivityResponse = {
  data: CashActivityRow[]
  totals: { cash_in: number; cash_out: number; net: number; pending_ach: number }
  range: { from: string; to: string }
}

export type MonthlyIncomeStatementResponse = {
  months: string[]
  statements: IncomeStatement[]
  total: IncomeStatement
}
