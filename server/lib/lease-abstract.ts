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

// MONEY REDESIGN (merge gate PR #69, user decision after round 2): the model never states a monthly
// figure or does arithmetic. Every money value arrives EXACTLY AS PRINTED ("$120,000.00", "3%") plus the
// period the lease attaches to that figure; resolveAmounts() parses it, checks it is written in its own
// quote, computes the monthly amount deterministically, and the human confirms each billing value in
// Phase 4 (AbstractResult.confirmations). Text-matching heuristics (keyword cues, "any number in the
// quote") leaked in rounds 1 and 2 and are gone.
export const AMOUNT_PERIODS = ['month', 'year', 'psf_year'] as const
export const ABSTRACT_SCHEMA: JsonSchema = obj({
  facts: list(obj({ field: enumOf(Object.keys(FACT_FIELDS)), value: STR, ...SOURCE })),
  rent_schedule: list(obj({ start: DATE, end: DATE, amount_as_written: STR, amount_period: enumOf(AMOUNT_PERIODS), ...SOURCE })),
  escalations: list(obj({
    kind: enumOf(['fixed_pct', 'fixed_amount', 'cpi']), value_as_written: STR, value_period: enumOf([...AMOUNT_PERIODS, 'none']),
    cadence_months: INT, first_adjustment_date: DATE, cpi_floor: NUM, cpi_cap: NUM, ...SOURCE,
  })),
  concessions: list(obj({
    charge_type: enumOf(['rent', 'cam_estimate', 'all']), period_start: DATE, period_end: DATE,
    kind: enumOf(['full_waiver', 'pct', 'fixed_amount']), value_as_written: STR, value_period: enumOf(['month', 'year', 'none']), reason: STR, ...SOURCE,
  })),
  recurring_charges: list(obj({
    type: enumOf(RECURRING_TYPES), description: STR, amount_as_written: STR, amount_period: enumOf(['month', 'year']),
    effective_start: DATE, effective_end: DATE, ...SOURCE,
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
  '- Use the lease text only. Never infer, convert or compute a value.',
  '- facts: one entry per field the lease states; leave a field out entirely if it is not stated. value is a string: dates as YYYY-MM-DD, numbers as plain decimals without $ or commas (10000, 0.03), tenant_entity_type one of llc/corporation/partnership/sole_proprietorship/individual/nonprofit/other, rent_type one of nnn/gross/modified_gross.',
  '- page: the "Page n" number the value appears on. quote: a verbatim excerpt of at least a few words (under 200 characters) copied exactly from that page that states the value. confidence: 0..1.',
  '- MONEY: never divide, multiply or convert. Copy every dollar amount into its *_as_written field EXACTLY as the lease prints it, including "$" and commas (e.g. "$120,000.00"), and copy percentages with their "%" (e.g. "3%"). The quote must contain that exact text. Then set the *_period field to the period the lease attaches to THAT printed figure: "month" (per month, monthly installment), "year" (per annum, per year, per lease year, annual), or "psf_year" (per rentable square foot per year). The server computes monthly amounts.',
  '- Percentages in facts (pro_rata_share, cam_cap_pct, admin_fee_pct) are FRACTIONS: 3% is 0.03; holdover is a multiplier, 150% is 1.5.',
  '- Dates are YYYY-MM-DD. Date ranges are inclusive (a year starting 2026-01-01 ends 2026-12-31).',
  '- rent_schedule: one row per rent period across the whole term, contiguous, no gaps or overlaps. If a period\'s rent is printed, give it as written. If it is NOT printed and follows only from a stated escalation, set amount_as_written to "" and amount_period to "month"; the server derives it from the escalation. The first period\'s rent must be printed.',
  '- escalations: at most one entry, only if the lease states a rule; first_adjustment_date is always a real date. fixed_pct: value_as_written is the printed percentage ("3%"), value_period "none". fixed_amount: value_as_written is the printed dollar increase, value_period its period. cpi: value_as_written "", value_period "none"; cpi_floor is -1 when not stated (0 means a stated 0% floor); cpi_cap is 0 when not stated. For fixed rules, cpi_floor is -1 and cpi_cap is 0.',
  '- concessions: free rent, abatements, waivers. full_waiver: value_as_written "" and value_period "none". pct: value_as_written is the printed percentage waived ("50%"), value_period "none". fixed_amount: value_as_written is the printed dollar amount waived, value_period its period. charge_type "all" only when the lease says the waiver covers rent AND CAM/operating expenses; a dollar waiver over both is two entries. Never "all" with fixed_amount.',
  '- recurring_charges: amounts other than base rent (CAM estimate, utilities, tax or insurance escrow as type "other"), each as written with its period.',
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
  // Money arrives as written; the computed numbers start null and are filled by resolveAmounts().
  out.rent_schedule = mapItems(r.rent_schedule, (o) => ({ ...o, base_rent_monthly: null, rent_psf_annual: null }))
  out.concessions = mapItems(r.concessions, (o) => ({ ...o, value: null }))
  out.recurring_charges = mapItems(r.recurring_charges, (o) => ({ ...o, amount_monthly: null }))
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
  if (e) out.escalation = { ...e, value: null, cpi_floor: minusOneToNull(e.cpi_floor), cpi_cap: zeroToNull(e.cpi_cap) }
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

// Computed money fields (base_rent_monthly, rent_psf_annual, value, amount_monthly) are null until
// resolveAmounts() fills them; a value that cannot be resolved stays null and carries a block flag.
const RentRowZ = z.object({
  start: isoDate, end: isoDate, amount_as_written: z.string(), amount_period: z.enum(AMOUNT_PERIODS),
  base_rent_monthly: z.number().nullable(), rent_psf_annual: z.number().nullable(), ...source,
})
const EscalationZ = z.object({
  kind: z.enum(['fixed_pct', 'fixed_amount', 'cpi']), value_as_written: z.string(), value_period: z.enum([...AMOUNT_PERIODS, 'none']),
  value: z.number().nullable(), cadence_months: z.number().int(),
  first_adjustment_date: isoDate, cpi_floor: z.number().nullable(), cpi_cap: z.number().nullable(), ...source,
})
const ConcessionZ = z.object({
  charge_type: z.enum(['rent', 'cam_estimate', 'all']), period_start: isoDate, period_end: isoDate,
  kind: z.enum(['full_waiver', 'pct', 'fixed_amount']), value_as_written: z.string(), value_period: z.enum(['month', 'year', 'none']),
  value: z.number().nullable(), reason: z.string(), ...source,
})
const RecurringZ = z.object({
  type: z.enum(RECURRING_TYPES), description: z.string(), amount_as_written: z.string(), amount_period: z.enum(['month', 'year']),
  amount_monthly: z.number().nullable(), effective_start: isoDate, effective_end: isoDate, ...source,
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

/**
 * One billing value a human must confirm in Phase 4 before approval: what the lease prints, the period,
 * the monthly amount the server computed from it, and where it is. Approval must require every entry to
 * be confirmed against its highlighted quote; flags are triage, not proof (merge gate redesign).
 */
export interface Confirmation {
  path: string
  as_written: string
  period: string
  monthly: number | null
  /** The billing window this value applies to (rent period, charge or concession dates); null if none. */
  start: string | null
  end: string | null
  /** Which charges it applies to: 'rent', a recurring type, or a concession class ('rent' / 'cam_estimate' / 'all'). */
  charge: string | null
  /** For per-square-foot amounts: the RSF the monthly figure was computed with (merge gate R3-01). */
  rsf: number | null
  /** For escalations: when adjustments start and how often (merge gate R3-03). */
  first_adjustment_date: string | null
  cadence_months: number | null
  page: number
  quote: string
}

export interface AbstractResult {
  abstract: LeaseAbstract
  flags: AbstractFlag[]
  warnings: string[]
  confirmations: Confirmation[]
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
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ExtractionStopped('no_output')
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

/**
 * Paths whose values feed billing: an unverifiable citation there BLOCKS approval (REFUTE C4). Exported
 * so the intake route's post-egress "withheld billing value" rule uses the same list (merge gate O-1).
 */
export const BILLING_PATH = /^(rent_schedule|escalation|concessions|recurring_charges|commencement_date|rent_commencement_date|expiration_date|premises_rsf)\b/

/** Every number written in a quote ("$1,250.00" → 1250; "10,000 RSF" → 10000). Commas stripped first. */
export function numbersInQuote(quote: string): number[] {
  return (quote.replace(/,/g, '').match(/\d+(?:\.\d+)?/g) ?? []).map(Number)
}

/** True when `amount` is written in the quote as a whole number (never as a substring of a larger one). */
export function amountInQuote(amount: number, quote: string): boolean {
  return Number.isFinite(amount) && numbersInQuote(quote).some((n) => Math.abs(n - amount) < 0.005)
}

const CURRENCY_RE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?![\d,.]*\d)/g

/** Every dollar figure in a quote ("$" + digits): the only numbers that can be money. */
export function currencyFiguresInQuote(quote: string): number[] {
  return [...quote.matchAll(CURRENCY_RE)].map((m) => Number(`${m[1].replace(/,/g, '')}.${m[2] ?? '0'}`))
}

/** "$120,000.00" → 120000. null unless the whole string is ONE dollar figure as a lease prints it. */
export function parseWrittenCurrency(written: string): number | null {
  const m = /^\s*\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*$/.exec(written)
  return m ? Number(`${m[1].replace(/,/g, '')}.${m[2] ?? '0'}`) : null
}

/** "3%", "three percent (3%)", "3.5 %" → 0.03 / 0.035. null unless it holds exactly one "%" figure. */
export function parseWrittenPercent(written: string): number | null {
  const all = [...written.matchAll(/(\d+(?:\.\d+)?)\s*%/g)]
  return all.length === 1 ? Number(all[0][1]) / 100 : null
}

/** True when `written` occurs in `quote` (case/space/typography-insensitive) and not inside a larger number. */
export function writtenInQuote(written: string, quote: string): boolean {
  const w = normalizeForMatch(written)
  const q = normalizeForMatch(quote)
  if (!w) return false
  for (let i = q.indexOf(w); i !== -1; i = q.indexOf(w, i + 1)) {
    const before = q[i - 1] ?? ''
    const after = q.slice(i + w.length)
    if (/[\d,.]/.test(before) && /\d/.test(w[0] ?? '')) continue // "1,000" inside "11,000"
    if (/^[,.]?\d/.test(after)) continue // "$1,000" inside "$1,000,000" or "$1,000.50"
    return true
  }
  return false
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const ORDINAL_WORDS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh',
  'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth',
  'twenty-first', 'twenty-second', 'twenty-third', 'twenty-fourth', 'twenty-fifth', 'twenty-sixth', 'twenty-seventh',
  'twenty-eighth', 'twenty-ninth', 'thirtieth', 'thirty-first']

/**
 * True when the ISO date is written in the quote. Forms: ISO; "January 1, 2026"; "Jan. 1, 2026";
 * "1 January 2026"; "1st day of January, 2026"; the legal form "the first (1st) day of January, 2026"
 * (word, digit or both); "1/1/2026", "1-1-2026", "01/01/26". A numeric date never matches inside a larger one.
 */
export function dateInQuote(iso: string, quote: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const q = quote.toLowerCase().replace(/\s+/g, ' ')
  if (new RegExp(`(?<![\\d-])${iso}(?![\\d])`).test(q)) return true
  const full = MONTH_NAMES[mo - 1]
  // Merge gate R4-05: "Sept. 1, 2027", "January 1,2027" (no space, common in extracted PDF text) and
  // "twenty first" (no hyphen) are ordinary forms.
  const month = `(?:${full}|${full.slice(0, 3)}${mo === 9 ? 't?' : ''}\\.?)`
  const ord = `0?${d}(?:st|nd|rd|th)?`
  const dayToken = `(?:${ord}|${ORDINAL_WORDS[d - 1].replace('-', '[- ]')})(?: ?\\( ?${ord} ?\\))?`
  const yr = `(?:, ?| )${y}\\b`
  const patterns = [
    `\\b${month} ${ord}${yr}`,
    `\\b${dayToken} (?:(?:day )?of )?${month}${yr}`,
    `(?<![\\d/-])0?${mo}[/-]0?${d}[/-](?:${y}|${String(y).slice(2)})(?![\\d/-])`,
  ]
  return patterns.some((p) => new RegExp(p).test(q))
}

/** Monthly amount for a figure printed per `period`. null when psf_year has no usable RSF. */
function toMonthly(n: number, period: string, rsf: number | null): number | null {
  if (period === 'month') return round2(n)
  if (period === 'year') return round2(n / 12)
  if (period === 'psf_year') return rsf && rsf > 0 ? round2((n * rsf) / 12) : null
  return null
}

/**
 * Arithmetic consistency (merge gate R2-01). If the quote ALSO prints the other side of the month/year
 * split for this figure, the chosen period must agree with it: "$120,000.00 ... monthly installments of
 * $10,000.00" with period "month" is caught because $10,000.00 × 12 = $120,000.00. Pure arithmetic over
 * the dollar figures in the quote; no wording heuristics.
 */
function periodContradiction(n: number, period: string, quote: string): string | null {
  for (const f of currencyFiguresInQuote(quote)) {
    if (Math.abs(f - n) < 0.005) continue
    if (period === 'month' && Math.abs(f * 12 - n) <= 1) return `the quote also prints $${f}, which is ${n} ÷ 12, so ${n} is an annual figure`
    if (period === 'year' && Math.abs(n * 12 - f) <= 1) return `the quote also prints $${f}, which is ${n} × 12, so ${n} is a monthly figure`
  }
  return null
}

/**
 * The period the lease attaches to this exact figure: a label in the same clause just before it
 * ("Monthly Base Rent: $6,000.00", "Annual Rent of $72,000.00") or the words right after it
 * ("$6,000.00 per month"). null when unlabelled or labelled both ways.
 */
export function labelledPeriod(written: string, quote: string): 'month' | 'year' | null {
  const q = normalizeForMatch(quote).toLowerCase()
  const w = normalizeForMatch(written).toLowerCase()
  const i = q.indexOf(w)
  if (i === -1) return null
  const before = (q.slice(0, i).split(/;|\.\s/).pop() ?? '').slice(-40)
  const after = q.slice(i + w.length).replace(/^[\s,]*(?:\([^)]*\)\s*)?/, '')
  const monthly = /\bmonthly\b|\bper month\b/.test(before) || /^(?:per\s+month|a\s+month|monthly|each\s+month)\b/.test(after)
  const annual = /\b(?:annual|annually|yearly)\b|\bper (?:annum|year)\b/.test(before) ||
    /^(?:per\s+(?:lease\s+|calendar\s+)?year|per\s+annum|annually|a\s+year|each\s+year|yearly)\b/.test(after)
  return monthly && !annual ? 'month' : annual && !monthly ? 'year' : null
}

/**
 * TRIAGE ONLY (a warning, never a block): the words directly after the printed figure name a period
 * different from the one chosen ("$2,400.00 per lease year" entered as "month"). Only the phrase that
 * immediately follows the figure counts, so "$1,000.00 per month, subject to annual reconciliation"
 * reads as monthly. The human confirms every billing value in Phase 4 regardless.
 */
export function periodWordingMismatch(written: string, period: string, quote: string): string | null {
  const q = normalizeForMatch(quote)
  const i = q.indexOf(normalizeForMatch(written))
  if (i === -1) return null
  const after = q.slice(i + normalizeForMatch(written).length).replace(/^[\s,]*(?:\([^)]*\)\s*)?/, '')
  const annual = /^(?:per\s+(?:lease\s+|calendar\s+)?year|per\s+annum|annually|a\s+year|each\s+year|yearly|per\s+rentable)/.test(after)
  const monthly = /^(?:per\s+month|a\s+month|monthly|each\s+month)/.test(after)
  if (period === 'month' && annual) return 'the lease prints this figure per year'
  if (period === 'year' && monthly) return 'the lease prints this figure per month'
  return null
}

/**
 * Parse every money value as written, check it is written in its own quote, and compute the monthly
 * figure. Anything that cannot be resolved stays null and blocks. Returns the confirmation list.
 */
function resolveAmounts(a: LeaseAbstract, flags: AbstractFlag[]): Confirmation[] {
  const block = (path: string, message: string) => flags.push({ severity: 'block', path, message })
  const warn = (path: string, message: string) => flags.push({ severity: 'warn', path, message })
  const confirmations: Confirmation[] = []
  type Ctx = Partial<Pick<Confirmation, 'start' | 'end' | 'charge' | 'rsf' | 'first_adjustment_date' | 'cadence_months'>>
  // Merge gate round 3: every confirmation carries the whole context a human needs to check it against its
  // quote: the billing window, which charges it covers, the RSF behind a per-square-foot figure, and the
  // escalation timing. A value whose inputs are hidden cannot be confirmed.
  const confirm = (path: string, as_written: string, period: string, monthly: number | null, s: Source, ctx: Ctx = {}) =>
    confirmations.push({
      path, as_written, period, monthly,
      start: ctx.start ?? null, end: ctx.end ?? null, charge: ctx.charge ?? null, rsf: ctx.rsf ?? null,
      first_adjustment_date: ctx.first_adjustment_date ?? null, cadence_months: ctx.cadence_months ?? null,
      page: s.page, quote: s.quote,
    })

  // The term dates bound everything billed: each is confirmed against its own quote.
  for (const k of ['commencement_date', 'rent_commencement_date', 'expiration_date'] as const) {
    const v = a[k]
    if (v) confirm(k, v.value, 'date', null, v)
  }

  // RSF is billing input once anything is quoted per square foot: it must be printed in its own quote.
  const rsfFact = a.premises_rsf
  const rsf = rsfFact && amountInQuote(rsfFact.value, rsfFact.quote) && rsfFact.confidence > 0 ? rsfFact.value : null
  let rsfUsed = false
  const needRsf = (path: string) => {
    rsfUsed = true
    if (!rsfFact) block(path, 'This amount is quoted per square foot, but the lease abstract has no rentable square footage.')
    else if (rsf === null) block(path, `The rentable square footage ${rsfFact.value} is not printed in its own quote; confirm it.`)
  }

  /** Parse a printed dollar figure + period into a monthly amount, with every check. */
  const money = (path: string, written: string, period: string, s: Source): number | null => {
    const n = parseWrittenCurrency(written)
    if (n === null) { block(path, `"${written}" is not a dollar amount as printed (e.g. "$1,250.00"); enter it exactly as the lease prints it.`); return null }
    if (!writtenInQuote(written, s.quote)) { block(path, `"${written}" is not written in its quote; confirm the amount against the lease.`); return null }
    const contradiction = periodContradiction(n, period, s.quote)
    // Merge gate R4-05: when the figure itself is labelled with the chosen period ("Monthly Base Rent:
    // $6,000.00; Monthly CAM: $500.00"), the other figure is a different charge, so this is triage only.
    if (contradiction && labelledPeriod(written, s.quote) === period) warn(path, `Confirm the period "${period}": ${contradiction}.`)
    else if (contradiction) { block(path, `The period "${period}" does not fit: ${contradiction}.`); return null }
    const wording = periodWordingMismatch(written, period, s.quote)
    if (wording) flags.push({ severity: 'warn', path, message: `Confirm the period "${period}": ${wording}.` })
    if (period === 'psf_year') needRsf(path)
    return toMonthly(n, period, rsf)
  }

  // Escalation first: derived rent periods depend on it.
  const e = a.escalation
  if (e) {
    const timing: Ctx = { charge: 'rent', first_adjustment_date: e.first_adjustment_date, cadence_months: e.cadence_months }
    if (e.kind === 'cpi') {
      e.value = null
      if (e.value_as_written.trim()) block('escalation', 'A CPI escalation has no fixed value.')
    } else if (e.kind === 'fixed_pct') {
      const v = parseWrittenPercent(e.value_as_written)
      if (v === null) block('escalation', `"${e.value_as_written}" is not a percentage as printed (e.g. "3%").`)
      else if (!writtenInQuote(e.value_as_written, e.quote)) block('escalation', `"${e.value_as_written}" is not written in its quote.`)
      e.value = v
      confirm('escalation', e.value_as_written, 'per adjustment', null, e, timing)
    } else {
      e.value = e.value_period === 'none' ? null : money('escalation', e.value_as_written, e.value_period, e)
      if (e.value_period === 'none') block('escalation', 'A fixed-dollar escalation needs the period its amount is quoted in.')
      confirm('escalation', e.value_as_written, e.value_period, e.value, e, { ...timing, rsf: e.value_period === 'psf_year' ? rsf : null })
    }
    // Merge gate R3-03 (triage): the first adjustment should be printed in the quote or fall on an
    // anniversary of the commencement / rent commencement date at the stated cadence.
    if (e.cadence_months > 0 && !dateInQuote(e.first_adjustment_date, e.quote)) {
      const starts = [a.commencement_date?.value, a.rent_commencement_date?.value].filter((x): x is string => !!x)
      const onAnniversary = starts.some((s) => {
        for (let k = 1; k <= 1200 / e.cadence_months; k++) {
          const d = addMonthsIso(s, k * e.cadence_months)
          if (d === e.first_adjustment_date) return true
          if (d > e.first_adjustment_date) return false
        }
        return false
      })
      if (!onAnniversary) warn('escalation', `The first adjustment ${e.first_adjustment_date} is neither printed in the quote nor an anniversary of the commencement date; confirm when rent first increases.`)
    }
  }

  // Rent periods printed in the lease.
  const rows = [...a.rent_schedule].sort((x, y) => x.start.localeCompare(y.start))
  for (const r of rows) {
    const path = `rent_schedule[${a.rent_schedule.indexOf(r)}]`
    if (!r.amount_as_written.trim()) continue
    r.base_rent_monthly = money(path, r.amount_as_written, r.amount_period, r)
    if (r.amount_period === 'psf_year') r.rent_psf_annual = parseWrittenCurrency(r.amount_as_written)
    confirm(path, r.amount_as_written, r.amount_period, r.base_rent_monthly, r,
      { start: r.start, end: r.end, charge: 'rent', rsf: r.amount_period === 'psf_year' ? rsf : null })
  }
  // Rent periods not printed: derived from the stated fixed escalation off the first printed period.
  const derived = rows.filter((r) => !r.amount_as_written.trim())
  if (derived.length > 0) {
    const first = rows[0]
    const term = billingTerm(a)
    const fixed = e && (e.kind === 'fixed_pct' || e.kind === 'fixed_amount') && e.value !== null && e.value > 0
    if (derived.includes(first)) {
      block(`rent_schedule[${a.rent_schedule.indexOf(first)}]`, 'The first rent period must be printed in the lease; it cannot be derived.')
    } else if (!fixed || !term || first.base_rent_monthly === null) {
      for (const r of derived) block(`rent_schedule[${a.rent_schedule.indexOf(r)}]`, 'This rent period is not printed and there is no stated fixed escalation to derive it from.')
    } else {
      const expected = expandFixedEscalation({
        termStart: term.start, termEnd: term.end, baseRentMonthly: first.base_rent_monthly,
        rule: { kind: e!.kind as 'fixed_pct' | 'fixed_amount', value: e!.value, cadence_months: e!.cadence_months, first_adjustment_date: e!.first_adjustment_date, applies_until: null },
      })
      for (const r of derived) {
        const path = `rent_schedule[${a.rent_schedule.indexOf(r)}]`
        const match = 'needsReview' in expected ? undefined : expected.find((x) => x.effective_start === r.start)
        if (!match) { block(path, `No escalation step starts on ${r.start}; this period cannot be derived.`); continue }
        r.base_rent_monthly = match.base_rent_monthly
        confirm(path, '(derived from the escalation)', 'month', r.base_rent_monthly, r, { start: r.start, end: r.end, charge: 'rent' })
      }
    }
  }

  a.recurring_charges.forEach((r, i) => {
    const path = `recurring_charges[${i}]`
    r.amount_monthly = money(path, r.amount_as_written, r.amount_period, r)
    confirm(path, r.amount_as_written, r.amount_period, r.amount_monthly, r,
      { start: r.effective_start, end: r.effective_end, charge: r.type })
  })

  a.concessions.forEach((c, i) => {
    const path = `concessions[${i}]`
    if (c.kind === 'full_waiver') {
      c.value = null
      if (c.value_as_written.trim()) block(path, 'A full waiver has no value.')
      // Merge gate R2-04: a quote that prints a percentage under 100% describes a PARTIAL waiver. (A dollar
      // figure alone does not: "Base Rent of $10,000.00 shall be fully abated" is a full waiver.)
      // Merge gate R4-05: a percentage that labels a share ("Tenant's Share (8.5%) of Operating Expenses")
      // is not the waiver's extent.
      const pcts = [...c.quote.matchAll(/(\d+(?:\.\d+)?)\s*%/g)]
        .filter((m) => !/\b(?:share|pro[- ]?rata|proportionate)\b[^.;%]{0,12}$/i.test(c.quote.slice(Math.max(0, (m.index ?? 0) - 30), m.index)))
        .map((m) => Number(m[1]))
      if (pcts.some((p) => p < 100)) block(path, 'The quote prints a percentage under 100%, so this is a partial waiver, not a full one.')
    } else if (c.kind === 'pct') {
      const v = parseWrittenPercent(c.value_as_written)
      if (v === null) block(path, `"${c.value_as_written}" is not a percentage as printed (e.g. "50%").`)
      else if (!writtenInQuote(c.value_as_written, c.quote)) block(path, `"${c.value_as_written}" is not written in its quote.`)
      c.value = v
    } else {
      c.value = c.value_period === 'none' ? null : money(path, c.value_as_written, c.value_period, c)
      if (c.value_period === 'none') block(path, 'A fixed-dollar waiver needs the period its amount is quoted in.')
    }
    // Triage (merge gate R3-02: wording cannot prove coverage; "continue to pay all Additional Rent" names
    // CAM too). "all" waives CAM as well, so any 'all' waiver is flagged for the human, who sees the
    // charge class on its confirmation entry.
    if (c.charge_type === 'all') {
      warn(path, 'This waiver is marked as covering rent AND CAM; confirm the lease waives CAM / operating expenses for this period.')
    }
    confirm(path, c.value_as_written || '(full waiver)', c.kind, c.value, c, { start: c.period_start, end: c.period_end, charge: c.charge_type })
  })

  // The RSF behind any per-square-foot figure is itself a billing value to confirm (merge gate R3-01).
  if (rsfUsed && rsfFact) {
    confirm('premises_rsf', String(rsfFact.value), 'rentable square feet', null, rsfFact)
    const others = numbersInQuote(rsfFact.quote).filter((n) => n >= 100 && Math.abs(n - rsfFact.value) >= 0.005)
    if (others.length > 0) warn('premises_rsf', `The square-footage quote also prints ${others.join(', ')}; confirm ${rsfFact.value} is the Premises, not the building or another area.`)
  }

  return confirmations
}

/**
 * Month numbers (1-12) a quote names. A range — two months joined by "through", "thru", "to", "until" or a
 * dash, each optionally followed by a day and year ("January 1, 2027 through March 31, 2027") — names every
 * month it spans, wrapping at December (merge gate R3-04).
 */
export function namedMonths(quote: string): Set<number> {
  const alt = MONTH_NAMES.map((n) => `${n}|${n.slice(0, 3)}\\.?`).join('|')
  const monthOf = (word: string) => MONTH_NAMES.findIndex((n) => word.toLowerCase().replace('.', '').startsWith(n.slice(0, 3))) + 1
  const named = new Set<number>()
  for (const m of quote.matchAll(new RegExp(`\\b(${alt})\\b`, 'gi'))) named.add(monthOf(m[1]))
  const range = new RegExp(`\\b(${alt})\\b(?:\\s+\\d{1,2}(?:st|nd|rd|th)?)?,?(?:\\s+\\d{4})?\\s*(?:through|thru|to|until|-|–|—)\\s*(?:the\\s+month\\s+of\\s+)?\\b(${alt})\\b`, 'gi')
  for (const m of quote.matchAll(range)) {
    const from = monthOf(m[1])
    const to = monthOf(m[2])
    for (let k = from, n = 0; n < 12; k = (k % 12) + 1, n++) {
      named.add(k)
      if (k === to) break
    }
  }
  return named
}

function verifyCitations(a: LeaseAbstract, pages: readonly string[], flags: AbstractFlag[]): void {
  const push = (severity: 'block' | 'warn', path: string, message: string) => flags.push({ severity, path, message })
  const check = (path: string, s: Source) => {
    if (!quoteOnPage(pages, s.page, s.quote)) {
      s.confidence = 0
      push(BILLING_PATH.test(path) ? 'block' : 'warn', path, `Quote not found on cited page ${s.page}; verify this value against the lease.`)
      return false
    }
    return true
  }
  for (const k of Object.keys(SCALARS) as (keyof typeof SCALARS)[]) {
    const v = a[k]
    if (v) check(k, v)
  }
  // A citation must also SUPPORT its value. The term dates bound everything billed.
  for (const k of ['commencement_date', 'rent_commencement_date', 'expiration_date'] as const) {
    const v = a[k]
    if (v && v.confidence > 0 && !dateInQuote(v.value, v.quote)) {
      push('block', k, `The quote does not state ${v.value}; confirm the date against the lease.`)
    }
  }
  a.rent_schedule.forEach((r, i) => check(`rent_schedule[${i}]`, r))
  if (a.escalation) check('escalation', a.escalation)

  a.concessions.forEach((c, i) => {
    const path = `concessions[${i}]`
    if (!check(path, c)) return
    // Triage only (merge gate R3-04: wording heuristics must never block a correct lease; the human sees
    // the concession's start/end on its confirmation entry).
    // Years: when the quote names any year, the concession's start year should be one of them.
    const years = new Set((c.quote.match(/\b(?:19|20)\d{2}\b/g) ?? []).map(Number))
    if (years.size > 0 && !years.has(Number(c.period_start.slice(0, 4)))) {
      push('warn', path, `The concession starts in ${c.period_start.slice(0, 4)}, but its quote names ${[...years].join(', ')}; confirm the period.`)
    }
    // Months: the months a concession covers should match the months its quote names (when it names any).
    // A range ("January through March", "January 1, 2027 to March 31, 2027") names every month it spans.
    const named = namedMonths(c.quote)
    if (named.size === 0) {
      push('warn', path, `Confirm the concession period ${c.period_start} to ${c.period_end} against the lease.`)
      return
    }
    const covered = new Set<number>()
    for (let k = 0; k < 13; k++) {
      const first = addMonthsIso(`${c.period_start.slice(0, 7)}-01`, k)
      if (first > c.period_end) break
      covered.add(Number(first.slice(5, 7)))
    }
    const missing = [...named].filter((mo) => !covered.has(mo))
    const extra = [...covered].filter((mo) => !named.has(mo))
    if (covered.size <= 12 && (missing.length > 0 || extra.length > 0)) {
      push('warn', path, `The concession covers ${c.period_start} to ${c.period_end}, but its quote names other months; confirm the period.`)
    }
  })

  // Merge gate R2-05: a recurring charge that does not run the whole rent term must say where it stops.
  const term = billingTerm(a)
  a.recurring_charges.forEach((r, i) => {
    const path = `recurring_charges[${i}]`
    if (!check(path, r) || !term) return
    if (r.effective_start > term.start && !dateInQuote(r.effective_start, r.quote)) push('warn', path, `Starts ${r.effective_start}, after the rent term starts; confirm against the lease.`)
    if (r.effective_end < term.end && !dateInQuote(r.effective_end, r.quote)) push('warn', path, `Ends ${r.effective_end}, before the lease expires; confirm against the lease.`)
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
    if (i > 0 && day(r.start) !== day(rows[i - 1].end) + 1) {
      block(p, day(r.start) <= day(rows[i - 1].end) ? 'Overlaps the previous rent period.' : 'Gap before this rent period.')
    }
    const m = r.base_rent_monthly
    if (m === null) return // unresolved: resolveAmounts already blocked it
    if (!(m >= 0)) block(p, 'Monthly rent must be zero or more.')
    else if (!isCents(m)) block(p, `Monthly rent ${m} has fractions of a cent; enter it to the cent.`)
    const rsf = a.premises_rsf?.value
    if (rsf && rsf > 0 && r.rent_psf_annual !== null && Math.abs((m * 12) / rsf - r.rent_psf_annual) > 0.05) {
      block(p, `Monthly rent × 12 / ${rsf} RSF = $${round2((m * 12) / rsf)}/SF, but the lease states $${r.rent_psf_annual}/SF.`)
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
    const base0 = rows[0]?.base_rent_monthly ?? null
    if (term && rows.length > 0 && base0 !== null && (e.kind === 'fixed_pct' || e.kind === 'fixed_amount') && e.value !== null && e.value > 0
      && (e.kind !== 'fixed_pct' || e.value < 1) && e.cadence_months > 0) {
      const expected = expandFixedEscalation({
        termStart: term.start, termEnd: term.end, baseRentMonthly: base0,
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
            const got = rows[i].base_rent_monthly
            if (got !== null && Math.abs(got - x.base_rent_monthly) > 1) {
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
    // Merge gate R4-01: billing runs from rent commencement, so months of a charge that starts earlier
    // (CAM payable from commencement during free base rent) would silently never bill.
    if (term && day(r.effective_start) < day(term.start)) {
      block(p, `Starts ${r.effective_start}, before billing starts on ${term.start}; the months before ${term.start} would not be billed. Bill them by hand or correct the start.`)
    }
    const amt = r.amount_monthly
    if (amt !== null && !(amt > 0)) block(p, 'Monthly amount must be positive.')
    else if (amt !== null && !isCents(amt)) block(p, `Amount ${amt} has fractions of a cent.`)
    if (!r.description.trim()) block(p, 'A recurring charge needs a description.')
  })
  a.provisions.forEach((pv, i) => {
    if ((pv.exercise_window_start === null) !== (pv.exercise_window_end === null)) block(`provisions[${i}]`, 'An exercise window needs both a start and an end date.')
  })

  // Final gate: the billing engine must bill every month of the term from this abstract without an
  // exception. Only run once the structural checks above pass (otherwise it just restates them).
  // Every amount is resolved here: an unresolved (null) one always carries a block flag.
  const allResolved = rows.every((r) => r.base_rent_monthly !== null) && a.recurring_charges.every((r) => r.amount_monthly !== null)
  if (term && allResolved && !flags.some((f) => f.severity === 'block')) {
    const schedule: LeaseSchedule = {
      rent: rows.map((r) => ({ effective_start: r.start, effective_end: r.end, base_rent_monthly: r.base_rent_monthly as number })),
      recurring: a.recurring_charges.map((r, i) => ({
        id: `abstract-${i}`, type: r.type as RecurringChargeType, description: r.description,
        amount_monthly: r.amount_monthly as number, effective_start: r.effective_start, effective_end: r.effective_end,
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
  const confirmations = resolveAmounts(abstract, flags)
  // crossCheck skips value checks on unresolved (null) amounts (resolveAmounts already blocked them), and
  // its billing-engine dry run runs only when every amount is resolved and it raised no block itself.
  flags.push(...crossCheck(abstract))
  // Re-REFUTE 3: the lease states an escalation the model returned malformed. Treating it as "no rule"
  // would skip the schedule-vs-rule comparison, so it blocks until entered by hand.
  const sent = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).escalations : undefined
  if (Array.isArray(sent) && sent.length > 0 && abstract.escalation === null) {
    flags.push({ severity: 'block', path: 'escalation', message: 'The lease states an escalation that could not be read; enter it manually.' })
  }
  // Merge gate R4-02: only one escalation rule can be applied. A second rule (3% to 2028, then 5%) would be
  // dropped and every later step derived at the first rule's rate, so more than one rule blocks.
  if (Array.isArray(sent) && sent.length > 1) {
    flags.push({ severity: 'block', path: 'escalation', message: `The lease states ${sent.length} escalation rules; only one can be applied automatically. Enter the rent schedule by hand.` })
  }
  return { abstract, flags, warnings, confirmations }
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
