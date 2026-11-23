import { describe, it, expect } from 'vitest'
import { finalizeAbstract, revalidateAbstract, REVIEWER_QUOTE_SUFFIX, type LeaseAbstract } from '../../server/lib/lease-abstract'
import { buildApprovalPayload, divergenceSignature, legacyBillingDivergence, ApprovalInputError, BillingDivergenceError, OverBillingError, type ApproveInputs } from '../../server/lib/lease-approve'
import { PAGES, reviewed, wire } from '../fixtures/lease-abstract-approve'

const inputs = (over: Partial<ApproveInputs> = {}): ApproveInputs => ({
  unitId: '20000000-0000-0000-0000-000000000001', today: '2026-11-23',
  tenant: { mode: 'new', name: 'Acme Fabrication' }, replace: null, notes: 'Holdover 150%.',
  storagePath: 'abstracts/x.pdf', fileSha256: 'a'.repeat(64), filename: 'Acme.pdf', model: 'm', approvedBy: 'admin@x', warnings: [],
  acknowledgedDivergence: null,
  ...over,
})
type Row = Record<string, unknown>
type P = { tenant: Row; lease: Row; escalation: Row; replace: Row; rent_schedule: Row[]; concessions: Row[]; recurring_charges: Row[]; provisions: Row[]; critical_dates: Array<{ kind: string; critical_date: string; description: string }> }
const pay = (a: LeaseAbstract, i: ApproveInputs) => buildApprovalPayload(a, { ...i, acknowledgedDivergence: i.acknowledgedDivergence ?? sigFor(a) }) as unknown as P
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
/** Signature of the under-bill months for the lease row buildApprovalPayload will derive (no throw = none). */
function sigFor(a: LeaseAbstract): string | null {
  try { buildApprovalPayload(a, inputs()); return null } catch (e) { return e instanceof BillingDivergenceError ? e.signature : null }
}
const abs = () => clone(reviewed().abstract)
const blocksOf = (r: ReturnType<typeof revalidateAbstract>) => r.flags.filter((f) => f.severity === 'block')

describe('revalidateAbstract (approval-time re-check against the approved PDF)', () => {
  it('a finalized block-free abstract round-trips with no blocks; confirmations are a superset of extraction', () => {
    const r = reviewed()
    expect(r.flags.filter((f) => f.severity === 'block')).toEqual([])
    const again = revalidateAbstract(clone(r.abstract), PAGES)
    expect(again.warnings).toEqual([])
    expect(blocksOf(again)).toEqual([])
    const paths = new Set(again.confirmations.map((c) => c.path))
    for (const c of r.confirmations) expect(paths.has(c.path)).toBe(true)
  })

  it('REFUTE C1a/C1c: a quote not in the approved PDF blocks at approval, not only at extraction', () => {
    const a = abs()
    a.recurring_charges[0].amount_as_written = '$1,500.00'
    a.recurring_charges[0].quote = 'estimated CAM of $1,500.00 per month'
    expect(blocksOf(revalidateAbstract(a, PAGES)).some((f) => f.path === 'recurring_charges[0]')).toBe(true)
    // The same abstract against a different document blocks every billing citation.
    expect(blocksOf(revalidateAbstract(abs(), ['an unrelated one-page document with other text'])).length).toBeGreaterThan(0)
  })

  it('a value the reviewer typed is exempt from the page check, warned, and still confirmed', () => {
    const a = abs()
    a.recurring_charges[0].amount_as_written = '$1,500.00'
    a.recurring_charges[0].quote = `$1,500.00${REVIEWER_QUOTE_SUFFIX}`
    const r = revalidateAbstract(a, PAGES)
    expect(blocksOf(r).filter((f) => f.path === 'recurring_charges[0]')).toEqual([])
    expect(r.flags.some((f) => f.severity === 'warn' && f.path === 'recurring_charges[0]' && /reviewer/.test(f.message))).toBe(true)
    expect(r.confirmations.find((c) => c.path === 'recurring_charges[0]')?.monthly).toBe(1500)
  })

  it('REFUTE round 2: a model quote carrying the reviewer marker is stripped at extraction and still blocks', () => {
    const w = wire()
    const cam = w.recurring_charges[0] as Record<string, unknown>
    cam.amount_as_written = '$1,500.00'
    cam.quote = `estimated CAM of $1,500.00 per month${REVIEWER_QUOTE_SUFFIX}`
    const ext = finalizeAbstract(w, PAGES)
    expect(ext.abstract.recurring_charges[0].quote).not.toContain('entered by reviewer')
    expect(ext.flags.some((f) => f.severity === 'block' && f.path === 'recurring_charges[0]')).toBe(true)
    expect(blocksOf(revalidateAbstract(clone(ext.abstract), PAGES)).some((f) => f.path === 'recurring_charges[0]')).toBe(true)
  })

  it('REFUTE round 2: rent type is always confirmed and blocks when not stated', () => {
    expect(revalidateAbstract(abs(), PAGES).confirmations.map((c) => c.path)).toContain('rent_type')
    const a = abs()
    a.rent_type = null
    expect(blocksOf(revalidateAbstract(a, PAGES)).some((f) => f.path === 'rent_type')).toBe(true)
  })

  it('REFUTE round 3 P8: a derived (unprinted) rent period blocks at approval until the reviewer enters it', () => {
    const a = abs()
    a.rent_schedule[2].amount_as_written = ''
    expect(blocksOf(revalidateAbstract(clone(a), PAGES)).some((f) => f.path === 'rent_schedule[2]' && /derived/.test(f.message))).toBe(true)
    a.rent_schedule[2].amount_as_written = '$8,840.83'
    a.rent_schedule[2].quote = `$8,840.83${REVIEWER_QUOTE_SUFFIX}`
    expect(blocksOf(revalidateAbstract(clone(a), PAGES)).filter((f) => f.path === 'rent_schedule[2]')).toEqual([])
  })

  it('REFUTE C1d: client-sent computed figures are discarded and re-derived', () => {
    const a = abs()
    a.rent_schedule[0].base_rent_monthly = 1
    a.rent_schedule[0].rent_psf_annual = 999
    const r = revalidateAbstract(a, PAGES)
    expect(r.abstract.rent_schedule[0].base_rent_monthly).toBe(8333.33)
    expect(r.abstract.rent_schedule[0].rent_psf_annual).toBeNull()
  })

  it('REFUTE C1d: lease-row terms the reviewer must confirm are added (deposit, share, rent type...)', () => {
    const a = abs()
    a.security_deposit = { value: 10000, page: 1, quote: `10000${REVIEWER_QUOTE_SUFFIX}`, confidence: 1 }
    a.pro_rata_share = { value: 0.25, page: 1, quote: `0.25${REVIEWER_QUOTE_SUFFIX}`, confidence: 1 }
    const paths = revalidateAbstract(a, PAGES).confirmations.map((c) => c.path)
    expect(paths).toEqual(expect.arrayContaining(['security_deposit', 'pro_rata_share']))
  })

  it('blocks rent commencement before lease commencement', () => {
    const a = abs()
    a.rent_commencement_date = { value: '2025-12-01', page: 1, quote: `2025-12-01${REVIEWER_QUOTE_SUFFIX}`, confidence: 1 }
    expect(blocksOf(revalidateAbstract(a, PAGES)).some((f) => f.path === 'rent_commencement_date')).toBe(true)
  })

  it('blocks an as-written amount changed without re-entering its quote', () => {
    const a = abs()
    a.rent_schedule[0].amount_as_written = '$9,000.00'
    expect(blocksOf(revalidateAbstract(a, PAGES)).some((f) => f.path === 'rent_schedule[0]')).toBe(true)
  })

  it('reports a malformed field as a warning (the route rejects it, never drops it silently)', () => {
    const a = abs() as unknown as Record<string, unknown>
    a.expiration_date = { value: 'not a date', page: 1, quote: 'x', confidence: 1 }
    expect(revalidateAbstract(a, PAGES).warnings.length).toBeGreaterThan(0)
  })
})

const LEASE_ROW = { start_date: '2026-01-01', end_date: '2028-12-31', base_rent_monthly: 8333.33, cam_estimate_monthly: 1250 }
const sig = (a: LeaseAbstract) => divergenceSignature(legacyBillingDivergence(a, LEASE_ROW))

describe('legacy billing divergence (REFUTE C4)', () => {
  it('an abatement month is an OVER-bill and refuses approval with no acknowledgement escape', () => {
    const a = revalidateAbstract(clone(reviewed({ abatement: true }).abstract), PAGES).abstract
    const jan = legacyBillingDivergence(a, LEASE_ROW).find((x) => x.period === '2026-01')!
    expect(jan.billed).toBe(9583.33)
    expect(jan.due).toBeLessThan(jan.billed)
    expect(() => buildApprovalPayload(a, inputs({ acknowledgedDivergence: sig(a) }))).toThrow(OverBillingError)
  })

  it('CAM that ends before the term does is an over-bill (refused)', () => {
    const a = revalidateAbstract(abs(), PAGES).abstract
    a.recurring_charges[0].effective_end = '2026-12-31'
    expect(() => buildApprovalPayload(a, inputs({ acknowledgedDivergence: sig(a) }))).toThrow(OverBillingError)
  })

  it('escalation steps are UNDER-bills: refused until acknowledged, and only the exact month list passes', () => {
    const a = revalidateAbstract(abs(), PAGES).abstract
    const d = legacyBillingDivergence(a, LEASE_ROW)
    expect(d.length).toBeGreaterThan(0)
    expect(d.every((x) => x.due > x.billed)).toBe(true)
    expect(() => buildApprovalPayload(a, inputs({ acknowledgedDivergence: null }))).toThrow(BillingDivergenceError)
    expect(() => buildApprovalPayload(a, inputs({ acknowledgedDivergence: sig(a) + ',2099-01:1.00:2.00' }))).toThrow(BillingDivergenceError)
    const p = pay(a, inputs({ acknowledgedDivergence: sig(a) }))
    expect(p.critical_dates.some((c) => c.critical_date === '2027-01-01' && /Billing review 2027-01/.test(c.description))).toBe(true)
  })

  it('REFUTE round 3 P7: a rent over-bill cannot net against a CAM under-bill in the same month', () => {
    const a = revalidateAbstract(abs(), PAGES).abstract
    a.rent_schedule = [{ ...a.rent_schedule[0], end: '2028-12-31' }]
    a.escalation = null
    a.recurring_charges = [
      { ...a.recurring_charges[0], effective_end: '2026-12-31' },
      { ...a.recurring_charges[0], amount_monthly: 1400, effective_start: '2027-01-01', effective_end: '2028-12-31' },
    ]
    a.concessions = [{ charge_type: 'rent', period_start: '2027-02-01', period_end: '2027-02-28', kind: 'fixed_amount', value_as_written: '$100.00', value_period: 'month', value: 100, reason: 'Credit', page: 2, quote: 'q', confidence: 1 }]
    const feb = legacyBillingDivergence(a, LEASE_ROW).find((d) => d.period === '2027-02')!
    expect(feb.due).toBeGreaterThan(feb.billed) // the month TOTAL is an under-bill...
    expect(feb.over).toBe(true)                 // ...but rent alone is over-billed
    expect(feb.by_type.find((t) => t.type === 'rent')).toMatchObject({ billed: 8333.33, due: 8233.33 })
    expect(() => buildApprovalPayload(a, inputs({ acknowledgedDivergence: sig(a) }))).toThrow(OverBillingError)
  })

  it('a flat lease with no steps, concessions or ending charges has no divergence', () => {
    const a = revalidateAbstract(abs(), PAGES).abstract
    a.rent_schedule = [{ ...a.rent_schedule[0], end: '2028-12-31' }]
    a.escalation = null
    expect(legacyBillingDivergence(a, LEASE_ROW)).toEqual([])
    expect(() => buildApprovalPayload(a, inputs({ acknowledgedDivergence: null }))).not.toThrow()
  })
})

describe('buildApprovalPayload', () => {
  it('maps the abstract onto tenant, lease, schedule, rule, concessions, charges, provisions and dates', () => {
    const a = revalidateAbstract(abs(), PAGES).abstract
    const p = pay(a, inputs())
    expect(p.tenant).toMatchObject({ mode: 'new', name: 'Acme Fabrication', legal_name: 'Acme Fabrication LLC', entity_type: 'llc', state_of_formation: 'OH' })
    expect(p.lease).toMatchObject({ start_date: '2026-01-01', end_date: '2028-12-31', base_rent_monthly: 8333.33, cam_estimate_monthly: 1250, rent_type: 'nnn', notes: 'Holdover 150%.' })
    expect(p.rent_schedule).toHaveLength(3)
    expect(p.escalation).toMatchObject({ kind: 'fixed_pct', value: 0.03, cadence_months: 12, applies_until: '2028-12-31' })
    expect(p.recurring_charges[0]).toMatchObject({ type: 'cam_estimate', amount_monthly: 1250 })
    expect(p.provisions[0]).toMatchObject({ category: 'renewal_option', notice_deadline: '2028-06-30', exercise_window_start: null, exercise_window_end: null })
    const kinds = p.critical_dates.filter((d) => d.kind !== 'other').map((d) => d.kind)
    expect(kinds).toEqual(['expiration', 'rent_step', 'rent_step'])
  })

  it('starts the lease (and billing) at rent commencement when it is later than commencement', () => {
    const a = abs()
    a.rent_commencement_date = { value: '2026-03-01', page: 1, quote: 'Rent Commencement Date: March 1, 2026', confidence: 1 }
    a.rent_schedule[0].start = '2026-03-01'
    const p = pay(a, inputs())
    expect(p.lease.start_date).toBe('2026-03-01')
    expect(p.critical_dates.some((d) => d.kind === 'other' && d.critical_date === '2026-03-01' && /Rent commencement/.test(d.description))).toBe(true)
  })

  it('normalizes a spelled-out state and drops an unusable one', () => {
    const a = abs()
    a.tenant_state_of_formation = { value: 'Ohio', page: 1, quote: 'q', confidence: 1 }
    expect(pay(a, inputs()).tenant.state_of_formation).toBe('OH')
    a.tenant_state_of_formation = { value: 'Narnia', page: 1, quote: 'q', confidence: 1 }
    expect(pay(a, inputs()).tenant.state_of_formation).toBeNull()
  })

  it('refuses an abstract with no term or no schedule', () => {
    const a = abs()
    a.expiration_date = null
    expect(() => buildApprovalPayload(a, inputs())).toThrow(ApprovalInputError)
    const b = abs()
    b.rent_schedule = []
    expect(() => buildApprovalPayload(b, inputs())).toThrow(ApprovalInputError)
  })

  it('passes the replace choice and the existing-tenant choice through', () => {
    const p = pay(abs(), inputs({ tenant: { mode: 'existing', id: 't-1' }, replace: { lease_id: 'l-1', end_date: '2025-12-31' } }))
    expect(p.tenant).toMatchObject({ mode: 'existing', id: 't-1', legal_name: 'Acme Fabrication LLC' })
    expect(p.replace).toEqual({ lease_id: 'l-1', end_date: '2025-12-31' })
  })
})
