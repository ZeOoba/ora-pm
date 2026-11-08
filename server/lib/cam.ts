export type CAMRentType = 'nnn' | 'gross' | 'modified_gross'

export interface CAMInput {
  totalRecoverableExpenses: number
  tenantSF: number
  totalLeasedSF: number
  estimatedCamPaid: number
  /** leases.rent_type. Omitted = 'nnn' (the pre-fix behaviour, kept for existing callers). */
  rentType?: CAMRentType
  /** leases.expense_stop_amount: $/SF per year (LeaseForm "Expense Stop ($/SF)"). */
  expenseStopPerSF?: number | null
}

/** How actualCamOwed was derived — persisted context for a human reviewing the draft. */
export type CAMRecoveryBasis = 'full_pro_rata' | 'above_expense_stop' | 'none_gross'

export interface CAMOutput {
  tenantProRataSharePct: number
  actualCamOwed: number
  trueUpAmount: number  // positive = tenant owes; negative = credit to tenant
  recoveryBasis: CAMRecoveryBasis
}

/** Lease terms make a recovery uncomputable (e.g. modified_gross with no expense stop). Callers map
 *  this to a 422: it is a lease-data problem a human must fix, not a server error. */
export class CAMTermsError extends Error {}

/**
 * CAM true-up for one lease.
 *
 * Recovery by rent type (audit finding cam-ignores-rent-type-expense-stop), using the schema's own
 * fields — leases.rent_type IN ('nnn','gross','modified_gross') and leases.expense_stop_amount
 * ($/SF/yr, entered "for gross / modified-gross leases"):
 *   - nnn:            full pro-rata share of recoverable expenses. A stop, if present, is ignored.
 *   - modified_gross: only the share ABOVE the stop: max(0, share - stop x tenantSF). A null stop
 *                     fails closed (CAMTermsError): without it the recoverable amount is unknown.
 *   - gross, stop set: same above-stop recovery as modified_gross.
 *   - gross, no stop: full-service gross: recovers nothing (owed 0; any CAM estimate that was billed
 *                     comes back as a credit through the negative true-up).
 * `tenantSF` is the SF the stop is applied to, so a caller that occupancy-weights tenantSF for a
 * partial year prorates the stop by the same factor.
 * Base-year stops, CAM caps, admin-fee and gross-up provisions are NOT modelled: the schema has no
 * fields for them.
 */
export function calculateCAMTrueUp(input: CAMInput): CAMOutput {
  const { totalRecoverableExpenses, tenantSF, totalLeasedSF, estimatedCamPaid } = input
  const rentType: CAMRentType = input.rentType ?? 'nnn'
  const stop = input.expenseStopPerSF ?? null

  if (totalLeasedSF === 0) throw new Error('totalLeasedSF cannot be zero')
  if (tenantSF < 0) throw new Error('tenantSF cannot be negative')
  if (tenantSF > totalLeasedSF) throw new Error('tenantSF cannot exceed totalLeasedSF')
  if (stop !== null && (!Number.isFinite(stop) || stop < 0)) {
    throw new CAMTermsError('Lease expense stop must be a non-negative $/SF amount')
  }

  const tenantProRataSharePct = tenantSF / totalLeasedSF
  const share = totalRecoverableExpenses * tenantProRataSharePct

  let owed: number
  let recoveryBasis: CAMRecoveryBasis
  if (rentType === 'nnn') {
    owed = share
    recoveryBasis = 'full_pro_rata'
  } else if (stop !== null) {
    owed = Math.max(0, share - stop * tenantSF)
    recoveryBasis = 'above_expense_stop'
  } else if (rentType === 'modified_gross') {
    throw new CAMTermsError(
      'Modified-gross lease has no expense stop set — the recoverable amount cannot be computed. '
      + 'Enter the lease\'s expense stop ($/SF) and recalculate.'
    )
  } else {
    owed = 0
    recoveryBasis = 'none_gross'
  }

  const actualCamOwed = Math.round(owed * 100) / 100
  const trueUpAmount = Math.round((actualCamOwed - estimatedCamPaid) * 100) / 100

  return { tenantProRataSharePct, actualCamOwed, trueUpAmount, recoveryBasis }
}
