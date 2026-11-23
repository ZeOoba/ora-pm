// A consistent synthetic lease (same text and wire output as tests/lib/lease-abstract.test.ts good())
// finalized into a block-free abstract — the input a reviewer approves in Phase 4.
import { finalizeAbstract, type AbstractResult } from '../../server/lib/lease-abstract'

export const PAGES = [
  'INDUSTRIAL LEASE AGREEMENT\nThis Lease is made between Landlord and Acme Fabrication LLC, an Ohio limited liability company ("Tenant").\nPremises: Suite 100, containing 10,000 rentable square feet.\nCommencement Date: January 1, 2026. Expiration Date: December 31, 2028.',
  'ARTICLE 4 – RENT\nYear 1: $8,333.33 per month ($10.00 per RSF per year).\nYear 2: $8,583.33 per month. Year 3: $8,840.83 per month.\nBase Rent shall increase three percent (3%) annually on each anniversary.\nTenant shall receive fifty percent (50%) abatement of Base Rent for January 2026.\nTenant shall pay estimated CAM of $1,250.00 per month.\nThis is a triple net (NNN) lease.',
  'ARTICLE 30 – RENEWAL\nTenant shall have one option to renew for five (5) years upon written notice no later than June 30, 2028.\nHoldover rent shall be 150% of the Base Rent then in effect.',
]

const src = (page: number, quote: string) => ({ page, quote, confidence: 0.95 })
const fact = (field: string, value: string, page: number, quote: string) => ({ field, value, ...src(page, quote) })
const row = (start: string, end: string, written: string, quote: string) =>
  ({ start, end, amount_as_written: written, amount_period: 'month', ...src(2, quote) })

export function wire() {
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
      fact('rent_type', 'nnn', 2, 'This is a triple net (NNN) lease'),
    ],
    rent_schedule: [
      row('2026-01-01', '2026-12-31', '$8,333.33', 'Year 1: $8,333.33 per month'),
      row('2027-01-01', '2027-12-31', '$8,583.33', 'Year 2: $8,583.33 per month'),
      row('2028-01-01', '2028-12-31', '$8,840.83', 'Year 3: $8,840.83 per month'),
    ],
    escalations: [{ kind: 'fixed_pct', value_as_written: '3%', value_period: 'none', cadence_months: 12, first_adjustment_date: '2027-01-01', cpi_floor: -1, cpi_cap: 0, ...src(2, 'increase three percent (3%) annually') }],
    concessions: [] as Array<Record<string, unknown>>,
    recurring_charges: [{ type: 'cam_estimate', description: 'CAM estimate', amount_as_written: '$1,250.00', amount_period: 'month', effective_start: '2026-01-01', effective_end: '2028-12-31', ...src(2, 'estimated CAM of $1,250.00 per month') }],
    late_fees: [],
    provisions: [{ category: 'renewal_option', summary: 'One 5-year renewal option.', notice_deadline: '2028-06-30', exercise_window_start: '', exercise_window_end: '', ...src(3, 'one option to renew for five (5) years') }],
  }
}

/** The January 2026 50% rent abatement the lease text states (page 2). Flat billing over-bills it. */
export const ABATEMENT = { charge_type: 'rent', period_start: '2026-01-01', period_end: '2026-01-31', kind: 'pct', value_as_written: '50%', value_period: 'none', reason: 'Abatement', ...src(2, 'fifty percent (50%) abatement of Base Rent for January 2026') }

export function reviewed(opts: { abatement?: boolean } = {}): AbstractResult {
  const w = wire()
  if (opts.abatement) w.concessions = [ABATEMENT]
  return finalizeAbstract(w, PAGES)
}

/** The PAGES above as a real text-layer PDF (letter-size pages, one drawn line per text line, small
 *  enough font that no line is clipped), so approval can re-verify quotes against the file itself. */
export async function buildLeasePdf(): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const text of PAGES) {
    const page = doc.addPage([1000, 792])
    text.split('\n').forEach((line, i) => page.drawText(line, { x: 20, y: 760 - i * 14, size: 9, font }))
  }
  return doc.save()
}
