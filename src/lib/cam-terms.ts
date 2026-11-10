// CAM terms of an EXISTING lease, edited in place on Lease Detail (REFUTE M2, 2026-11-10: the create
// form was the only way to enter a stated Proportionate Share or base year, so the leases already in
// the system could not get them without a raw API call). Pure: validation, the percent <-> fraction
// conversion and the PUT payload, so the rules are unit-tested apart from the page.
import type { Lease } from '../types'

export type CamRentType = 'nnn' | 'gross' | 'modified_gross'

/** expenses.category values (0002) — mirrors server/lib/cam.ts EXPENSE_CATEGORIES (pinned equal by
 *  tests/lib/cam-terms.test.ts; the client bundle does not import server code). */
export const CAM_CATEGORIES = ['taxes', 'insurance', 'maintenance', 'utilities', 'management', 'capital', 'other'] as const
export type CamCategory = typeof CAM_CATEGORIES[number]

export const CAM_CATEGORY_LABEL: Record<CamCategory, string> = {
  taxes: 'Real estate taxes',
  insurance: 'Insurance',
  maintenance: 'Maintenance (CAM)',
  utilities: 'Utilities (water / storm / sewer)',
  management: 'Management',
  capital: 'Capital',
  other: 'Other',
}

/** Editor presets (0024). "All" stores NULL: every recoverable expense, the pre-0024 behaviour. */
export const CAM_CATEGORY_PRESETS: { label: string; categories: CamCategory[] | null }[] = [
  { label: 'All recoverable', categories: null },
  { label: 'Taxes only', categories: ['taxes'] },
  { label: 'CAM only (no taxes / insurance)', categories: ['maintenance', 'utilities', 'other'] },
]

export interface CamTermsForm {
  rent_type: CamRentType
  /** Typed as a percent (12.5); stored as a fraction (0.125) in leases.proportionate_share_pct. */
  proportionate_share_percent: string
  base_year: string
  base_year_expense_amount: string
  expense_stop_amount: string
  /** 0024: false = never CAM-reconciled; the reason is then required. */
  cam_reconciled: boolean
  cam_exclusion_reason: string
  /** 0024: null = every recoverable expense; otherwise the categories the lease passes through. */
  recoverable_categories: CamCategory[] | null
  /** 0024: annual $ cap and the last ISO date it applies (blank = none / no end). */
  cam_annual_cap: string
  cam_cap_through: string
  /** As loaded (read-only): which categories the saved base-year amount covers, and that amount.
   *  REFUTE 0024: changing the categories of a base-year lease requires re-entering the amount. */
  saved_base_year_categories: CamCategory[] | null
  saved_base_year_expense_amount: string
}

export type CamTermsErrors = Partial<Record<keyof CamTermsForm, string>>

/** Order-insensitive key for a category set (null = all). */
const categoriesKey = (c: readonly string[] | null) => (c === null ? null : [...c].sort().join(','))

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
function isIsoDate(s: string): boolean {
  const m = ISO_DATE.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
}

/** A stored fraction shown as a percent without float noise (0.1111 -> "11.11", not 11.110000000000001). */
export function fractionToPercentText(f: number | null | undefined): string {
  if (f == null || !Number.isFinite(Number(f))) return ''
  return String(Number((Number(f) * 100).toFixed(6)))
}

export type CamTermsLease = Pick<Lease,
  'rent_type' | 'proportionate_share_pct' | 'base_year' | 'base_year_expense_amount' | 'expense_stop_amount'
  | 'recoverable_categories' | 'base_year_categories' | 'cam_annual_cap' | 'cam_cap_through' | 'cam_reconciled' | 'cam_exclusion_reason'>

export function camTermsFormFromLease(l: CamTermsLease): CamTermsForm {
  const s = (v: number | string | null | undefined) => (v == null ? '' : String(v))
  return {
    rent_type: l.rent_type as CamRentType,
    proportionate_share_percent: fractionToPercentText(l.proportionate_share_pct),
    base_year: s(l.base_year),
    base_year_expense_amount: s(l.base_year_expense_amount),
    expense_stop_amount: s(l.expense_stop_amount),
    // A lease read before 0024 has none of these columns: today's behaviour (reconciled, all).
    cam_reconciled: l.cam_reconciled !== false,
    cam_exclusion_reason: l.cam_exclusion_reason ?? '',
    recoverable_categories: l.recoverable_categories == null ? null : [...l.recoverable_categories] as CamCategory[],
    cam_annual_cap: s(l.cam_annual_cap),
    cam_cap_through: l.cam_cap_through ?? '',
    saved_base_year_categories: l.base_year_categories == null ? null : [...l.base_year_categories] as CamCategory[],
    saved_base_year_expense_amount: s(l.base_year_expense_amount),
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
    e.base_year_expense_amount = 'Required with a base year: that year\'s recoverable total ($) for this lease\'s categories (the whole pool when All)'
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
  // 0024 — same rules as the DB CHECKs and server/lib/cam.ts.
  if (!f.cam_reconciled && f.cam_exclusion_reason.trim() === '') {
    e.cam_exclusion_reason = 'Say why (e.g. tenant pays taxes directly; fixed charge in rent)'
  }
  if (f.recoverable_categories !== null) {
    if (f.recoverable_categories.length === 0) {
      e.recoverable_categories = 'Pick at least one category, or mark the lease not CAM-reconciled'
    } else if (f.recoverable_categories.some((c) => !(CAM_CATEGORIES as readonly string[]).includes(c))
      || new Set(f.recoverable_categories).size !== f.recoverable_categories.length) {
      e.recoverable_categories = 'Unknown or repeated category'
    }
  }
  // REFUTE 0024: the base-year amount is a total for one category set. Changing the categories of a
  // base-year lease without re-entering the amount would compare it against a different pool.
  if (hasBaseYear && !e.base_year_expense_amount && f.base_year_expense_amount.trim() !== ''
    && categoriesKey(f.recoverable_categories) !== categoriesKey(f.saved_base_year_categories)
    && f.base_year_expense_amount.trim() === f.saved_base_year_expense_amount.trim()) {
    e.base_year_expense_amount = 'The recoverable categories changed: re-enter the base-year total for the new categories'
  }
  const hasCap = f.cam_annual_cap.trim() !== ''
  if (hasCap) {
    const cap = Number(f.cam_annual_cap)
    // NUMERIC(12,2): whole cents, above 0, within the column's range.
    if (!(Number.isFinite(cap) && cap > 0 && cap <= 9_999_999_999.99 && Math.abs(Math.round(cap * 100) - cap * 100) < 1e-6)) {
      e.cam_annual_cap = 'Enter a dollar amount above 0 (at most 2 decimals)'
    }
  }
  if (f.cam_cap_through.trim() !== '') {
    if (!isIsoDate(f.cam_cap_through.trim())) e.cam_cap_through = 'Enter a date as YYYY-MM-DD'
    else if (!hasCap) e.cam_cap_through = 'A cap end date needs the annual cap'
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
    recoverable_categories: f.recoverable_categories === null
      ? null
      // Stored in the canonical order so the same set always compares equal.
      : CAM_CATEGORIES.filter((c) => f.recoverable_categories!.includes(c)),
    // The base-year amount covers the categories it was entered with (null = all); none without a base year.
    base_year_categories: f.base_year.trim() === '' || f.recoverable_categories === null
      ? null
      : CAM_CATEGORIES.filter((c) => f.recoverable_categories!.includes(c)),
    cam_annual_cap: num(f.cam_annual_cap),
    cam_cap_through: f.cam_cap_through.trim() === '' ? null : f.cam_cap_through.trim(),
    cam_reconciled: f.cam_reconciled,
    // A reconciled lease keeps no stale exclusion reason.
    cam_exclusion_reason: f.cam_reconciled || f.cam_exclusion_reason.trim() === '' ? null : f.cam_exclusion_reason.trim(),
  }
}
