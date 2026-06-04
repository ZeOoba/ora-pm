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

export interface PropertyPeriodSummary {
  propertyName: string
  entityLLC: string
  periodStart: Date
  periodEnd: Date
  baseRentCollected: number
  camCollected: number
  utilityCollected: number
  lateFeeCollected: number
  arAccountName: string
  incomeAccountBase: string
  incomeAccountCAM: string
  incomeAccountUtil: string
  incomeAccountFees: string
}

export function buildPropertyJournalEntry(s: PropertyPeriodSummary): IIFTransaction {
  const total = Math.round((s.baseRentCollected + s.camCollected + s.utilityCollected + s.lateFeeCollected) * 100) / 100
  const label = format(s.periodStart, 'MMM yyyy')
  const docNum = `JE-${format(s.periodStart, 'yyyy-MM')}-${s.propertyName.replace(/\s+/g, '-').slice(0, 20)}`

  const lines: IIFLine[] = [
    { account: s.arAccountName, amount: total, memo: `${label} – ${s.propertyName}` },
  ]

  if (s.baseRentCollected !== 0)
    lines.push({ account: s.incomeAccountBase, amount: -s.baseRentCollected, memo: `Base rent – ${label}` })
  if (s.camCollected !== 0)
    lines.push({ account: s.incomeAccountCAM, amount: -s.camCollected, memo: `CAM – ${label}` })
  if (s.utilityCollected !== 0)
    lines.push({ account: s.incomeAccountUtil, amount: -s.utilityCollected, memo: `Utilities – ${label}` })
  if (s.lateFeeCollected !== 0)
    lines.push({ account: s.incomeAccountFees, amount: -s.lateFeeCollected, memo: `Late fees – ${label}` })

  const totalDebits  = lines.filter(l => l.amount > 0).reduce((s, l) => s + l.amount, 0)
  const totalCredits = Math.abs(lines.filter(l => l.amount < 0).reduce((s, l) => s + l.amount, 0))
  const diff = Math.abs(totalDebits - totalCredits)
  if (diff > 0.01) {
    throw new Error(`Journal entry is unbalanced: debits=${totalDebits.toFixed(2)}, credits=${totalCredits.toFixed(2)}`)
  }

  return { date: s.periodStart, docNum, memo: `${s.propertyName} – ${label}`, lines }
}
