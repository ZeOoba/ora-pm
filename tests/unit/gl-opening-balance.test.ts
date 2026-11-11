import { describe, it, expect } from 'vitest'
import { parseCsv, parseTbAmount, planOpeningBalance, splitQbAccountLabel, type ChartAccount } from '../../server/lib/gl-opening-balance'

const CHART: ChartAccount[] = [
  { id: 'cash', number: '1000', qb_name: 'Operating Cash', account_type: 'asset', is_active: true },
  { id: 'esc', number: '1900', qb_name: 'Old Escrow', account_type: 'asset', is_active: false },
  { id: 'mtg', number: '2500', qb_name: 'Mortgage Payable', account_type: 'liability', is_active: true },
  { id: 'eq', number: '3000', qb_name: "Members' Equity", account_type: 'equity', is_active: true },
  { id: 'inc', number: '4000', qb_name: 'Rental Income', account_type: 'income', is_active: true },
  { id: 'base', number: '4010', qb_name: 'Rental Income:Base Rent', account_type: 'income', is_active: true },
  { id: 'rep', number: '6100', qb_name: 'Repairs', account_type: 'expense', is_active: true },
]
const csv = (...rows: string[]) => ['Account,Debit,Credit', ...rows].join('\r\n') + '\r\n'

describe('parseCsv', () => {
  it('handles Excel quoting: commas, doubled quotes, line breaks, BOM, CRLF', () => {
    expect(parseCsv('\uFEFFa,"b,c","d ""q""",e\r\n"x\ny",2\n')).toEqual([['a', 'b,c', 'd "q"', 'e'], ['x\ny', '2']])
  })
})

describe('parseTbAmount', () => {
  it.each([['1,234.56', 123456], ['$1,234.56', 123456], ['1234.5', 123450], ['0.00', 0], ['', 0], ['-', 0], ['  20  ', 2000]])('%j → %d', (raw, cents) => {
    expect(parseTbAmount(raw)).toBe(cents)
  })
  it.each(['-5.00', '(5.00)', '1,23.00', '1.234', 'abc', '1e3', '$-5'])('rejects %j', (raw) => {
    expect(parseTbAmount(raw)).toBeNull()
  })
})

describe('splitQbAccountLabel', () => {
  it('reads QuickBooks "number · name" labels, including sub-accounts', () => {
    expect(splitQbAccountLabel('1000 · Operating Cash')).toEqual({ name: 'Operating Cash', number: '1000' })
    expect(splitQbAccountLabel('4000 · Rental Income:4010 · Base Rent')).toEqual({ name: 'Rental Income:Base Rent', number: '4010' })
    expect(splitQbAccountLabel('Repairs')).toEqual({ name: 'Repairs', number: null })
  })
})

describe('planOpeningBalance', () => {
  it('a balanced trial balance: exact lines, totals, file TOTAL checked, zero rows skipped', () => {
    const p = planOpeningBalance(['Raytown Flex Holdings LLC,,', 'Trial Balance,,', 'As of December 31 2026,,', ...csv(
      '1000 · Operating Cash,"125,000.00",',
      'Old Escrow,"5,000.00",',
      '2500 · Mortgage Payable,,"90,000.00"',
      "Members' Equity,,\"55,000.00\"",
      '4000 · Rental Income:4010 · Base Rent,,"20,000.00"',
      'Repairs,"35,000.00",',
      'Rental Income,0.00,0.00',
      'TOTAL,"165,000.00","165,000.00"',
    ).split('\r\n')].join('\r\n'), CHART)
    expect(p.errors).toEqual([])
    expect(p.lines.map((l) => [l.account_id, l.debit_cents, l.credit_cents])).toEqual([
      ['cash', 12500000, 0], ['esc', 500000, 0], ['mtg', 0, 9000000], ['eq', 0, 5500000], ['base', 0, 2000000], ['rep', 3500000, 0],
    ])
    expect([p.debit_cents, p.credit_cents]).toEqual([16500000, 16500000])
    expect(p.file_total).toEqual({ debit_cents: 16500000, credit_cents: 16500000 })
    expect(p.skipped_zero_rows).toBe(1)
    expect(p.warnings).toEqual(['Old Escrow is hidden in QuickBooks but carries a balance; the opening balance includes it'])
  })

  it('an explicit Number column wins over the label', () => {
    const p = planOpeningBalance('Number,Account,Debit,Credit\n1000,Cash (renamed in report),100.00,\n3000,"Members\' Equity",,100.00\n', CHART)
    expect(p.errors).toEqual(['row 2 (Cash (renamed in report)): number 1000 is "Operating Cash" in the ledger chart; the file and the chart disagree'])
  })

  it.each([
    ['unbalanced', csv('Operating Cash,100.00,', "Members' Equity,,99.99"), /debits \$100\.00 do not equal credits \$99\.99 \(difference \$0\.01\)/],
    ['TOTAL row disagrees (a dropped row)', csv('Operating Cash,100.00,', "Members' Equity,,100.00", 'TOTAL,150.00,150.00'), /TOTAL row .* does not match its rows/],
    ['unknown account', csv('Petty Cash,100.00,', "Members' Equity,,100.00"), /Petty Cash\): not in this LLC's chart/],
    ['case-only mismatch', csv('operating cash,100.00,', "Members' Equity,,100.00"), /no exact match; the chart spells it "Operating Cash"/],
    ['unknown number', csv('1001 · Operating Cash,100.00,', "Members' Equity,,100.00"), /no account numbered 1001/],
    ['account twice', csv('Operating Cash,50.00,', 'Operating Cash,50.00,', "Members' Equity,,100.00"), /already appears on row 2/],
    ['both columns', csv('Operating Cash,100.00,1.00', "Members' Equity,,99.00"), /both a debit and a credit/],
    ['negative amount', csv('Operating Cash,-100.00,', "Members' Equity,,100.00"), /not a plain amount; a negative balance belongs in the other column/],
    ['amount without account', csv(',100.00,', "Members' Equity,,100.00"), /an amount with no account/],
    ['no header', 'Name,Amount\nCash,1\n', /no header row with Account, Debit and Credit/],
    ['two Debit columns', 'Account,Debit,Credit,Debit,Credit\nOperating Cash,1,,,\n', /more than one Debit or Credit column/],
    ['one account', csv('Operating Cash,0.00,'), /at least two accounts/],
  ])('rejects: %s', (_n, text, re) => {
    expect(planOpeningBalance(text, CHART).errors.join('\n')).toMatch(re)
  })

  it('flags balances on the unusual side without blocking', () => {
    const p = planOpeningBalance(csv('Operating Cash,,100.00', "Members' Equity,100.00,"), CHART)
    expect(p.errors).toEqual([])
    expect(p.warnings).toEqual([
      'Operating Cash (asset) has a credit balance; check it against QuickBooks',
      "Members' Equity (equity) has a debit balance; check it against QuickBooks",
    ])
  })

  it('caps the error list', () => {
    const rows = Array.from({ length: 300 }, (_, i) => `Nope ${i},1.00,`)
    const p = planOpeningBalance(csv(...rows), CHART)
    expect(p.errors.length).toBe(51)
    expect(p.errors.at(-1)).toMatch(/stopped after 50/)
  })
})
