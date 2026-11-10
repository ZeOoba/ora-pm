// Tenant account statement for one lease over [start, end] — pure, integer cents.
//
// Balances follow ar_ledger exactly (supabase/migrations/0016_charges_void.sql), so a statement
// whose `end` is on or after the lease's latest activity closes on ar_ledger.balance:
//   * charges: the caller passes only non-voided rows (voided_at IS NULL); a void is not a credit.
//   * payments: check/wire/other always count; ach_stripe counts only when stripe_status is
//     'succeeded'. 'pending'/'processing' ACH is listed as a memo that does NOT reduce the balance
//     (Gabriel ruling 2026-11-09). Anything else (failed, returned, canceled, unknown) is excluded.
//     Status is today's status — the schema keeps no status history.
//   * no credits: charges.amount is CHECK (>= 0) and there is no credit table.
//
// Period membership is by posting date: charges.charge_date, payments.payment_date.
//   opening = Σ charges before start − Σ counted payments before start
//   closing = opening + Σ period charges − Σ period counted payments   (the balance as of `end`)
// Aging is as of `end`, oldest-first (OI-234) via allocateOldestFirst over the charges posted on
// or before `end`, so the closing balance sits on the newest charges and the buckets sum to it.
import { allocateOldestFirst, daysPastDue, type AgingBucketsCents } from './ar-aging'

export interface StatementCharge {
  id: string
  charge_date: string
  due_date: string
  type: string
  description: string | null
  amountCents: number
}

export interface StatementPayment {
  id: string
  payment_date: string
  method: string
  stripe_status: string | null
  check_number: string | null
  amountCents: number
}

export type PaymentClass = 'counted' | 'pending' | 'excluded'

export function classifyPayment(p: { method: string; stripe_status: string | null }): PaymentClass {
  if (p.method === 'check' || p.method === 'wire' || p.method === 'other') return 'counted'
  if (p.method === 'ach_stripe') {
    if (p.stripe_status === 'succeeded') return 'counted'
    if (p.stripe_status === 'pending' || p.stripe_status === 'processing') return 'pending'
  }
  return 'excluded'
}

export interface StatementLine {
  date: string
  kind: 'charge' | 'payment'
  id: string
  label: string
  amountCents: number
  balanceCents: number
}

export interface PendingLine {
  date: string
  id: string
  amountCents: number
}

export interface Statement {
  start: string
  end: string
  openingCents: number
  chargesCents: number
  paymentsCents: number
  closingCents: number
  lines: StatementLine[]
  pending: PendingLine[]
  pendingCents: number
  aging: AgingBucketsCents
}

const CHARGE_LABELS: Record<string, string> = {
  rent: 'Base rent',
  cam_estimate: 'CAM estimate',
  cam_true_up: 'CAM reconciliation',
  late_fee: 'Late fee',
  security_deposit: 'Security deposit',
  utility_water: 'Water',
  utility_gas: 'Gas',
  utility_electric: 'Electric',
  utility_other: 'Utilities',
  percentage_rent: 'Percentage rent',
  other: 'Other charge',
}

export function chargeLabel(c: Pick<StatementCharge, 'type' | 'description'>): string {
  const base = CHARGE_LABELS[c.type] ?? 'Charge'
  const desc = c.description?.trim()
  return desc ? `${base} — ${desc}` : base
}

export function paymentLabel(p: Pick<StatementPayment, 'method' | 'check_number'>): string {
  if (p.method === 'check') return p.check_number?.trim() ? `Payment — check #${p.check_number.trim()}` : 'Payment — check'
  if (p.method === 'wire') return 'Payment — wire'
  if (p.method === 'ach_stripe') return 'Payment — ACH'
  return 'Payment'
}

function assertDate(label: string, d: string): void {
  // daysPastDue returns NaN when either side is malformed (strict YYYY-MM-DD, no rollover).
  if (Number.isNaN(daysPastDue(d, d))) throw new Error(`malformed ${label} date: ${d}`)
}

export function buildStatement(input: {
  charges: readonly StatementCharge[]
  payments: readonly StatementPayment[]
  start: string
  end: string
}): Statement {
  const { charges, payments, start, end } = input
  assertDate('start', start)
  assertDate('end', end)
  if (start > end) throw new Error(`invalid statement range: start ${start} is after end ${end}`)
  for (const c of charges) {
    if (!Number.isInteger(c.amountCents) || c.amountCents < 0) throw new Error(`charge ${c.id}: amount is not non-negative integer cents: ${c.amountCents}`)
    assertDate(`charge ${c.id} charge_date`, c.charge_date)
    assertDate(`charge ${c.id} due_date`, c.due_date)
  }
  for (const p of payments) {
    if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) throw new Error(`payment ${p.id}: amount is not positive integer cents: ${p.amountCents}`)
    assertDate(`payment ${p.id} payment_date`, p.payment_date)
  }

  let openingCents = 0
  let chargesCents = 0
  let paymentsCents = 0
  const period: Omit<StatementLine, 'balanceCents'>[] = []
  const pending: PendingLine[] = []

  for (const c of charges) {
    if (c.charge_date < start) openingCents += c.amountCents
    else if (c.charge_date <= end) {
      chargesCents += c.amountCents
      period.push({ date: c.charge_date, kind: 'charge', id: c.id, label: chargeLabel(c), amountCents: c.amountCents })
    }
  }
  for (const p of payments) {
    const cls = classifyPayment(p)
    if (cls === 'pending') {
      if (p.payment_date <= end) pending.push({ date: p.payment_date, id: p.id, amountCents: p.amountCents })
      continue
    }
    if (cls !== 'counted') continue
    if (p.payment_date < start) openingCents -= p.amountCents
    else if (p.payment_date <= end) {
      paymentsCents += p.amountCents
      period.push({ date: p.payment_date, kind: 'payment', id: p.id, label: paymentLabel(p), amountCents: p.amountCents })
    }
  }

  // Date ascending; on the same day charges before payments; then id (stable, deterministic).
  period.sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? -1 : 1)
      : a.kind !== b.kind ? (a.kind === 'charge' ? -1 : 1)
        : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

  let running = openingCents
  const lines: StatementLine[] = period.map(l => {
    running += l.kind === 'charge' ? l.amountCents : -l.amountCents
    return { ...l, balanceCents: running }
  })
  const closingCents = openingCents + chargesCents - paymentsCents
  if (running !== closingCents) throw new Error(`statement does not foot: running ${running} != closing ${closingCents}`)

  pending.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.id < b.id ? -1 : 1))
  const aging = allocateOldestFirst(
    closingCents,
    charges.filter(c => c.charge_date <= end).map(c => ({ id: c.id, due_date: c.due_date, amountCents: c.amountCents })),
    end,
  )

  return {
    start, end, openingCents, chargesCents, paymentsCents, closingCents, lines,
    pending, pendingCents: pending.reduce((a, p) => a + p.amountCents, 0), aging,
  }
}
