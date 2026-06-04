export interface CAMInput {
  totalRecoverableExpenses: number
  tenantSF: number
  totalLeasedSF: number
  estimatedCamPaid: number
}

export interface CAMOutput {
  tenantProRataSharePct: number
  actualCamOwed: number
  trueUpAmount: number  // positive = tenant owes; negative = credit to tenant
}

export function calculateCAMTrueUp(input: CAMInput): CAMOutput {
  const { totalRecoverableExpenses, tenantSF, totalLeasedSF, estimatedCamPaid } = input

  if (totalLeasedSF === 0) throw new Error('totalLeasedSF cannot be zero')
  if (tenantSF < 0) throw new Error('tenantSF cannot be negative')
  if (tenantSF > totalLeasedSF) throw new Error('tenantSF cannot exceed totalLeasedSF')

  const tenantProRataSharePct = tenantSF / totalLeasedSF
  const actualCamOwed = Math.round(totalRecoverableExpenses * tenantProRataSharePct * 100) / 100
  const trueUpAmount = Math.round((actualCamOwed - estimatedCamPaid) * 100) / 100

  return { tenantProRataSharePct, actualCamOwed, trueUpAmount }
}
