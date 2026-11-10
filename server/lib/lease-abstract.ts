import { z } from 'zod'
import {
  addMonthsIso,
  computeScheduledLines,
  expandFixedEscalation,
  isoDayNumber,
  type ConcessionRow,
  type LeaseSchedule,
  type RecurringChargeType,
} from './rent-schedule'

// Lease abstraction v2 (lease abstraction plan, Phase 3 — docs/plans/2026-11-10-lease-abstraction-auto-billing-plan.md §3).
//
// Extracts the FULL abstract the 0020 tables hold (parties, term, rent schedule, escalation,
// concessions, recurring charges, recoveries, provisions), every value with a page + verbatim quote.
//
// INPUT IS SCANNED TEXT ONLY — same rule as lease-extract.ts (REFUTE C1b): the request carries the
// per-page text the intake confidentiality scan cleared, never the PDF bytes.
//
// OUTPUT IS UNTRUSTED until a human approves it (Phase 4). This module never writes anything. It returns
// the parsed abstract plus FLAGS: deterministic checks a model cannot talk its way past —
//   - every quote must actually occur on the page it cites (else confidence 0 + flag);
//   - the rent schedule must be contiguous and span exactly the rent term;
//   - steps must match the stated escalation (±$1), monthly × 12 / RSF must match the stated $/SF;
//   - percentages must be fractions; concessions must sit inside the term;
//   - and the Phase-2 billing engine must be able to bill every month of the term from it.
// 'block' flags must be resolved before approval; 'warn' flags must be looked at.
//
// Transport: raw fetch (Cloudflare Worker, matching lease-extract.ts). Structured outputs
// (output_config.format json_schema), NOT forced tool_choice: forced tool use returns a 400 on Claude
// Opus 5.5, while structured outputs work on both the current default (claude-opus-5) and Opus 5.5.

// ── JSON schema sent to the API ───────────────────────────────────────────────
//
// Structured outputs cap a request at 16 union-typed parameters (anyOf / type arrays) and 24 optional
// parameters (docs: build-with-claude/structured-outputs, "Explicit limits"). This WIRE schema therefore
// has NO unions and NO optional parameters: every object is closed with every key required; scalar facts
// arrive as a list of {field, value} entries (an unstated field is simply absent); optional objects are
// zero-or-more lists; an unstated number is 0 and an unstated date is "". wireToShape() converts the
// wire form into the internal LeaseAbstract shape, which the zod layer then validates.

type JsonSchema = Record<string, unknown>
const STR: JsonSchema = { type: 'string' }
const NUM: JsonSchema = { type: 'number' }
const INT: JsonSchema = { type: 'integer' }
const DATE: JsonSchema = { type: 'string', format: 'date' }
const enumOf = (values: readonly string[]): JsonSchema => ({ type: 'string', enum: [...values] })
const obj = (properties: Record<string, JsonSchema>): JsonSchema =>
  ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const SOURCE = { page: INT, quote: STR, confidence: NUM }
const list = (item: JsonSchema): JsonSchema => ({ type: 'array', items: item })

export const ENTITY_TYPES = ['llc', 'corporation', 'partnership', 'sole_proprietorship', 'individual', 'nonprofit', 'other'] as const
export const RECURRING_TYPES = ['cam_estimate', 'utility_water', 'utility_gas', 'utility_electric', 'utility_other', 'other'] as const
export const PROVISION_CATEGORIES = [
  'renewal_option', 'expansion', 'rofr_rofo', 'termination', 'exclusive_use', 'permitted_use', 'signage',
  'parking', 'assignment_sublet', 'insurance_req', 'maintenance_split', 'hvac', 'holdover', 'late_fee',
  'guaranty', 'relocation', 'other',
] as const

/** Scalar facts, each sent as {field, value: string}. Kind drives the server-side parse. */
export const FACT_FIELDS = {
  tenant_legal_name: 'text', tenant_dba: 'text', tenant_entity_type: 'entity', tenant_state_of_formation: 'text',
  notice_address: 'text', guarantor_name: 'text', premises_suite: 'text', premises_rsf: 'number',
  pro_rata_share: 'number', execution_date: 'date', commencement_date: 'date', rent_commencement_date: 'date',
  expiration_date: 'date', rent_type: 'rent_type', security_deposit: 'number', expense_stop_psf_annual: 'number',
  base_year: 'integer', cam_cap_pct: 'number', admin_fee_pct: 'number', holdover_rent_multiplier: 'number',
} as const

export const ABSTRACT_SCHEMA: JsonSchema = obj({
  facts: list(obj({ field: enumOf(Object.keys(FACT_FIELDS)), value: STR, ...SOURCE })),
  rent_schedule: list(obj({ start: DATE, end: DATE, base_rent_monthly: NUM, rent_psf_annual: NUM, ...SOURCE })),
  escalations: list(obj({
    kind: enumOf(['fixed_pct', 'fixed_amount', 'cpi']), value: NUM, cadence_months: INT,
    first_adjustment_date: DATE, cpi_floor: NUM, cpi_cap: NUM, ...SOURCE,
  })),
  concessions: list(obj({
    charge_type: enumOf(['rent', 'cam_estimate', 'all']), period_start: DATE, period_end: DATE,
    kind: enumOf(['full_waiver', 'pct', 'fixed_amount']), value: NUM, reason: STR, ...SOURCE,
  })),
  recurring_charges: list(obj({
    type: enumOf(RECURRING_TYPES), description: STR, amount_monthly: NUM, effective_start: DATE, effective_end: DATE, ...SOURCE,
  })),
  late_fees: list(obj({ amount: NUM, pct: NUM, grace_days: INT, ...SOURCE })),
  provisions: list(obj({
    category: enumOf(PROVISION_CATEGORIES), summary: STR, notice_deadline: STR,
    exercise_window_start: STR, exercise_window_end: STR, ...SOURCE,
  })),
})

const INSTRUCTIONS = [
  'You abstract commercial (industrial/flex) leases for a landlord. Below is the extracted text of ONE lease, page by page.',
  'Text was extracted from a PDF: tables and images are not preserved and words may be split across lines.',
  'Rules:',
  '- Use the lease text only. Never infer or compute a value the lease does not state, except: rent_schedule rows may be derived from an explicitly stated rent table or an explicitly stated escalation.',
  '- facts: one entry per field the lease states; leave a field out entirely if it is not stated. value is a string: dates as YYYY-MM-DD, numbers as plain decimals without $ or commas (10000, 0.03), tenant_entity_type one of llc/corporation/partnership/sole_proprietorship/individual/nonprofit/other, rent_type one of nnn/gross/modified_gross.',
  '- page: the "Page n" number the value appears on. quote: a verbatim excerpt of at least a few words (under 200 characters) copied exactly from that page that states the value. confidence: 0..1.',
  '- Percentages are FRACTIONS: 3% is 0.03, 150% holdover is 1.5.',
  '- Money is dollars. base_rent_monthly is per month; rent_psf_annual is dollars per rentable square foot per year, or 0 if the lease does not state it.',
  '- Dates are YYYY-MM-DD. Date ranges are inclusive (a year starting 2026-01-01 ends 2026-12-31).',
  '- rent_schedule: one row per rent period across the whole term, contiguous, no gaps or overlaps.',
  '- escalations: at most one entry, only if the lease states a rule; first_adjustment_date is always a real date. For cpi, value is 0; cpi_floor is -1 when not stated (0 means a stated 0% floor); cpi_cap is 0 when not stated. For fixed rules, cpi_floor is -1 and cpi_cap is 0.',
  '- concessions: free rent, abatements, waivers. full_waiver has value 0; pct is the fraction waived; fixed_amount is dollars per month waived. A waiver of a dollar amount that covers both rent and CAM must be two entries (charge_type rent and cam_estimate), never "all".',
  '- recurring_charges: monthly amounts other than base rent (CAM estimate, utilities, tax or insurance escrow as type "other").',
  '- late_fees: at most one entry; amount and pct are 0 when not stated; grace_days is -1 when not stated (0 means no grace period).',
  '- provisions: tenant rights and special rules (options, ROFR/ROFO, termination, exclusives, use, signage, parking, assignment, insurance requirements, maintenance split, HVAC, holdover, guaranty, relocation). summary is one plain sentence. notice_deadline, exercise_window_start and exercise_window_end are YYYY-MM-DD, or "" when the lease does not let you determine them.',
].join('\n')

/**
 * Convert the WIRE form (sentinels, fact list) into the internal shape coerceAbstract validates.
 * Sentinels: 0 → null for optional numbers; "" → null for optional dates; first escalation / late fee.
 * Anything not in the expected wire form is passed through so the zod layer rejects it with a warning.
 */
export function wireToShape(raw: unknown, warnings: string[]): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const r = raw as Record<string, unknown>
  const out: Record<string, unknown> = {
    rent_schedule: r.rent_schedule, concessions: r.concessions, recurring_charges: r.recurring_charges, provisions: r.provisions,
    escalation: null, late_fee: null,
  }
  const zeroToNull = (v: unknown) => (v === 0 ? null : v)
  // -1 where 0 is a meaningful stated value (a 0% CPI floor, a 0-day grace period).
  const minusOneToNull = (v: unknown) => (v === -1 ? null : v)
  const blankToNull = (v: unknown) => (v === '' ? null : v)
  const mapItems = (v: unknown, f: (o: Record<string, unknown>) => Record<string, unknown>) =>
    Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? f(x as Record<string, unknown>) : x)) : v

  if (Array.isArray(r.facts)) {
    for (const [i, f] of r.facts.entries()) {
      const fact = f as Record<string, unknown> | null
      const name = fact?.field
      if (typeof name !== 'string' || !(name in FACT_FIELDS)) { warnings.push(`facts[${i}] names an unknown field and was dropped.`); continue }
      if (name in out) { warnings.push(`Field "${name}" was stated more than once; the first value was kept.`); continue }
      const kind = FACT_FIELDS[name as keyof typeof FACT_FIELDS]
      const text = typeof fact?.value === 'string' ? fact.value.trim() : fact?.value
      let value: unknown = text
      if ((kind === 'number' || kind === 'integer') && typeof text === 'string') {
        value = /^-?\d+(\.\d+)?$/.test(text.replace(/,/g, '')) ? Number(text.replace(/,/g, '')) : text // non-numeric → rejected by zod
      }
      out[name] = { value, page: fact?.page, quote: fact?.quote, confidence: fact?.confidence }
    }
  } else if (r.facts !== undefined) {
    warnings.push('"facts" was not a list and was dropped.')
  }
  out.rent_schedule = mapItems(r.rent_schedule, (o) => ({ ...o, rent_psf_annual: zeroToNull(o.rent_psf_annual) }))
  out.concessions = mapItems(r.concessions, (o) => ({ ...o, value: o.kind === 'full_waiver' ? zeroToNull(o.value) : o.value }))
  out.provisions = mapItems(r.provisions, (o) => ({
    ...o, notice_deadline: blankToNull(o.notice_deadline),
    exercise_window_start: blankToNull(o.exercise_window_start), exercise_window_end: blankToNull(o.exercise_window_end),
  }))
  const firstOf = (key: string, label: string) => {
    const v = r[key]
    if (!Array.isArray(v) || v.length === 0) return null
    if (v.length > 1) warnings.push(`More than one ${label} was returned; only the first was kept. Check the lease.`)
    if (!v[0] || typeof v[0] !== 'object' || Array.isArray(v[0])) { warnings.push(`The ${label} was malformed and was dropped.`); return null }
    return v[0] as Record<string, unknown>
  }
  const e = firstOf('escalations', 'escalation rule')
  if (e) out.escalation = { ...e, value: e.kind === 'cpi' ? zeroToNull(e.value) : e.value, cpi_floor: minusOneToNull(e.cpi_floor), cpi_cap: zeroToNull(e.cpi_cap) }
  const lf = firstOf('late_fees', 'late fee')
  if (lf) out.late_fee = { ...lf, amount: zeroToNull(lf.amount), pct: zeroToNull(lf.pct), grace_days: minusOneToNull(lf.grace_days) }
  return out
}

/** Above this the lease is refused rather than truncated (~250k tokens; a 100-page lease is ~60k). */
export const MAX_INPUT_CHARS = 1_000_000
export const ABSTRACT_MAX_TOKENS = 32_000

function formatPages(pages: readonly string[]): string {
  return pages.map((text, i) => `--- Page ${i + 1} of ${pages.length} ---\n${text}`).join('\n\n')
}

export function buildAbstractRequest(pages: readonly string[], model: string) {
  // Runtime guard as well as the type: a raw base64 PDF string must never reach this request.
  if (!Array.isArray(pages)) throw new TypeError('buildAbstractRequest expects scanned page text (string[]), not a PDF')
  const body = formatPages(pages)
  if (body.length > MAX_INPUT_CHARS) throw new RangeError(`lease text is ${body.length} characters; the limit is ${MAX_INPUT_CHARS}`)
  return {
    model,
    max_tokens: ABSTRACT_MAX_TOKENS,
    output_config: { effort: 'high', format: { type: 'json_schema', schema: ABSTRACT_SCHEMA } },
    system: INSTRUCTIONS,
    messages: [{ role: 'user', content: [{ type: 'text', text: body }] }],
  }
}

// ── server-side validation of the model's JSON ────────────────────────────────

const source = { page: z.number().int(), quote: z.string(), confidence: z.number() }
const citedZ = <T extends z.ZodTypeAny>(v: T) => z.object({ value: v, ...source }).nullable()
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => isoDayNumber(s) !== null, 'invalid date')

const RentRowZ = z.object({ start: isoDate, end: isoDate, base_rent_monthly: z.number(), rent_psf_annual: z.number().nullable(), ...source })
const EscalationZ = z.object({
  kind: z.enum(['fixed_pct', 'fixed_amount', 'cpi']), value: z.number().nullable(), cadence_months: z.number().int(),
  first_adjustment_date: isoDate, cpi_floor: z.number().nullable(), cpi_cap: z.number().nullable(), ...source,
})
const ConcessionZ = z.object({
  charge_type: z.enum(['rent', 'cam_estimate', 'all']), period_start: isoDate, period_end: isoDate,
  kind: z.enum(['full_waiver', 'pct', 'fixed_amount']), value: z.number().nullable(), reason: z.string(), ...source,
})
const RecurringZ = z.object({
  type: z.enum(RECURRING_TYPES), description: z.string(), amount_monthly: z.number(), effective_start: isoDate, effective_end: isoDate, ...source,
})
const LateFeeZ = z.object({ amount: z.number().nullable(), pct: z.number().nullable(), grace_days: z.number().int().nullable(), ...source })
const ProvisionZ = z.object({
  category: z.enum(PROVISION_CATEGORIES), summary: z.string(), notice_deadline: isoDate.nullable(),
  exercise_window_start: isoDate.nullable(), exercise_window_end: isoDate.nullable(), ...source,
})

const SCALARS = {
  tenant_legal_name: citedZ(z.string()),
  tenant_dba: citedZ(z.string()),
  tenant_entity_type: citedZ(z.enum(ENTITY_TYPES)),
  tenant_state_of_formation: citedZ(z.string()),
  notice_address: citedZ(z.string()),
  guarantor_name: citedZ(z.string()),
  premises_suite: citedZ(z.string()),
  premises_rsf: citedZ(z.number()),
  pro_rata_share: citedZ(z.number()),
  execution_date: citedZ(isoDate),
  commencement_date: citedZ(isoDate),
  rent_commencement_date: citedZ(isoDate),
  expiration_date: citedZ(isoDate),
  rent_type: citedZ(z.enum(['nnn', 'gross', 'modified_gross'])),
  security_deposit: citedZ(z.number()),
  expense_stop_psf_annual: citedZ(z.number()),
  base_year: citedZ(z.number().int()),
  cam_cap_pct: citedZ(z.number()),
  admin_fee_pct: citedZ(z.number()),
  holdover_rent_multiplier: citedZ(z.number()),
} as const

type Source = { page: number; quote: string; confidence: number }
export type Cited<T> = ({ value: T } & Source) | null
export type RentRow = z.infer<typeof RentRowZ>
export type Escalation = z.infer<typeof EscalationZ>
export type ConcessionItem = z.infer<typeof ConcessionZ>
export type RecurringItem = z.infer<typeof RecurringZ>
export type ProvisionItem = z.infer<typeof ProvisionZ>
export type LateFee = z.infer<typeof LateFeeZ>
export type LeaseAbstract = { -readonly [K in keyof typeof SCALARS]: z.infer<(typeof SCALARS)[K]> } & {
  rent_schedule: RentRow[]
  escalation: Escalation | null
  concessions: ConcessionItem[]
  recurring_charges: RecurringItem[]
  late_fee: LateFee | null
  provisions: ProvisionItem[]
}

export interface AbstractFlag {
  severity: 'block' | 'warn'
  path: string
  message: string
}

export interface AbstractResult {
  abstract: LeaseAbstract
  flags: AbstractFlag[]
  warnings: string[]
}

export function emptyAbstract(): LeaseAbstract {
  const a = Object.fromEntries(Object.keys(SCALARS).map((k) => [k, null])) as unknown as LeaseAbstract
  return { ...a, rent_schedule: [], escalation: null, concessions: [], recurring_charges: [], late_fee: null, provisions: [] }
}

/**
 * Validate the model JSON field by field. A malformed scalar becomes null and a malformed array item is
 * dropped — each with a warning, never silently — so one bad value never discards the whole abstract.
 */
export function coerceAbstract(raw: unknown): { abstract: LeaseAbstract; warnings: string[] } {
  const warnings: string[] = []
  const out = emptyAbstract()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { abstract: out, warnings: ['The extraction returned no usable abstract. Enter the lease manually.'] }
  }
  const r = raw as Record<string, unknown>
  for (const [k, zs] of Object.entries(SCALARS)) {
    const p = zs.safeParse(r[k] ?? null)
    if (p.success) (out as Record<string, unknown>)[k] = p.data
    else warnings.push(`Field "${k}" was malformed and was dropped.`)
  }
  const list = <T>(key: string, zs: z.ZodType<T>): T[] => {
    const v = r[key]
    if (v === undefined || v === null) return []
    if (!Array.isArray(v)) { warnings.push(`"${key}" was not a list and was dropped.`); return [] }
    const kept: T[] = []
    v.forEach((item, i) => {
      const p = zs.safeParse(item)
      if (p.success) kept.push(p.data)
      else warnings.push(`${key}[${i}] was malformed and was dropped.`)
    })
    return kept
  }
  out.rent_schedule = list('rent_schedule', RentRowZ)
  out.concessions = list('concessions', ConcessionZ)
  out.recurring_charges = list('recurring_charges', RecurringZ)
  out.provisions = list('provisions', ProvisionZ)
  for (const [key, zs] of [['escalation', EscalationZ], ['late_fee', LateFeeZ]] as const) {
    const v = r[key]
    if (v === undefined || v === null) continue
    const p = (zs as z.ZodTypeAny).safeParse(v)
    if (p.success) (out as Record<string, unknown>)[key] = p.data
    else warnings.push(`"${key}" was malformed and was dropped.`)
  }
  return { abstract: out, warnings }
}

export class ExtractionStopped extends Error {
  constructor(readonly reason: 'refusal' | 'max_tokens' | 'no_output' | 'bad_json') {
    super(`Lease abstraction stopped: ${reason}`)
  }
}

/** Pull the JSON object out of a Messages API response. Throws ExtractionStopped on anything unusable. */
export function parseAbstractResponse(json: unknown): unknown {
  const res = json as { stop_reason?: string; content?: Array<{ type?: string; text?: string }> }
  if (res.stop_reason === 'refusal') throw new ExtractionStopped('refusal')
  if (res.stop_reason === 'max_tokens') throw new ExtractionStopped('max_tokens')
  const text = (res.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
  if (!text.trim()) throw new ExtractionStopped('no_output')
  try {
    return JSON.parse(text)
  } catch {
    throw new ExtractionStopped('bad_json')
  }
}

// ── citation verification ─────────────────────────────────────────────────────

/** Case/whitespace/typography-insensitive form for quote matching. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export const MIN_QUOTE_CHARS = 12

/** True when `quote` occurs on page `page` (1-based), or straddles that page and the next. */
export function quoteOnPage(pages: readonly string[], page: number, quote: string): boolean {
  if (!Number.isInteger(page) || page < 1 || page > pages.length) return false
  const q = normalizeForMatch(quote)
  // REFUTE C3: a 3-character quote ("100", "net") matches almost any page and proves nothing.
  if (q.length < MIN_QUOTE_CHARS) return false
  const here = normalizeForMatch(pages[page - 1])
  if (here.includes(q)) return true
  if (page >= pages.length) return false
  // Straddling the break: the match must START on the cited page; a quote wholly on the next page is a
  // wrong citation, not a straddle.
  const joined = `${here} ${normalizeForMatch(pages[page])}`
  for (let i = joined.indexOf(q); i !== -1; i = joined.indexOf(q, i + 1)) {
    if (i < here.length && i + q.length > here.length) return true
  }
  return false
}

/** Paths whose values feed billing: an unverifiable citation there BLOCKS approval (REFUTE C4). */
const BILLING_PATH = /^(rent_schedule|escalation|concessions|recurring_charges|commencement_date|rent_commencement_date|expiration_date)\b/

/** Digits of a money amount as a lease would print it ("8333.33" matches "$8,333.33"; "1250" matches "1,250.00"). */
function amountInQuote(amount: number, quote: string): boolean {
  const q = quote.replace(/,/g, '')
  const fixed = amount.toFixed(2)
  return q.includes(fixed) || (Number.isInteger(amount) && new RegExp(`(^|[^\\d.])${amount}(?!\\d|\\.\\d)`).test(q))
}

function verifyCitations(a: LeaseAbstract, pages: readonly string[], flags: AbstractFlag[]): void {
  const check = (path: string, s: Source) => {
    if (!quoteOnPage(pages, s.page, s.quote)) {
      s.confidence = 0
      flags.push({
        severity: BILLING_PATH.test(path) ? 'block' : 'warn',
        path,
        message: `Quote not found on cited page ${s.page}; verify this value against the lease.`,
      })
    }
  }
  for (const k of Object.keys(SCALARS) as (keyof typeof SCALARS)[]) {
    const v = a[k]
    if (v) check(k, v)
  }
  a.rent_schedule.forEach((r, i) => check(`rent_schedule[${i}]`, r))
  if (a.escalation) check('escalation', a.escalation)
  a.concessions.forEach((r, i) => check(`concessions[${i}]`, r))
  a.recurring_charges.forEach((r, i) => {
    check(`recurring_charges[${i}]`, r)
    // REFUTE C3: a quote proves presence, not the value. A stated monthly amount should appear in it.
    // A charge the lease states per year must not be billed as that amount per month (×12 over-bill).
    if (/\b(per (year|annum)|annual(ly)?|yearly)\b/i.test(r.quote) && !/\bmonth/i.test(r.quote)) {
      flags.push({ severity: 'block', path: `recurring_charges[${i}]`, message: 'The quote states an annual amount; enter the monthly amount.' })
    }
    if (r.confidence > 0 && !amountInQuote(r.amount_monthly, r.quote)) {
      flags.push({ severity: 'warn', path: `recurring_charges[${i}]`, message: `The quote does not state ${r.amount_monthly}; confirm the amount against the lease.` })
    }
  })
  if (a.late_fee) check('late_fee', a.late_fee)
  a.provisions.forEach((r, i) => check(`provisions[${i}]`, r))
}

// ── deterministic cross-checks ────────────────────────────────────────────────

const round2 = (x: number) => Math.round(x * 100) / 100
const isCents = (x: number) => round2(x) === x

/** The billing term the schedule must cover: rent commencement (else commencement) .. expiration. */
export function billingTerm(a: LeaseAbstract): { start: string; end: string } | null {
  const start = a.rent_commencement_date?.value ?? a.commencement_date?.value ?? null
  const end = a.expiration_date?.value ?? null
  return start && end ? { start, end } : null
}

export function crossCheck(a: LeaseAbstract): AbstractFlag[] {
  const flags: AbstractFlag[] = []
  const block = (path: string, message: string) => flags.push({ severity: 'block', path, message })
  const warn = (path: string, message: string) => flags.push({ severity: 'warn', path, message })
  const day = (s: string) => isoDayNumber(s) as number

  const term = billingTerm(a)
  if (!term) block('expiration_date', 'Commencement (or rent commencement) and expiration dates are required.')
  else if (day(term.end) < day(term.start)) block('expiration_date', 'Expiration is before the rent term starts.')

  const pct = (path: string, v: number | null | undefined, max = 1, allowZero = false) => {
    if (v === null || v === undefined) return
    if (!((allowZero ? v >= 0 : v > 0) && v < max)) block(path, `Percentages are fractions (3% = 0.03); ${v} is out of range.`)
  }
  pct('pro_rata_share', a.pro_rata_share?.value, 1.000001)
  pct('cam_cap_pct', a.cam_cap_pct?.value)
  pct('admin_fee_pct', a.admin_fee_pct?.value)
  const hold = a.holdover_rent_multiplier?.value
  if (hold !== undefined && hold !== null && !(hold >= 1 && hold <= 5)) block('holdover_rent_multiplier', `Holdover is a multiplier (150% = 1.5); ${hold} is out of range.`)
  if (a.tenant_state_of_formation && !/^[A-Z]{2}$/.test(a.tenant_state_of_formation.value)) {
    warn('tenant_state_of_formation', 'State of formation should be a two-letter code.')
  }

  // Rent schedule.
  const rows = [...a.rent_schedule].sort((x, y) => day(x.start) - day(y.start))
  if (rows.length === 0) block('rent_schedule', 'No rent schedule was found.')
  rows.forEach((r, i) => {
    const p = `rent_schedule[${a.rent_schedule.indexOf(r)}]`
    if (day(r.end) < day(r.start)) block(p, 'Row ends before it starts.')
    if (!(r.base_rent_monthly >= 0)) block(p, 'Monthly rent must be zero or more.')
    else if (!isCents(r.base_rent_monthly)) block(p, `Monthly rent ${r.base_rent_monthly} has fractions of a cent; enter it to the cent.`)
    if (i > 0 && day(r.start) !== day(rows[i - 1].end) + 1) {
      block(p, day(r.start) <= day(rows[i - 1].end) ? 'Overlaps the previous rent period.' : 'Gap before this rent period.')
    }
    const rsf = a.premises_rsf?.value
    if (rsf && rsf > 0 && r.rent_psf_annual !== null && Math.abs((r.base_rent_monthly * 12) / rsf - r.rent_psf_annual) > 0.05) {
      block(p, `Monthly rent × 12 / ${rsf} RSF = $${round2((r.base_rent_monthly * 12) / rsf)}/SF, but the lease states $${r.rent_psf_annual}/SF.`)
    }
  })
  if (term && rows.length > 0) {
    if (rows[0].start !== term.start) block('rent_schedule', `Schedule starts ${rows[0].start}; the rent term starts ${term.start}.`)
    if (rows[rows.length - 1].end !== term.end) block('rent_schedule', `Schedule ends ${rows[rows.length - 1].end}; the lease expires ${term.end}.`)
  }

  // Escalation vs schedule.
  const e = a.escalation
  if (e) {
    if (e.kind === 'fixed_pct') pct('escalation', e.value)
    if (e.kind === 'fixed_amount' && !(e.value !== null && e.value > 0)) block('escalation', 'A fixed-dollar escalation needs a positive amount.')
    if (e.kind === 'cpi' && e.value !== null) block('escalation', 'A CPI escalation has no fixed value.')
    if (e.kind !== 'cpi' && (e.cpi_floor !== null || e.cpi_cap !== null)) block('escalation', 'CPI floor/cap only apply to a CPI escalation.')
    pct('escalation.cpi_floor', e.cpi_floor, 1, true)
    pct('escalation.cpi_cap', e.cpi_cap)
    if (e.cpi_floor !== null && e.cpi_cap !== null && e.cpi_floor > e.cpi_cap) block('escalation', 'CPI floor is above the cap.')
    if (!(e.cadence_months > 0)) block('escalation', 'Escalation cadence must be a positive number of months.')
    if (e.kind === 'cpi') {
      warn('escalation', 'CPI escalation: each adjustment must be reviewed when it occurs; it is never posted automatically.')
      // Re-REFUTE 2: future CPI rents are unknown, so any later step in the schedule was invented.
      if (rows.length > 1) block('rent_schedule', 'A CPI lease can only schedule the current rent; later periods depend on index values not yet published.')
    }
    // REFUTE C4: the stated rule must REPRODUCE the schedule — same step dates (first_adjustment_date
    // + k × cadence), same number of periods, each amount within $1. Checking only consecutive amounts let
    // one flat row across the term (rent never steps) and steps on the wrong dates pass.
    if (term && rows.length > 0 && (e.kind === 'fixed_pct' || e.kind === 'fixed_amount') && e.value !== null && e.value > 0
      && (e.kind !== 'fixed_pct' || e.value < 1) && e.cadence_months > 0) {
      const expected = expandFixedEscalation({
        termStart: term.start, termEnd: term.end, baseRentMonthly: rows[0].base_rent_monthly,
        rule: { kind: e.kind, value: e.value, cadence_months: e.cadence_months, first_adjustment_date: e.first_adjustment_date, applies_until: null },
      })
      if ('needsReview' in expected) {
        block('escalation', `The stated escalation cannot be applied to this term: ${expected.needsReview}.`)
      } else if (expected.length === 1) {
        // Re-REFUTE 1: a rule that never adjusts inside the term agrees with a flat schedule trivially.
        block('escalation', `The stated escalation never takes effect before expiration (first adjustment ${e.first_adjustment_date}); check the date.`)
      } else {
        const fmt = (xs: { effective_start?: string; start?: string }[]) => xs.map((x) => x.effective_start ?? x.start).join(', ')
        if (expected.length !== rows.length || expected.some((x, i) => x.effective_start !== rows[i].start || x.effective_end !== rows[i].end)) {
          block('rent_schedule', `The stated escalation implies ${expected.length} rent period(s) starting ${fmt(expected)}; the schedule has ${rows.length} starting ${fmt(rows)}.`)
        } else {
          expected.forEach((x, i) => {
            if (Math.abs(rows[i].base_rent_monthly - x.base_rent_monthly) > 1) {
              block(`rent_schedule[${a.rent_schedule.indexOf(rows[i])}]`, `Rent ${rows[i].base_rent_monthly} does not follow the stated escalation (expected about ${x.base_rent_monthly}).`)
            }
          })
        }
      }
    }
  } else if (rows.length > 1) {
    warn('rent_schedule', 'Rent steps are not tied to a stated escalation rule; confirm each period against the lease.')
  }
  if (rows.length > 0 && rows.every((r) => r.base_rent_monthly === 0)) block('rent_schedule', 'Every rent period is $0.')
  else rows.forEach((r) => { if (r.base_rent_monthly === 0) warn(`rent_schedule[${a.rent_schedule.indexOf(r)}]`, 'A $0 rent period; free rent is normally a concession, not a $0 rent row.') })

  // Concessions and recurring charges.
  a.concessions.forEach((c, i) => {
    const p = `concessions[${i}]`
    if (day(c.period_end) < day(c.period_start)) block(p, 'Ends before it starts.')
    if (term && (day(c.period_start) < day(term.start) || day(c.period_end) > day(term.end))) block(p, 'Falls outside the rent term.')
    if (c.kind === 'full_waiver' && c.value !== null) block(p, 'A full waiver has no value.')
    if (c.kind === 'pct') pct(p, c.value)
    if (c.kind === 'fixed_amount' && !(c.value !== null && c.value > 0)) block(p, 'A fixed-dollar waiver needs a positive amount.')
    if (c.charge_type === 'all' && c.kind === 'fixed_amount') block(p, 'A dollar waiver covering rent and CAM must be split into one rent row and one CAM row.')
    if (!c.reason.trim()) block(p, 'A concession needs a reason.')
  })
  a.recurring_charges.forEach((r, i) => {
    const p = `recurring_charges[${i}]`
    if (day(r.effective_end) < day(r.effective_start)) block(p, 'Ends before it starts.')
    if (!(r.amount_monthly > 0)) block(p, 'Monthly amount must be positive.')
    else if (!isCents(r.amount_monthly)) block(p, `Amount ${r.amount_monthly} has fractions of a cent.`)
    if (!r.description.trim()) block(p, 'A recurring charge needs a description.')
  })
  a.provisions.forEach((pv, i) => {
    if ((pv.exercise_window_start === null) !== (pv.exercise_window_end === null)) block(`provisions[${i}]`, 'An exercise window needs both a start and an end date.')
  })

  // Final gate: the billing engine must bill every month of the term from this abstract without an
  // exception. Only run once the structural checks above pass (otherwise it just restates them).
  if (term && !flags.some((f) => f.severity === 'block')) {
    const schedule: LeaseSchedule = {
      rent: rows.map((r) => ({ effective_start: r.start, effective_end: r.end, base_rent_monthly: r.base_rent_monthly })),
      recurring: a.recurring_charges.map((r, i) => ({
        id: `abstract-${i}`, type: r.type as RecurringChargeType, description: r.description,
        amount_monthly: r.amount_monthly, effective_start: r.effective_start, effective_end: r.effective_end,
      })),
      concessions: a.concessions.map((c): ConcessionRow => ({
        charge_type: c.charge_type, period_start: c.period_start, period_end: c.period_end, kind: c.kind, value: c.value, reason: c.reason,
      })),
    }
    const first = term.start.slice(0, 7) + '-01'
    for (let k = 0; k < 1200; k++) {
      const month = addMonthsIso(first, k)
      if (day(month) > day(term.end)) break
      const out = computeScheduledLines({
        schedule, leaseStartDate: term.start, leaseEndDate: term.end, legacyCamMonthly: 0,
        periodYear: Number(month.slice(0, 4)), periodMonth: Number(month.slice(5, 7)),
      })
      if ('exception' in out) {
        block('rent_schedule', `Billing would fail for ${month.slice(0, 7)}: ${out.exception.code} (${out.exception.detail}).`)
        break
      }
    }
  }
  return flags
}

// ── entry point ───────────────────────────────────────────────────────────────

/** Coerce + verify + cross-check a parsed model output against the pages it was extracted from. Pure. */
export function finalizeAbstract(raw: unknown, pages: readonly string[]): AbstractResult {
  const wireWarnings: string[] = []
  const shaped = wireToShape(raw, wireWarnings)
  const { abstract, warnings: coerceWarnings } = coerceAbstract(shaped)
  const warnings = [...wireWarnings, ...coerceWarnings]
  const flags: AbstractFlag[] = []
  verifyCitations(abstract, pages, flags)
  flags.push(...crossCheck(abstract))
  // Re-REFUTE 3: the lease states an escalation the model returned malformed. Treating it as "no rule"
  // would skip the schedule-vs-rule comparison, so it blocks until entered by hand.
  const sent = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).escalations : undefined
  if (Array.isArray(sent) && sent.length > 0 && abstract.escalation === null) {
    flags.push({ severity: 'block', path: 'escalation', message: 'The lease states an escalation that could not be read; enter it manually.' })
  }
  return { abstract, flags, warnings }
}

export async function extractAbstract(
  pages: readonly string[],
  opts: { apiKey: string; model: string },
): Promise<AbstractResult> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(buildAbstractRequest(pages, opts.model)),
  })
  if (!res.ok) {
    // Never surface the raw upstream body — it may echo document text.
    throw new Error(`Lease abstraction failed (status ${res.status})`)
  }
  return finalizeAbstract(parseAbstractResponse(await res.json()), pages)
}
