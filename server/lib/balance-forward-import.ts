// Balance forward from QuickBooks (migration 0030): plan one opening-balance adjustment per lease
// from an LLC's QuickBooks Desktop "A/R Aging Summary" (Reports → Customers & Receivables → A/R
// Aging Summary, as of the cut-off date → Excel → save as CSV), plus manual figures.
// FINANCIAL-DECISION CODE (refute-gated): this decides each lease's starting balance.
//
// Nothing here talks to the database. The route loads the LLC's leases and their app balances as of
// the date; planBalanceForwards matches QuickBooks customers to leases and returns, per lease,
//     QuickBooks balance − app balance = the adjustment
// or the reasons it must not be applied. apply_balance_forwards (0030) recomputes every app balance
// under a lock and refuses any that moved since the preview.
//
// Rules:
//   * A customer row is matched to a lease automatically only when its name, normalized, is the
//     tenant's name (or "<tenant>:<job>") and exactly one lease of the LLC has that tenant. Anything
//     else is assigned by hand (`assign`), or left unmatched (a warning showing the dollars that
//     will not reach the app, so the LLC's totals will not tie).
//   * With a file, a lease no customer is matched to has a QuickBooks balance of 0 (QuickBooks says
//     the tenant owes nothing). Without a file, a lease with no manual figure is listed as
//     'no_figure' (so one can be typed) and never applied.
//   * A manual figure (`manual`, cents) overrides the file for that lease.
//   * The file's customer rows must add up to its TOTAL row, and its "As of" date must be the cut-off.
import { parseCsv, parseAsOf } from './gl-opening-balance'

export const MAX_AGING_CHARS = 1_000_000
export const MAX_AGING_ROWS = 5000

export interface BfLease {
  lease_id: string
  tenant_name: string
  suite: string | null
  property_name: string
  status: string
  app_cents: number // the app's balance as of the cut-off (ar_ledger's populations)
  pending_ach: boolean // an ACH payment dated on or before the cut-off is still pending/processing
  live_forward: { amount_cents: number; as_of: string } | null
  /** 0032: the lease's ledger entity — its AR tie-out date (null if not tied out) and ledger start date. */
  ledger?: { tied_out_as_of: string | null; start_date: string | null }
}

export interface QbCustomerRow { row: number; customer: string; cents: number }

export type BfRowStatus = 'adjust' | 'no_change' | 'has_forward' | 'blocked' | 'no_figure'

export interface BfPlanRow {
  lease_id: string
  tenant_name: string
  suite: string | null
  property_name: string
  lease_status: string
  qb_customers: string[]
  qb_source: 'file' | 'manual' | 'absent_from_file' | 'none'
  qb_cents: number
  app_cents: number
  adjustment_cents: number
  status: BfRowStatus
  note: string | null
}

export interface BfPlan {
  as_of: string
  customers: (QbCustomerRow & { lease_id: string | null; how: 'auto' | 'assigned' | 'unmatched' })[]
  file_total_cents: number | null
  unmatched_cents: number
  rows: BfPlanRow[]
  adjust_count: number
  errors: string[]
  warnings: string[]
}

/** Signed dollars as QuickBooks/Excel write them: "1,234.56", "$1,234.56", "-12.00", "(12.00)", "". */
export function parseSignedCents(raw: string): number | null {
  let v = raw.trim().replace(/^\$/, '')
  if (v === '' || v === '-') return 0
  let sign = 1
  const paren = /^\((.*)\)$/.exec(v)
  if (paren) { sign = -1; v = paren[1].trim() }
  if (v.startsWith('-')) { sign = -sign; v = v.slice(1).trim() }
  v = v.replace(/^\$/, '')
  const m = /^((?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.(\d{1,2}))?$/.exec(v)
  if (!m) return null
  const whole = Number(m[1].replace(/,/g, ''))
  const frac = Number((m[2] ?? '').padEnd(2, '0'))
  const cents = whole * 100 + frac
  if (!Number.isSafeInteger(cents)) return null
  return cents === 0 ? 0 : sign * cents
}

const SUFFIX = /\b(llc|l l c|inc|incorporated|co|corp|corporation|company|ltd|lp|llp|pllc)\b/g

/** Lowercase, '&' → 'and', no punctuation or entity suffixes, single spaces. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9: ]+/g, ' ').replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim()
}

export interface ParsedAging {
  customers: QbCustomerRow[]
  total_cents: number | null
  as_of: string | null
  as_of_cell: string | null
  errors: string[]
}

/**
 * The A/R Aging Summary CSV. The header row is the one with a "TOTAL" column; each later row whose
 * TOTAL cell holds an amount is a customer (label = first non-empty cell left of the amounts),
 * except "TOTAL" (the report total) and "Total <customer>" (a subtotal of the job rows above it).
 */
export function parseAgingSummary(text: string): ParsedAging {
  const out: ParsedAging = { customers: [], total_cents: null, as_of: null, as_of_cell: null, errors: [] }
  if (text.length > MAX_AGING_CHARS) { out.errors.push(`the file is larger than ${MAX_AGING_CHARS.toLocaleString('en-US')} characters`); return out }
  const rows = parseCsv(text)
  if (rows.length > MAX_AGING_ROWS) { out.errors.push(`the file has more than ${MAX_AGING_ROWS} rows`); return out }
  const headerIdx = rows.findIndex((r) => r.some((c) => c.trim().toUpperCase() === 'TOTAL') && r.some((c) => /^current$/i.test(c.trim())))
  if (headerIdx < 0) {
    out.errors.push('no header row with "Current" and "TOTAL" columns; export the A/R Aging Summary from QuickBooks unchanged')
    return out
  }
  for (const r of rows.slice(0, headerIdx)) {
    const cell = r.map((c) => c.trim()).find((c) => /^as of\s/i.test(c))
    if (cell) { out.as_of_cell = cell; out.as_of = parseAsOf(cell); break }
  }
  const header = rows[headerIdx].map((c) => c.trim())
  const totalCol = header.findIndex((c) => c.toUpperCase() === 'TOTAL')
  const firstAmountCol = header.findIndex((c) => c !== '')
  const seen = new Map<string, number>()
  // QuickBooks indents a customer's jobs one column right of the customer, under a header row with
  // no amounts and above a "Total <customer>" row. A job is named "<customer>:<job>" (QuickBooks'
  // own full name), so it matches its customer's tenant.
  const parents: { col: number; name: string }[] = []
  const popTo = (col: number) => { while (parents.length && parents[parents.length - 1].col >= col) parents.pop() }
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i]
    const labelCol = r.slice(0, firstAmountCol).findIndex((c) => c.trim() !== '')
    const own = labelCol < 0 ? '' : r[labelCol].trim()
    const totalRaw = (r[totalCol] ?? '').trim()
    if (totalRaw === '') {
      // A customer header (its jobs follow), a blank line or a footer.
      if (own !== '' && !/^total(\s|$)/i.test(own)) { popTo(labelCol); parents.push({ col: labelCol, name: own }) }
      continue
    }
    const cents = parseSignedCents(totalRaw)
    if (cents === null) { out.errors.push(`row ${i + 1}: TOTAL "${totalRaw}" is not an amount`); continue }
    if (own.toUpperCase() === 'TOTAL') { out.total_cents = cents; continue }
    if (/^total\s/i.test(own)) { popTo(labelCol); continue } // a customer's subtotal over its jobs
    if (own === '') { out.errors.push(`row ${i + 1}: an amount with no customer name`); continue }
    popTo(labelCol)
    const label = [...parents.map((p) => p.name), own].join(':')
    const prev = seen.get(normalizeName(label))
    if (prev !== undefined) { out.errors.push(`row ${i + 1}: customer "${label}" appears twice (also row ${prev})`); continue }
    seen.set(normalizeName(label), i + 1)
    out.customers.push({ row: i + 1, customer: label, cents })
  }
  if (out.total_cents === null) out.errors.push('the file has no TOTAL row; keep it (it is checked)')
  else {
    const sum = out.customers.reduce((a, c) => a + c.cents, 0)
    if (sum !== out.total_cents) out.errors.push(`the customer rows add up to ${centsText(sum)} but the TOTAL row says ${centsText(out.total_cents)}`)
  }
  return out
}

export function centsText(c: number): string {
  const s = (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return c < 0 ? `-$${s}` : `$${s}`
}

export interface BfPlanInput {
  as_of: string
  today: string // US Central date
  leases: BfLease[]
  aging: ParsedAging | null
  /** QuickBooks customer name → lease_id, or '' to leave that customer unmatched. */
  assign?: Record<string, string>
  /** lease_id → QuickBooks balance in cents, overriding the file. */
  manual?: Record<string, number>
}

export function planBalanceForwards(input: BfPlanInput): BfPlan {
  const { as_of, leases, aging } = input
  const assign = input.assign ?? {}
  const manual = input.manual ?? {}
  const plan: BfPlan = { as_of, customers: [], file_total_cents: aging?.total_cents ?? null, unmatched_cents: 0, rows: [], adjust_count: 0, errors: [], warnings: [] }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(as_of)) { plan.errors.push(`"${as_of}" is not a date`); return plan }
  // The cut-off is a closed day: same-day late fees, ACH reservations and checks stay open.
  if (as_of >= input.today) plan.errors.push(`the cut-off ${as_of} must be before today (${input.today})`)

  const byLease = new Map(leases.map((l) => [l.lease_id, l]))
  if (aging) {
    plan.errors.push(...aging.errors)
    if (aging.as_of_cell === null) plan.errors.push(`the file does not show its report date; keep QuickBooks' title rows (the "As of" date is checked against ${as_of})`)
    else if (aging.as_of === null) plan.errors.push(`could not read the report date "${aging.as_of_cell}"`)
    else if (aging.as_of !== as_of) plan.errors.push(`the report is "${aging.as_of_cell}" (${aging.as_of}) but the cut-off is ${as_of}`)
  }
  for (const [name, leaseId] of Object.entries(assign)) {
    if (leaseId !== '' && !byLease.has(leaseId)) plan.errors.push(`customer "${name}" is assigned to a lease that is not in this LLC`)
    if (aging && !aging.customers.some((c) => c.customer === name)) plan.errors.push(`customer "${name}" is not in the file`)
  }
  for (const [leaseId, cents] of Object.entries(manual)) {
    if (!byLease.has(leaseId)) plan.errors.push('a manual figure is for a lease that is not in this LLC')
    else if (!Number.isSafeInteger(cents)) plan.errors.push(`the manual figure for ${byLease.get(leaseId)!.tenant_name} is not whole cents`)
  }

  // Auto-match: normalized tenant name (or "<tenant>:<job>"), only when one lease has that tenant.
  const leasesByTenant = new Map<string, BfLease[]>()
  for (const l of leases) {
    const k = normalizeName(l.tenant_name)
    leasesByTenant.set(k, [...(leasesByTenant.get(k) ?? []), l])
  }
  const customersByLease = new Map<string, QbCustomerRow[]>()
  for (const c of aging?.customers ?? []) {
    let leaseId: string | null = null
    let how: 'auto' | 'assigned' | 'unmatched' = 'unmatched'
    if (Object.prototype.hasOwnProperty.call(assign, c.customer)) {
      leaseId = assign[c.customer] || null
      how = leaseId ? 'assigned' : 'unmatched'
    } else {
      const key = normalizeName(c.customer)
      const cands = leasesByTenant.get(key) ?? leasesByTenant.get(key.split(':')[0].trim()) ?? []
      if (cands.length === 1) { leaseId = cands[0].lease_id; how = 'auto' }
      else if (cands.length > 1 && c.cents !== 0) plan.errors.push(`customer "${c.customer}" matches ${cands.length} leases of the same tenant; assign it to one (and enter the other leases' balances by hand)`)
    }
    if (leaseId && byLease.has(leaseId)) customersByLease.set(leaseId, [...(customersByLease.get(leaseId) ?? []), c])
    else {
      leaseId = null; how = 'unmatched'; plan.unmatched_cents += c.cents
      // An unmatched balance would silently leave a lease at $0; only an explicit "not in the app" passes.
      if (c.cents !== 0 && assign[c.customer] !== '') {
        plan.errors.push(`QuickBooks customer "${c.customer}" (${centsText(c.cents)}) is not matched to a lease; match it, or mark it "Not in the app"`)
      }
    }
    plan.customers.push({ ...c, lease_id: leaseId, how })
  }
  if (plan.unmatched_cents !== 0) {
    plan.warnings.push(`${centsText(plan.unmatched_cents)} of the QuickBooks total is on customers not matched to a lease; it will not be in the app, so this LLC's app A/R will not tie to QuickBooks`)
  }

  for (const l of leases) {
    const matched = customersByLease.get(l.lease_id) ?? []
    const hasManual = Object.prototype.hasOwnProperty.call(manual, l.lease_id)
    if (!aging && !hasManual) {
      plan.rows.push({
        lease_id: l.lease_id, tenant_name: l.tenant_name, suite: l.suite, property_name: l.property_name, lease_status: l.status,
        qb_customers: [], qb_source: 'none', qb_cents: 0, app_cents: l.app_cents, adjustment_cents: 0, status: 'no_figure',
        note: l.live_forward ? `already has a balance forward of ${centsText(l.live_forward.amount_cents)} as of ${l.live_forward.as_of}` : null,
      })
      continue
    }
    const qb_cents = hasManual ? manual[l.lease_id] : matched.reduce((a, c) => a + c.cents, 0)
    const qb_source: BfPlanRow['qb_source'] = hasManual ? 'manual' : matched.length ? 'file' : 'absent_from_file'
    const adjustment_cents = qb_cents - l.app_cents
    let status: BfRowStatus = adjustment_cents === 0 ? 'no_change' : 'adjust'
    let note: string | null = null
    if (l.live_forward) {
      status = 'has_forward'
      note = `already has a balance forward of ${centsText(l.live_forward.amount_cents)} as of ${l.live_forward.as_of}; void it to import again`
    } else if (l.ledger?.tied_out_as_of) {
      // 0032 BF7: the ledger's AR tie-out is done; apply_balance_forwards refuses. Never applied.
      status = 'blocked'
      note = `its LLC's AR is already tied out in the ledger as of ${l.ledger.tied_out_as_of}; balance forwards must be imported before the tie-out`
    } else if (l.pending_ach) {
      status = 'blocked'
      note = `an ACH payment on or before ${as_of} is still processing; wait for it to settle`
      plan.errors.push(`${l.tenant_name}${l.suite ? ` (suite ${l.suite})` : ''}: ${note}`)
    }
    plan.rows.push({
      lease_id: l.lease_id, tenant_name: l.tenant_name, suite: l.suite, property_name: l.property_name, lease_status: l.status,
      qb_customers: matched.map((c) => c.customer), qb_source, qb_cents, app_cents: l.app_cents, adjustment_cents, status, note,
    })
  }
  plan.rows.sort((a, b) => a.property_name.localeCompare(b.property_name) || a.tenant_name.localeCompare(b.tenant_name) || a.lease_id.localeCompare(b.lease_id))
  plan.adjust_count = plan.rows.filter((r) => r.status === 'adjust').length
  // 0032 BF7: a cut-off on or after an LLC's ledger start date would refuse its AR tie-out.
  const starts = [...new Set(leases.map((l) => l.ledger?.start_date).filter((d): d is string => !!d && as_of >= d))].sort()
  if (starts.length && plan.adjust_count > 0) {
    plan.warnings.push(`the cut-off ${as_of} is on or after the ledger start date ${starts.join(', ')}: the ledger's AR tie-out will refuse these balance forwards; use the day before the start date or earlier`)
  }
  const zeroed = plan.rows.filter((r) => r.qb_source === 'absent_from_file' && r.status === 'adjust')
  if (zeroed.length) {
    plan.warnings.push(`${zeroed.length} lease${zeroed.length === 1 ? ' has' : 's have'} no QuickBooks customer and will be set to $0 (the app shows ${centsText(zeroed.reduce((a, r) => a + r.app_cents, 0))}); check each is truly paid up in QuickBooks`)
  }
  if (plan.rows.length === 0 && plan.errors.length === 0) plan.errors.push('this LLC has no leases in the app')
  return plan
}
