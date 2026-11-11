// B8 slice 2: an LLC's opening trial balance from a CSV of QuickBooks Desktop's Trial Balance
// report (Reports → Accountant & Taxes → Trial Balance, as of the day before the ledger start
// date → Excel → keep Account / Debit / Credit columns → save as CSV).
// FINANCIAL-DECISION CODE (refute-gated): this decides every LLC's opening position.
//
// Nothing here talks to the database. planOpeningBalance matches each row to the LLC's ledger
// chart (imported from QB in slice 1) and returns the exact lines gl_post_opening_balance would
// post, or the reasons it must not. The database re-checks balance, accounts, dates and the
// one-live-opening-balance rule (migration 0026).
import { MAX_LINE_CENTS, parseCents } from './gl'

export const MAX_TB_CHARS = 2_000_000
export const MAX_TB_ROWS = 5000
export const MAX_TB_ERRORS = 50

/** RFC 4180 CSV (Excel's dialect): quoted fields may hold commas, doubled quotes and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const s = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"' && field === '') { quoted = true; continue }
    if (ch === ',') { row.push(field); field = ''; continue }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
      continue
    }
    field += ch
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

/**
 * Dollar amounts as QuickBooks/Excel write them: "1,234.56", "$1,234.56", "1234.5", "0.00", "".
 * Returns integer cents, 0 for blank, or null when the value is not a plain non-negative amount
 * (a negative or parenthesised amount means the balance belongs in the other column).
 */
export function parseTbAmount(raw: string): number | null {
  const v = raw.trim()
  if (v === '' || v === '-') return 0
  const m = /^\$?((?:\d{1,3}(?:,\d{3})+)|\d+)(\.\d{1,2})?$/.exec(v)
  if (!m) return null
  return parseCents(m[1].replace(/,/g, '') + (m[2] ?? ''))
}

/** "4000 · Rental Income:4010 · Base Rent" → { name: "Rental Income:Base Rent", number: "4010" }. */
export function splitQbAccountLabel(label: string): { name: string; number: string | null } {
  const parts = label.split(':').map((seg) => {
    const m = /^(\S+) · (.+)$/.exec(seg.trim())
    return m ? { number: m[1], name: m[2].trim() } : { number: null, name: seg.trim() }
  })
  return { name: parts.map((p) => p.name).join(':'), number: parts[parts.length - 1].number }
}

export type ChartAccount = { id: string; number: string | null; qb_name: string; account_type: string; is_active: boolean }

export type OpeningLine = {
  row: number
  account_id: string
  number: string | null
  qb_name: string
  account_type: string
  is_active: boolean
  debit_cents: number
  credit_cents: number
}

export type OpeningPlan = {
  lines: OpeningLine[]
  debit_cents: number
  credit_cents: number
  /** From the file's TOTAL row, when it has one. */
  file_total: { debit_cents: number; credit_cents: number } | null
  skipped_zero_rows: number
  errors: string[]
  warnings: string[]
}

const NORMAL_SIDE: Record<string, 'debit' | 'credit'> = { asset: 'debit', expense: 'debit', liability: 'credit', equity: 'credit', income: 'credit' }

export function planOpeningBalance(csv: string, chart: ChartAccount[]): OpeningPlan {
  const plan: OpeningPlan = { lines: [], debit_cents: 0, credit_cents: 0, file_total: null, skipped_zero_rows: 0, errors: [], warnings: [] }
  const fail = (m: string) => { if (plan.errors.length < MAX_TB_ERRORS) plan.errors.push(m) }
  if (csv.length > MAX_TB_CHARS) { fail('file is larger than 2,000,000 characters'); return plan }
  const rows = parseCsv(csv)
  if (rows.length > MAX_TB_ROWS + 50) { fail(`more than ${MAX_TB_ROWS} rows`); return plan }

  // Header: the first row naming Account, Debit and Credit (case-insensitive); optional Number.
  const norm = (s: string) => s.trim().toLowerCase()
  const hi = rows.findIndex((r) => r.some((c) => ['account', 'account name'].includes(norm(c))) && r.some((c) => norm(c) === 'debit') && r.some((c) => norm(c) === 'credit'))
  if (hi < 0) { fail('no header row with Account, Debit and Credit columns (rename the trial balance columns to exactly these)'); return plan }
  const header = rows[hi].map(norm)
  const ci = {
    account: header.findIndex((c) => c === 'account' || c === 'account name'),
    debit: header.indexOf('debit'),
    credit: header.indexOf('credit'),
    number: header.findIndex((c) => ['number', 'account number', 'acct #', 'num'].includes(c)),
  }
  if (header.filter((c) => c === 'debit').length > 1 || header.filter((c) => c === 'credit').length > 1) {
    fail('more than one Debit or Credit column; keep a single as-of date'); return plan
  }

  const byNumber = new Map(chart.filter((a) => a.number).map((a) => [a.number as string, a]))
  const byName = new Map(chart.map((a) => [a.qb_name, a]))
  const byLower = new Map<string, ChartAccount[]>()
  for (const a of chart) byLower.set(a.qb_name.toLowerCase(), [...(byLower.get(a.qb_name.toLowerCase()) ?? []), a])
  const used = new Map<string, number>()

  for (let r = hi + 1; r < rows.length && plan.errors.length < MAX_TB_ERRORS; r++) {
    const cells = rows[r]
    const rowNo = r + 1
    const label = (cells[ci.account] ?? '').trim()
    const rawDr = cells[ci.debit] ?? ''
    const rawCr = cells[ci.credit] ?? ''
    if (!label && !rawDr.trim() && !rawCr.trim()) continue
    const dr = parseTbAmount(rawDr)
    const cr = parseTbAmount(rawCr)
    if (dr === null || cr === null) {
      fail(`row ${rowNo} (${label || 'no account'}): "${dr === null ? rawDr : rawCr}" is not a plain amount; a negative balance belongs in the other column`)
      continue
    }
    if (/^total$/i.test(label)) {
      plan.file_total = { debit_cents: dr, credit_cents: cr }
      continue
    }
    if (!label) { fail(`row ${rowNo}: an amount with no account`); continue }
    if (dr > 0 && cr > 0) { fail(`row ${rowNo} (${label}): both a debit and a credit`); continue }
    if (dr === 0 && cr === 0) { plan.skipped_zero_rows++; continue }

    const explicitNumber = ci.number >= 0 ? (cells[ci.number] ?? '').trim() : ''
    const { name, number: labelNumber } = splitQbAccountLabel(label)
    const number = explicitNumber || labelNumber
    let acct: ChartAccount | undefined
    if (number) {
      acct = byNumber.get(number)
      if (!acct) { fail(`row ${rowNo} (${label}): no account numbered ${number} in this LLC's chart`); continue }
      if (acct.qb_name.toLowerCase() !== name.toLowerCase() && acct.qb_name.toLowerCase().split(':').pop() !== name.toLowerCase().split(':').pop()) {
        fail(`row ${rowNo} (${label}): number ${number} is "${acct.qb_name}" in the ledger chart; the file and the chart disagree`)
        continue
      }
    } else {
      acct = byName.get(name)
      if (!acct) {
        const near = byLower.get(name.toLowerCase())
        fail(near?.length ? `row ${rowNo} (${label}): no exact match; the chart spells it "${near[0].qb_name}"` : `row ${rowNo} (${label}): not in this LLC's chart (import the chart from QuickBooks first)`)
        continue
      }
    }
    const prior = used.get(acct.id)
    if (prior) { fail(`row ${rowNo} (${label}): "${acct.qb_name}" already appears on row ${prior}`); continue }
    used.set(acct.id, rowNo)
    if (dr > MAX_LINE_CENTS || cr > MAX_LINE_CENTS) { fail(`row ${rowNo} (${label}): amount too large`); continue }
    plan.lines.push({ row: rowNo, account_id: acct.id, number: acct.number, qb_name: acct.qb_name, account_type: acct.account_type, is_active: acct.is_active, debit_cents: dr, credit_cents: cr })
    const side = dr > 0 ? 'debit' : 'credit'
    if (NORMAL_SIDE[acct.account_type] && NORMAL_SIDE[acct.account_type] !== side) {
      plan.warnings.push(`${acct.qb_name} (${acct.account_type}) has a ${side} balance; check it against QuickBooks`)
    }
    if (!acct.is_active) plan.warnings.push(`${acct.qb_name} is hidden in QuickBooks but carries a balance; the opening balance includes it`)
  }

  plan.debit_cents = plan.lines.reduce((s, l) => s + l.debit_cents, 0)
  plan.credit_cents = plan.lines.reduce((s, l) => s + l.credit_cents, 0)
  if (!Number.isSafeInteger(plan.debit_cents) || !Number.isSafeInteger(plan.credit_cents)) fail('totals too large')
  if (!plan.errors.length) {
    if (plan.lines.length < 2) fail('an opening balance needs at least two accounts with balances')
    if (plan.debit_cents !== plan.credit_cents) {
      fail(`debits ${formatUsd(plan.debit_cents)} do not equal credits ${formatUsd(plan.credit_cents)} (difference ${formatUsd(Math.abs(plan.debit_cents - plan.credit_cents))})`)
    }
    if (plan.file_total && (plan.file_total.debit_cents !== plan.debit_cents || plan.file_total.credit_cents !== plan.credit_cents)) {
      fail(`the file's TOTAL row (${formatUsd(plan.file_total.debit_cents)} / ${formatUsd(plan.file_total.credit_cents)}) does not match its rows (${formatUsd(plan.debit_cents)} / ${formatUsd(plan.credit_cents)}); a row may be missing`)
    }
  }
  if (plan.errors.length >= MAX_TB_ERRORS) plan.errors.push(`stopped after ${MAX_TB_ERRORS} problems; fix these and preview again`)
  return plan
}

function formatUsd(cents: number): string {
  const s = (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${cents < 0 ? '-' : ''}$${s}`
}
