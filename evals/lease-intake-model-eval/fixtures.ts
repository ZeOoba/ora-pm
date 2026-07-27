// Synthetic lease-document fixtures for the opus-5 vs sonnet-5 intake-accuracy eval.
// Entirely fictional -- no real tenant, property, or deal data (fake company names,
// fake addresses, round-number rents). Ground truth includes ONLY fields the fixture
// text actually states; any field absent from groundTruth is expected to be OMITTED
// by the model, not hallucinated (see score.ts's hallucination tracking).
import type { ExtractedFields } from '../../server/lib/lease-extract'

export interface LeaseFixture {
  id: string
  /** Rationale: what extraction behavior this fixture is designed to probe. */
  probes: string
  /** Plain-text lines rendered into a synthetic single-page PDF (see build-pdf.ts). */
  lines: string[]
  /** Expected extract_lease field values. Fields not listed here must NOT appear
   * in the model's output (a hallucination-detection case, not just an accuracy one). */
  groundTruth: Partial<ExtractedFields>
}

export const FIXTURES: LeaseFixture[] = [
  {
    id: 'clean-nnn',
    probes: 'all 8 fields stated plainly, ISO-formatted dates, NNN rent type — the easy case',
    lines: [
      'INDUSTRIAL LEASE AGREEMENT',
      '',
      'Landlord: Fictional Industrial Holdings LLC',
      'Tenant: Test Fixture Manufacturing Co',
      'Premises: 4400 Sample Parkway, Faketown, OH',
      '',
      'Lease Term: 2026-03-01 to 2031-02-28',
      'Rent Type: NNN (Triple Net)',
      'Base Rent: $8,250.00 per month',
      'CAM Estimate: $612.00 per month',
      'Security Deposit: $16,500.00',
      'Tenant Improvement Allowance: $25,000.00',
      '',
      'Notes: Tenant has one 5-year renewal option at 95% of then-market rent.',
    ],
    groundTruth: {
      start_date: '2026-03-01',
      end_date: '2031-02-28',
      rent_type: 'nnn',
      base_rent_monthly: 8250,
      cam_estimate_monthly: 612,
      security_deposit: 16500,
      ti_allowance: 25000,
    },
  },
  {
    id: 'gross-with-expense-stop',
    probes: 'gross lease with an expense stop instead of CAM/NNN — a less common field combination',
    lines: [
      'OFFICE/FLEX LEASE',
      '',
      'Landlord: Fictional Flex Properties Inc',
      'Tenant: Sample Logistics Partners LLC',
      '',
      'Term Commencement: January 15, 2027',
      'Term Expiration: January 14, 2032',
      'This is a Gross Lease.',
      'Monthly Base Rent: $5,100',
      'Expense Stop: $2.10 per rentable square foot annually, capped operating expense pass-through above $118,000.00 stop amount',
      'Security Deposit equal to one month base rent: $5,100.00',
    ],
    groundTruth: {
      start_date: '2027-01-15',
      end_date: '2032-01-14',
      rent_type: 'gross',
      base_rent_monthly: 5100,
      security_deposit: 5100,
      expense_stop_amount: 118000,
    },
  },
  {
    id: 'modified-gross-percentage-rent',
    probes: 'modified_gross + a percentage-rent clause that should land in notes, not a structured field',
    lines: [
      'RETAIL/FLEX SPACE LEASE',
      '',
      'Landlord: Fictional Retail Centers LP',
      'Tenant: Made-Up Home Goods Outlet LLC',
      '',
      'Lease Dates: 04/01/2026 through 03/31/2029',
      'Rent Structure: Modified Gross (tenant pays own utilities and janitorial; landlord pays taxes/insurance/CAM)',
      'Base Rent: $12,000.00/month',
      'Tenant Improvement Allowance: $40,000.00',
      'Additional Rent: Tenant shall pay percentage rent of 4% of gross sales exceeding $3,000,000 annually.',
    ],
    groundTruth: {
      start_date: '2026-04-01',
      end_date: '2029-03-31',
      rent_type: 'modified_gross',
      base_rent_monthly: 12000,
      ti_allowance: 40000,
      // security_deposit / cam_estimate_monthly / expense_stop_amount: intentionally
      // absent from the document -- must not be hallucinated.
    },
  },
  {
    id: 'sparse-no-deposit-no-ti',
    probes: 'a short, sparse lease abstract missing several fields entirely — the hallucination-risk case',
    lines: [
      'LEASE ABSTRACT — SHORT FORM',
      '',
      'Tenant: Barebones Fixture Storage LLC',
      'Term: 2026-06-01 to 2027-05-31 (one year, no renewal option stated)',
      'Rent Type: NNN',
      'Base Rent: $3,400.00 per month',
      '',
      '(No security deposit, TI allowance, or CAM estimate mentioned anywhere in this abstract.)',
    ],
    groundTruth: {
      start_date: '2026-06-01',
      end_date: '2027-05-31',
      rent_type: 'nnn',
      base_rent_monthly: 3400,
      // security_deposit, cam_estimate_monthly, ti_allowance, expense_stop_amount:
      // must be OMITTED, not guessed at some plausible-looking number.
    },
  },
]
