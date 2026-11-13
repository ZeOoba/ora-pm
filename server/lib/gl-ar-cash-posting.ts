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
//                   firstOpen(max(void date, its replay date)); the start date for tie-out charges
//   payment         cash in: received (ACH succeeded; check/wire/other), dated
//                   firstOpen(max(payment_date, start)); a pre-start payment only if the tie-out
//                   did NOT count it (it cleared later)
//   payment_return  cash out: an ACH in the replay (posted here, or counted at the tie-out) now
//                   failed/returned, dated firstOpen(max(status date ?? through, its cash date))
// Replay date (REFUTE-7 H1): each event also has a replay date, never earlier than its lease's
// previous one: firstOpen(max(its date, the lease's last replay date)). The allocation change posts
// on the replay date; cash dated earlier posts on its own date into prepaid rent first.
// Allocation (ratified 2026-11-11): per lease, cash fills live charges in BILLING order: by the
// replay date each became live (tie-out charges first), then oldest due date, then deposit, rent,
// CAM, utilities, percentage rent, other, late fees, then id; the rest is a tenant credit
// (prepaid_rent). A charge billed late takes only cash still unapplied.
// Balance forwards from QuickBooks (0032 BF3): a counted positive one is a pseudo-charge live from
// the start, due on its as_of, after a deposit due that day and before rent (role 'balance_forward',
// income to rent unless mapped); a counted negative one is cash already on account. Never an event.

import { arRoleAccount, centralDate, exactCents, uncountedForwardMessage, unmappedRoleMessage, type ArCharge, type ArPayment, type ArRole, type LiveBalanceForward } from './gl-ar-posting'

export type CashKind = 'charge' | 'charge_void' | 'payment' | 'payment_return'
export type CashCharge = ArCharge & { due_date: string }
export type CashEvent = { kind: CashKind; source_id: string; lease_id: string; event_date: string; alloc_date: string }
export type CashPlanInput = {
  startDate: string
  through: string
  charges: CashCharge[]
  payments: ArPayment[]
  /** Events already in the ledger's replay (gl_ar_cash_events). */
  events: CashEvent[]
  tieoutItems: { kind: 'charge' | 'payment' | 'balance_forward'; source_id: string; counted: boolean; cents?: number }[]
  roles: Partial<Record<ArRole, string>>
  lockedMonths?: string[]
  /** Balance forwards counted at the tie-out, with the snapshot's SIGNED cents (0032). */
  balanceForwards?: { id: string; lease_id: string; as_of: string; cents: number }[]
  /** Live balance forwards the tie-out did NOT count (the database prevents this; defensive). */
  liveBalanceForwards?: LiveBalanceForward[]
}
export type CashItem = { kind: CashKind; source_id: string; lease_id: string; date: string; alloc_date: string; cents: number; label: string }
export type CashPlan = {
  items: CashItem[]
  attention: { source_id: string; kind: 'charge' | 'payment' | 'balance_forward'; message: string }[]
  skipped: number
  errors: string[]
  /** Net change per role across the run, in cents (debits positive). */
  by_role: Partial<Record<ArRole, number>>
}

/** Ratified order within one due date (0029 gl_ar_cash_priority). */
export const CASH_PRIORITY: Record<string, number> = {
  security_deposit: 0, rent: 1, cam_estimate: 2, cam_true_up: 3, utility_water: 4, utility_gas: 5,
  utility_electric: 6, utility_other: 7, percentage_rent: 8, other: 9, late_fee: 10,
  // 0032: a balance forward shares the deposit's priority and sorts after it (allocateCash).
  balance_forward: 0,
}

/** A live charge; `live` is its replay date ('0001-01-01' for tie-out charges). */
export type AllocCharge = { id: string; type: string; due_date: string; live: string; cents: number }

/** Billing-order allocation of `cash` over `charges`: cents per role (prepaid_rent = the credit). */
export function allocateCash(cash: number, charges: AllocCharge[]): Map<string, number> {
  for (const c of charges) if (c.cents < 0) throw new Error(`allocateCash: charge ${c.id} has negative cents ${c.cents}`)
  const out = new Map<string, number>()
  const ordered = [...charges].sort((a, b) =>
    a.live !== b.live ? (a.live < b.live ? -1 : 1)
      : a.due_date !== b.due_date ? (a.due_date < b.due_date ? -1 : 1)
        : (CASH_PRIORITY[a.type] ?? 99) - (CASH_PRIORITY[b.type] ?? 99)
          || (a.type === 'balance_forward' ? 1 : 0) - (b.type === 'balance_forward' ? 1 : 0)
          || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
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
const TIEOUT_LIVE = '0001-01-01'
const order = (a: { date: string; kind: CashKind; source_id: string }, b: { date: string; kind: CashKind; source_id: string }) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : RANK[a.kind] - RANK[b.kind] || (a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : 0)

function nextMonth(d: string): string {
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7))
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
}

type Candidate = { kind: CashKind; source_id: string; lease_id: string; date: string | null; cents: number | null; label: string; what: string; amount: number | string;
  /** For a void/return whose charge/payment is also planned in this run. */ dependsOn?: string; voidDate?: string; statusDate?: string | null }

export function planCashArRun(input: CashPlanInput): CashPlan {
  const { startDate: start, through } = input
  const plan: CashPlan = { items: [], attention: [], skipped: 0, errors: [], by_role: {} }
  const done = new Map(input.events.map((e) => [`${e.kind}:${e.source_id}`, e]))
  const snap = new Map(input.tieoutItems.map((i) => [`${i.kind}:${i.source_id}`, i.counted]))
  const locked = new Set(input.lockedMonths ?? [])
  const firstOpen = (d: string) => { let v = d; while (locked.has(`${v.slice(0, 7)}-01`)) v = nextMonth(v); return v }
  const cands: Candidate[] = []
  for (const bf of input.liveBalanceForwards ?? []) {
    plan.attention.push({ source_id: bf.id, kind: 'balance_forward', message: uncountedForwardMessage(bf, start) })
  }

  for (const c of input.charges) {
    const cents = exactCents(c.amount)
    const what = `charge ${c.id} (${c.type}, ${c.charge_date})`
    const label = `${c.type.replace(/_/g, ' ')} ${c.charge_date}${c.description ? ` — ${c.description}` : ''}`
    const voidDate = c.voided_at ? centralDate(c.voided_at) : null
    let liveBase: string | null = null // known replay date of the charge, or null if planned now
    let plannedNow = false
    if (c.charge_date >= start) {
      const natural = firstOpen(c.charge_date)
      const ev = done.get(`charge:${c.id}`)
      if (ev) liveBase = ev.alloc_date
      else if (cents === 0 || (voidDate && voidDate <= natural)) { plan.skipped++; continue } // never live
      else { cands.push({ kind: 'charge', source_id: c.id, lease_id: c.lease_id, date: natural, cents, label, what, amount: c.amount }); plannedNow = true }
    } else {
      const counted = snap.get(`charge:${c.id}`)
      if (counted === undefined) {
        plan.attention.push({ source_id: c.id, kind: 'charge', message: `${label}: dated before the ledger start date but added after the AR tie-out, so it is in neither QuickBooks nor the ledger's replay. Enter it in QuickBooks for that period, or post a manual journal entry.` })
        continue
      }
      if (counted) liveBase = start
    }
    if (voidDate && (liveBase || plannedNow) && !done.has(`charge_void:${c.id}`)) {
      cands.push({ kind: 'charge_void', source_id: c.id, lease_id: c.lease_id, date: liveBase ? firstOpen(max(voidDate, liveBase)) : null, cents, label: `void of ${label}`, what, amount: c.amount,
        dependsOn: plannedNow ? `charge:${c.id}` : undefined, voidDate })
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
    const ev = done.get(`payment:${p.id}`)
    const inReplay = counted === true || !!ev
    if (counts(p)) {
      if (!inReplay && (!pre || counted === false)) {
        cands.push({ kind: 'payment', source_id: p.id, lease_id: p.lease_id, date: cashDate, cents, label: pre ? `${label} (cleared after the tie-out)` : label, what, amount: p.amount })
      }
      continue
    }
    if (!failed(p)) {
      if (inReplay) plan.attention.push({ source_id: p.id, kind: 'payment', message: `${label}: in the ledger as received but now "${p.stripe_status ?? 'unknown'}". Nothing posts until Stripe settles it (succeeded again, or failed/returned). Check it in Stripe.` })
      continue
    }
    if (inReplay && !done.has(`payment_return:${p.id}`)) {
      const base = counted === true ? start : ev!.event_date
      cands.push({ kind: 'payment_return', source_id: p.id, lease_id: p.lease_id, date: firstOpen(max(statusDate ?? through, base)), cents, label: `${label} ${p.stripe_status}`, what, amount: p.amount })
    }
  }

  // Per lease, replay in order, assigning replay dates; dependents get their date once their base has one.
  const lastAlloc = new Map<string, string>()
  for (const e of input.events) if (!lastAlloc.has(e.lease_id) || e.alloc_date > lastAlloc.get(e.lease_id)!) lastAlloc.set(e.lease_id, e.alloc_date)
  const byLease = new Map<string, Candidate[]>()
  for (const c of cands) { const l = byLease.get(c.lease_id) ?? []; l.push(c); byLease.set(c.lease_id, l) }
  for (const [lease, list] of byLease) {
    let last = lastAlloc.get(lease) ?? null
    const ready = list.filter((c) => c.date !== null) as (Candidate & { date: string })[]
    const waiting = new Map(list.filter((c) => c.dependsOn).map((c) => [c.dependsOn!, c]))
    const excluded = new Set<string>()
    while (ready.length) {
      ready.sort(order)
      const c = ready.shift()!
      const key = `${c.kind}:${c.source_id}`
      const alloc = firstOpen(last && last > c.date ? last : c.date)
      if (c.date > through || alloc > through) { excluded.add(key); continue } // waits for a later run (and so does whatever depends on it)
      if (c.cents === null) { plan.errors.push(`${c.what}: amount ${String(c.amount)} is not a whole number of cents`); excluded.add(key); continue }
      plan.items.push({ kind: c.kind, source_id: c.source_id, lease_id: lease, date: c.date, alloc_date: alloc, cents: c.cents, label: c.label })
      last = alloc
      const dep = waiting.get(key)
      if (dep && dep.voidDate) ready.push({ ...dep, date: firstOpen(max(dep.voidDate, alloc)) })
    }
  }
  plan.items.sort(order)
  if (plan.errors.length) return plan

  // Preview: replay each lease from its current state through the planned items (by_role nets the
  // cash and allocation legs of a split payment, so it is the run's total per role).
  const chargeById = new Map(input.charges.map((c) => [c.id, c]))
  const payById = new Map(input.payments.map((p) => [p.id, p]))
  type LeaseState = { charges: Map<string, AllocCharge>; cash: number }
  const states = new Map<string, LeaseState>()
  const state = (lease: string) => {
    let s = states.get(lease)
    if (!s) { s = { charges: new Map(), cash: 0 }; states.set(lease, s) }
    return s
  }
  const liveCharge = (c: CashCharge, live: string): AllocCharge => ({ id: c.id, type: c.type, due_date: c.due_date, live, cents: exactCents(c.amount) ?? 0 })
  for (const c of input.charges) {
    const ev = done.get(`charge:${c.id}`)
    const live = ev ? ev.alloc_date : snap.get(`charge:${c.id}`) === true ? TIEOUT_LIVE : null
    if (live && !done.has(`charge_void:${c.id}`)) state(c.lease_id).charges.set(c.id, liveCharge(c, live))
  }
  for (const p of input.payments) {
    const inSet = snap.get(`payment:${p.id}`) === true || done.has(`payment:${p.id}`)
    if (inSet && !done.has(`payment_return:${p.id}`)) state(p.lease_id).cash += exactCents(p.amount) ?? 0
  }
  // 0032 BF3: counted balance forwards are part of every lease's starting state.
  for (const bf of input.balanceForwards ?? []) {
    if (bf.cents > 0) state(bf.lease_id).charges.set(bf.id, { id: bf.id, type: 'balance_forward', due_date: bf.as_of, live: TIEOUT_LIVE, cents: bf.cents })
    else if (bf.cents < 0) state(bf.lease_id).cash += -bf.cents
  }
  const needed = new Set<ArRole>()
  for (const item of plan.items) {
    const s = state(item.lease_id)
    const before = allocateCash(s.cash, [...s.charges.values()])
    let cashDelta = 0
    if (item.kind === 'charge') s.charges.set(item.source_id, liveCharge(chargeById.get(item.source_id)!, item.alloc_date))
    else if (item.kind === 'charge_void') s.charges.delete(item.source_id)
    else {
      cashDelta = (exactCents(payById.get(item.source_id)!.amount) ?? 0) * (item.kind === 'payment' ? 1 : -1)
      s.cash += cashDelta
      if (item.date < item.alloc_date) needed.add('prepaid_rent') // the cash leg parks it there
    }
    const after = allocateCash(s.cash, [...s.charges.values()])
    const delta = new Map<string, number>()
    for (const [r, v] of after) delta.set(r, (delta.get(r) ?? 0) - v) // credit side: negative
    for (const [r, v] of before) delta.set(r, (delta.get(r) ?? 0) + v)
    if (cashDelta) delta.set('undeposited_funds', (delta.get('undeposited_funds') ?? 0) + cashDelta)
    for (const [r, v] of delta) {
      if (!v) continue
      needed.add(r as ArRole)
      // REFUTE-9 F8: an unmapped balance_forward posts to the rent account, so the preview nets it
      // there (gl_ar_cash_expected groups by account), instead of showing a reclass the ledger never posts.
      const key = (r === 'balance_forward' && !input.roles.balance_forward ? 'rent' : r) as ArRole
      plan.by_role[key] = (plan.by_role[key] ?? 0) + v
    }
  }
  for (const r of Object.keys(plan.by_role) as ArRole[]) if (plan.by_role[r] === 0) delete plan.by_role[r]
  for (const r of needed) if (!arRoleAccount(input.roles, r)) plan.errors.push(unmappedRoleMessage(r))
  return plan
}
