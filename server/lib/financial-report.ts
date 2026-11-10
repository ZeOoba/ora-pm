// Read-only report math for the AppFolio-style dashboard, Transactions page and report library.
//
// Basis (there is no GL until roadmap P3, so these are NOT ledger statements):
//   - Income statement: billed basis — non-voided `charges` by charge_date, `expenses` by
//     expense_date. Security-deposit charges are a liability, not income: excluded and reported
//     separately. Capital expenses sit below NOI.
//   - Cash flow / cash activity: cash basis — payments the AR ledger counts as received
//     (isCashReceived mirrors the ar_ledger view's CASE in migration 0016 exactly) by payment_date;
//     recorded `expenses` as cash out by expense_date (no AP/bill-pay exists, so an expense row is
//     treated as paid on its date).
//
// Money is summed in integer cents and converted to dollars once at the end. Every row's amount
// and date is validated; a non-numeric amount, malformed date, or unknown type/category THROWS so
// the route fails closed (500) instead of under-reporting.

import { toCents } from './ar-aging'

// ---------------------------------------------------------------- input validation

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_RANGE_DAYS = 731
const MAX_PROPERTY_IDS = 100

function utcDay(iso: string): number {
  const m = ISO_DATE.exec(iso)
  if (!m) return Number.NaN
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = Date.UTC(y, mo - 1, d)
  const back = new Date(t)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return Number.NaN
  return t / 86_400_000
}

export type DateRange = { from: string; to: string }
export type RangeResult = ({ ok: true } & DateRange) | { ok: false; error: string }

/** Inclusive YYYY-MM-DD range; from <= to; at most two years. */
export function parseReportRange(from: unknown, to: unknown): RangeResult {
  if (typeof from !== 'string' || typeof to !== 'string') return { ok: false, error: 'from and to are required (YYYY-MM-DD)' }
  const f = utcDay(from)
  const t = utcDay(to)
  if (Number.isNaN(f) || Number.isNaN(t)) return { ok: false, error: 'from and to must be valid dates (YYYY-MM-DD)' }
  if (f > t) return { ok: false, error: 'from must be on or before to' }
  if (t - f > MAX_RANGE_DAYS) return { ok: false, error: `date range cannot exceed ${MAX_RANGE_DAYS} days` }
  return { ok: true, from, to }
}

/** Comma-separated property UUIDs; absent/empty = all properties (ids: null). */
export function parsePropertyIds(raw: string | undefined): { ok: true; ids: string[] | null } | { ok: false; error: string } {
  if (raw === undefined || raw.trim() === '') return { ok: true, ids: null }
  const ids = [...new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))]
  // A non-empty value with no ids (",") is malformed, not "all properties".
  if (ids.length === 0) return { ok: false, error: 'property_ids must be UUIDs' }
  if (ids.length > MAX_PROPERTY_IDS) return { ok: false, error: `at most ${MAX_PROPERTY_IDS} property_ids` }
  if (!ids.every((id) => UUID.test(id))) return { ok: false, error: 'property_ids must be UUIDs' }
  return { ok: true, ids }
}

/** Calendar fiscal year (all ORA LLCs close on Dec 31). */
export function fiscalYearStart(to: string): string {
  return `${to.slice(0, 4)}-01-01`
}

// ---------------------------------------------------------------- payment classification

type PaymentStatus = { method: string; stripe_status: string | null }

/** Exactly the ar_ledger payment_totals CASE (migration 0016): what the ledger credits as paid. */
export function isCashReceived(p: PaymentStatus): boolean {
  if (p.method === 'ach_stripe') return p.stripe_status === 'succeeded'
  return p.method === 'check' || p.method === 'wire' || p.method === 'other'
}

/** ACH still in flight (the same set reserve_payment_intent treats as in flight, migration 0014). */
export function isPendingAch(p: PaymentStatus): boolean {
  return p.method === 'ach_stripe' && (p.stripe_status === 'pending' || p.stripe_status === 'processing')
}

// ---------------------------------------------------------------- line definitions

const INCOME_LINES = [
  ['rent', 'Rent'],
  ['cam_estimate', 'CAM estimates'],
  ['cam_true_up', 'CAM true-up'],
  ['percentage_rent', 'Percentage rent'],
  ['late_fee', 'Late fees'],
  ['utility_water', 'Water & sewer reimbursement'],
  ['utility_gas', 'Gas reimbursement'],
  ['utility_electric', 'Electric reimbursement'],
  ['utility_other', 'Other utility reimbursement'],
  ['other', 'Other income'],
] as const
const EXCLUDED_CHARGE_TYPES = new Set(['security_deposit'])

const OPEX_LINES = [
  ['taxes', 'Real estate taxes'],
  ['insurance', 'Insurance'],
  ['maintenance', 'Repairs & maintenance'],
  ['utilities', 'Utilities'],
  ['management', 'Management'],
  ['other', 'Other expense'],
] as const
const CAPITAL_LINES = [['capital', 'Capital expenditures']] as const

const CASH_IN_LINES = [
  ['ach_stripe', 'Tenant receipts — ACH'],
  ['check', 'Tenant receipts — check'],
  ['wire', 'Tenant receipts — wire'],
  ['other', 'Tenant receipts — other'],
] as const
const CASH_OUT_LINES = [...OPEX_LINES, ...CAPITAL_LINES]

const INCOME_KEYS = new Set<string>(INCOME_LINES.map(([k]) => k))
const EXPENSE_KEYS = new Set<string>(CASH_OUT_LINES.map(([k]) => k))

export type Line = { key: string; label: string; amount: number }

function lines(defs: readonly (readonly [string, string])[], cents: Map<string, number>): Line[] {
  return defs.map(([key, label]) => ({ key, label, amount: (cents.get(key) ?? 0) / 100 }))
}
function sumCents(defs: readonly (readonly [string, string])[], cents: Map<string, number>): number {
  return defs.reduce((s, [k]) => s + (cents.get(k) ?? 0), 0)
}
function add(m: Map<string, number>, k: string, c: number) {
  m.set(k, (m.get(k) ?? 0) + c)
}

function cents(v: unknown, what: string): number {
  const c = toCents(v)
  if (c === null) throw new Error(`non-numeric amount on ${what}`)
  return c
}
function checkDate(d: unknown, what: string): string {
  if (typeof d !== 'string' || Number.isNaN(utcDay(d))) throw new Error(`malformed date on ${what}`)
  return d
}
const inRange = (d: string, r: DateRange) => d >= r.from && d <= r.to

// ---------------------------------------------------------------- income statement

export type StmtCharge = { id: string; charge_date: string; type: string; amount: unknown }
export type StmtExpense = { id: string; expense_date: string; category: string; amount: unknown }

export type IncomeStatement = {
  income: Line[]
  total_income: number
  operating_expense: Line[]
  total_operating_expense: number
  noi: number
  capital: Line[]
  total_capital: number
  net_income: number
  excluded: { security_deposits: number }
}

export function buildIncomeStatement(charges: readonly StmtCharge[], expenses: readonly StmtExpense[], range: DateRange): IncomeStatement {
  const income = new Map<string, number>()
  const expense = new Map<string, number>()
  let depositsCents = 0
  for (const ch of charges) {
    const d = checkDate(ch.charge_date, `charge ${ch.id}`)
    const c = cents(ch.amount, `charge ${ch.id}`)
    if (EXCLUDED_CHARGE_TYPES.has(ch.type)) {
      if (inRange(d, range)) depositsCents += c
      continue
    }
    if (!INCOME_KEYS.has(ch.type)) throw new Error(`unknown charge type '${ch.type}' on charge ${ch.id}`)
    if (inRange(d, range)) add(income, ch.type, c)
  }
  for (const ex of expenses) {
    const d = checkDate(ex.expense_date, `expense ${ex.id}`)
    const c = cents(ex.amount, `expense ${ex.id}`)
    if (!EXPENSE_KEYS.has(ex.category)) throw new Error(`unknown expense category '${ex.category}' on expense ${ex.id}`)
    if (inRange(d, range)) add(expense, ex.category, c)
  }
  const totalIncome = sumCents(INCOME_LINES, income)
  const totalOpex = sumCents(OPEX_LINES, expense)
  const totalCapital = sumCents(CAPITAL_LINES, expense)
  const noi = totalIncome - totalOpex
  return {
    income: lines(INCOME_LINES, income),
    total_income: totalIncome / 100,
    operating_expense: lines(OPEX_LINES, expense),
    total_operating_expense: totalOpex / 100,
    noi: noi / 100,
    capital: lines(CAPITAL_LINES, expense),
    total_capital: totalCapital / 100,
    net_income: (noi - totalCapital) / 100,
    excluded: { security_deposits: depositsCents / 100 },
  }
}

// ---------------------------------------------------------------- cash flow

export type StmtPayment = { id: string; payment_date: string; method: string; stripe_status: string | null; amount: unknown }

export type CashFlow = {
  cash_in: Line[]
  total_cash_in: number
  cash_out: Line[]
  total_cash_out: number
  net_cash_flow: number
  pending_ach: number
}

export function buildCashFlow(payments: readonly StmtPayment[], expenses: readonly StmtExpense[], range: DateRange): CashFlow {
  const cashIn = new Map<string, number>()
  const cashOut = new Map<string, number>()
  let pendingCents = 0
  for (const p of payments) {
    const d = checkDate(p.payment_date, `payment ${p.id}`)
    const c = cents(p.amount, `payment ${p.id}`)
    if (!inRange(d, range)) continue
    if (isCashReceived(p)) add(cashIn, p.method, c)
    else if (isPendingAch(p)) pendingCents += c
  }
  for (const ex of expenses) {
    const d = checkDate(ex.expense_date, `expense ${ex.id}`)
    const c = cents(ex.amount, `expense ${ex.id}`)
    if (!EXPENSE_KEYS.has(ex.category)) throw new Error(`unknown expense category '${ex.category}' on expense ${ex.id}`)
    if (inRange(d, range)) add(cashOut, ex.category, c)
  }
  const tin = sumCents(CASH_IN_LINES, cashIn)
  const tout = sumCents(CASH_OUT_LINES, cashOut)
  return {
    cash_in: lines(CASH_IN_LINES, cashIn),
    total_cash_in: tin / 100,
    cash_out: lines(CASH_OUT_LINES, cashOut),
    total_cash_out: tout / 100,
    net_cash_flow: (tin - tout) / 100,
    pending_ach: pendingCents / 100,
  }
}

// ---------------------------------------------------------------- cash activity (Transactions)

export type LeaseMeta = { tenant_name: string | null; property_id: string; property_name: string | null; suite: string | null }
export type ActivityPayment = StmtPayment & { lease_id: string; check_number: string | null; notes: string | null }
export type ActivityExpense = StmtExpense & {
  property_id: string
  vendor: string | null
  description: string | null
  properties?: { name: string | null } | null
}

export type ActivityRow = {
  id: string
  kind: 'cash_in' | 'cash_out'
  date: string
  party: string
  property_id: string
  property_name: string | null
  suite: string | null
  description: string
  amount: number // signed: + cash in, − cash out
  running_net: number
}

const METHOD_LABEL: Record<string, string> = { ach_stripe: 'ACH payment', check: 'Check', wire: 'Wire', other: 'Payment' }
const CATEGORY_LABEL = new Map<string, string>(CASH_OUT_LINES.map(([k, l]) => [k, l]))

export function buildCashActivity(
  payments: readonly ActivityPayment[],
  expenses: readonly ActivityExpense[],
  leaseMeta: ReadonlyMap<string, LeaseMeta>,
  range: DateRange,
): { rows: ActivityRow[]; totals: { cash_in: number; cash_out: number; net: number; pending_ach: number } } {
  type Draft = Omit<ActivityRow, 'amount' | 'running_net'> & { cents: number }
  const drafts: Draft[] = []
  let inC = 0
  let outC = 0
  let pendingC = 0
  for (const p of payments) {
    const d = checkDate(p.payment_date, `payment ${p.id}`)
    const c = cents(p.amount, `payment ${p.id}`)
    if (!inRange(d, range)) continue
    if (isPendingAch(p)) pendingC += c
    if (!isCashReceived(p)) continue
    const meta = leaseMeta.get(p.lease_id)
    if (!meta) throw new Error(`no lease metadata for lease ${p.lease_id} (payment ${p.id})`)
    const ref = p.check_number ? ` #${p.check_number}` : ''
    drafts.push({
      id: p.id, kind: 'cash_in', date: d,
      party: meta.tenant_name ?? '—', property_id: meta.property_id, property_name: meta.property_name, suite: meta.suite,
      description: `${METHOD_LABEL[p.method] ?? 'Payment'}${ref}${p.notes ? ` — ${p.notes}` : ''}`,
      cents: c,
    })
    inC += c
  }
  for (const ex of expenses) {
    const d = checkDate(ex.expense_date, `expense ${ex.id}`)
    const c = cents(ex.amount, `expense ${ex.id}`)
    if (!EXPENSE_KEYS.has(ex.category)) throw new Error(`unknown expense category '${ex.category}' on expense ${ex.id}`)
    if (!inRange(d, range)) continue
    drafts.push({
      id: ex.id, kind: 'cash_out', date: d,
      party: ex.vendor ?? '—', property_id: ex.property_id, property_name: ex.properties?.name ?? null, suite: null,
      description: `${CATEGORY_LABEL.get(ex.category)}${ex.description ? ` — ${ex.description}` : ''}`,
      cents: -c,
    })
    outC += c
  }
  // Running net accumulates oldest-first (date, then id for a stable order), shown newest-first.
  drafts.sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.date < b.date ? -1 : 1))
  let run = 0
  const rows: ActivityRow[] = drafts.map(({ cents: c, ...r }) => {
    run += c
    return { ...r, amount: c / 100, running_net: run / 100 }
  })
  rows.reverse()
  return { rows, totals: { cash_in: inC / 100, cash_out: outC / 100, net: (inC - outC) / 100, pending_ach: pendingC / 100 } }
}

// ---------------------------------------------------------------- 12-month income statement

/** `count` consecutive YYYY-MM months ending at `endMonth`. */
export function trailingMonths(endMonth: string, count: number): string[] {
  const m = /^(\d{4})-(\d{2})$/.exec(endMonth)
  if (!m) throw new Error('endMonth must be YYYY-MM')
  const y = Number(m[1])
  const mo = Number(m[2])
  if (mo < 1 || mo > 12 || y < 1900 || y > 2100) throw new Error('endMonth must be YYYY-MM (1900–2100)')
  const out: string[] = []
  for (let i = count - 1; i >= 0; i--) {
    const idx = y * 12 + (mo - 1) - i
    out.push(`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`)
  }
  return out
}

export function monthRange(month: string): DateRange {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}

export function buildMonthlyIncomeStatement(charges: readonly StmtCharge[], expenses: readonly StmtExpense[], months: readonly string[]) {
  const statements = months.map((mo) => buildIncomeStatement(charges, expenses, monthRange(mo)))
  const total = buildIncomeStatement(charges, expenses, { from: monthRange(months[0]).from, to: monthRange(months[months.length - 1]).to })
  return { months: [...months], statements, total }
}
