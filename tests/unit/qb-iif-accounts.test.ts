import { describe, it, expect } from 'vitest'
import { MAX_IIF_CHARS, MAX_IIF_ERRORS, QB_ACCOUNT_TYPES, parseIifAccounts, planAccountImport, type ExistingAccount } from '../../server/lib/qb-iif-accounts'

// Column order as QuickBooks Desktop writes the !ACCNT header in a Lists → Chart of Accounts IIF
// export. The parser reads columns by header NAME, so order does not matter (tested below).
const HDR = ['!ACCNT', 'NAME', 'REFNUM', 'TIMESTAMP', 'ACCNTTYPE', 'OBAMOUNT', 'DESC', 'ACCNUM', 'SCD', 'BANKNUM', 'EXTRA', 'HIDDEN', 'DELCOUNT', 'USEID']
const row = (name: string, type: string, num = '', hidden = 'N') =>
  ['ACCNT', name, '1', '0', type, '0.00', '', num, '0', '', '', hidden, '0', 'N'].join('\t')
const iif = (...rows: string[]) => [HDR.join('\t'), ...rows].join('\r\n') + '\r\n'

const SAMPLE = iif(
  row('Operating Cash', 'BANK', '1000'),
  row('Accounts Receivable', 'AR', '1200'),
  row('Security Deposits Held', 'OCLIAB', '2100'),
  row('Mortgage Payable', 'LTLIAB', '2500'),
  row("Members' Equity", 'EQUITY', '3000'),
  row('Rental Income', 'INC', '4000'),
  row('Rental Income:Base Rent', 'INC', '4010'),
  row('Rental Income:CAM Recoveries', 'INC', '4020'),
  row('Repairs', 'EXP', '6100'),
  row('Old Repairs', 'EXP', '6190', 'Y'),
  row('Estimates', 'NONPOSTING'),
)

describe('parseIifAccounts', () => {
  it('reads a QuickBooks Desktop chart: names, numbers, QB and ledger types, active flag', () => {
    const p = parseIifAccounts(SAMPLE)
    expect(p.errors).toEqual([])
    expect(p.accounts.map((a) => [a.qb_name, a.number, a.qb_account_type, a.account_type, a.is_active])).toEqual([
      ['Operating Cash', '1000', 'BANK', 'asset', true],
      ['Accounts Receivable', '1200', 'AR', 'asset', true],
      ['Security Deposits Held', '2100', 'OCLIAB', 'liability', true],
      ['Mortgage Payable', '2500', 'LTLIAB', 'liability', true],
      ["Members' Equity", '3000', 'EQUITY', 'equity', true],
      ['Rental Income', '4000', 'INC', 'income', true],
      ['Rental Income:Base Rent', '4010', 'INC', 'income', true],
      ['Rental Income:CAM Recoveries', '4020', 'INC', 'income', true],
      ['Repairs', '6100', 'EXP', 'expense', true],
      ['Old Repairs', '6190', 'EXP', 'expense', false],
    ])
    expect(p.skipped).toEqual([{ line: 12, qb_name: 'Estimates', reason: 'non-posting (estimates / purchase orders)' }])
  })

  it('maps every posting QB type to the right statement side', () => {
    expect(QB_ACCOUNT_TYPES).toEqual({
      BANK: 'asset', AR: 'asset', OCASSET: 'asset', FIXASSET: 'asset', OASSET: 'asset',
      AP: 'liability', CCARD: 'liability', OCLIAB: 'liability', LTLIAB: 'liability',
      EQUITY: 'equity', INC: 'income', EXINC: 'income', COGS: 'expense', EXP: 'expense', EXEXP: 'expense',
    })
  })

  it('reads columns by header name, unquotes QB-quoted fields, accepts LF and a BOM, ignores other lists', () => {
    const text = '\uFEFF!CUST\tNAME\nCUST\tAcme\n!ACCNT\tACCNTTYPE\tACCNUM\tNAME\nACCNT\tbank\t"1000"\t"Cash ""Main"""\nACCNT\tINC\t\tRent\n'
    const p = parseIifAccounts(text)
    expect(p.errors).toEqual([])
    expect(p.accounts.map((a) => [a.qb_name, a.number, a.qb_account_type])).toEqual([['Cash "Main"', '1000', 'BANK'], ['Rent', null, 'INC']])
  })

  it.each([
    ['no !ACCNT header', '!CUST\tNAME\nCUST\tAcme\n', /no chart of accounts/],
    ['ACCNT before its header', 'ACCNT\tCash\tBANK\n!ACCNT\tNAME\tACCNTTYPE\n', /before its !ACCNT header/],
    ['unknown type', iif(row('Cash', 'SAVINGS')), /unknown QuickBooks account type "SAVINGS"/],
    ['blank type', iif(row('Cash', '')), /unknown QuickBooks account type "\(blank\)"/],
    ['missing name', iif(row('', 'BANK')), /has no NAME/],
    ['empty Parent:Child part', iif(row('Income:', 'INC')), /empty part/],
    ['duplicate name (case-insensitive)', iif(row('Cash', 'BANK'), row('cash', 'BANK')), /repeats line 2/],
    ['duplicate number', iif(row('Cash', 'BANK', '1000'), row('Savings', 'BANK', '1000')), /number 1000 is also used by "Cash"/],
    ['orphan sub-account', iif(row('Income:Rent', 'INC')), /has no parent "Income"/],
    ['sub-account on the other statement side', iif(row('Repairs', 'EXP'), row('Repairs:Refund', 'INC')), /is income but its parent is expense/],
    ['over-long number', iif(row('Cash', 'BANK', '1'.repeat(41))), /longer than 40/],
  ])('rejects %s', (_n, text, re) => {
    const p = parseIifAccounts(text)
    expect(p.errors.join('\n')).toMatch(re)
  })

  it('REFUTE F2: a short row (line break inside a field) is rejected, never imported without its number or hidden flag', () => {
    const p = parseIifAccounts(iif('ACCNT\tChecking\t1\t0\tBANK\t0.00\t"a', 'b"\t1000\t0\t\t\tY\t0\tN'))
    expect(p.accounts).toEqual([])
    expect(p.errors[0]).toMatch(/row has 7 fields but the header needs 12 \(a field may contain a line break/)
  })

  it('REFUTE N1: HIDDEN must be Y, N or empty', () => {
    expect(parseIifAccounts(iif(row('Cash', 'BANK', '1000', 'YES'))).errors[0]).toMatch(/HIDDEN "YES"; QuickBooks writes Y or N/)
    expect(parseIifAccounts(iif(row('Cash', 'BANK', '1000', ''))).accounts[0].is_active).toBe(true)
  })

  it('REFUTE N2: no spaces around name parts; a sub-account must spell its parent exactly', () => {
    expect(parseIifAccounts(iif(row('"Rent "', 'INC'))).errors[0]).toMatch(/spaces at the start or end/)
    expect(parseIifAccounts(iif(row('Rent', 'INC'), row('Rent: Base', 'INC'))).errors[0]).toMatch(/spaces at the start or end/)
    expect(parseIifAccounts(iif(row('Utilities', 'EXP'), row('UTILITIES:Water', 'EXP'))).errors[0]).toMatch(/spells its parent differently from "Utilities"/)
  })

  it('REFUTE F1: a huge header and many bad rows stay cheap and return a capped error list', () => {
    const hdr = '!ACCNT\t' + 'X\t'.repeat(50_000) + 'NAME\tACCNTTYPE'
    const text = hdr + '\n' + 'ACCNT\n'.repeat(Math.floor((MAX_IIF_CHARS - hdr.length - 1) / 6))
    const t0 = performance.now()
    const p = parseIifAccounts(text)
    expect(performance.now() - t0).toBeLessThan(2000)
    expect(p.errors.length).toBe(MAX_IIF_ERRORS + 1)
    expect(p.errors.at(-1)).toMatch(/stopped after 50 problems/)
  })

  it('REFUTE F1: many valid-looking rows under a wide header stay fast', () => {
    const hdr = '!ACCNT\t' + 'X\t'.repeat(100_000) + 'NAME\tACCNTTYPE'
    const body = Array.from({ length: 1500 }, (_, i) => `ACCNT\tA${i}`).join('\n')
    const t0 = performance.now()
    parseIifAccounts(hdr + '\n' + body)
    expect(performance.now() - t0).toBeLessThan(2000)
  })

  it('a header without NAME or ACCNTTYPE is reported', () => {
    expect(parseIifAccounts('!ACCNT\tFOO\nACCNT\tx\n').errors[0]).toMatch(/has no NAME or no ACCNTTYPE column/)
  })

  it('rejects an oversized file without parsing it', () => {
    expect(parseIifAccounts('x'.repeat(MAX_IIF_CHARS + 1)).errors[0]).toMatch(/larger than/)
  })
})

describe('planAccountImport', () => {
  const file = parseIifAccounts(iif(
    row('Operating Cash', 'BANK', '1000'),
    row('Rental Income', 'INC', '4000'),
    row('Repairs', 'EXP', '6100', 'Y'),
    row('Utilities', 'EXP', '6200'),
  )).accounts
  const ex = (over: Partial<ExistingAccount>): ExistingAccount =>
    ({ id: over.qb_name ?? 'x', number: null, account_type: 'asset', qb_account_type: null, is_active: true, qb_name: 'x', ...over })

  it('first import: everything is new', () => {
    const plan = planAccountImport(file, [])
    expect(plan.new.map((a) => a.qb_name)).toEqual(['Operating Cash', 'Rental Income', 'Repairs', 'Utilities'])
    expect(plan.conflicts).toEqual([])
  })

  it('re-import of the same chart: unchanged, nothing new, ledger-only accounts listed but kept', () => {
    const existing = [
      ex({ qb_name: 'Operating Cash', number: '1000', account_type: 'asset', qb_account_type: 'BANK' }),
      ex({ qb_name: 'Rental Income', number: '4000', account_type: 'income', qb_account_type: 'INC' }),
      ex({ qb_name: 'Repairs', number: '6100', account_type: 'expense', qb_account_type: 'EXP', is_active: true }),
      ex({ qb_name: 'Utilities', number: '6200', account_type: 'expense', qb_account_type: 'EXP' }),
      ex({ qb_name: 'Manual Clearing', number: '9999', account_type: 'asset' }),
    ]
    const plan = planAccountImport(file, existing)
    expect(plan.new).toEqual([])
    expect(plan.unchanged).toHaveLength(4)
    expect(plan.conflicts).toEqual([])
    expect(plan.warnings).toEqual([{ qb_name: 'Repairs', line: 4, message: 'inactive in QuickBooks, active in the ledger' }])
    expect(plan.ledger_only).toEqual([{ qb_name: 'Manual Clearing', number: '9999' }])
  })

  it('conflicts: different type, number, QB type, spelling, or a number already used by another account', () => {
    const plan = planAccountImport(file, [
      ex({ qb_name: 'Operating Cash', number: '1000', account_type: 'asset', qb_account_type: 'OCASSET' }),
      ex({ qb_name: 'rental income', number: '4000', account_type: 'income' }),
      ex({ qb_name: 'Repairs', number: '6150', account_type: 'liability' }),
      ex({ qb_name: 'Office', number: '6200', account_type: 'expense' }),
    ])
    expect(plan.new).toEqual([])
    expect(Object.fromEntries(plan.conflicts.map((c) => [c.qb_name, c.reasons]))).toEqual({
      'Operating Cash': ['QuickBooks type is OCASSET in the ledger, BANK in the file'],
      'Rental Income': ['the ledger spells it "rental income"'],
      Repairs: ['type is liability in the ledger, expense in QuickBooks', 'number is 6150 in the ledger, 6100 in QuickBooks'],
      Utilities: ['number 6200 already belongs to "Office" in the ledger'],
    })
  })

  it('REFUTE N3: with "Checking" and "checking" both in the ledger, an exact match is unchanged, not a conflict', () => {
    const one = parseIifAccounts(iif(row('Operating Cash', 'BANK', '1000'))).accounts
    const plan = planAccountImport(one, [
      ex({ id: 'b', qb_name: 'operating cash', number: '1001', account_type: 'asset', qb_account_type: 'BANK' }),
      ex({ id: 'a', qb_name: 'Operating Cash', number: '1000', account_type: 'asset', qb_account_type: 'BANK' }),
    ])
    expect(plan.conflicts).toEqual([])
    expect(plan.unchanged.map((a) => a.qb_name)).toEqual(['Operating Cash'])
    expect(plan.ledger_only).toEqual([{ qb_name: 'operating cash', number: '1001' }])
  })

  it('existing account without a recorded QB type: unchanged, with a warning', () => {
    const plan = planAccountImport(file.slice(0, 1), [ex({ qb_name: 'Operating Cash', number: '1000', account_type: 'asset' })])
    expect(plan.unchanged).toHaveLength(1)
    expect(plan.warnings[0].message).toMatch(/BANK is not recorded/)
  })
})
