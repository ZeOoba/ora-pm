// Helpers for Books › AR posting (kept apart from the page for react-refresh).
export const AR_ROLE_LABELS: { role: string; label: string; type: 'asset' | 'liability' | 'income' }[] = [
  { role: 'ar', label: 'Accounts receivable', type: 'asset' },
  { role: 'undeposited_funds', label: 'Undeposited funds', type: 'asset' },
  { role: 'security_deposit', label: 'Security deposits held', type: 'liability' },
  { role: 'prepaid_rent', label: 'Prepaid rent (tenant credits)', type: 'liability' },
  { role: 'rent', label: 'Rent', type: 'income' },
  { role: 'cam_estimate', label: 'CAM estimates', type: 'income' },
  { role: 'cam_true_up', label: 'CAM true-ups', type: 'income' },
  { role: 'late_fee', label: 'Late fees', type: 'income' },
  { role: 'utility_water', label: 'Utility — water', type: 'income' },
  { role: 'utility_gas', label: 'Utility — gas', type: 'income' },
  { role: 'utility_electric', label: 'Utility — electric', type: 'income' },
  { role: 'utility_other', label: 'Utility — other', type: 'income' },
  { role: 'percentage_rent', label: 'Percentage rent', type: 'income' },
  { role: 'other', label: 'Other charges', type: 'income' },
  // 0032: cash-basis only; unmapped, it posts to the Rent account.
  { role: 'balance_forward', label: 'Balance forward from QuickBooks (defaults to Rent)', type: 'income' },
]

/** The roles an LLC's basis uses: accrual books AR; cash books tenant credits as prepaid rent. */
export function rolesForBasis(basis: 'accrual' | 'cash') {
  return AR_ROLE_LABELS.filter((r) => (basis === 'cash' ? r.role !== 'ar' : r.role !== 'prepaid_rent' && r.role !== 'balance_forward'))
}

export const KIND_LABELS: Record<string, string> = {
  charge: 'Charge',
  charge_void: 'Charge void',
  charge_void_pre: 'Void (opening AR)',
  payment: 'Payment',
  payment_return: 'ACH return',
  payment_return_pre: 'ACH return (opening AR)',
}

/** Today's date in US Central (the ledger's calendar), YYYY-MM-DD. */
export function centralToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** Signed cents as dollars, debits positive: "$1,000.00" / "−$1,000.00". */
export function signedDollars(cents: number): string {
  const s = `$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return cents < 0 ? `−${s}` : s
}
