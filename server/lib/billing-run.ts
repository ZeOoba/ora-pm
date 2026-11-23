// Monthly-billing run helpers (lease abstraction plan Phase 7, docs/plans/2026-11-10-lease-abstraction-auto-billing-plan.md §5/§5a).
// PURE: no I/O. server/routes/cron.ts reads the 0020 rows and the prior period's charges and calls these.
import type { ConcessionRow, LeaseSchedule, RecurringChargeRow, RentScheduleRow } from './rent-schedule'

/** Columns cron.ts selects from each 0020 table (cron prepends `id`, the keyset). Every row is read, superseded or not (see groupSchedules). */
export const RENT_SCHEDULE_COLUMNS = 'lease_id, effective_start, effective_end, base_rent_monthly, superseded_at'
export const RECURRING_COLUMNS = 'lease_id, type, description, amount_monthly, effective_start, effective_end, superseded_at'
export const CONCESSION_COLUMNS = 'lease_id, charge_type, period_start, period_end, kind, value, reason, clause_ref, superseded_at'

type Numeric = number | string | null | undefined
export type DbRentRow = Omit<RentScheduleRow, 'base_rent_monthly'> & { lease_id: string; base_rent_monthly: Numeric }
export type DbRecurringRow = Omit<RecurringChargeRow, 'amount_monthly'> & { lease_id: string; amount_monthly: Numeric }
export type DbConcessionRow = Omit<ConcessionRow, 'value'> & { lease_id: string; value: Numeric }

/**
 * PostgREST may hand NUMERIC back as a string (plan §5a item 5). A numeric string or number becomes a
 * number; null/undefined stays null; anything unparseable becomes NaN. The engine rejects a null or
 * NaN amount as invalid_row (fail closed), never a silent 0.
 */
export function toNumber(v: Numeric): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return v
  if (v.trim() === '') return NaN
  return Number(v)
}

/** Lease-row money fields: the legacy path treats null as 0 (null × factor), so the same here. */
export function leaseAmount(v: Numeric): number {
  const n = toNumber(v)
  return n === null ? 0 : n
}

/**
 * One LeaseSchedule per lease that has ANY 0020 row. Superseded rows are kept on purpose: the engine
 * reads only active rows, and a lease whose rows are ALL superseded must still take the schedule path
 * and fail closed (schedule_missing_rent, plan §5a item 3) instead of silently billing the flat fields.
 */
export function groupSchedules(rent: DbRentRow[], recurring: DbRecurringRow[], concessions: DbConcessionRow[]): Map<string, LeaseSchedule> {
  const out = new Map<string, LeaseSchedule>()
  const of = (id: string) => {
    let s = out.get(id)
    if (!s) { s = { rent: [], recurring: [], concessions: [] }; out.set(id, s) }
    return s
  }
  for (const r of rent) {
    of(r.lease_id).rent.push({ effective_start: r.effective_start, effective_end: r.effective_end, base_rent_monthly: toNumber(r.base_rent_monthly) as number, superseded_at: r.superseded_at ?? null })
  }
  for (const r of recurring) {
    of(r.lease_id).recurring.push({ id: r.id, type: r.type, description: r.description, amount_monthly: toNumber(r.amount_monthly) as number, effective_start: r.effective_start, effective_end: r.effective_end, superseded_at: r.superseded_at ?? null })
  }
  for (const c of concessions) {
    of(c.lease_id).concessions.push({ charge_type: c.charge_type, period_start: c.period_start, period_end: c.period_end, kind: c.kind, value: toNumber(c.value), reason: c.reason, clause_ref: c.clause_ref ?? null, superseded_at: c.superseded_at ?? null })
  }
  return out
}

/** Auto charges moving by more than this fraction month over month, unexplained by the lease's own inputs, hold autopay. */
export const AUTOPAY_VARIANCE_LIMIT = 0.15

/**
 * Plan §5 autopay variance guard: never debit a surprise amount. Returns a reason to HOLD the autopay
 * debit for this lease this period, or null to let it proceed.
 *
 *   current         — total of this period's monthly auto charges the debit will draw on (posted, plus any
 *                     built charge not yet posted).
 *   currentExpected — what the lease's CURRENT inputs bill for this period.
 *   priorPosted   — total of the lease's non-voided monthly auto charges posted for the previous period;
 *                   null when the previous period has NO monthly auto charge at all, voided or not. A month
 *                   whose charges were all voided is a $0 baseline, not a missing one.
 *   priorExpected — what the CURRENT lease inputs (schedule or flat fields) bill for the previous period;
 *                   null when the engine raised an exception for it.
 *   noBaselineOk  — with no baseline (priorPosted null) the debit is allowed only when this is true: the
 *                   caller sets it only when the lease's term began this period (never for a QuickBooks
 *                   cutover: that first app-billed month is held once, REFUTE round 3). Otherwise a missing month (an exception, a failed run) is held
 *                   (REFUTE C5: that is exactly when a mis-keyed amount would go through unchecked).
 *
 * The move is EXPLAINED when the current inputs reproduce last month's posted total to the cent: it then
 * comes from the approved schedule itself (a step, an abatement ending, a prorated first month). Otherwise
 * the inputs changed since last month (lease edited, schedule replaced, prior month voided or billed
 * outside the app) and a move of more than 15%, or any move off a $0 month, is held for a human.
 */
export function autopayVarianceHold(args: { current: number; currentExpected: number; priorPosted: number | null; priorExpected: number | null; noBaselineOk: boolean }): string | null {
  const { current, currentExpected, priorExpected } = args
  // No baseline is a $0 baseline under the same explained rule (REFUTE round 2 N1: a month after a whole-month
  // abatement posts nothing, and the inputs explain that). Otherwise it holds unless noBaselineOk.
  if (args.priorPosted === null && !args.noBaselineOk
      && !(priorExpected !== null && Math.round(priorExpected * 100) === 0 && Math.round(currentExpected * 100) === Math.round(current * 100))) {
    return `no monthly auto charge was posted last month to compare $${current.toFixed(2)} against`
  }
  if (args.priorPosted === null) return null
  const priorPosted = args.priorPosted
  const cents = (x: number) => Math.round(x * 100)
  // Explained only when the current inputs reproduce BOTH months as posted (REFUTE C5: a stale amount posted
  // this month by an earlier run must not pass because last month matches).
  if (priorExpected !== null && cents(priorExpected) === cents(priorPosted) && cents(currentExpected) === cents(current)) return null
  const change = Math.abs(cents(current) - cents(priorPosted))
  if (change === 0) return null
  if (cents(priorPosted) === 0 || change > cents(priorPosted) * AUTOPAY_VARIANCE_LIMIT) {
    const why = priorExpected === null
      ? 'the lease inputs cannot bill last month'
      : `last month posted $${priorPosted.toFixed(2)} but the lease now provides $${priorExpected.toFixed(2)} for it`
    return `auto charges $${current.toFixed(2)} vs $${priorPosted.toFixed(2)} last month (more than ${AUTOPAY_VARIANCE_LIMIT * 100}% and unexplained: ${why})`
  }
  return null
}

/** First day (ISO) of the month before year/month, plus its year and month. */
export function priorPeriod(year: number, month: number): { year: number; month: number; start: string } {
  const y = month === 1 ? year - 1 : year
  const m = month === 1 ? 12 : month - 1
  return { year: y, month: m, start: `${y}-${String(m).padStart(2, '0')}-01` }
}
