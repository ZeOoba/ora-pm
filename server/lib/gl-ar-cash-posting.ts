// B8 slice 4: plan a cash-basis LLC's AR run ("post through <date>").
// FINANCIAL-DECISION CODE (refute-gated). The plan decides WHICH events enter the ledger's replay
// and in what order; migration 0029's gl_post_ar_cash_batch dates each event, recomputes the
// lease's oldest-first allocation and builds the entry itself, and a deferred check verifies it,
// so this file cannot post a wrong amount or account. It mirrors the allocation only to show the
// person running it what will happen (by_role) before it does.
//
// Events (mirroring 0029):
//   charge          a charge on/after the start date becomes live, dated firstOpen(charge_date);
//                   skipped if voided on or before that date (it was never live)
//   charge_void     a live charge (posted here, or counted at the tie-out) is voided, dated
//                   firstOpen(max(void date, its live date)); its live date is the start date for
//                   tie-out charges
//   payment         cash in: received (ACH succeeded; check/wire/other), dated
//                   firstOpen(max(payment_date, start)); a pre-start payment only if the tie-out
//                   did NOT count it (it cleared later)
//   payment_return  cash out: an ACH in the replay (posted here, or counted at the tie-out) now
//                   failed/returned, dated firstOpen(max(status date ?? through, its cash date))
// Allocation: per lease, cash pays live charges oldest first by due date, then (same due date)
// deposit, rent, CAM, utilities, percentage rent, other, late fees, then id; the rest is a tenant
// credit (prepaid_rent). Each event posts the change in that allocation, account by account.

import { centralDate, exactCents, type ArCharge, type ArPayment, type ArRole } from './gl-ar-posting'

export type CashKind = 'charge' | 'charge_void' | 'payment' | 'payment_return'
export type CashCharge = ArCharge & { due_date: string }
export type CashPlanInput = {
  startDate: string
  through: string
  charges: CashCharge[]
  payments: ArPayment[]
  /** Events already in the ledger's replay (gl_ar_cash_events). */
  events: { kind: CashKind; source_id: string }[]
  tieoutItems: { kind: 'charge' | 'payment'; source_id: string; counted: boolean }[]
  roles: Partial<Record<ArRole, string>>
  lockedMonths?: string[]
}
export type CashItem = { kind: CashKind; source_id: string; lease_id: string; date: string; cents: number; label: string }
export type CashPlan = {
  items: CashItem[]
  attention: { source_id: string; kind: 'charge' | 'payment'; message: string }[]
  skipped: number
  errors: string[]
  /** Net change per role across the run, in cents (debits positive). */
  by_role: Partial<Record<ArRole, number>>
}

/** Ratified order within one due date (0029 gl_ar_cash_priority). */
export const CASH_PRIORITY: Record<string, number> = {
  security_deposit: 0, rent: 1, cam_estimate: 2, cam_true_up: 3, utility_water: 4, utility_gas: 5,
  utility_electric: 6, utility_other: 7, percentage_rent: 8, other: 9, late_fee: 10,
}

type AllocCharge = { id: string; type: string; due_date: string; cents: number }

/** Oldest-first allocation of `cash` over `charges`: cents per role (prepaid_rent = the credit). */
export function allocateCash(cash: number, charges: AllocCharge[]): Map<string, number> {
  const out = new Map<string, number>()
  const ordered = [...charges].sort((a, b) =>
    a.due_date !== b.due_date ? (a.due_date < b.due_date ? -1 : 1)
      : (CASH_PRIORITY[a.type] ?? 99) - (CASH_PRIORITY[b.type] ?? 99) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  let left = cash
  let billed = 0
  for (const c of ordered) {
    billed += c.cents
    const take = Math.max(0, Math.min(c.cents, left))
    left -= take
    if (take) out.set(c.type, (out.get(c.type) ?? 0) + take)
  }
  const credit = Math.max(0, cash - billed)
  if (credit) out.set('prepaid_rent', credit)
  return out
}

const counts = (p: ArPayment) => (p.method === 'ach_stripe' ? p.stripe_status === 'succeeded' : true)
const failed = (p: ArPayment) => p.method === 'ach_stripe' && (p.stripe_status === 'failed' || p.stripe_status === 'returned')
const max = (a: string, b: string) => (a > b ? a : b)
const RANK: Record<CashKind, number> = { charge: 0, payment: 1, charge_void: 2, payment_return: 3 }

function nextMonth(d: string): string {
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7))
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
}

export function planCashArRun(input: CashPlanInput): CashPlan {
  const { startDate: start, through } = input
  const plan: CashPlan = { items: [], attention: [], skipped: 0, errors: [], by_role: {} }
  const done = new Set(input.events.map((e) => `${e.kind}:${e.source_id}`))
  const snap = new Map(input.tieoutItems.map((i) => [`${i.kind}:${i.source_id}`, i.counted]))
  const locked = new Set(input.lockedMonths ?? [])
  const firstOpen = (d: string) => { let v = d; while (locked.has(`${v.slice(0, 7)}-01`)) v = nextMonth(v); return v }
  const add = (item: Omit<CashItem, 'cents'> & { cents: number | null }, what: string, amount: number | string) => {
    if (item.date > through) return
    if (item.cents === null) { plan.errors.push(`${what}: amount ${String(amount)} is not a whole number of cents`); return }
    plan.items.push(item as CashItem)
  }

  for (const c of input.charges) {
    const cents = exactCents(c.amount)
    const what = `charge ${c.id} (${c.type}, ${c.charge_date})`
    const label = `${c.type.replace(/_/g, ' ')} ${c.charge_date}${c.description ? ` — ${c.description}` : ''}`
    const voidDate = c.voided_at ? centralDate(c.voided_at) : null
    let live: string | null = null // the date it entered (or enters) the replay
    if (c.charge_date >= start) {
      const liveDate = firstOpen(c.charge_date)
      if (done.has(`charge:${c.id}`)) live = liveDate
      else if (cents === 0 || (voidDate && voidDate <= liveDate)) { plan.skipped++; continue } // never live
      else if (liveDate <= through) {
        add({ kind: 'charge', source_id: c.id, lease_id: c.lease_id, date: liveDate, cents, label }, what, c.amount)
        live = cents === null ? null : liveDate
      }
    } else {
      const counted = snap.get(`charge:${c.id}`)
      if (counted === undefined) {
        plan.attention.push({ source_id: c.id, kind: 'charge', message: `${label}: dated before the ledger start date but added after the AR tie-out, so it is in neither QuickBooks nor the ledger's replay. Enter it in QuickBooks for that period, or post a manual journal entry.` })
        continue
      }
      if (counted) live = start
    }
    if (live && voidDate && !done.has(`charge_void:${c.id}`)) {
      add({ kind: 'charge_void', source_id: c.id, lease_id: c.lease_id, date: firstOpen(max(voidDate, live)), cents, label: `void of ${label}` }, what, c.amount)
    }
  }

  for (const p of input.payments) {
    const cents = exactCents(p.amount)
    const what = `payment ${p.id} (${p.payment_date})`
    const label = `${p.method === 'ach_stripe' ? 'ACH' : p.method} payment ${p.payment_date}`
    const statusDate = p.status_changed_at ? centralDate(p.status_changed_at) : null
    const pre = p.payment_date < start
    const counted = pre ? snap.get(`payment:${p.id}`) : undefined
    if (pre && counted === undefined) {
      plan.attention.push({ source_id: p.id, kind: 'payment', message: `${label}: dated before the ledger start date but added after the AR tie-out. Record it in QuickBooks for that period, or post a manual journal entry.` })
      continue
    }
    const cashDate = firstOpen(max(p.payment_date, start))
    const inReplay = counted === true || done.has(`payment:${p.id}`)
    if (counts(p)) {
      if (inReplay) continue
      if (!pre || counted === false) {
        add({ kind: 'payment', source_id: p.id, lease_id: p.lease_id, date: cashDate, cents, label: pre ? `${label} (cleared after the tie-out)` : label }, what, p.amount)
      }
      continue
    }
    if (!failed(p)) {
      if (inReplay) plan.attention.push({ source_id: p.id, kind: 'payment', message: `${label}: in the ledger as received but now "${p.stripe_status ?? 'unknown'}". Nothing posts until Stripe settles it (succeeded again, or failed/returned). Check it in Stripe.` })
      continue
    }
    if (inReplay && !done.has(`payment_return:${p.id}`)) {
      const base = counted === true ? start : cashDate
      add({ kind: 'payment_return', source_id: p.id, lease_id: p.lease_id, date: firstOpen(max(statusDate ?? through, base)), cents, label: `${label} ${p.stripe_status}` }, what, p.amount)
    }
  }

  plan.items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : RANK[a.kind] - RANK[b.kind] || (a.source_id < b.source_id ? -1 : 1)))
  if (plan.errors.length) return plan

  // Preview: replay each lease from its current state through the planned items.
  const chargeById = new Map(input.charges.map((c) => [c.id, c]))
  const payById = new Map(input.payments.map((p) => [p.id, p]))
  type LeaseState = { charges: Map<string, AllocCharge>; cash: number }
  const states = new Map<string, LeaseState>()
  const state = (lease: string) => {
    let s = states.get(lease)
    if (!s) { s = { charges: new Map(), cash: 0 }; states.set(lease, s) }
    return s
  }
  const liveCharge = (c: CashCharge) => ({ id: c.id, type: c.type, due_date: c.due_date, cents: exactCents(c.amount) ?? 0 })
  for (const c of input.charges) {
    const inSet = snap.get(`charge:${c.id}`) === true || done.has(`charge:${c.id}`)
    if (inSet && !done.has(`charge_void:${c.id}`)) state(c.lease_id).charges.set(c.id, liveCharge(c))
  }
  for (const p of input.payments) {
    const inSet = snap.get(`payment:${p.id}`) === true || done.has(`payment:${p.id}`)
    if (inSet && !done.has(`payment_return:${p.id}`)) state(p.lease_id).cash += exactCents(p.amount) ?? 0
  }
  const needed = new Set<ArRole>()
  for (const item of plan.items) {
    const s = state(item.lease_id)
    const before = allocateCash(s.cash, [...s.charges.values()])
    let cashDelta = 0
    if (item.kind === 'charge') s.charges.set(item.source_id, liveCharge(chargeById.get(item.source_id)!))
    else if (item.kind === 'charge_void') s.charges.delete(item.source_id)
    else {
      cashDelta = (exactCents(payById.get(item.source_id)!.amount) ?? 0) * (item.kind === 'payment' ? 1 : -1)
      s.cash += cashDelta
    }
    const after = allocateCash(s.cash, [...s.charges.values()])
    const delta = new Map<string, number>()
    for (const [r, v] of after) delta.set(r, (delta.get(r) ?? 0) - v) // credit side: negative
    for (const [r, v] of before) delta.set(r, (delta.get(r) ?? 0) + v)
    if (cashDelta) delta.set('undeposited_funds', (delta.get('undeposited_funds') ?? 0) + cashDelta)
    for (const [r, v] of delta) {
      if (!v) continue
      needed.add(r as ArRole)
      plan.by_role[r as ArRole] = (plan.by_role[r as ArRole] ?? 0) + v
    }
  }
  for (const r of Object.keys(plan.by_role) as ArRole[]) if (plan.by_role[r] === 0) delete plan.by_role[r]
  for (const r of needed) if (!input.roles[r]) plan.errors.push(`map an account to "${r.replace(/_/g, ' ')}" before posting (Books › AR posting › Accounts)`)
  return plan
}
