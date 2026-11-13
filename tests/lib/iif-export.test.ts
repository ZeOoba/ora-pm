import { describe, it, expect } from 'vitest'
import { generateIIF, buildPropertyJournalEntry, IIF_AR_ACCOUNT, IIF_CHARGE_ACCOUNTS, UnmappedChargeTypeError } from '../../server/lib/iif-export'
import { CHARGE_TYPES } from '../../server/lib/gl-ar-posting'

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
  const base = { propertyName: '100 Example', periodStart: new Date(2026, 5, 1) }

  it('builds a balanced journal entry (debits = credits)', () => {
    const tx = buildPropertyJournalEntry({ ...base, charges: [{ type: 'rent', amount: 5000 }, { type: 'cam_estimate', amount: 500 }] })
    const totalDebits  = tx.lines.filter(l => l.amount > 0).reduce((s, l) => s + l.amount, 0)
    const totalCredits = Math.abs(tx.lines.filter(l => l.amount < 0).reduce((s, l) => s + l.amount, 0))
    expect(totalDebits).toBe(5500)
    expect(totalCredits).toBe(5500)
  })

  it('credits a security deposit to the deposit liability account, never to income', () => {
    const tx = buildPropertyJournalEntry({ ...base, charges: [{ type: 'security_deposit', amount: 2500 }] })
    expect(tx.lines).toEqual([
      expect.objectContaining({ account: IIF_AR_ACCOUNT, amount: 2500 }),
      expect.objectContaining({ account: 'Security Deposits Held', amount: -2500 }),
    ])
    expect(IIF_CHARGE_ACCOUNTS.security_deposit.account).not.toMatch(/income/i)
  })

  it('sums in integer cents (no float drift) and accepts NUMERIC-as-string amounts', () => {
    const charges = Array.from({ length: 10 }, () => ({ type: 'other', amount: '0.10' }))
    const tx = buildPropertyJournalEntry({ ...base, charges })
    expect(tx.lines[0].amount).toBe(1)
    expect(tx.lines[1]).toMatchObject({ account: 'Rental Income:Other', amount: -1 })
  })

  it('throws UnmappedChargeTypeError naming every unmapped type, instead of dropping them', () => {
    expect(() => buildPropertyJournalEntry({ ...base, charges: [{ type: 'rent', amount: 1 }, { type: 'zz', amount: 1 }, { type: 'aa', amount: 1 }] }))
      .toThrow(UnmappedChargeTypeError)
    try {
      buildPropertyJournalEntry({ ...base, charges: [{ type: 'zz', amount: 1 }, { type: 'aa', amount: 1 }] })
    } catch (e) {
      expect((e as UnmappedChargeTypeError).types).toEqual(['aa', 'zz'])
    }
  })

  it('does not treat inherited object keys as mapped types', () => {
    expect(() => buildPropertyJournalEntry({ ...base, charges: [{ type: 'toString', amount: 1 }] })).toThrow(UnmappedChargeTypeError)
  })

  it('maps exactly the GL CHARGE_TYPES list (server/lib/gl-ar-posting.ts)', () => {
    expect(Object.keys(IIF_CHARGE_ACCOUNTS).sort()).toEqual([...CHARGE_TYPES].sort())
  })
})
