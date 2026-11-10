// CAM terms of an EXISTING lease, edited in place on Lease Detail (REFUTE M2, 2026-11-10: the create
// form was the only way to enter a stated Proportionate Share or base year, so the leases already in
// the system could not get them without a raw API call). Pure: validation, the percent <-> fraction
// conversion and the PUT payload, so the rules are unit-tested apart from the page.
import type { Lease } from '../types'

export type CamRentType = 'nnn' | 'gross' | 'modified_gross'

export interface CamTermsForm {
  rent_type: CamRentType
  /** Typed as a percent (12.5); stored as a fraction (0.125) in leases.proportionate_share_pct. */
  proportionate_share_percent: string
  base_year: string
  base_year_expense_amount: string
  expense_stop_amount: string
}

export type CamTermsErrors = Partial<Record<keyof CamTermsForm, string>>

/** A stored fraction shown as a percent without float noise (0.1111 -> "11.11", not 11.110000000000001). */
export function fractionToPercentText(f: number | null | undefined): string {
  if (f == null || !Number.isFinite(Number(f))) return ''
  return String(Number((Number(f) * 100).toFixed(6)))
}

export function camTermsFormFromLease(l: Pick<Lease, 'rent_type' | 'proportionate_share_pct' | 'base_year' | 'base_year_expense_amount' | 'expense_stop_amount'>): CamTermsForm {
  const s = (v: number | null | undefined) => (v == null ? '' : String(v))
  return {
    rent_type: l.rent_type as CamRentType,
    proportionate_share_percent: fractionToPercentText(l.proportionate_share_pct),
    base_year: s(l.base_year),
    base_year_expense_amount: s(l.base_year_expense_amount),
    expense_stop_amount: s(l.expense_stop_amount),
  }
}

/** Same rules as the create form and the DB CHECKs (0021): share in (0,100] %, base year 1900-2200,
 *  amounts >= 0, a base-year amount needs its base year, modified gross needs an expense stop, and a
 *  base year cannot be combined with an expense stop (the engine refuses that pair). */
export function validateCamTerms(f: CamTermsForm): CamTermsErrors {
  const e: CamTermsErrors = {}
  const hasBaseYear = f.base_year.trim() !== ''
  if (f.proportionate_share_percent.trim() !== '') {
    const pct = Number(f.proportionate_share_percent)
    // REFUTE D4: the payload rounds the fraction to 8 dp; a share that rounds to 0 would 422.
    if (!(Number.isFinite(pct) && pct > 0 && pct <= 100 && Number((pct / 100).toFixed(8)) > 0)) {
      e.proportionate_share_percent = 'Enter a percent above 0 and at most 100'
    }
  }
  if (hasBaseYear) {
    const y = Number(f.base_year)
    if (!(Number.isInteger(y) && y >= 1900 && y <= 2200)) e.base_year = 'Enter a calendar year, e.g. 2026'
  }
  if (f.base_year_expense_amount.trim() !== '') {
    const amt = Number(f.base_year_expense_amount)
    if (!(Number.isFinite(amt) && amt >= 0)) e.base_year_expense_amount = 'Must be ≥ 0'
    else if (!hasBaseYear) e.base_year = 'Required when a base-year amount is entered'
    // REFUTE C6: the engine refuses a $0 base amount against any non-zero pool (the 3x plausibility
    // guard), so a $0 here would only fail later, at CAM time.
    else if (amt === 0) e.base_year_expense_amount = 'A base year needs that year\'s recoverable total above $0'
  } else if (hasBaseYear) {
    // REFUTE C6: the engine refuses a base year with no amount; say so now, not at reconciliation.
    e.base_year_expense_amount = 'Required with a base year: that year\'s whole-pool recoverable total ($)'
  }
  if (f.expense_stop_amount.trim() !== '') {
    const stop = Number(f.expense_stop_amount)
    if (!(Number.isFinite(stop) && stop >= 0)) e.expense_stop_amount = 'Must be ≥ 0'
    else if (hasBaseYear) e.expense_stop_amount = 'A lease uses a base year or an expense stop, not both'
  }
  // Modified gross recovers above an expense stop OR above a base year (the engine accepts either);
  // with neither there is nothing to recover above.
  if (f.rent_type === 'modified_gross' && f.expense_stop_amount.trim() === '' && !hasBaseYear && !e.expense_stop_amount) {
    e.expense_stop_amount = 'Modified gross needs an expense stop ($/SF/yr) or a base year'
  }
  return e
}

/** PUT /api/leases/:id body. Blank clears the field (null); the share goes back to a fraction. */
export function camTermsPayload(f: CamTermsForm) {
  const num = (v: string) => (v.trim() === '' ? null : Number(v))
  const pct = num(f.proportionate_share_percent)
  return {
    rent_type: f.rent_type,
    proportionate_share_pct: pct === null ? null : Number((pct / 100).toFixed(8)),
    base_year: num(f.base_year),
    base_year_expense_amount: num(f.base_year_expense_amount),
    expense_stop_amount: num(f.expense_stop_amount),
  }
}
