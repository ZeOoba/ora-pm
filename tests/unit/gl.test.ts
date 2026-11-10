import { describe, it, expect } from 'vitest'
import { MAX_LINE_CENTS, canLockPeriods, formatCents, glRuleMessage, isRealIsoDate, ledgerToday, parseCents, trialBalance, validateEntryLines } from '../../server/lib/gl'

describe('parseCents', () => {
  it('parses exact dollar strings to integer cents', () => {
    expect(parseCents('0.01')).toBe(1)
    expect(parseCents('1234')).toBe(123400)
    expect(parseCents('1234.5')).toBe(123450)
    expect(parseCents('20192.50')).toBe(2019250)
    expect(parseCents(' 7.07 ')).toBe(707)
  })
  it.each(['', '-1', '+1', '1e3', '1,000', '1.234', '.5', '1.', 'abc', '0x10', 'NaN', 'Infinity'])('rejects %j', (s) => {
    expect(parseCents(s)).toBeNull()
  })
  it('caps at MAX_LINE_CENTS', () => {
    expect(parseCents(formatCents(MAX_LINE_CENTS))).toBe(MAX_LINE_CENTS)
    expect(parseCents(formatCents(MAX_LINE_CENTS + 1))).toBeNull()
  })
  it('formatCents round-trips', () => {
    for (const c of [0, 1, 99, 100, 2019250]) expect(parseCents(formatCents(c))).toBe(c)
    expect(formatCents(-1050)).toBe('-10.50')
  })
})

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

describe('validateEntryLines', () => {
  it('converts a balanced entry to cents lines', () => {
    const v = validateEntryLines([{ account_id: A, debit: '20192.50' }, { account_id: B, credit: '20192.5', memo: ' Ste 3 ' }])
    expect(v).toEqual({ ok: true, totalCents: 2019250, lines: [
      { account_id: A, debit_cents: 2019250, credit_cents: 0, memo: null },
      { account_id: B, debit_cents: 0, credit_cents: 2019250, memo: 'Ste 3' },
    ] })
  })
  it('rejects unbalanced entries in exact cents (no float tolerance)', () => {
    const v = validateEntryLines([{ account_id: A, debit: '0.10' }, { account_id: A, debit: '0.20' }, { account_id: B, credit: '0.31' }])
    expect(v.ok).toBe(false)
    expect(!v.ok && v.errors[0]).toContain('does not balance')
    expect(validateEntryLines([{ account_id: A, debit: '0.10' }, { account_id: A, debit: '0.20' }, { account_id: B, credit: '0.30' }]).ok).toBe(true)
  })
  it('requires exactly one side per line, positive', () => {
    const both = validateEntryLines([{ account_id: A, debit: '1', credit: '1' }, { account_id: B, credit: '1' }])
    expect(!both.ok && both.errors[0]).toContain('not both')
    const neither = validateEntryLines([{ account_id: A }, { account_id: B, credit: '1' }])
    expect(!neither.ok && neither.errors[0]).toContain('not neither')
    const zero = validateEntryLines([{ account_id: A, debit: '0.00' }, { account_id: B, credit: '0' }])
    expect(zero.ok).toBe(false)
  })
  it('refuses totals beyond exact JS integer range instead of comparing rounded sums', () => {
    const max = formatCents(MAX_LINE_CENTS)
    const lines = [
      ...Array.from({ length: 91 }, () => ({ account_id: A, debit: max })),
      ...Array.from({ length: 91 }, () => ({ account_id: B, credit: max })),
    ]
    const v = validateEntryLines(lines)
    expect(v.ok).toBe(false)
    expect(!v.ok && v.errors[0]).toContain('too large')
  })
})

describe('trialBalance', () => {
  const accounts = [
    { id: B, number: '4000', qb_name: 'Rental Income', account_type: 'income' as const, is_active: true },
    { id: A, number: '1000', qb_name: 'Operating Cash', account_type: 'asset' as const, is_active: true },
    { id: 'c', number: null, qb_name: 'Unused', account_type: 'expense' as const, is_active: true },
  ]
  it('sums per account in cents, lists every account, orders by number, ties out', () => {
    const tb = trialBalance(accounts, [
      { account_id: A, debit_cents: 2019250, credit_cents: 0 },
      { account_id: B, debit_cents: 0, credit_cents: '2019250' },
    ])
    expect(tb.rows.map((r) => [r.number, r.net_cents])).toEqual([['1000', 2019250], ['4000', -2019250], [null, 0]])
    expect(tb).toMatchObject({ debit_cents: 2019250, credit_cents: 2019250, balanced: true })
  })
  it('flags an out-of-balance read and refuses foreign or malformed lines', () => {
    expect(trialBalance(accounts, [{ account_id: A, debit_cents: 1, credit_cents: 0 }]).balanced).toBe(false)
    expect(() => trialBalance(accounts, [{ account_id: 'zzz', debit_cents: 1, credit_cents: 0 }])).toThrow(/outside this entity/)
    expect(() => trialBalance(accounts, [{ account_id: A, debit_cents: 1.5, credit_cents: 0 }])).toThrow(/non-integer/)
    expect(() => trialBalance(accounts, [{ account_id: A, debit_cents: -1, credit_cents: 0 }])).toThrow(/negative/)
  })
})

describe('canLockPeriods', () => {
  it('exact, case-insensitive allowlist; fail-closed when unset or empty', () => {
    expect(canLockPeriods('Owner@Example.com', 'owner@example.com, other@example.com')).toBe(true)
    expect(canLockPeriods('bookkeeper@example.com', 'owner@example.com')).toBe(false)
    expect(canLockPeriods('owner@example.com', undefined)).toBe(false)
    expect(canLockPeriods('owner@example.com', ' , ')).toBe(false)
    expect(canLockPeriods(undefined, 'owner@example.com')).toBe(false)
    expect(canLockPeriods('owner@example.com.evil', 'owner@example.com')).toBe(false)
  })
})

describe('glRuleMessage', () => {
  it("passes the ledger's own rule messages and named gl_ constraints; nothing else", () => {
    expect(glRuleMessage({ message: 'gl: period 2026-09-01 is locked for entity x; post in an open month' })).toBe('period 2026-09-01 is locked for entity x; post in an open month')
    expect(glRuleMessage({ message: 'new row for relation "gl_journal_lines" violates check constraint "gl_journal_lines_one_side"' })).toBe('ledger rule violated (gl_journal_lines_one_side)')
    expect(glRuleMessage({ message: 'connection to server at 10.0.0.5 failed: password authentication failed' })).toBeNull()
    expect(glRuleMessage({ message: 'violates check constraint "charges_amount_check"' })).toBeNull()
    expect(glRuleMessage(null)).toBeNull()
  })
})

describe('ledger dates', () => {
  it('isRealIsoDate rejects impossible calendar dates', () => {
    expect(isRealIsoDate('2026-10-31')).toBe(true)
    expect(isRealIsoDate('2028-02-29')).toBe(true)
    for (const d of ['2026-02-31', '2026-02-29', '2026-13-01', '2026-1-01', 'infinity', '']) expect(isRealIsoDate(d)).toBe(false)
  })
  it('ledgerToday is the US Central date (a month ends at Central midnight, not UTC)', () => {
    expect(ledgerToday(new Date('2026-11-01T03:00:00Z'))).toBe('2026-10-31')
    expect(ledgerToday(new Date('2026-11-01T06:00:00Z'))).toBe('2026-11-01')
  })
})
