// Rent-schedule engine (lease abstraction plan, Phase 2 — docs/plans/2026-11-10-lease-abstraction-auto-billing-plan.md).
//
// PURE: no I/O. Given a lease's active schedule rows (migration 0020: lease_rent_schedule,
// lease_recurring_charges, lease_concessions) it computes the monthly charge LINES for one billing
// month. server/lib/billing.ts turns those lines into AutoCharge rows; nothing here touches the DB.
//
// Contract (every rule fails CLOSED — an unusable schedule yields an exception and no lines, never a
// guessed amount, because these lines feed the autopay debit):
//   - Only rows with superseded_at NULL/undefined are read.
//   - Every date range is INCLUSIVE on both ends (like leases.start_date/end_date).
//   - Every in-term day of the month must be covered by exactly ONE active rent row
//     (0 → schedule_gap, 2+ → schedule_overlap). Days outside the lease term are never billed, even
//     when a row extends past the term.
//   - A day may carry at most one concession per charge class; 'all' counts against both 'rent' and
//     'cam_estimate' (concession_conflict). 'all' never reduces utilities or 'other' lines.
//   - CAM has ONE source per lease: if the schedule has ANY active cam_estimate recurring row, those
//     rows govern every month (a month they don't cover bills no CAM); otherwise the lease's flat
//     cam_estimate_monthly is billed over in-term days. Never both.
//   - Amounts: each run of days with the same rate and concession is a segment worth
//     rate × (days === daysInMonth ? 1 : days / daysInMonth); concessions apply per segment; the
//     line is the sum rounded once to cents. A single unconcessioned segment is therefore the exact
//     legacy expression in billing.ts, so a one-row backfilled schedule bills identically to legacy
//     (pinned by a 2000-case equivalence test).
//   - Percentages are fractions (0.03 = 3%), as in 0020's CHECKs.

export interface RentScheduleRow {
  effective_start: string
  effective_end: string
  base_rent_monthly: number
  superseded_at?: string | null
}

export type RecurringChargeType = 'cam_estimate' | 'utility_water' | 'utility_gas' | 'utility_electric' | 'utility_other' | 'other'

export interface RecurringChargeRow {
  id: string
  type: RecurringChargeType
  description: string
  amount_monthly: number
  effective_start: string
  effective_end: string
  superseded_at?: string | null
}

export interface ConcessionRow {
  charge_type: 'rent' | 'cam_estimate' | 'all'
  period_start: string
  period_end: string
  kind: 'full_waiver' | 'pct' | 'fixed_amount'
  value: number | null
  reason: string
  clause_ref?: string | null
  superseded_at?: string | null
}

export interface LeaseSchedule {
  rent: RentScheduleRow[]
  recurring: RecurringChargeRow[]
  concessions: ConcessionRow[]
}

export type ScheduleExceptionCode =
  | 'invalid_row'
  | 'schedule_missing_rent'
  | 'schedule_gap'
  | 'schedule_overlap'
  | 'recurring_overlap'
  | 'concession_conflict'

export interface ScheduleException {
  code: ScheduleExceptionCode
  detail: string
}

export type LineType = 'rent' | RecurringChargeType

export interface ScheduledLine {
  type: LineType
  amount: number
  description: string
  /** Idempotency-key discriminator when it differs from `type` ('other:<row id>'); null otherwise. */
  keySuffix: string | null
}

// ── dates ─────────────────────────────────────────────────────────────────────

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 86_400_000

/** Days since the epoch for an ISO calendar date, in UTC (host-time-zone independent). null if malformed. */
export function isoDayNumber(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string') return null
  const m = ISO_DATE_RE.exec(iso)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = Date.UTC(y, mo - 1, d)
  const back = new Date(t)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return Math.round(t / DAY_MS)
}

function isoFromDayNumber(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10)
}

/** ISO date plus n calendar months, clamped to the target month's last day (Jan 31 + 1 → Feb 28/29). */
export function addMonthsIso(iso: string, n: number): string {
  const m = ISO_DATE_RE.exec(iso)
  if (!m || isoDayNumber(iso) === null) throw new RangeError(`addMonthsIso: invalid date ${iso}`)
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + n
  const y = Math.floor(total / 12)
  const mo = total - y * 12
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()
  const d = Math.min(Number(m[3]), last)
  return `${String(y).padStart(4, '0')}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// ── helpers ───────────────────────────────────────────────────────────────────

const isActive = (r: { superseded_at?: string | null }) => r.superseded_at === null || r.superseded_at === undefined

/**
 * True when the lease has ANY schedule row, active or superseded; billing then uses the schedule path.
 * Superseded-only counts on purpose (REFUTE Phase-7 item 3): a lease whose rent rows were all
 * superseded with nothing replacing them must fail closed (schedule_missing_rent), never silently
 * fall back to the legacy flat rent.
 */
export function hasSchedule(s: LeaseSchedule | undefined): boolean {
  if (!s) return false
  return s.rent.length > 0 || s.recurring.length > 0 || s.concessions.length > 0
}

interface Span { from: number; to: number }

function span(start: string, end: string): Span | null {
  const from = isoDayNumber(start)
  const to = isoDayNumber(end)
  if (from === null || to === null || to < from) return null
  return { from, to }
}

const covers = (s: Span, d: number) => d >= s.from && d <= s.to

const CONCESSION_KINDS = new Set(['full_waiver', 'pct', 'fixed_amount'])
const CONCESSION_CLASSES = new Set(['rent', 'cam_estimate', 'all'])
const RECURRING_TYPES = new Set<string>(['cam_estimate', 'utility_water', 'utility_gas', 'utility_electric', 'utility_other', 'other'])

function concessionValueOk(c: ConcessionRow): boolean {
  // REFUTE C3: enums are whitelisted here too, not left to the 0020 CHECKs.
  if (!CONCESSION_KINDS.has(c.kind) || !CONCESSION_CLASSES.has(c.charge_type)) return false
  // Re-REFUTE finding: 'all' + fixed_amount has no defined split between rent and CAM, and netting it
  // per class credited the full value twice. Rejected; enter one fixed concession per charge class.
  if (c.charge_type === 'all' && c.kind === 'fixed_amount') return false
  if (c.kind === 'full_waiver') return c.value === null || c.value === undefined
  if (typeof c.value !== 'number' || !Number.isFinite(c.value)) return false
  if (c.kind === 'pct') return c.value > 0 && c.value < 1
  return c.value > 0
}

interface Segment { rate: number; days: number; concession: ConcessionRow | null }

/**
 * Sum segments to a cent-rounded amount. Unconcessioned, full-waiver and pct segments are netted per
 * segment. A fixed_amount concession is netted ONCE across all the segments it covers this month
 * (REFUTE C4a: a per-segment floor lost the part of the waiver that exceeded a low-rent segment when
 * a rent step fell in the same month, overbilling the tenant): waiver = value × its covered days /
 * daysInMonth, applied against the gross of those same days, floored at zero. A concession's note is
 * written only when it changes the CENT-ROUNDED amount of the days it covers (REFUTE C4b).
 */
function sumSegments(segments: Segment[], dim: number): { amount: number; notes: string[] } {
  const frac = (days: number) => (days >= dim ? 1 : days / dim)
  const cents = (x: number) => Math.round(x * 100)
  let total = 0
  const notes: string[] = []
  const note = (c: ConcessionRow) => {
    const n = c.clause_ref ? `${c.reason}, ${c.clause_ref}` : c.reason
    if (!notes.includes(n)) notes.push(n)
  }
  // fixed_amount concessions, aggregated per concession row across its segments.
  const fixed = new Map<ConcessionRow, { gross: number; days: number }>()
  for (const s of segments) {
    const gross = s.rate * frac(s.days)
    const c = s.concession
    if (!c) { total += gross; continue }
    if (c.kind === 'fixed_amount') {
      const agg = fixed.get(c) ?? { gross: 0, days: 0 }
      agg.gross += gross
      agg.days += s.days
      fixed.set(c, agg)
      continue
    }
    const net = c.kind === 'full_waiver' ? 0 : gross * (1 - (c.value as number))
    if (cents(net) < cents(gross)) note(c)
    total += net
  }
  for (const [c, agg] of fixed) {
    const net = Math.max(0, agg.gross - (c.value as number) * frac(agg.days))
    if (cents(net) < cents(agg.gross)) note(c)
    total += net
  }
  return { amount: Math.round(total * 100) / 100, notes }
}

function describe(label: string, monthLabel: string, prorated: boolean, notes: string[]): string {
  return `${label} – ${monthLabel}${prorated ? ' (prorated)' : ''}${notes.length ? ` (abatement: ${notes.join('; ')})` : ''}`
}

// ── monthly lines ─────────────────────────────────────────────────────────────

export function computeScheduledLines(args: {
  schedule: LeaseSchedule
  leaseStartDate: string
  leaseEndDate: string
  legacyCamMonthly: number
  periodYear: number
  periodMonth: number
}): { lines: ScheduledLine[] } | { exception: ScheduleException } {
  const { schedule, leaseStartDate, leaseEndDate, legacyCamMonthly, periodYear, periodMonth } = args
  const fail = (code: ScheduleExceptionCode, detail: string) => ({ exception: { code, detail } })

  const rent = schedule.rent.filter(isActive)
  const recurring = schedule.recurring.filter(isActive)
  const concessions = schedule.concessions.filter(isActive)

  // Validate every active row up front (the DB CHECKs should already guarantee this; the engine does
  // not rely on it).
  const rentSpans: Span[] = []
  for (const r of rent) {
    const s = span(r.effective_start, r.effective_end)
    if (!s || !Number.isFinite(r.base_rent_monthly) || r.base_rent_monthly < 0) {
      return fail('invalid_row', `rent row ${r.effective_start}..${r.effective_end} is malformed`)
    }
    rentSpans.push(s)
  }
  const recSpans: Span[] = []
  for (const r of recurring) {
    const s = span(r.effective_start, r.effective_end)
    if (!s || !RECURRING_TYPES.has(r.type) || !Number.isFinite(r.amount_monthly) || r.amount_monthly <= 0) {
      return fail('invalid_row', `recurring row ${r.id} is malformed`)
    }
    recSpans.push(s)
  }
  const conSpans: Span[] = []
  for (const c of concessions) {
    const s = span(c.period_start, c.period_end)
    if (!s || !concessionValueOk(c)) {
      return fail('invalid_row', `concession ${c.period_start}..${c.period_end} (${c.kind}) is malformed`)
    }
    conSpans.push(s)
  }
  if (rent.length === 0) {
    return fail('schedule_missing_rent', 'schedule has rows but no active rent rows')
  }
  const term = span(leaseStartDate, leaseEndDate)
  if (!term) return fail('invalid_row', 'lease term dates are malformed')
  if (!Number.isFinite(legacyCamMonthly) || legacyCamMonthly < 0) return fail('invalid_row', 'lease cam_estimate_monthly is malformed')

  const monthFirst = Math.round(Date.UTC(periodYear, periodMonth - 1, 1) / DAY_MS)
  const monthLast = Math.round(Date.UTC(periodYear, periodMonth, 0) / DAY_MS)
  const dim = monthLast - monthFirst + 1
  const from = Math.max(monthFirst, term.from)
  const to = Math.min(monthLast, term.to)
  if (from > to) return { lines: [] }
  const billedDays = to - from + 1
  const prorated = billedDays < dim
  const monthLabel = `${MONTHS[periodMonth - 1]} ${periodYear}`

  // The single concession (or none) applying to a charge class on day d; null result = conflict.
  const concessionOn = (cls: 'rent' | 'cam_estimate', d: number): { c: ConcessionRow | null } | null => {
    let found: ConcessionRow | null = null
    for (let i = 0; i < concessions.length; i++) {
      const c = concessions[i]
      if ((c.charge_type === cls || c.charge_type === 'all') && covers(conSpans[i], d)) {
        if (found) return null
        found = c
      }
    }
    return { c: found }
  }

  // Run-length segments keyed on (rate source, concession) so a single-rate month is ONE segment.
  const pushDay = (segs: Segment[], rate: number, c: ConcessionRow | null) => {
    const last = segs[segs.length - 1]
    if (last && last.rate === rate && last.concession === c) last.days++
    else segs.push({ rate, days: 1, concession: c })
  }

  // Rent.
  const rentSegs: Segment[] = []
  for (let d = from; d <= to; d++) {
    const idx: number[] = []
    for (let i = 0; i < rent.length; i++) if (covers(rentSpans[i], d)) idx.push(i)
    if (idx.length === 0) return fail('schedule_gap', `no active rent row covers ${isoFromDayNumber(d)}`)
    if (idx.length > 1) return fail('schedule_overlap', `${idx.length} active rent rows cover ${isoFromDayNumber(d)}`)
    const con = concessionOn('rent', d)
    if (!con) return fail('concession_conflict', `more than one rent concession covers ${isoFromDayNumber(d)}`)
    // CAM-class conflicts are checked here too, so a conflict is caught even in a month with no CAM.
    if (!concessionOn('cam_estimate', d)) return fail('concession_conflict', `more than one CAM concession covers ${isoFromDayNumber(d)}`)
    pushDay(rentSegs, rent[idx[0]].base_rent_monthly, con.c)
  }

  const lines: ScheduledLine[] = []
  const rentSum = sumSegments(rentSegs, dim)
  if (rentSum.amount > 0) {
    lines.push({ type: 'rent', amount: rentSum.amount, description: describe('Rent', monthLabel, prorated, rentSum.notes), keySuffix: null })
  }

  // CAM: recurring rows if any active cam_estimate row exists, else the lease's flat field.
  const camFromRecurring = recurring.some((r) => r.type === 'cam_estimate')
  if (!camFromRecurring) {
    const segs: Segment[] = []
    for (let d = from; d <= to; d++) pushDay(segs, legacyCamMonthly, (concessionOn('cam_estimate', d) as { c: ConcessionRow | null }).c)
    const s = sumSegments(segs, dim)
    if (s.amount > 0) lines.push({ type: 'cam_estimate', amount: s.amount, description: describe('CAM Estimate', monthLabel, prorated, s.notes), keySuffix: null })
  }

  // Recurring lines, grouped by idempotency key: cam_estimate/utilities by type, 'other' per row.
  const keyOf = (r: RecurringChargeRow) => (r.type === 'other' ? `other:${r.id}` : r.type)
  const order: RecurringChargeType[] = ['cam_estimate', 'utility_water', 'utility_gas', 'utility_electric', 'utility_other', 'other']
  const keys = [...new Set(recurring.map(keyOf))].sort((a, b) => {
    const ta = order.indexOf(a.startsWith('other:') ? 'other' : (a as RecurringChargeType))
    const tb = order.indexOf(b.startsWith('other:') ? 'other' : (b as RecurringChargeType))
    return ta - tb || a.localeCompare(b)
  })
  for (const key of keys) {
    const segs: Segment[] = []
    let label: string | null = null
    let type: RecurringChargeType = 'other'
    for (let d = from; d <= to; d++) {
      const idx: number[] = []
      for (let i = 0; i < recurring.length; i++) if (keyOf(recurring[i]) === key && covers(recSpans[i], d)) idx.push(i)
      if (idx.length > 1) return fail('recurring_overlap', `${idx.length} active ${key} rows cover ${isoFromDayNumber(d)}`)
      if (idx.length === 0) continue
      const r = recurring[idx[0]]
      type = r.type
      label ??= r.type === 'cam_estimate' ? 'CAM Estimate' : r.description
      const c = r.type === 'cam_estimate' ? (concessionOn('cam_estimate', d) as { c: ConcessionRow | null }).c : null
      pushDay(segs, r.amount_monthly, c)
    }
    if (segs.length === 0 || label === null) continue
    const days = segs.reduce((n, s) => n + s.days, 0)
    const s = sumSegments(segs, dim)
    if (s.amount > 0) {
      lines.push({ type, amount: s.amount, description: describe(label, monthLabel, days < dim, s.notes), keySuffix: type === 'other' ? key : null })
    }
  }

  return { lines }
}

// ── escalation expansion ──────────────────────────────────────────────────────

export interface EscalationRuleInput {
  kind: 'fixed_pct' | 'fixed_amount' | 'cpi'
  value: number | null
  cadence_months: number
  /** Already resolved from anniversary_basis by the caller (approve step); used as-is here. */
  first_adjustment_date: string
  applies_until: string | null
}

/**
 * Expand a FIXED escalation rule into contiguous rent rows covering termStart..termEnd. Each step
 * compounds on the prior step's cent-rounded rent; anniversaries are anchored on
 * first_adjustment_date + k × cadence (no month-end drift). CPI rules are never expanded: the index
 * value must be reviewed at each adjustment, so a review item comes back instead of rows.
 */
export function expandFixedEscalation(args: {
  termStart: string
  termEnd: string
  baseRentMonthly: number
  rule: EscalationRuleInput
}): Omit<RentScheduleRow, 'superseded_at'>[] | { needsReview: string } {
  const { termStart, termEnd, baseRentMonthly, rule } = args
  if (rule.kind === 'cpi') {
    return { needsReview: 'CPI escalation: the index value must be reviewed at each adjustment date; it is never auto-posted.' }
  }
  const term = span(termStart, termEnd)
  const first = isoDayNumber(rule.first_adjustment_date)
  const until = rule.applies_until === null ? null : isoDayNumber(rule.applies_until)
  if (!term || first === null || (rule.applies_until !== null && until === null)) return { needsReview: 'escalation rule has malformed dates' }
  if (!Number.isInteger(rule.cadence_months) || rule.cadence_months <= 0) return { needsReview: 'escalation cadence must be a positive whole number of months' }
  if (typeof rule.value !== 'number' || !Number.isFinite(rule.value) || rule.value <= 0 || (rule.kind === 'fixed_pct' && rule.value >= 1)) {
    return { needsReview: 'escalation value is out of range (fixed_pct is a fraction in (0, 1))' }
  }
  if (!Number.isFinite(baseRentMonthly) || baseRentMonthly < 0) return { needsReview: 'base rent is malformed' }
  if (first <= term.from) return { needsReview: 'first adjustment date must fall after the term start' }

  const limit = until === null ? term.to : Math.min(term.to, until)
  const round2 = (x: number) => Math.round(x * 100) / 100
  const rows: Omit<RentScheduleRow, 'superseded_at'>[] = []
  let rentNow = round2(baseRentMonthly)
  let segStart = term.from
  for (let k = 0; k < 1200; k++) {
    const adj = isoDayNumber(addMonthsIso(rule.first_adjustment_date, k * rule.cadence_months)) as number
    if (adj > limit) break
    rows.push({ effective_start: isoFromDayNumber(segStart), effective_end: isoFromDayNumber(adj - 1), base_rent_monthly: rentNow })
    rentNow = rule.kind === 'fixed_pct' ? round2(rentNow * (1 + rule.value)) : round2(rentNow + rule.value)
    segStart = adj
  }
  rows.push({ effective_start: isoFromDayNumber(segStart), effective_end: isoFromDayNumber(term.to), base_rent_monthly: rentNow })
  return rows
}
