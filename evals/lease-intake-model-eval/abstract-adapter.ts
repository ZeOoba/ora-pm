// Maps a lease abstraction v2 result onto the v1 ground-truth fields so both extractors are scored on
// the same fixtures. Pure; unit-tested in tests/evals/lease-intake-model-eval/abstract-adapter.test.ts.
import type { ExtractedFields } from '../../server/lib/lease-extract'
import type { LeaseAbstract } from '../../server/lib/lease-abstract'

/** v1 fields the abstract does not produce (TI allowance is not billed and not in the 0020 model). */
export const ABSTRACT_SKIPPED_FIELDS = ['ti_allowance'] as const

export function abstractToLegacyFields(a: LeaseAbstract): ExtractedFields {
  const out: ExtractedFields = {}
  const set = (k: string, v: unknown) => { if (v !== null && v !== undefined) out[k] = v }
  set('start_date', a.commencement_date?.value)
  set('end_date', a.expiration_date?.value)
  set('rent_type', a.rent_type?.value)
  set('security_deposit', a.security_deposit?.value)
  set('expense_stop_amount', a.expense_stop_psf_annual?.value)
  // First rent period = the base rent v1 reports; first CAM line = the CAM estimate.
  const firstRent = [...a.rent_schedule].sort((x, y) => x.start.localeCompare(y.start))[0]
  set('base_rent_monthly', firstRent?.base_rent_monthly)
  const firstCam = a.recurring_charges.filter((r) => r.type === 'cam_estimate').sort((x, y) => x.effective_start.localeCompare(y.effective_start))[0]
  set('cam_estimate_monthly', firstCam?.amount_monthly)
  return out
}
