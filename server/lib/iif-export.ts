import { format } from 'date-fns'

export interface IIFLine {
  account: string
  amount: number   // positive = debit, negative = credit
  memo: string
}

export interface IIFTransaction {
  date: Date
  docNum: string
  memo: string
  lines: IIFLine[]
}

export function generateIIF(transactions: IIFTransaction[]): string {
  const out: string[] = [
    '!TRNS\tTRNSTYPE\tDATE\tACCNT\tAMOUNT\tDOCNUM\tMEMO',
    '!SPL\tTRNSTYPE\tDATE\tACCNT\tAMOUNT\tDOCNUM\tMEMO',
    '!ENDTRNS',
  ]

  for (const tx of transactions) {
    const d = format(tx.date, 'MM/dd/yyyy')
    const debits  = tx.lines.filter(l => l.amount > 0)
    const credits = tx.lines.filter(l => l.amount < 0)

    if (debits.length === 0 || credits.length === 0) continue

    // IIF: first debit is the TRNS line; all credits + additional debits are SPL lines
    const [mainDebit, ...additionalDebits] = debits
    out.push(`TRNS\tGENERAL JOURNAL\t${d}\t${mainDebit.account}\t${mainDebit.amount.toFixed(2)}\t${tx.docNum}\t${tx.memo}`)
    for (const cr of credits) {
      out.push(`SPL\tGENERAL JOURNAL\t${d}\t${cr.account}\t${cr.amount.toFixed(2)}\t${tx.docNum}\t${cr.memo}`)
    }
    for (const dr of additionalDebits) {
      out.push(`SPL\tGENERAL JOURNAL\t${d}\t${dr.account}\t${dr.amount.toFixed(2)}\t${tx.docNum}\t${dr.memo}`)
    }
    out.push('ENDTRNS')
  }

  return out.join('\n')
}

// Every charges.type (the CHECK in supabase/migrations/0002_financial_tables.sql) mapped to the
// QuickBooks account its amount is credited to. The AR debit is the sum of ALL charges, so a type
// missing here used to vanish from both sides and leave a balanced but understated entry (audit
// 2026-11-12 #2: percentage_rent, other — tax/insurance escrows, manual adjustments — and
// security_deposit). Now an unmapped type refuses the export (UnmappedChargeTypeError).
//
// security_deposit is NOT income: it is credited to a deposit liability account. Order here is the
// order of the SPL lines in the file. Account names must exist in the QuickBooks chart the IIF is
// imported into (QuickBooks Desktop creates an unknown account on import rather than failing).
export const IIF_AR_ACCOUNT = 'Accounts Receivable'
export const IIF_CHARGE_ACCOUNTS = {
  rent:             { account: 'Rental Income:Base Rent',       memo: 'Base rent' },
  cam_estimate:     { account: 'Rental Income:CAM',             memo: 'CAM' },
  cam_true_up:      { account: 'Rental Income:CAM',             memo: 'CAM' },
  utility_water:    { account: 'Rental Income:Utilities',       memo: 'Utilities' },
  utility_gas:      { account: 'Rental Income:Utilities',       memo: 'Utilities' },
  utility_electric: { account: 'Rental Income:Utilities',       memo: 'Utilities' },
  utility_other:    { account: 'Rental Income:Utilities',       memo: 'Utilities' },
  percentage_rent:  { account: 'Rental Income:Percentage Rent', memo: 'Percentage rent' },
  late_fee:         { account: 'Rental Income:Late Fees',       memo: 'Late fees' },
  other:            { account: 'Rental Income:Other',           memo: 'Other charges' },
  security_deposit: { account: 'Security Deposits Held',        memo: 'Security deposits' },
} as const satisfies Record<string, { account: string; memo: string }>

export type IifChargeType = keyof typeof IIF_CHARGE_ACCOUNTS

export class UnmappedChargeTypeError extends Error {
  constructor(public readonly types: string[]) {
    super(`No QuickBooks account mapping for charge type(s): ${types.join(', ')} — export refused rather than dropping them`)
    this.name = 'UnmappedChargeTypeError'
  }
}

export interface PropertyChargesPeriod {
  propertyName: string
  periodStart: Date
  /** Live (non-voided) charges of the period. amount is dollars; PostgREST may send NUMERIC as a string. */
  charges: { type: string; amount: number | string }[]
}

function toCents(amount: number | string): number {
  const n = Number(amount)
  if (!Number.isFinite(n)) throw new Error(`Charge amount is not a number: ${String(amount)}`)
  return Math.round(n * 100)
}

/** One journal entry for a property-period: AR debit = every charge; one credit per mapped account. */
export function buildPropertyJournalEntry(p: PropertyChargesPeriod): IIFTransaction {
  const unmapped = [...new Set(p.charges.map(c => c.type).filter(t => !Object.hasOwn(IIF_CHARGE_ACCOUNTS, t)))]
  if (unmapped.length > 0) throw new UnmappedChargeTypeError(unmapped.sort())

  const label = format(p.periodStart, 'MMM yyyy')
  const docNum = `JE-${format(p.periodStart, 'yyyy-MM')}-${p.propertyName.replace(/\s+/g, '-').slice(0, 20)}`

  // Integer cents throughout: summing dollar floats drifts by a cent on long charge lists.
  let totalCents = 0
  const centsByAccount = new Map<string, { cents: number; memo: string }>()
  for (const { account, memo } of Object.values(IIF_CHARGE_ACCOUNTS)) {
    if (!centsByAccount.has(account)) centsByAccount.set(account, { cents: 0, memo })
  }
  for (const c of p.charges) {
    const cents = toCents(c.amount)
    totalCents += cents
    centsByAccount.get(IIF_CHARGE_ACCOUNTS[c.type as IifChargeType].account)!.cents += cents
  }

  const lines: IIFLine[] = [
    { account: IIF_AR_ACCOUNT, amount: totalCents / 100, memo: `${label} – ${p.propertyName}` },
  ]
  let creditCents = 0
  for (const [account, { cents, memo }] of centsByAccount) {
    if (cents === 0) continue
    creditCents += cents
    lines.push({ account, amount: -cents / 100, memo: `${memo} – ${label}` })
  }

  if (creditCents !== totalCents) {
    throw new Error(`Journal entry is unbalanced: debits=${(totalCents / 100).toFixed(2)}, credits=${(creditCents / 100).toFixed(2)}`)
  }

  return { date: p.periodStart, docNum, memo: `${p.propertyName} – ${label}`, lines }
}
