// Pure helpers for the lease-abstract review screen (AbstractReview.tsx). Types mirror
// server/lib/lease-abstract.ts (the UI does not import server code).

export type Cited<T> = { value: T; page: number; quote: string; confidence: number } | null
export interface RentRow { start: string; end: string; amount_as_written: string; amount_period: 'month' | 'year' | 'psf_year'; base_rent_monthly: number | null; rent_psf_annual: number | null; page: number; quote: string; confidence: number }
export interface Escalation { kind: 'fixed_pct' | 'fixed_amount' | 'cpi'; value_as_written: string; value_period: string; value: number | null; cadence_months: number; first_adjustment_date: string; cpi_floor: number | null; cpi_cap: number | null; page: number; quote: string; confidence: number }
export interface Concession { charge_type: 'rent' | 'cam_estimate' | 'all'; period_start: string; period_end: string; kind: 'full_waiver' | 'pct' | 'fixed_amount'; value_as_written: string; value_period: string; value: number | null; reason: string; page: number; quote: string; confidence: number }
export interface Recurring { type: string; description: string; amount_as_written: string; amount_period: 'month' | 'year'; amount_monthly: number | null; effective_start: string; effective_end: string; page: number; quote: string; confidence: number }
export interface LateFee { amount: number | null; pct: number | null; grace_days: number | null; page: number; quote: string; confidence: number }
export interface Provision { category: string; summary: string; notice_deadline: string | null; exercise_window_start: string | null; exercise_window_end: string | null; page: number; quote: string; confidence: number }

export interface LeaseAbstract {
  tenant_legal_name: Cited<string>; tenant_dba: Cited<string>; tenant_entity_type: Cited<string>; tenant_state_of_formation: Cited<string>
  notice_address: Cited<string>; guarantor_name: Cited<string>; premises_suite: Cited<string>; premises_rsf: Cited<number>
  pro_rata_share: Cited<number>; execution_date: Cited<string>; commencement_date: Cited<string>; rent_commencement_date: Cited<string>
  expiration_date: Cited<string>; rent_type: Cited<string>; security_deposit: Cited<number>; expense_stop_psf_annual: Cited<number>
  base_year: Cited<number>; cam_cap_pct: Cited<number>; admin_fee_pct: Cited<number>; holdover_rent_multiplier: Cited<number>
  rent_schedule: RentRow[]; escalation: Escalation | null; concessions: Concession[]; recurring_charges: Recurring[]
  late_fee: LateFee | null; provisions: Provision[]
}
export interface Flag { severity: 'block' | 'warn'; path: string; message: string }
export interface Confirmation {
  path: string; as_written: string; period: string; monthly: number | null; start: string | null; end: string | null
  charge: string | null; rsf: number | null; first_adjustment_date: string | null; cadence_months: number | null; page: number; quote: string
}

/** Suffix marking a value the reviewer typed (server: lease-abstract.ts REVIEWER_QUOTE_SUFFIX). Such a
 *  value is exempt from the quote-on-page check, warned, and still needs its confirmation ticked. */
export const REVIEWER_QUOTE_SUFFIX = ' [entered by reviewer]'
export const REVIEWER_QUOTE = (v: string) => `${v}${REVIEWER_QUOTE_SUFFIX}`

/** Content identity of a confirmation, byte-identical to server lease-abstract.ts confirmationKey (parity
 *  test in tests/pages/abstract-review.test.tsx). Approval matches ticks by this key, so an unchanged value
 *  stays confirmed after a re-check and any change needs a fresh tick. */
export function confirmationKey(c: Confirmation): string {
  return [c.path, c.as_written, c.period, c.monthly, c.start, c.end, c.charge, c.rsf, c.first_adjustment_date, c.cadence_months, c.page, c.quote].join('|')
}

export interface Divergence { period: string; billed: number; due: number; by_type: Array<{ type: string; billed: number; due: number }>; over: boolean }

/** Set a cited scalar to a reviewer-entered value (null clears it). */
export function setCited<T>(v: T | null, prev: Cited<T>): Cited<T> {
  if (v === null || v === '' || (typeof v === 'number' && Number.isNaN(v))) return null
  return { value: v, page: prev?.page ?? 1, quote: REVIEWER_QUOTE(String(v)), confidence: 1 }
}

const pct = (x: number) => `${Math.round(x * 10000) / 100}%`
const LABEL: Record<string, string> = {
  renewal_option: 'Renewal option', expansion: 'Expansion', rofr_rofo: 'ROFR / ROFO', termination: 'Termination',
  exclusive_use: 'Exclusive use', permitted_use: 'Permitted use', signage: 'Signage', parking: 'Parking',
  assignment_sublet: 'Assignment / sublet', insurance_req: 'Insurance requirements', maintenance_split: 'Maintenance',
  hvac: 'HVAC', holdover: 'Holdover', late_fee: 'Late fee', guaranty: 'Guaranty', relocation: 'Relocation', other: 'Other',
}
export const provisionLabel = (c: string) => LABEL[c] ?? c

/** Default lease notes: every term the PM record has no column for, so nothing in the abstract is lost. */
export function defaultLeaseNotes(a: LeaseAbstract, filename: string): string {
  const lines: string[] = [`Abstracted from "${filename}".`]
  if (a.execution_date) lines.push(`Executed: ${a.execution_date.value}.`)
  if (a.commencement_date && a.rent_commencement_date && a.rent_commencement_date.value !== a.commencement_date.value) {
    lines.push(`Lease commencement ${a.commencement_date.value}; rent commencement ${a.rent_commencement_date.value}.`)
  }
  if (a.premises_suite || a.premises_rsf) lines.push(`Premises: ${[a.premises_suite && `Suite ${a.premises_suite.value}`, a.premises_rsf && `${a.premises_rsf.value.toLocaleString()} RSF`].filter(Boolean).join(', ')}.`)
  if (a.guarantor_name) lines.push(`Guarantor: ${a.guarantor_name.value}.`)
  if (a.escalation) {
    const e = a.escalation
    lines.push(`Escalation: ${e.kind === 'cpi' ? 'CPI' : e.value_as_written} every ${e.cadence_months} months from ${e.first_adjustment_date}${e.kind === 'cpi' && e.cpi_cap ? `, cap ${pct(e.cpi_cap)}` : ''}${e.kind === 'cpi' && e.cpi_floor !== null ? `, floor ${pct(e.cpi_floor)}` : ''}.`)
  }
  if (a.cam_cap_pct) lines.push(`CAM cap: ${pct(a.cam_cap_pct.value)} per year.`)
  if (a.admin_fee_pct) lines.push(`Admin fee: ${pct(a.admin_fee_pct.value)}.`)
  if (a.holdover_rent_multiplier) lines.push(`Holdover: ${Math.round(a.holdover_rent_multiplier.value * 100)}% of rent then in effect.`)
  if (a.late_fee) {
    const f = a.late_fee
    const parts = [f.amount ? `$${f.amount.toFixed(2)}` : null, f.pct ? pct(f.pct) : null].filter(Boolean).join(' or ')
    lines.push(`Late fee: ${parts || 'per lease'}${f.grace_days !== null ? ` after ${f.grace_days}-day grace` : ''}.`)
  }
  for (const c of a.concessions) lines.push(`Concession (${c.charge_type}, ${c.period_start} to ${c.period_end}): ${c.reason}${c.value_as_written ? ` (${c.value_as_written})` : ''}.`)
  if (a.provisions.length > 0) {
    lines.push('', 'Rights & rules:')
    for (const p of a.provisions) {
      const dl = p.notice_deadline ? ` Notice by ${p.notice_deadline}.` : ''
      lines.push(`- ${provisionLabel(p.category)}: ${p.summary}${dl} (p. ${p.page})`)
    }
  }
  return lines.join('\n')
}

/** Day before an ISO date (prior tenant's default end date when replaced). */
export function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

export const money = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
