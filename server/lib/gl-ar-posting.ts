// B8 slice 3: plan an LLC's AR posting run ("post through <date>") for an accrual-basis LLC.
// FINANCIAL-DECISION CODE (refute-gated). The plan decides WHAT posts and when; migration 0028's
// gl_post_ar_batch builds every journal entry itself from the source rows and the account roles,
// and a deferred check verifies each posting against its source, so this file cannot post a
// wrong amount or account. Its job is to choose exactly the items the rules call for, in order,
// and to show the person running it what will happen before it does.
//
// Rules (mirroring 0028):
//   charge          dated charge_date ≥ start date, ≤ through; skipped if voided on or before
//                   through without ever having posted (no entry for something never billed)
//   charge_void     a posted charge, voided; dated max(void date, charge date) ≤ through
//   charge_void_pre a pre-start charge counted at the tie-out, voided; dated max(void date, start)
//   payment         received (ACH succeeded; check/wire/other), dated payment_date ≥ start; or a
//                   pre-start payment the tie-out did NOT count (cleared later), dated the start date
//   payment_return  a posted payment now failed/returned; dated by the status change (else through)
//   payment_return_pre  a pre-start payment counted at the tie-out, now failed/returned
// Any of these dated in a locked month posts on the first day of the next open month.
// Anything the rules cannot place (a pre-start charge or payment created after the tie-out, a
// counted payment now back in a pending state) is listed under `attention` and never posted.

export const CHARGE_TYPES = ['rent', 'cam_estimate', 'cam_true_up', 'late_fee', 'security_deposit', 'utility_water', 'utility_gas', 'utility_electric', 'utility_other', 'percentage_rent', 'other'] as const
export const AR_ROLES = ['ar', 'undeposited_funds', 'prepaid_rent', ...CHARGE_TYPES] as const
export type ArRole = (typeof AR_ROLES)[number]
export type ArKind = 'charge' | 'charge_void' | 'charge_void_pre' | 'payment' | 'payment_return' | 'payment_return_pre'

export type ArCharge = { id: string; lease_id: string; charge_date: string; type: string; amount: number | string; description?: string | null; voided_at: string | null }
export type ArPayment = { id: string; lease_id: string; payment_date: string; amount: number | string; method: string; stripe_status: string | null; status_changed_at: string | null }
export type ArPlanInput = {
  startDate: string
  through: string
  charges: ArCharge[]
  payments: ArPayment[]
  postings: { kind: ArKind; source_id: string }[]
  tieoutItems: { kind: 'charge' | 'payment'; source_id: string; counted: boolean }[]
  roles: Partial<Record<ArRole, string>>
  /** Locked periods (first of month, YYYY-MM-01); their activity posts in the next open month. */
  lockedMonths?: string[]
}
export type ArItem = { kind: ArKind; source_id: string; lease_id: string; date: string; cents: number; label: string; debit_role: ArRole; credit_role: ArRole }
export type ArPlan = {
  items: ArItem[]
  attention: { source_id: string; kind: 'charge' | 'payment'; message: string }[]
  skipped: number
  errors: string[]
  /** Net change per role across the run, in cents (debits positive). */
  by_role: Partial<Record<ArRole, number>>
}

/** US Central calendar day of a timestamp (matches 0028's gl_central_date / gl_today). */
export function centralDate(ts: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts))
}

/** Exact cents for a NUMERIC dollar amount as PostgREST returns it; null if not whole cents. */
export function exactCents(amount: number | string): number | null {
  const s = typeof amount === 'number' ? String(amount) : amount.trim()
  const m = /^(\d+)(?:\.(\d{1,2})0*)?$/.exec(s)
  if (!m) return null
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
  return Number.isSafeInteger(cents) ? cents : null
}

const counts = (p: ArPayment) => (p.method === 'ach_stripe' ? p.stripe_status === 'succeeded' : true)
const failed = (p: ArPayment) => p.method === 'ach_stripe' && (p.stripe_status === 'failed' || p.stripe_status === 'returned')
const max = (a: string, b: string) => (a > b ? a : b)
const RANK: Record<ArKind, number> = { charge: 0, payment: 1, charge_void: 2, charge_void_pre: 2, payment_return: 3, payment_return_pre: 3 }

/** First day of the month after `d` (YYYY-MM-DD). */
function nextMonth(d: string): string {
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7))
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
}

export function planArRun(input: ArPlanInput): ArPlan {
  const { startDate: start, through } = input
  const plan: ArPlan = { items: [], attention: [], skipped: 0, errors: [], by_role: {} }
  const posted = new Set(input.postings.map((p) => `${p.kind}:${p.source_id}`))
  const snap = new Map(input.tieoutItems.map((i) => [`${i.kind}:${i.source_id}`, i.counted]))
  const locked = new Set(input.lockedMonths ?? [])
  // Matches 0028's gl_first_open_date: activity dated in a locked month posts on the first day of
  // the next open month (REFUTE-6 H3).
  const firstOpen = (d: string) => { let v = d; while (locked.has(`${v.slice(0, 7)}-01`)) v = nextMonth(v); return v }
  const add = (item: Omit<ArItem, 'cents'> & { cents: number | null }, what: string, amount: number | string) => {
    if (item.date > through) return
    if (item.cents === null) { plan.errors.push(`${what}: amount ${String(amount)} is not a whole number of cents`); return }
    const full = item as ArItem
    plan.items.push(full)
    plan.by_role[full.debit_role] = (plan.by_role[full.debit_role] ?? 0) + full.cents
    plan.by_role[full.credit_role] = (plan.by_role[full.credit_role] ?? 0) - full.cents
  }

  for (const c of input.charges) {
    const cents = exactCents(c.amount)
    const what = `charge ${c.id} (${c.type}, ${c.charge_date})`
    const type = c.type as ArRole
    const label = `${c.type.replace(/_/g, ' ')} ${c.charge_date}${c.description ? ` — ${c.description}` : ''}`
    const voidDate = c.voided_at ? centralDate(c.voided_at) : null
    if (c.charge_date >= start) {
      const isPosted = posted.has(`charge:${c.id}`)
      let postsNow = false
      if (!isPosted) {
        if (cents === 0) { plan.skipped++; continue }
        if (voidDate && voidDate <= through) { plan.skipped++; continue } // voided before it ever posted: nothing to book
        const d = firstOpen(c.charge_date)
        if (d <= through) {
          add({ kind: 'charge', source_id: c.id, lease_id: c.lease_id, date: d, cents, label, debit_role: 'ar', credit_role: type }, what, c.amount)
          postsNow = cents !== null
        }
      }
      if (voidDate && (isPosted || postsNow) && !posted.has(`charge_void:${c.id}`)) {
        add({ kind: 'charge_void', source_id: c.id, lease_id: c.lease_id, date: firstOpen(max(voidDate, c.charge_date)), cents, label: `void of ${label}`, debit_role: type, credit_role: 'ar' }, what, c.amount)
      }
      continue
    }
    // Pre-start: its AR came in with the opening balance (if the tie-out counted it).
    const counted = snap.get(`charge:${c.id}`)
    if (counted === undefined) {
      plan.attention.push({ source_id: c.id, kind: 'charge', message: `${label}: dated before the ledger start date but added after the AR tie-out, so it is in neither QuickBooks' opening balance nor the ledger. Enter it in QuickBooks for that period, or post a manual journal entry.` })
      continue
    }
    if (counted && voidDate && !posted.has(`charge_void_pre:${c.id}`)) {
      add({ kind: 'charge_void_pre', source_id: c.id, lease_id: c.lease_id, date: firstOpen(max(voidDate, start)), cents, label: `void of ${label} (opening AR)`, debit_role: type, credit_role: 'ar' }, what, c.amount)
    }
  }

  for (const p of input.payments) {
    const cents = exactCents(p.amount)
    const what = `payment ${p.id} (${p.payment_date})`
    const label = `${p.method === 'ach_stripe' ? 'ACH' : p.method} payment ${p.payment_date}`
    const statusDate = p.status_changed_at ? centralDate(p.status_changed_at) : null
    const counted = p.payment_date < start ? snap.get(`payment:${p.id}`) : undefined
    if (p.payment_date < start && counted === undefined) {
      plan.attention.push({ source_id: p.id, kind: 'payment', message: `${label}: dated before the ledger start date but added after the AR tie-out. Record it in QuickBooks for that period, or post a manual journal entry.` })
      continue
    }
    const isPosted = posted.has(`payment:${p.id}`)
    if (counts(p)) {
      if (isPosted) continue
      if (p.payment_date >= start) {
        add({ kind: 'payment', source_id: p.id, lease_id: p.lease_id, date: firstOpen(p.payment_date), cents, label, debit_role: 'undeposited_funds', credit_role: 'ar' }, what, p.amount)
      } else if (counted === false) {
        add({ kind: 'payment', source_id: p.id, lease_id: p.lease_id, date: firstOpen(start), cents, label: `${label} (cleared after the tie-out)`, debit_role: 'undeposited_funds', credit_role: 'ar' }, what, p.amount)
      }
      continue
    }
    if (!failed(p)) {
      // Disputed, canceled or back in flight: nothing posts until it settles (REFUTE-6 L2).
      if ((isPosted && !posted.has(`payment_return:${p.id}`)) || counted === true) {
        plan.attention.push({ source_id: p.id, kind: 'payment', message: `${label}: in the ledger as received but now "${p.stripe_status ?? 'unknown'}". Nothing posts until Stripe settles it (succeeded again, or failed/returned). Check it in Stripe.` })
      }
      continue
    }
    if (isPosted && !posted.has(`payment_return:${p.id}`)) {
      add({ kind: 'payment_return', source_id: p.id, lease_id: p.lease_id, date: firstOpen(max(statusDate ?? through, max(p.payment_date, start))), cents, label: `${label} ${p.stripe_status}`, debit_role: 'ar', credit_role: 'undeposited_funds' }, what, p.amount)
    } else if (counted === true && !posted.has(`payment_return_pre:${p.id}`)) {
      add({ kind: 'payment_return_pre', source_id: p.id, lease_id: p.lease_id, date: firstOpen(max(statusDate ?? start, start)), cents, label: `${label} ${p.stripe_status} (opening AR)`, debit_role: 'ar', credit_role: 'undeposited_funds' }, what, p.amount)
    }
  }

  plan.items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : RANK[a.kind] - RANK[b.kind] || (a.source_id < b.source_id ? -1 : 1)))
  const needed = new Set<ArRole>()
  for (const i of plan.items) { needed.add(i.debit_role); needed.add(i.credit_role) }
  for (const r of needed) if (!input.roles[r]) plan.errors.push(`map an account to "${r.replace(/_/g, ' ')}" before posting (Books › AR posting › Accounts)`)
  return plan
}
