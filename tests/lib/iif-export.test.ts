import { describe, it, expect } from 'vitest'
import { generateIIF, buildPropertyJournalEntry } from '../../server/lib/iif-export'

describe('generateIIF', () => {
  it('includes required IIF headers', () => {
    const iif = generateIIF([])
    expect(iif).toContain('!TRNS\tTRNSTYPE\tDATE\tACCNT\tAMOUNT\tDOCNUM\tMEMO')
    expect(iif).toContain('!SPL')
    expect(iif).toContain('!ENDTRNS')
  })

  it('generates TRNS and SPL lines for a transaction', () => {
    const tx = {
      date: new Date('2026-06-01'),
      docNum: 'JE-2026-06-TEST',
      memo: 'June 2026',
      lines: [
        { account: 'Accounts Receivable', amount: 5000, memo: 'Rent' },
        { account: 'Rental Income', amount: -5000, memo: 'Base rent' },
      ],
    }
    const iif = generateIIF([tx])
    expect(iif).toContain('TRNS\t')
    expect(iif).toContain('SPL\t')
    expect(iif).toContain('ENDTRNS')
    expect(iif).toContain('5000.00')
    expect(iif).toContain('-5000.00')
  })
})

describe('buildPropertyJournalEntry', () => {
  it('builds a balanced journal entry (debits = credits)', () => {
    const summary = {
      propertyName: 'REDACTED-020',
      entityLLC: 'ORA LLC',
      periodStart: new Date('2026-06-01'),
      periodEnd: new Date('2026-06-30'),
      baseRentCollected: 5000,
      camCollected: 500,
      utilityCollected: 0,
      lateFeeCollected: 0,
      arAccountName: 'Accounts Receivable',
      incomeAccountBase: 'Rental Income:Base Rent',
      incomeAccountCAM: 'Rental Income:CAM',
      incomeAccountUtil: 'Rental Income:Utilities',
      incomeAccountFees: 'Rental Income:Late Fees',
    }
    const tx = buildPropertyJournalEntry(summary)
    const totalDebits  = tx.lines.filter(l => l.amount > 0).reduce((s, l) => s + l.amount, 0)
    const totalCredits = Math.abs(tx.lines.filter(l => l.amount < 0).reduce((s, l) => s + l.amount, 0))
    expect(totalDebits).toBe(totalCredits)
  })
})
