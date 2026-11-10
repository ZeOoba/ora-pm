import { describe, it, expect } from 'vitest'
import {
  ABSTRACT_SCHEMA,
  ExtractionStopped,
  MAX_INPUT_CHARS,
  MIN_QUOTE_CHARS,
  buildAbstractRequest,
  coerceAbstract,
  currencyFiguresInQuote,
  dateInQuote,
  finalizeAbstract,
  namedMonths,
  normalizeForMatch,
  parseAbstractResponse,
  parseWrittenCurrency,
  parseWrittenPercent,
  periodWordingMismatch,
  quoteOnPage,
  wireToShape,
  writtenInQuote,
} from '../../server/lib/lease-abstract'

// A synthetic 4-page industrial lease. Every quote in good() comes verbatim from these pages.
const PAGES = [
  'INDUSTRIAL LEASE AGREEMENT\nThis Lease is made between Landlord and Acme Fabrication LLC, an Ohio limited liability company ("Tenant").\nPremises: Suite 100, containing 10,000 rentable square feet.\nCommencement Date: January 1, 2026. Expiration Date: December 31, 2028.',
  'ARTICLE 4 – RENT\nYear 1: $8,333.33 per month ($10.00 per RSF per year).\nYear 2: $8,583.33 per month. Year 3: $8,840.83 per month.\nBase Rent shall increase three percent (3%) annually on each anniversary.\nTenant shall receive fifty percent (50%) abatement of Base Rent for January 2026.\nTenant shall pay estimated CAM of $1,250.00 per month.',
  'ARTICLE 30 – RENEWAL\nTenant shall have one option to renew for five (5) years upon written notice no later than June 30, 2028.\nHoldover rent shall be 150% of the Base Rent then in effect.',
  'ARTICLE 6 – TAXES AND UTILITIES\nTenant shall pay a real estate tax escrow of $12,000.00 per annum, payable in equal monthly installments.\nTenant shall pay a water charge of $2,400.00 per lease year.\nRent Commencement Date: March 1, 2026.',
]

type Obj = Record<string, unknown>
type Wire = Obj & { facts: Obj[]; rent_schedule: Obj[]; escalations: Obj[]; concessions: Obj[]; recurring_charges: Obj[] }
const src = (page: number, quote: string) => ({ page, quote, confidence: 0.95 })
const fact = (field: string, value: string, page: number, quote: string) => ({ field, value, ...src(page, quote) })
const row = (start: string, end: string, written: string, quote: string, period = 'month') =>
  ({ start, end, amount_as_written: written, amount_period: period, ...src(2, quote) })

/** The model's WIRE output for a consistent lease: money as written + period; sentinels -1 / 0 / "". */
function good(): Wire {
  return {
    facts: [
      fact('tenant_legal_name', 'Acme Fabrication LLC', 1, 'Acme Fabrication LLC, an Ohio limited liability company'),
      fact('tenant_entity_type', 'llc', 1, 'an Ohio limited liability company'),
      fact('tenant_state_of_formation', 'OH', 1, 'an Ohio limited liability company'),
      fact('premises_suite', '100', 1, 'Premises: Suite 100'),
      fact('premises_rsf', '10000', 1, 'containing 10,000 rentable square feet'),
      fact('commencement_date', '2026-01-01', 1, 'Commencement Date: January 1, 2026'),
      fact('expiration_date', '2028-12-31', 1, 'Expiration Date: December 31, 2028'),
      fact('holdover_rent_multiplier', '1.5', 3, 'Holdover rent shall be 150% of the Base Rent'),
    ],
    rent_schedule: [
      row('2026-01-01', '2026-12-31', '$8,333.33', 'Year 1: $8,333.33 per month'),
      row('2027-01-01', '2027-12-31', '$8,583.33', 'Year 2: $8,583.33 per month'),
      row('2028-01-01', '2028-12-31', '$8,840.83', 'Year 3: $8,840.83 per month'),
    ],
    escalations: [{ kind: 'fixed_pct', value_as_written: '3%', value_period: 'none', cadence_months: 12, first_adjustment_date: '2027-01-01', cpi_floor: -1, cpi_cap: 0, ...src(2, 'increase three percent (3%) annually') }],
    concessions: [{ charge_type: 'rent', period_start: '2026-01-01', period_end: '2026-01-31', kind: 'pct', value_as_written: '50%', value_period: 'none', reason: 'Abatement', ...src(2, 'fifty percent (50%) abatement of Base Rent for January 2026') }],
    recurring_charges: [{ type: 'cam_estimate', description: 'CAM estimate', amount_as_written: '$1,250.00', amount_period: 'month', effective_start: '2026-01-01', effective_end: '2028-12-31', ...src(2, 'estimated CAM of $1,250.00 per month') }],
    late_fees: [],
    provisions: [{ category: 'renewal_option', summary: 'One 5-year renewal option.', notice_deadline: '2028-06-30', exercise_window_start: '', exercise_window_end: '', ...src(3, 'one option to renew for five (5) years') }],
  }
}

const run = (raw: Wire, pages = PAGES) => finalizeAbstract(raw, pages)
const blocks = (r: ReturnType<typeof finalizeAbstract>) => r.flags.filter((f) => f.severity === 'block')
const blockText = (r: ReturnType<typeof finalizeAbstract>) => blocks(r).map((b) => b.message).join(' | ')
const factOf = (w: Wire, field: string) => w.facts.find((f) => f.field === field) as Obj
const esc = (r: Wire) => r.escalations[0]
const con = (r: Wire) => r.concessions[0]
const rec = (r: Wire) => r.recurring_charges[0]
const mutate = (f: (raw: Wire) => void, pages = PAGES) => { const raw = good(); f(raw); return run(raw, pages) }
const withPage = (i: number, from: string, to: string) => PAGES.map((p, k) => (k === i ? p.replace(from, to) : p))

describe('buildAbstractRequest', () => {
  it('sends scanned page text only, with structured outputs and no forced tool_choice', () => {
    const req = buildAbstractRequest(PAGES, 'claude-opus-5') as Obj
    expect(req).not.toHaveProperty('tool_choice')
    expect(req).not.toHaveProperty('tools')
    expect(req.output_config).toEqual({ effort: 'high', format: { type: 'json_schema', schema: ABSTRACT_SCHEMA } })
    const text = JSON.stringify(req.messages)
    expect(text).toContain('--- Page 2 of 4 ---')
    expect(text).not.toMatch(/"type":"document"|base64/)
  })
  it('refuses a non-array (a raw base64 PDF can never reach the request)', () => {
    expect(() => buildAbstractRequest('JVBERi0xLjQK' as unknown as string[], 'm')).toThrow(TypeError)
  })
  it('refuses text over the size limit instead of truncating it', () => {
    expect(() => buildAbstractRequest(['x'.repeat(MAX_INPUT_CHARS + 1)], 'm')).toThrow(RangeError)
  })
  // Structured outputs: ≤16 union-typed and ≤24 optional parameters per request (docs, "Explicit limits").
  it('stays inside the structured-outputs limits: zero unions, zero optional parameters, every object closed', () => {
    let unions = 0
    let optional = 0
    const walk = (s: unknown): void => {
      if (!s || typeof s !== 'object') return
      const o = s as Obj
      if ('anyOf' in o || 'oneOf' in o || Array.isArray(o.type)) unions++
      if (o.type === 'object') {
        expect(o.additionalProperties).toBe(false)
        optional += Object.keys(o.properties as object).filter((k) => !(o.required as string[]).includes(k)).length
      }
      for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'multipleOf']) expect(o).not.toHaveProperty(k)
      Object.values(o).forEach((v) => (Array.isArray(v) ? v.forEach(walk) : walk(v)))
    }
    walk(ABSTRACT_SCHEMA)
    expect(unions).toBe(0)
    expect(optional).toBe(0)
  })
  it('asks for money as written plus its period, never a computed monthly figure', () => {
    const s = JSON.stringify(ABSTRACT_SCHEMA)
    expect(s).toContain('amount_as_written')
    expect(s).not.toContain('base_rent_monthly')
    expect(s).not.toContain('amount_monthly')
  })
})

describe('parseAbstractResponse', () => {
  it('parses the JSON text block', () => {
    expect(parseAbstractResponse({ stop_reason: 'end_turn', content: [{ type: 'thinking' }, { type: 'text', text: '{"a":1}' }] })).toEqual({ a: 1 })
  })
  it.each([
    [{ stop_reason: 'refusal', content: [] }, 'refusal'],
    [{ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"a":' }] }, 'max_tokens'],
    [{ stop_reason: 'end_turn', content: [] }, 'no_output'],
    [{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }, 'bad_json'],
    [null, 'no_output'], [undefined, 'no_output'], [5, 'no_output'], ['x', 'no_output'], [[], 'no_output'],
  ])('stops on %j with %s', (res, reason) => {
    let caught: unknown
    try { parseAbstractResponse(res) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(ExtractionStopped)
    expect((caught as ExtractionStopped).reason).toBe(reason)
  })
})

describe('money as written', () => {
  it('parses only a whole dollar figure as printed', () => {
    expect(parseWrittenCurrency('$120,000.00')).toBe(120000)
    expect(parseWrittenCurrency('$8,333.33')).toBe(8333.33)
    expect(parseWrittenCurrency('$1250')).toBe(1250)
    expect(parseWrittenCurrency(' $ 1,250.5 ')).toBe(1250.5)
    for (const bad of ['12', '120000', '$8,333.333', '$-100', '$1,25,000', 'USD 100', '$100 per month', '']) expect(parseWrittenCurrency(bad)).toBeNull()
  })
  it('parses exactly one printed percentage', () => {
    expect(parseWrittenPercent('3%')).toBe(0.03)
    expect(parseWrittenPercent('three percent (3%)')).toBe(0.03)
    expect(parseWrittenPercent('3.5 %')).toBe(0.035)
    for (const bad of ['3', 'three percent', '3% or 4%', '']) expect(parseWrittenPercent(bad)).toBeNull()
  })
  it('finds a written figure in its quote, never inside a larger number', () => {
    expect(writtenInQuote('$1,000.00', 'CAM of $1,000.00 per month')).toBe(true)
    expect(writtenInQuote('$1,000.00', 'CAM of $11,000.00 per month')).toBe(false)
    expect(writtenInQuote('$1,000', 'a deposit of $1,000,000')).toBe(false)
    expect(writtenInQuote('$1,000', 'rent of $1,000.50')).toBe(false)
    expect(writtenInQuote('$12', 'Months 1-12: $10,000.00 per month')).toBe(false)
    expect(writtenInQuote('3%', 'increase three percent (3%) annually')).toBe(true)
    expect(writtenInQuote('', 'anything')).toBe(false)
  })
  it('lists only dollar figures in a quote', () => {
    expect(currencyFiguresInQuote('Months 1-12: $10,000.00 per month, 10,000 RSF; $120,000 per year')).toEqual([10000, 120000])
  })
})

describe('period wording (triage warning only)', () => {
  it('reads the phrase directly after the figure', () => {
    expect(periodWordingMismatch('$2,400.00', 'month', 'a water charge of $2,400.00 per lease year')).toMatch(/per year/)
    expect(periodWordingMismatch('$1,000.00', 'year', 'CAM of $1,000.00 per month')).toMatch(/per month/)
    expect(periodWordingMismatch('$1,000.00', 'month', 'CAM of $1,000.00 per month, subject to annual reconciliation')).toBeNull()
    expect(periodWordingMismatch('$10,000.00', 'month', 'Base Rent shall be $10,000.00 per month, increasing by three percent (3%) annually')).toBeNull()
  })
})

describe('dateInQuote', () => {
  it.each([
    ['2026-01-01', 'Commencement Date: 2026-01-01'],
    ['2026-01-01', 'Commencement Date: January 1, 2026'],
    ['2026-01-01', 'effective Jan. 1, 2026'],
    ['2026-01-01', 'effective 1 January 2026'],
    ['2026-01-01', 'commencing on the 1st day of January, 2026'],
    ['2027-01-01', 'the first (1st) day of January, 2027'],
    ['2027-12-31', 'the thirty-first (31st) day of December, 2027'],
    ['2027-12-31', 'the thirty-first day of December, 2027'],
    ['2026-01-01', 'effective 01/01/2026'],
    ['2026-01-01', 'effective 1/1/26'],
    ['2026-01-01', 'effective 1-1-2026'],
  ])('%s is stated by "%s"', (iso, q) => {
    expect(dateInQuote(iso, q)).toBe(true)
  })
  it.each([
    ['2026-01-01', 'January 10, 2026'],
    ['2026-01-01', 'effective 11/1/2026'],
    ['2028-12-31', 'Expiration Date: December 31, 2027'],
    ['2027-01-01', 'the second (2nd) day of January, 2027'],
  ])('%s is NOT stated by "%s"', (iso, q) => {
    expect(dateInQuote(iso, q)).toBe(false)
  })
})

describe('quote verification', () => {
  it('normalizes case, whitespace and typographic quotes/dashes', () => {
    expect(normalizeForMatch('  “Base”\n RENT – x ')).toBe('"base" rent - x')
  })
  it('finds a quote on its page, across a page break, and nowhere else', () => {
    expect(quoteOnPage(PAGES, 2, 'YEAR 2:   $8,583.33 per month')).toBe(true)
    expect(quoteOnPage(PAGES, 1, 'December 31, 2028. ARTICLE 4')).toBe(true) // straddles pages 1-2
    expect(quoteOnPage(PAGES, 1, 'Year 2: $8,583.33 per month')).toBe(false) // wholly on the next page
    expect(quoteOnPage(PAGES, 9, 'Year 2: $8,583.33')).toBe(false)
  })
  it('quotes of MIN_QUOTE_CHARS - 1 are rejected and of MIN_QUOTE_CHARS accepted', () => {
    expect(MIN_QUOTE_CHARS).toBe(12)
    expect(quoteOnPage(PAGES, 1, 'Premises: S')).toBe(false) // 11
    expect(quoteOnPage(PAGES, 1, 'Premises: Su')).toBe(true) // 12
  })
  const bad = 'this text is nowhere in the lease'
  it.each<[string, (r: Wire) => void]>([
    ['rent_schedule[1]', (r) => { r.rent_schedule[1].quote = bad }],
    ['concessions[0]', (r) => { con(r).quote = bad }],
    ['recurring_charges[0]', (r) => { rec(r).quote = bad }],
    ['escalation', (r) => { esc(r).quote = bad }],
    ['expiration_date', (r) => { factOf(r, 'expiration_date').quote = bad }],
    ['commencement_date', (r) => { factOf(r, 'commencement_date').quote = bad }],
    ['rent_commencement_date', (r) => { r.facts.push(fact('rent_commencement_date', '2026-01-01', 1, bad)) }],
    ['premises_rsf', (r) => { factOf(r, 'premises_rsf').quote = bad }],
  ])('an unverifiable citation on billing value %s BLOCKS', (path, f) => {
    expect(mutate(f).flags).toContainEqual(expect.objectContaining({ severity: 'block', path, message: expect.stringMatching(/Quote not found/) }))
  })
  it('an unverifiable citation on a non-billing value only warns', () => {
    const r = mutate((raw) => { factOf(raw, 'premises_suite').quote = 'Premises: Suite 900 north' })
    expect(r.flags).toContainEqual(expect.objectContaining({ severity: 'warn', path: 'premises_suite' }))
    expect(blocks(r)).toEqual([])
  })
  it.each(['commencement_date', 'expiration_date'])('a %s its quote does not state blocks', (k) => {
    const r = mutate((raw) => { factOf(raw, k).quote = k === 'expiration_date' ? 'Commencement Date: January 1, 2026' : 'Expiration Date: December 31, 2028' })
    expect(r.flags).toContainEqual(expect.objectContaining({ severity: 'block', path: k, message: expect.stringMatching(/does not state/) }))
  })
  it('a rent commencement date its quote does not state blocks', () => {
    const r = mutate((raw) => { raw.facts.push(fact('rent_commencement_date', '2026-01-01', 4, 'Rent Commencement Date: March 1, 2026')) })
    expect(r.flags).toContainEqual(expect.objectContaining({ severity: 'block', path: 'rent_commencement_date', message: expect.stringMatching(/does not state 2026-01-01/) }))
  })
})

describe('finalizeAbstract on a consistent lease', () => {
  it('returns no flags, computes every monthly amount, and lists every billing value for confirmation', () => {
    const r = run(good())
    expect(r.flags).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.abstract.rent_schedule.map((x) => x.base_rent_monthly)).toEqual([8333.33, 8583.33, 8840.83])
    expect(r.abstract.escalation?.value).toBe(0.03)
    expect(r.abstract.concessions[0].value).toBe(0.5)
    expect(r.abstract.recurring_charges[0].amount_monthly).toBe(1250)
    expect(r.confirmations.map((c) => c.path).sort()).toEqual([
      'commencement_date', 'concessions[0]', 'escalation', 'expiration_date', 'recurring_charges[0]', 'rent_schedule[0]', 'rent_schedule[1]', 'rent_schedule[2]',
    ])
    // Full content, quote included (merge gate R3-07 CN1): every field a human confirms against.
    const blank = { start: null, end: null, charge: null, rsf: null, first_adjustment_date: null, cadence_months: null }
    const byPath = (p: string) => r.confirmations.find((c) => c.path === p)
    expect(byPath('rent_schedule[0]')).toEqual({ ...blank, path: 'rent_schedule[0]', as_written: '$8,333.33', period: 'month', monthly: 8333.33,
      start: '2026-01-01', end: '2026-12-31', charge: 'rent', page: 2, quote: 'Year 1: $8,333.33 per month' })
    expect(byPath('escalation')).toEqual({ ...blank, path: 'escalation', as_written: '3%', period: 'per adjustment', monthly: null,
      charge: 'rent', first_adjustment_date: '2027-01-01', cadence_months: 12, page: 2, quote: 'increase three percent (3%) annually' })
    expect(byPath('concessions[0]')).toEqual({ ...blank, path: 'concessions[0]', as_written: '50%', period: 'pct', monthly: 0.5,
      start: '2026-01-01', end: '2026-01-31', charge: 'rent', page: 2, quote: 'fifty percent (50%) abatement of Base Rent for January 2026' })
    expect(byPath('recurring_charges[0]')).toEqual({ ...blank, path: 'recurring_charges[0]', as_written: '$1,250.00', period: 'month', monthly: 1250,
      start: '2026-01-01', end: '2028-12-31', charge: 'cam_estimate', page: 2, quote: 'estimated CAM of $1,250.00 per month' })
    expect(byPath('expiration_date')).toEqual({ ...blank, path: 'expiration_date', as_written: '2028-12-31', period: 'date', monthly: null,
      page: 1, quote: 'Expiration Date: December 31, 2028' })
  })
})

describe('resolution: periods and arithmetic (merge gate R2-01..R2-03)', () => {
  it('a figure printed per year is divided by 12; per $/SF per year is × RSF ÷ 12', () => {
    const r = mutate((raw) => {
      raw.rent_schedule[0] = row('2026-01-01', '2026-12-31', '$10.00', 'Year 1: $8,333.33 per month ($10.00 per RSF per year)', 'psf_year')
      ;(raw.recurring_charges as Obj[]).push({ type: 'other', description: 'Tax', amount_as_written: '$12,000.00', amount_period: 'year', effective_start: '2026-01-01', effective_end: '2028-12-31', ...src(4, 'real estate tax escrow of $12,000.00 per annum, payable in equal monthly installments') })
    })
    expect(blocks(r)).toEqual([])
    expect(r.abstract.rent_schedule[0].base_rent_monthly).toBe(8333.33)
    expect(r.abstract.rent_schedule[0].rent_psf_annual).toBe(10)
    expect(r.abstract.recurring_charges[1].amount_monthly).toBe(1000)
  })
  it('R2-01: "$120,000.00 ... monthly installments of $10,000.00" entered with period month blocks', () => {
    const q = 'Base Rent of $120,000.00, payable in twelve equal monthly installments of $10,000.00'
    const pages = withPage(1, 'Year 1: $8,333.33 per month ($10.00 per RSF per year).', `${q}.`)
    const r = mutate((raw) => { raw.rent_schedule[0] = row('2026-01-01', '2026-12-31', '$120,000.00', q); raw.escalations = []; raw.rent_schedule.splice(1, 2); factOf(raw, 'expiration_date').value = '2026-12-31'; factOf(raw, 'expiration_date').quote = q }, pages)
    expect(blockText(r)).toMatch(/period "month" does not fit: the quote also prints \$10000, which is 120000 ÷ 12/)
    expect(r.abstract.rent_schedule[0].base_rent_monthly).toBeNull()
  })
  it('the same figure entered with period year resolves to $10,000/month', () => {
    const q = 'Base Rent of $120,000.00, payable in twelve equal monthly installments of $10,000.00'
    const pages = withPage(1, 'Year 1: $8,333.33 per month ($10.00 per RSF per year).', `${q}.`)
    const r = mutate((raw) => { raw.rent_schedule[0] = row('2026-01-01', '2026-12-31', '$120,000.00', q, 'year') }, pages)
    expect(r.abstract.rent_schedule[0].base_rent_monthly).toBe(10000)
  })
  it('a monthly figure entered with period year blocks when the quote also prints its × 12', () => {
    const q = 'Base Rent of $10,000.00 per month ($120,000.00 per year)'
    const pages = withPage(1, 'Year 1: $8,333.33 per month ($10.00 per RSF per year).', `${q}.`)
    const r = mutate((raw) => { raw.rent_schedule[0] = row('2026-01-01', '2026-12-31', '$10,000.00', q, 'year') }, pages)
    expect(blockText(r)).toMatch(/period "year" does not fit: the quote also prints \$120000, which is 10000 × 12/)
  })
  it('R2-02: a bare number ("12") is not a dollar amount; a figure not written in its quote blocks', () => {
    expect(blockText(mutate((raw) => { raw.rent_schedule[0].amount_as_written = '12' }))).toMatch(/"12" is not a dollar amount as printed/)
    expect(blockText(mutate((raw) => { raw.rent_schedule[0].amount_as_written = '$12' }))).toMatch(/"\$12" is not written in its quote/)
  })
  it('R2-03: rent per $/SF needs an RSF that is printed in its own quote', () => {
    const psf = (raw: Wire) => { raw.rent_schedule[0] = row('2026-01-01', '2026-12-31', '$10.00', 'Year 1: $8,333.33 per month ($10.00 per RSF per year)', 'psf_year') }
    expect(blockText(mutate((raw) => { psf(raw); raw.facts = raw.facts.filter((f) => f.field !== 'premises_rsf') }))).toMatch(/no rentable square footage/)
    expect(blockText(mutate((raw) => { psf(raw); factOf(raw, 'premises_rsf').value = '150000' }))).toMatch(/150000 is not printed in its own quote/)
  })
  it('a period the wording contradicts is a warning (never a block)', () => {
    const r = mutate((raw) => {
      (raw.recurring_charges as Obj[]).push({ type: 'utility_water', description: 'Water', amount_as_written: '$2,400.00', amount_period: 'month', effective_start: '2026-01-01', effective_end: '2028-12-31', ...src(4, 'Tenant shall pay a water charge of $2,400.00 per lease year') })
    })
    expect(r.flags).toContainEqual(expect.objectContaining({ severity: 'warn', path: 'recurring_charges[1]', message: expect.stringMatching(/Confirm the period "month"/) }))
    expect(r.confirmations).toContainEqual(expect.objectContaining({ path: 'recurring_charges[1]', as_written: '$2,400.00', period: 'month', monthly: 2400 }))
  })
  it('R2-06: "per month, subject to annual reconciliation" and "per month, increasing annually" raise nothing', () => {
    const q1 = 'estimated CAM of $1,250.00 per month, subject to annual reconciliation'
    const q2 = 'Year 1: $8,333.33 per month, increasing by three percent (3%) annually'
    const pages = PAGES.map((p, k) => (k === 1 ? `${p}\n${q1}\n${q2}` : p))
    const r = mutate((raw) => { rec(raw).quote = q1; raw.rent_schedule[0].quote = q2 }, pages)
    expect(r.flags).toEqual([])
  })
})

describe('derived rent periods (printed rent only for the first period)', () => {
  const derive = (raw: Wire) => { raw.rent_schedule[1].amount_as_written = ''; raw.rent_schedule[2].amount_as_written = '' }
  it('are computed from the stated fixed escalation off the first printed period', () => {
    const r = mutate(derive)
    expect(blocks(r)).toEqual([])
    expect(r.abstract.rent_schedule.map((x) => x.base_rent_monthly)).toEqual([8333.33, 8583.33, 8840.83])
    expect(r.confirmations).toContainEqual(expect.objectContaining({ path: 'rent_schedule[1]', as_written: '(derived from the escalation)', monthly: 8583.33 }))
  })
  it('block without a stated fixed escalation', () => {
    expect(blockText(mutate((raw) => { derive(raw); raw.escalations = [] }))).toMatch(/no stated fixed escalation to derive it from/)
  })
  it('block when the first period itself is not printed', () => {
    expect(blockText(mutate((raw) => { raw.rent_schedule[0].amount_as_written = '' }))).toMatch(/first rent period must be printed/)
  })
  it('block when no escalation step starts on the period start', () => {
    expect(blockText(mutate((raw) => { derive(raw); raw.rent_schedule[0].end = '2027-01-31'; raw.rent_schedule[1].start = '2027-02-01' }))).toMatch(/No escalation step starts on 2027-02-01/)
  })
})

describe('concessions (merge gate R2-04)', () => {
  it('a full waiver whose quote prints a percentage under 100% blocks', () => {
    expect(blockText(mutate((raw) => { Object.assign(con(raw), { kind: 'full_waiver', value_as_written: '' }) }))).toMatch(/partial waiver/)
  })
  it('a full waiver quoting the rent being waived is valid', () => {
    const q = 'Base Rent of $8,333.33 shall be fully abated for January 2026'
    const pages = PAGES.map((p, k) => (k === 1 ? `${p}\n${q}` : p))
    const r = mutate((raw) => { Object.assign(con(raw), { kind: 'full_waiver', value_as_written: '', quote: q }) }, pages)
    expect(blocks(r)).toEqual([])
  })
  it('a full waiver with a value blocks', () => {
    expect(blockText(mutate((raw) => { Object.assign(con(raw), { kind: 'full_waiver', value_as_written: '$100.00', quote: 'Base Rent for January 2026' }) }))).toMatch(/full waiver has no value/)
  })
  // Merge gate R3-02: wording cannot prove CAM coverage ("continue to pay all Additional Rent" names it
  // too), so every 'all' waiver is a review warning and its confirmation shows charge 'all'.
  it('an "all" waiver is a review warning (never a block) and its confirmation shows it covers all charges', () => {
    const q = 'Base Rent shall be abated for January 2026; Tenant shall continue to pay all Additional Rent'
    const pages = PAGES.map((p, k) => (k === 1 ? `${p}\n${q}` : p))
    const r = mutate((raw) => { Object.assign(con(raw), { charge_type: 'all', kind: 'full_waiver', value_as_written: '', quote: q }) }, pages)
    expect(blocks(r)).toEqual([])
    expect(r.flags).toContainEqual(expect.objectContaining({ severity: 'warn', path: 'concessions[0]', message: expect.stringMatching(/covering rent AND CAM/) }))
    expect(r.confirmations).toContainEqual(expect.objectContaining({ path: 'concessions[0]', charge: 'all', start: '2026-01-01', end: '2026-01-31' }))
  })
  it('a percentage not written in its quote blocks', () => {
    expect(blockText(mutate((raw) => { con(raw).value_as_written = '75%' }))).toMatch(/"75%" is not written in its quote/)
  })
  const warnText = (r: ReturnType<typeof finalizeAbstract>) => r.flags.filter((f) => f.severity === 'warn').map((f) => f.message).join(' | ')
  // Merge gate R3-04: month and year matching are triage only; they must never block a correct lease.
  it('a concession whose year differs from the year its quote names is a review warning', () => {
    const r = mutate((raw) => { Object.assign(con(raw), { period_start: '2027-01-01', period_end: '2027-01-31' }) })
    expect(warnText(r)).toMatch(/quote names 2026/)
    expect(blockText(r)).not.toMatch(/quote names 2026/)
  })
  it('a concession spanning a year boundary whose quote names both years raises no year warning', () => {
    const q = 'fifty percent (50%) abatement of Base Rent for December 2026 and January 2027'
    const pages = PAGES.map((p, k) => (k === 1 ? `${p}\n${q}` : p))
    expect(warnText(mutate((raw) => { Object.assign(con(raw), { period_start: '2026-12-01', period_end: '2027-01-31', quote: q }) }, pages))).not.toMatch(/quote names/)
  })
  it('months: a period wider or narrower than the months the quote names is a review warning', () => {
    const wide = mutate((raw) => { con(raw).period_end = '2026-02-28' })
    expect(warnText(wide)).toMatch(/names other months/)
    expect(blockText(wide)).not.toMatch(/names other months/)
    const q = 'fifty percent (50%) abatement of Base Rent for January and February 2026'
    const pages = PAGES.map((p, k) => (k === 1 ? `${p}\n${q}` : p))
    expect(warnText(mutate((raw) => { con(raw).quote = q }, pages))).toMatch(/names other months/)
  })
  it('abbreviated months count ("Jan. 2026"): no period warning', () => {
    const qa = 'fifty percent (50%) abatement of Base Rent for Jan. 2026'
    const pagesA = PAGES.map((p, k) => (k === 1 ? `${p}\n${qa}` : p))
    expect(mutate((raw) => { con(raw).quote = qa }, pagesA).flags).toEqual([])
    const qb = 'fifty percent (50%) abatement of Base Rent for Jan. and Feb. 2026'
    const pagesB = PAGES.map((p, k) => (k === 1 ? `${p}\n${qb}` : p))
    expect(warnText(mutate((raw) => { con(raw).quote = qb }, pagesB))).toMatch(/names other months/)
  })
  it('a quote naming no month is a review warning', () => {
    const q = 'fifty percent (50%) abatement of Base Rent'
    expect(mutate((raw) => { con(raw).quote = q }).flags).toContainEqual(expect.objectContaining({ severity: 'warn', path: 'concessions[0]' }))
  })
})

describe('recurring charges (merge gate R2-05)', () => {
  it('a charge ending before expiration whose quote does not state the end is a review warning', () => {
    expect(mutate((raw) => { rec(raw).effective_end = '2027-03-31' }).flags)
      .toContainEqual(expect.objectContaining({ severity: 'warn', path: 'recurring_charges[0]', message: expect.stringMatching(/Ends 2027-03-31/) }))
  })
  it('a charge starting after the rent term whose quote does not state the start is a review warning', () => {
    expect(mutate((raw) => { rec(raw).effective_start = '2026-06-01' }).flags)
      .toContainEqual(expect.objectContaining({ severity: 'warn', path: 'recurring_charges[0]', message: expect.stringMatching(/Starts 2026-06-01/) }))
  })
})

describe('cross-checks (each mutation raises a blocking flag)', () => {
  it.each<[string, (raw: Wire) => void, RegExp, string[]?]>([
    ['a gap between rent periods', (r) => { r.rent_schedule[1].start = '2027-01-05' }, /Gap before/],
    ['overlapping rent periods', (r) => { r.rent_schedule[1].start = '2026-12-15' }, /Overlaps/],
    ['a rent row that ends before it starts', (r) => { r.rent_schedule[0].end = '2025-12-01' }, /Row ends before it starts/],
    ['schedule ending before expiration', (r) => { r.rent_schedule[2].end = '2028-11-30' }, /Schedule ends 2028-11-30/],
    ['one flat row across the term despite a 3% escalation', (r) => { r.rent_schedule.splice(0, 3, row('2026-01-01', '2028-12-31', '$8,333.33', 'Year 1: $8,333.33 per month')) }, /implies 3 rent period\(s\)/],
    ['steps on the wrong anniversary', (r) => { esc(r).first_adjustment_date = '2027-07-01' }, /implies 3 rent period\(s\) starting 2026-01-01, 2027-07-01, 2028-07-01/],
    ['an escalation whose first adjustment is after expiration, with a flat schedule', (r) => {
      esc(r).first_adjustment_date = '2029-01-01'
      r.rent_schedule.splice(0, 3, row('2026-01-01', '2028-12-31', '$8,333.33', 'Year 1: $8,333.33 per month'))
    }, /never takes effect before expiration/],
    ['a CPI escalation with a stepped schedule', (r) => { Object.assign(esc(r), { kind: 'cpi', value_as_written: '' }) }, /CPI lease can only schedule the current rent/],
    ['a CPI escalation with a value', (r) => { Object.assign(esc(r), { kind: 'cpi', value_as_written: '3%' }); r.rent_schedule.splice(1, 2); r.rent_schedule[0].end = '2028-12-31' }, /CPI escalation has no fixed value/],
    ['a stated escalation the model returned malformed', (r) => { esc(r).first_adjustment_date = '' }, /escalation that could not be read/],
    ['a 300% escalation', (r) => { esc(r).value_as_written = '300%'; esc(r).quote = 'Holdover rent shall be 150% of the Base Rent'; esc(r).page = 3 }, /not written in its quote|out of range/],
    ['a fixed-dollar escalation without a period', (r) => { Object.assign(esc(r), { kind: 'fixed_amount', value_as_written: '$250.00', value_period: 'none' }) }, /needs the period/],
    ['CPI cap on a fixed rule', (r) => { esc(r).cpi_cap = 0.04 }, /only apply to a CPI escalation/],
    ['a CPI cap of -1 (not a sentinel for the cap)', (r) => { Object.assign(esc(r), { kind: 'cpi', value_as_written: '', cpi_cap: -1 }) }, /Percentages are fractions/],
    ['cadence 0', (r) => { esc(r).cadence_months = 0 }, /cadence must be a positive/],
    ['first adjustment on the term start', (r) => { esc(r).first_adjustment_date = '2026-01-01' }, /cannot be applied to this term/],
    ['CPI floor above cap', (r) => { Object.assign(esc(r), { kind: 'cpi', value_as_written: '', cpi_floor: 0.05, cpi_cap: 0.02 }) }, /floor is above the cap/],
    ['a concession outside the term', (r) => { Object.assign(con(r), { period_start: '2025-12-01', period_end: '2025-12-31', quote: 'abatement of Base Rent for December 2025' }) }, /outside the rent term/],
    ['a concession ending after expiration', (r) => { con(r).period_end = '2029-01-31' }, /outside the rent term/],
    ['a concession that ends before it starts', (r) => { Object.assign(con(r), { period_start: '2026-01-31', period_end: '2026-01-01' }) }, /Ends before it starts/],
    ['a concession without a reason', (r) => { con(r).reason = '  ' }, /needs a reason/],
    ['an "all" dollar waiver', (r) => {
      Object.assign(con(r), { charge_type: 'all', kind: 'fixed_amount', value_as_written: '$1,250.00', value_period: 'month', quote: 'estimated CAM of $1,250.00 per month', reason: 'x' })
    }, /split/],
    ['a $0 recurring charge', (r) => { Object.assign(rec(r), { amount_as_written: '$0.00', quote: 'pay $0.00 per month for parking' }) }, /must be positive/, ['pay $0.00 per month for parking']],
    ['a recurring charge that ends before it starts', (r) => { Object.assign(rec(r), { effective_start: '2028-12-31', effective_end: '2026-01-01' }) }, /Ends before it starts/],
    ['a recurring charge without a description', (r) => { rec(r).description = ' ' }, /needs a description/],
    ['holdover written as 150', (r) => { factOf(r, 'holdover_rent_multiplier').value = '150' }, /multiplier/],
    ['no expiration date', (r) => { r.facts = r.facts.filter((f) => f.field !== 'expiration_date') }, /required/],
    ['expiration before the rent term starts', (r) => { factOf(r, 'expiration_date').value = '2025-12-31'; factOf(r, 'expiration_date').quote = 'Expiration Date: December 31, 2025' }, /Expiration is before the rent term starts/, ['Expiration Date: December 31, 2025']],
    ['every period $0', (r) => {
      r.escalations = []
      r.rent_schedule.forEach((x, i) => { x.amount_as_written = '$0.00'; x.quote = `Year ${i + 1}: $0.00 per month` })
    }, /Every rent period is \$0/, ['Year 1: $0.00 per month', 'Year 2: $0.00 per month', 'Year 3: $0.00 per month']],
    ['an exercise window with only a start', (r) => { (r.provisions as Obj[])[0].exercise_window_start = '2028-01-01' }, /needs both a start and an end/],
    ['a later rent commencement than the schedule start', (r) => { r.facts.push(fact('rent_commencement_date', '2026-03-01', 4, 'Rent Commencement Date: March 1, 2026')) }, /Schedule starts 2026-01-01; the rent term starts 2026-03-01/],
    ['cam_cap_pct 5', (r) => { r.facts.push(fact('cam_cap_pct', '5', 1, 'Premises: Suite 100, containing')) }, /Percentages are fractions/],
    ['admin_fee_pct 15', (r) => { r.facts.push(fact('admin_fee_pct', '15', 1, 'Premises: Suite 100, containing')) }, /Percentages are fractions/],
    ['pro_rata_share 25', (r) => { r.facts.push(fact('pro_rata_share', '25', 1, 'Premises: Suite 100, containing')) }, /Percentages are fractions/],
    ['cpi_cap 4', (r) => { Object.assign(esc(r), { kind: 'cpi', value_as_written: '', cpi_cap: 4 }) }, /Percentages are fractions/],
    ['cpi_floor 2', (r) => { Object.assign(esc(r), { kind: 'cpi', value_as_written: '', cpi_floor: 2 }) }, /Percentages are fractions/],
  ])('%s', (_name, f, msg, extraLines) => {
    const pages = extraLines ? PAGES.map((p, k) => (k === 1 ? `${p}\n${extraLines.join('\n')}` : p)) : PAGES
    expect(blockText(mutate(f, pages))).toMatch(msg)
  })

  it('a step amount off the 3% escalation (as printed) blocks', () => {
    const pages = withPage(1, '$8,583.33', '$9,000.00')
    const r = mutate((raw) => { Object.assign(raw.rent_schedule[1], { amount_as_written: '$9,000.00', quote: 'Year 2: $9,000.00 per month' }) }, pages)
    expect(blockText(r)).toMatch(/does not follow the stated escalation/)
  })
  it('steps with no stated escalation rule are a review warning', () => {
    const r = mutate((raw) => { raw.escalations = [] })
    expect(blocks(r)).toEqual([])
    expect(r.flags).toContainEqual(expect.objectContaining({ severity: 'warn', path: 'rent_schedule', message: expect.stringMatching(/not tied to a stated escalation/) }))
  })
  it('two overlapping rent concessions are caught by the billing dry run', () => {
    const r = mutate((raw) => { raw.concessions.push({ ...con(raw), reason: 'Second' }) })
    expect(blockText(r)).toMatch(/Billing would fail for 2026-01: concession_conflict/)
  })
  it('a CAM line overlapping itself is caught by the billing dry run', () => {
    const r = mutate((raw) => { raw.recurring_charges.push({ ...rec(raw), description: 'CAM 2', effective_start: '2027-06-01', effective_end: '2027-12-31' }) })
    expect(blockText(r)).toMatch(/Billing would fail for 2027-06: recurring_overlap/)
  })
  it('a CPI escalation is a review warning, never silently fine', () => {
    const r = mutate((raw) => { Object.assign(esc(raw), { kind: 'cpi', value_as_written: '' }) })
    expect(r.flags).toContainEqual(expect.objectContaining({ severity: 'warn', path: 'escalation' }))
  })
  it('a single-row CPI lease has no blocks', () => {
    const r = mutate((raw) => {
      Object.assign(esc(raw), { kind: 'cpi', value_as_written: '', value_period: 'none' })
      raw.rent_schedule.splice(0, 3, row('2026-01-01', '2028-12-31', '$8,333.33', 'Year 1: $8,333.33 per month'))
    })
    expect(blocks(r)).toEqual([])
  })
  it('a full waiver is valid', () => {
    const q = 'Base Rent shall be fully abated for January 2026'
    const pages = PAGES.map((p, k) => (k === 1 ? `${p}\n${q}` : p))
    expect(blocks(mutate((raw) => { Object.assign(con(raw), { kind: 'full_waiver', value_as_written: '', quote: q }) }, pages))).toEqual([])
  })
})

describe('wireToShape (sentinels and facts)', () => {
  it('starts every computed money field null and maps -1 / 0 / "" sentinels', () => {
    const w: string[] = []
    const s = wireToShape(good(), w) as Obj
    expect(w).toEqual([])
    expect((s.rent_schedule as Obj[])[0]).toEqual(expect.objectContaining({ base_rent_monthly: null, rent_psf_annual: null, amount_as_written: '$8,333.33' }))
    expect((s.recurring_charges as Obj[])[0].amount_monthly).toBeNull()
    expect((s.concessions as Obj[])[0].value).toBeNull()
    expect((s.escalation as Obj).cpi_floor).toBeNull()
    expect((s.escalation as Obj).cpi_cap).toBeNull()
    expect((s.provisions as Obj[])[0].exercise_window_start).toBeNull()
    expect((s.provisions as Obj[])[0].notice_deadline).toBe('2028-06-30')
    expect(s.premises_rsf).toEqual(expect.objectContaining({ value: 10000 }))
    expect(s.late_fee).toBeNull()
  })
  it('keeps a stated 0% CPI floor, a 0-day grace period, and maps a 0 late-fee amount to null', () => {
    const raw = good()
    raw.late_fees = [{ amount: 0, pct: 0.05, grace_days: 0, ...src(3, 'Holdover rent shall be 150% of the Base Rent') }]
    Object.assign(esc(raw), { kind: 'cpi', value_as_written: '', cpi_floor: 0, cpi_cap: 0.04 })
    const s = wireToShape(raw, []) as Obj
    expect((s.late_fee as Obj).grace_days).toBe(0)
    expect((s.late_fee as Obj).amount).toBeNull()
    expect((s.late_fee as Obj).pct).toBe(0.05)
    expect((s.escalation as Obj).cpi_floor).toBe(0)
  })
  it('strips commas from numeric facts', () => {
    const raw = good()
    factOf(raw, 'premises_rsf').value = '10,000'
    expect((wireToShape(raw, []) as Obj).premises_rsf).toEqual(expect.objectContaining({ value: 10000 }))
  })
  it('keeps the first of duplicated facts / escalations and drops unknown fields, each with a warning', () => {
    const raw = good()
    raw.facts.push(fact('premises_rsf', '12000', 1, 'x'), fact('rocket_fuel', '1', 1, 'x'))
    raw.escalations.push({ ...esc(raw) })
    const w: string[] = []
    const s = wireToShape(raw, w) as Record<string, { value?: unknown }>
    expect(s.premises_rsf.value).toBe(10000)
    expect(w).toEqual([
      'Field "premises_rsf" was stated more than once; the first value was kept.',
      'facts[9] names an unknown field and was dropped.',
      'More than one escalation rule was returned; only the first was kept. Check the lease.',
    ])
  })
  it('a non-numeric number fact is rejected by validation, not coerced', () => {
    const raw = good()
    factOf(raw, 'premises_rsf').value = 'ten thousand'
    const r = run(raw)
    expect(r.abstract.premises_rsf).toBeNull()
    expect(r.warnings).toContain('Field "premises_rsf" was malformed and was dropped.')
  })
})

describe('coerceAbstract', () => {
  it('drops a malformed item with a warning instead of discarding the abstract', () => {
    const shaped = wireToShape(good(), []) as Obj
    ;(shaped.rent_schedule as unknown[]).push({ start: '2029-02-30', end: 'x', amount_as_written: 5 })
    const { abstract, warnings } = coerceAbstract(shaped)
    expect(abstract.rent_schedule).toHaveLength(3)
    expect(warnings).toEqual(['rent_schedule[3] was malformed and was dropped.'])
  })
  it('a non-object response yields an empty abstract and a manual-entry warning', () => {
    const { abstract, warnings } = coerceAbstract([1, 2])
    expect(abstract.rent_schedule).toEqual([])
    expect(warnings[0]).toMatch(/Enter the lease manually/)
  })
  it('never throws on hostile JSON (prototype keys, wrong types everywhere)', () => {
    const hostile = JSON.parse('{"__proto__":{"x":1},"constructor":1,"facts":[{"field":"__proto__"},null,5],"rent_schedule":"x","escalations":[null],"provisions":[{}]}')
    expect(() => finalizeAbstract(hostile, PAGES)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------------------------------
// Merge gate PR #69, round 3 (cap raised to 4 by Gabriel): every confirmation is complete, wording checks
// are triage, and every money guard the test-validity auditor found unpinned now has a test.
// ---------------------------------------------------------------------------------------------------
const addLines = (lines: string[], page = 1) => PAGES.map((p, k) => (k === page ? `${p}\n${lines.join('\n')}` : p))
const warnsOf = (r: ReturnType<typeof finalizeAbstract>) => r.flags.filter((f) => f.severity === 'warn')

describe('merge gate R3-01: the RSF behind a per-square-foot figure is confirmed and its quote checked', () => {
  const psfRow = (raw: Wire) => { raw.rent_schedule[0] = row('2026-01-01', '2026-12-31', '$10.00', 'Year 1: $8,333.33 per month ($10.00 per RSF per year)', 'psf_year') }
  it('the rent confirmation carries the RSF used, and the RSF gets its own confirmation', () => {
    const r = mutate(psfRow)
    expect(r.confirmations).toContainEqual(expect.objectContaining({ path: 'rent_schedule[0]', period: 'psf_year', monthly: 8333.33, rsf: 10000 }))
    expect(r.confirmations).toContainEqual(expect.objectContaining({ path: 'premises_rsf', as_written: '10000', period: 'rentable square feet', page: 1, quote: 'containing 10,000 rentable square feet' }))
  })
  it('no RSF confirmation when nothing is quoted per square foot', () => {
    expect(run(good()).confirmations.some((c) => c.path === 'premises_rsf')).toBe(false)
  })
  it('an RSF quote that also prints another area (the building) is a review warning', () => {
    const q = 'The Premises contain 15,000 rentable square feet of the 150,000 rentable square foot Building'
    const r = mutate((raw) => { psfRow(raw); Object.assign(factOf(raw, 'premises_rsf'), { value: '150000', quote: q }) }, addLines([q], 0))
    expect(warnsOf(r)).toContainEqual(expect.objectContaining({ path: 'premises_rsf', message: expect.stringMatching(/also prints 15000; confirm 150000 is the Premises/) }))
    expect(r.confirmations).toContainEqual(expect.objectContaining({ path: 'rent_schedule[0]', rsf: 150000, monthly: 125000 }))
  })
})

describe('merge gate R3-03: escalation timing is confirmed and checked', () => {
  const derive = (raw: Wire) => { raw.rent_schedule[1].amount_as_written = ''; raw.rent_schedule[2].amount_as_written = '' }
  it('a first adjustment that is neither printed nor an anniversary is a review warning', () => {
    const r = mutate((raw) => {
      derive(raw)
      esc(raw).first_adjustment_date = '2026-07-01'
      raw.rent_schedule[0].end = '2026-06-30'
      raw.rent_schedule[1].start = '2026-07-01'; raw.rent_schedule[1].end = '2027-06-30'
      raw.rent_schedule[2].start = '2027-07-01'; raw.rent_schedule[2].end = '2028-12-31'
    })
    expect(warnsOf(r)).toContainEqual(expect.objectContaining({ path: 'escalation', message: expect.stringMatching(/first adjustment 2026-07-01 is neither printed/) }))
    expect(r.confirmations).toContainEqual(expect.objectContaining({ path: 'escalation', first_adjustment_date: '2026-07-01', cadence_months: 12 }))
  })
  it('an anniversary of the commencement date, or a date printed in the quote, raises no timing warning', () => {
    expect(run(good()).flags.some((f) => f.path === 'escalation')).toBe(false)
    const q = 'Base Rent shall first increase three percent (3%) on July 1, 2027'
    const r = mutate((raw) => { Object.assign(esc(raw), { first_adjustment_date: '2027-07-01', quote: q }) }, addLines([q], 1))
    expect(warnsOf(r).some((f) => f.path === 'escalation' && /neither printed/.test(f.message))).toBe(false)
  })
  it('every rent confirmation carries its period dates', () => {
    const r = mutate(derive)
    expect(r.confirmations.filter((c) => c.path.startsWith('rent_schedule')).map((c) => [c.start, c.end])).toEqual([
      ['2026-01-01', '2026-12-31'], ['2027-01-01', '2027-12-31'], ['2028-01-01', '2028-12-31'],
    ])
  })
  it('a fixed-dollar escalation is confirmed with its period, computed increase and timing (CN11)', () => {
    const q = 'Base Rent shall increase by $250.00 per month on each anniversary'
    const r = mutate((raw) => { Object.assign(esc(raw), { kind: 'fixed_amount', value_as_written: '$250.00', value_period: 'month', quote: q }); raw.rent_schedule.splice(1, 2); raw.rent_schedule[0].end = '2028-12-31' }, addLines([q], 1))
    expect(r.confirmations).toContainEqual(expect.objectContaining({ path: 'escalation', as_written: '$250.00', period: 'month', monthly: 250, first_adjustment_date: '2027-01-01', cadence_months: 12, quote: q }))
  })
})

describe('merge gate R3-04 / R3-05 / R3-08: dates and month ranges', () => {
  it('namedMonths expands ranges, including date ranges and a December wrap', () => {
    expect([...namedMonths('abated for the months of January through March 2027')].sort((a, b) => a - b)).toEqual([1, 2, 3])
    expect([...namedMonths('abated from January 1, 2027 through March 31, 2027')].sort((a, b) => a - b)).toEqual([1, 2, 3])
    expect([...namedMonths('free rent November - January')].sort((a, b) => a - b)).toEqual([1, 11, 12])
    expect([...namedMonths('Jan. and Mar. only')].sort((a, b) => a - b)).toEqual([1, 3])
  })
  it('a correctly entered January-March abatement raises no period flag', () => {
    for (const q of ['fifty percent (50%) abatement of Base Rent for January through March 2026', 'fifty percent (50%) abatement of Base Rent from January 1, 2026 to March 31, 2026']) {
      const r = mutate((raw) => { Object.assign(con(raw), { period_end: '2026-03-31', quote: q }) }, addLines([q], 1))
      expect(r.flags.filter((f) => f.path === 'concessions[0]')).toEqual([])
    }
  })
  it('"the 1st of January, 2027" states the date; an ISO date never matches inside a longer number', () => {
    expect(dateInQuote('2027-01-01', 'commencing the 1st of January, 2027')).toBe(true)
    expect(dateInQuote('2027-01-01', 'ref 12027-01-012')).toBe(false)
    expect(dateInQuote('2027-01-01', 'ref 2027-01-012')).toBe(false)
    expect(dateInQuote('2027-01-01', 'effective (2027-01-01)')).toBe(true)
  })
})

describe('merge gate R3-07: money guards the auditor found unpinned', () => {
  it('ES2: an in-range percentage that is not written in its quote blocks with exactly that reason', () => {
    expect(blockText(mutate((raw) => { esc(raw).value_as_written = '4%' }))).toMatch(/"4%" is not written in its quote/)
  })
  it('ES5: an escalation percentage that does not parse blocks (the schedule comparison never runs on null)', () => {
    expect(blockText(mutate((raw) => { esc(raw).value_as_written = 'three percent' }))).toMatch(/"three percent" is not a percentage as printed/)
  })
  it('WQ1/WQ6: a percentage never matches inside a larger one', () => {
    expect(writtenInQuote('3%', 'increase thirteen percent (13%)')).toBe(false)
    expect(writtenInQuote('3%', 'increase of 1.3%')).toBe(false)
    expect(writtenInQuote('3%', 'increase of 3%')).toBe(true)
  })
  it('WQ5/WQ7: matching ignores case and spacing, and finds a later occurrence', () => {
    expect(writtenInQuote('$1,000.00', 'CAM OF   $1,000.00 PER MONTH')).toBe(true)
    expect(writtenInQuote('$1,000.00', 'a $11,000.00 deposit and CAM of $1,000.00')).toBe(true)
  })
  it('PC1: a dollar figure must be the whole as-written string', () => {
    expect(parseWrittenCurrency('Rent $100')).toBeNull()
  })
  it('CF1/CF2: dollar figures keep their cents and a figure with a third decimal is not money', () => {
    expect(currencyFiguresInQuote('Monthly $8,333.33 or $100,000.00 per year')).toEqual([8333.33, 100000])
    expect(currencyFiguresInQuote('an amount of $1,000.505')).toEqual([])
  })
  const quoteBoth = 'Base Rent of $8,333.33 per month ($100,000.00 per year)'
  it('PX3/PX4: the period contradiction holds for a rounded pair, in both directions', () => {
    const asYear = mutate((raw) => { raw.rent_schedule[0] = row('2026-01-01', '2026-12-31', '$8,333.33', quoteBoth, 'year') }, addLines([quoteBoth], 1))
    expect(blockText(asYear)).toMatch(/period "year" does not fit: the quote also prints \$100000, which is 8333.33 × 12/)
    const asMonth = mutate((raw) => { raw.rent_schedule[0] = row('2026-01-01', '2026-12-31', '$100,000.00', quoteBoth) }, addLines([quoteBoth], 1))
    expect(blockText(asMonth)).toMatch(/period "month" does not fit: the quote also prints \$8333.33, which is 100000 ÷ 12/)
  })
  it('TM6: a per-year figure that does not divide evenly is rounded to the cent', () => {
    const r = mutate((raw) => { raw.rent_schedule[0] = row('2026-01-01', '2026-12-31', '$100,000.00', quoteBoth, 'year') }, addLines([quoteBoth], 1))
    expect(r.abstract.rent_schedule[0].base_rent_monthly).toBe(8333.33)
  })
  it('PX5/PX6: a near-miss pair ($50 off) is not a contradiction', () => {
    const q = 'Base Rent of $100,000.00 per year; the parking fee is $8,337.50 per month'
    const r = mutate((raw) => { raw.rent_schedule[0] = row('2026-01-01', '2026-12-31', '$100,000.00', q, 'year') }, addLines([q], 1))
    expect(blockText(r)).not.toMatch(/does not fit/)
  })
  it('ES1/CO12: parsed percentages are the printed ones (4% escalation, 25% abatement)', () => {
    const qe = 'Base Rent shall increase four percent (4%) on each anniversary'
    const qc = 'Tenant shall receive twenty-five percent (25%) abatement of Base Rent for January 2026'
    const r = mutate((raw) => {
      Object.assign(esc(raw), { value_as_written: '4%', quote: qe })
      raw.rent_schedule[1].amount_as_written = ''; raw.rent_schedule[2].amount_as_written = ''
      Object.assign(con(raw), { value_as_written: '25%', quote: qc })
    }, addLines([qe, qc], 1))
    expect(r.abstract.escalation?.value).toBe(0.04)
    expect(r.abstract.concessions[0].value).toBe(0.25)
    expect(r.abstract.rent_schedule.map((x) => x.base_rent_monthly)).toEqual([8333.33, 8666.66, 9013.33])
  })
  it('CO2: a full waiver whose quote prints 100% is not a partial waiver', () => {
    const q = 'one hundred percent (100%) of Base Rent shall be abated for January 2026'
    const r = mutate((raw) => { Object.assign(con(raw), { kind: 'full_waiver', value_as_written: '', quote: q }) }, addLines([q], 1))
    expect(blockText(r)).not.toMatch(/partial waiver/)
  })
  it('RW3/RW4: a recurring charge whose quote states its start and end raises no date warning', () => {
    const q = 'Tenant shall pay a parking fee of $100.00 per month from June 1, 2026 through March 31, 2027'
    const r = mutate((raw) => {
      raw.recurring_charges.push({ type: 'other', description: 'Parking', amount_as_written: '$100.00', amount_period: 'month', effective_start: '2026-06-01', effective_end: '2027-03-31', ...src(2, q) })
    }, addLines([q], 1))
    expect(r.flags.filter((f) => f.path === 'recurring_charges[1]')).toEqual([])
  })
  it('PW3/PW7/PW8/PW10: period wording triage', () => {
    expect(periodWordingMismatch('$2,400.00', 'month', 'a fee of $2,400.00 (two thousand four hundred dollars) per annum')).toMatch(/per year/)
    expect(periodWordingMismatch('$2,400.00', 'month', 'a fee of $2,400.00 per annum')).toMatch(/per year/)
    expect(periodWordingMismatch('$10.00', 'month', 'rent of $10.00 per rentable square foot')).toMatch(/per year/)
    expect(periodWordingMismatch('$1,000.00', 'year', 'a fee of $1,000.00 is due, payable monthly')).toBeNull()
  })
})
