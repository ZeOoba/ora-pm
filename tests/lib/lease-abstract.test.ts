import { describe, it, expect } from 'vitest'
import {
  ABSTRACT_SCHEMA,
  ExtractionStopped,
  MAX_INPUT_CHARS,
  buildAbstractRequest,
  coerceAbstract,
  finalizeAbstract,
  normalizeForMatch,
  parseAbstractResponse,
  quoteOnPage,
  wireToShape,
} from '../../server/lib/lease-abstract'

// A synthetic 3-page industrial lease. Every quote in good() comes verbatim from these pages.
const PAGES = [
  'INDUSTRIAL LEASE AGREEMENT\nThis Lease is made between Landlord and Acme Fabrication LLC, an Ohio limited liability company ("Tenant").\nPremises: Suite 100, containing 10,000 rentable square feet.\nCommencement Date: January 1, 2026. Expiration Date: December 31, 2028.',
  'ARTICLE 4 – RENT\nYear 1: $8,333.33 per month ($10.00 per RSF per year).\nYear 2: $8,583.33 per month. Year 3: $8,840.83 per month.\nBase Rent shall increase three percent (3%) annually on each anniversary.\nTenant shall receive fifty percent (50%) abatement of Base Rent for January 2026.\nTenant shall pay estimated CAM of $1,250.00 per month.',
  'ARTICLE 30 – RENEWAL\nTenant shall have one option to renew for five (5) years upon written notice no later than June 30, 2028.\nHoldover rent shall be 150% of the Base Rent then in effect.',
]

type Wire = Record<string, unknown> & { facts: Array<Record<string, unknown>>; rent_schedule: Array<Record<string, unknown>> }
const src = (page: number, quote: string) => ({ page, quote, confidence: 0.95 })
const fact = (field: string, value: string, page: number, quote: string) => ({ field, value, ...src(page, quote) })

/** The model's WIRE output (sentinels: 0 = not stated, "" = no date) for a consistent lease. */
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
      { start: '2026-01-01', end: '2026-12-31', base_rent_monthly: 8333.33, rent_psf_annual: 10, ...src(2, 'Year 1: $8,333.33 per month') },
      { start: '2027-01-01', end: '2027-12-31', base_rent_monthly: 8583.33, rent_psf_annual: 0, ...src(2, 'Year 2: $8,583.33 per month') },
      { start: '2028-01-01', end: '2028-12-31', base_rent_monthly: 8840.83, rent_psf_annual: 0, ...src(2, 'Year 3: $8,840.83 per month') },
    ],
    escalations: [{ kind: 'fixed_pct', value: 0.03, cadence_months: 12, first_adjustment_date: '2027-01-01', cpi_floor: -1, cpi_cap: 0, ...src(2, 'increase three percent (3%) annually') }],
    concessions: [{ charge_type: 'rent', period_start: '2026-01-01', period_end: '2026-01-31', kind: 'pct', value: 0.5, reason: 'Abatement', ...src(2, 'fifty percent (50%) abatement of Base Rent for January 2026') }],
    recurring_charges: [{ type: 'cam_estimate', description: 'CAM estimate', amount_monthly: 1250, effective_start: '2026-01-01', effective_end: '2028-12-31', ...src(2, 'estimated CAM of $1,250.00 per month') }],
    late_fees: [],
    provisions: [{ category: 'renewal_option', summary: 'One 5-year renewal option.', notice_deadline: '2028-06-30', exercise_window_start: '', exercise_window_end: '', ...src(3, 'one option to renew for five (5) years') }],
  }
}

const blocks = (r: ReturnType<typeof finalizeAbstract>) => r.flags.filter((f) => f.severity === 'block')
const blockText = (r: ReturnType<typeof finalizeAbstract>) => blocks(r).map((b) => b.message).join(' | ')
const factOf = (w: Wire, field: string) => w.facts.find((f) => f.field === field) as Record<string, unknown>

describe('buildAbstractRequest', () => {
  it('sends scanned page text only, with structured outputs and no forced tool_choice', () => {
    const req = buildAbstractRequest(PAGES, 'claude-opus-5') as Record<string, unknown>
    expect(req).not.toHaveProperty('tool_choice')
    expect(req).not.toHaveProperty('tools')
    expect(req.output_config).toEqual({ effort: 'high', format: { type: 'json_schema', schema: ABSTRACT_SCHEMA } })
    const text = JSON.stringify(req.messages)
    expect(text).toContain('--- Page 2 of 3 ---')
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
      const o = s as Record<string, unknown>
      if ('anyOf' in o || 'oneOf' in o || Array.isArray(o.type)) unions++
      if (o.type === 'object') {
        expect(o.additionalProperties).toBe(false)
        const keys = Object.keys(o.properties as object)
        optional += keys.filter((k) => !(o.required as string[]).includes(k)).length
      }
      for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'multipleOf']) expect(o).not.toHaveProperty(k)
      Object.values(o).forEach((v) => (Array.isArray(v) ? v.forEach(walk) : walk(v)))
    }
    walk(ABSTRACT_SCHEMA)
    expect(unions).toBe(0)
    expect(optional).toBe(0)
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
  ])('stops on %j', (res, reason) => {
    expect(() => parseAbstractResponse(res)).toThrow(ExtractionStopped)
    try { parseAbstractResponse(res) } catch (e) { expect((e as ExtractionStopped).reason).toBe(reason) }
  })
})

describe('wireToShape (sentinels and facts)', () => {
  it('maps 0 / "" sentinels to null and the fact list to cited scalars', () => {
    const w: string[] = []
    const s = wireToShape(good(), w) as Record<string, unknown>
    expect(w).toEqual([])
    expect((s.rent_schedule as Array<{ rent_psf_annual: unknown }>)[1].rent_psf_annual).toBeNull()
    expect((s.escalation as { cpi_floor: unknown }).cpi_floor).toBeNull()
    expect((s.provisions as Array<{ exercise_window_start: unknown }>)[0].exercise_window_start).toBeNull()
    expect(s.premises_rsf).toEqual(expect.objectContaining({ value: 10000 }))
    expect(s.late_fee).toBeNull()
  })
  it('keeps the first of duplicated facts / escalations and drops unknown fields, each with a warning', () => {
    const raw = good()
    raw.facts.push(fact('premises_rsf', '12000', 1, 'x'), fact('rocket_fuel', '1', 1, 'x'))
    ;(raw.escalations as unknown[]).push({ ...(raw.escalations as unknown[])[0] as object })
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
    const r = finalizeAbstract(raw, PAGES)
    expect(r.abstract.premises_rsf).toBeNull()
    expect(r.warnings).toContain('Field "premises_rsf" was malformed and was dropped.')
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
  it('rejects a quote too short to prove anything (REFUTE C3)', () => {
    expect(quoteOnPage(PAGES, 1, 'Suite 100')).toBe(false)
    expect(quoteOnPage(PAGES, 1, 'Premises: Suite 100')).toBe(true)
  })
  it('an unverifiable citation on a billing value BLOCKS; elsewhere it warns', () => {
    const raw = good()
    raw.rent_schedule[1].quote = 'Year 2: $9,999.99 per month'
    factOf(raw, 'premises_suite').quote = 'Premises: Suite 900 north'
    const r = finalizeAbstract(raw, PAGES)
    expect(r.abstract.rent_schedule[1].confidence).toBe(0)
    expect(r.flags).toContainEqual(expect.objectContaining({ severity: 'block', path: 'rent_schedule[1]' }))
    expect(r.flags).toContainEqual(expect.objectContaining({ severity: 'warn', path: 'premises_suite' }))
  })
  it('keeps a stated 0% CPI floor and a 0-day grace period (-1 is the "not stated" sentinel)', () => {
    const raw = good()
    raw.late_fees = [{ amount: 100, pct: 0, grace_days: 0, ...src(3, 'Holdover rent shall be 150% of the Base Rent') }]
    Object.assign((raw.escalations as Array<Record<string, unknown>>)[0], { kind: 'cpi', value: 0, cpi_floor: 0, cpi_cap: 0.04 })
    const r = finalizeAbstract(raw, PAGES)
    expect(r.abstract.late_fee?.grace_days).toBe(0)
    expect(r.abstract.escalation?.cpi_floor).toBe(0)
    expect(r.abstract.late_fee?.pct).toBeNull()
  })
  it('does not accept 1250 as stated by "$1,250.75"', () => {
    const raw = good()
    ;(raw.recurring_charges as Array<Record<string, unknown>>)[0].quote = 'estimated CAM of $1,250.75 per month'
    const page = PAGES.map((p) => p.replace('$1,250.00', '$1,250.75'))
    const r = finalizeAbstract(raw, page)
    expect(r.flags).toContainEqual(expect.objectContaining({ path: 'recurring_charges[0]', message: expect.stringMatching(/does not state 1250/) }))
  })
  it('warns when a recurring charge quote does not state its amount', () => {
    const raw = good()
    ;(raw.recurring_charges as Array<Record<string, unknown>>)[0].amount_monthly = 1500
    const r = finalizeAbstract(raw, PAGES)
    expect(r.flags).toContainEqual(expect.objectContaining({ severity: 'warn', path: 'recurring_charges[0]', message: expect.stringMatching(/does not state 1500/) }))
  })
})

describe('finalizeAbstract on a consistent lease', () => {
  it('returns no blocking flags and keeps every value', () => {
    const r = finalizeAbstract(good(), PAGES)
    expect(blocks(r)).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.flags).toEqual([])
    expect(r.abstract.rent_schedule).toHaveLength(3)
    expect(r.abstract.premises_rsf?.value).toBe(10000)
    expect(r.abstract.provisions[0].notice_deadline).toBe('2028-06-30')
  })
})

describe('cross-checks (each mutation must raise a blocking flag)', () => {
  const mutate = (f: (raw: Wire) => void) => { const raw = good(); f(raw); return finalizeAbstract(raw, PAGES) }
  const esc = (r: Wire) => (r.escalations as Array<Record<string, unknown>>)[0]
  const con = (r: Wire) => (r.concessions as Array<Record<string, unknown>>)[0]

  it.each<[string, (raw: Wire) => void, RegExp]>([
    ['a gap between rent periods', (r) => { r.rent_schedule[1].start = '2027-01-05' }, /Gap before/],
    ['overlapping rent periods', (r) => { r.rent_schedule[1].start = '2026-12-15' }, /Overlaps/],
    ['schedule ending before expiration', (r) => { r.rent_schedule[2].end = '2028-11-30' }, /Schedule ends 2028-11-30/],
    ['a step amount off the 3% escalation', (r) => { r.rent_schedule[1].base_rent_monthly = 9000 }, /does not follow the stated escalation/],
    // REFUTE C4: timing, not just amounts.
    ['one flat row across the term despite a 3% escalation', (r) => {
      r.rent_schedule.splice(0, 3, { start: '2026-01-01', end: '2028-12-31', base_rent_monthly: 8333.33, rent_psf_annual: 10, ...src(2, 'Year 1: $8,333.33 per month') })
    }, /implies 3 rent period\(s\)/],
    ['steps on the wrong anniversary', (r) => { esc(r).first_adjustment_date = '2027-07-01' }, /implies 3 rent period\(s\) starting 2026-01-01, 2027-07-01, 2028-07-01/],
    ['rent that does not tie to the stated $/SF', (r) => { r.rent_schedule[0].rent_psf_annual = 12 }, /states \$12\/SF/],
    ['sub-cent rent', (r) => { r.rent_schedule[0].base_rent_monthly = 8333.333 }, /fractions of a cent/],
    ['a 3% escalation written as 3', (r) => { esc(r).value = 3 }, /fractions/],
    ['a concession outside the term', (r) => { con(r).period_start = '2025-12-01' }, /outside the rent term/],
    ['a 50% abatement written as 50', (r) => { con(r).value = 50 }, /fractions/],
    ['an "all" dollar waiver', (r) => { Object.assign(con(r), { charge_type: 'all', kind: 'fixed_amount', value: 500 }) }, /split/],
    ['holdover written as 150', (r) => { factOf(r, 'holdover_rent_multiplier').value = '150' }, /multiplier/],
    ['no expiration date', (r) => { r.facts = r.facts.filter((f) => f.field !== 'expiration_date') }, /required/],
    ['CPI floor above cap', (r) => { Object.assign(esc(r), { kind: 'cpi', value: 0, cpi_floor: 0.05, cpi_cap: 0.02 }) }, /floor is above the cap/],
    ['every period $0', (r) => { r.rent_schedule.forEach((x) => { x.base_rent_monthly = 0; x.rent_psf_annual = 0 }); r.escalations = [] }, /Every rent period is \$0/],
    // Re-REFUTE 1: a rule that never adjusts inside the term must not bless a flat schedule.
    ['an escalation whose first adjustment is after expiration, with a flat schedule', (r) => {
      esc(r).first_adjustment_date = '2029-01-01'
      r.rent_schedule.splice(0, 3, { start: '2026-01-01', end: '2028-12-31', base_rent_monthly: 8333.33, rent_psf_annual: 10, ...src(2, 'Year 1: $8,333.33 per month') })
    }, /never takes effect before expiration/],
    // Re-REFUTE 2: future CPI rents are unknown.
    ['a CPI escalation with a stepped schedule', (r) => { Object.assign(esc(r), { kind: 'cpi', value: 0 }) }, /CPI lease can only schedule the current rent/],
    // Re-REFUTE 3: a stated escalation returned malformed must not become "no rule".
    ['a stated escalation the model returned malformed', (r) => { esc(r).first_adjustment_date = '' }, /escalation that could not be read/],
    ['a recurring charge quoted per year', (r) => {
      Object.assign((r.recurring_charges as Array<Record<string, unknown>>)[0], { quote: 'Tenant shall pay estimated CAM of $1,250.00 per month.' })
      ;(r.recurring_charges as Array<Record<string, unknown>>).push({ type: 'other', description: 'Tax escrow', amount_monthly: 3000, effective_start: '2026-01-01', effective_end: '2028-12-31', page: 2, quote: 'Base Rent shall increase three percent (3%) annually', confidence: 0.9 })
    }, /states an annual amount/],
  ])('%s', (_name, f, msg) => {
    expect(blockText(mutate(f))).toMatch(msg)
  })

  it('steps with no stated escalation rule are a review warning', () => {
    const r = mutate((raw) => { raw.escalations = [] })
    expect(blocks(r)).toEqual([])
    expect(r.flags).toContainEqual(expect.objectContaining({ severity: 'warn', path: 'rent_schedule', message: expect.stringMatching(/not tied to a stated escalation/) }))
  })
  it('the billing engine dry run catches what the structural checks cannot (a CAM line overlapping itself)', () => {
    const r = mutate((raw) => {
      (raw.recurring_charges as unknown[]).push({ type: 'cam_estimate', description: 'CAM 2', amount_monthly: 1250, effective_start: '2027-06-01', effective_end: '2027-12-31', ...src(2, 'estimated CAM of $1,250.00 per month') })
    })
    expect(blockText(r)).toMatch(/Billing would fail for 2027-06: recurring_overlap/)
  })
  it('a CPI escalation is a review warning, never silently fine', () => {
    const r = mutate((raw) => { Object.assign(esc(raw), { kind: 'cpi', value: 0 }) })
    expect(r.flags).toContainEqual(expect.objectContaining({ severity: 'warn', path: 'escalation' }))
  })
})

describe('coerceAbstract', () => {
  it('drops a malformed item with a warning instead of discarding the abstract', () => {
    const shaped = wireToShape(good(), []) as Record<string, unknown>
    ;(shaped.rent_schedule as unknown[]).push({ start: '2029-02-30', end: 'x', base_rent_monthly: 'lots' })
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
