// B8 slice 1 (supabase/migrations/0025_gl_qb_account_type.sql): QB account type on gl_accounts,
// with a CHECK that it agrees with the ledger account_type. Runs on the real migration chain.
import { describe, it, expect, beforeEach } from 'vitest'
import { freshMigratedDb, migrationFiles, readMigration, type MigratedDb } from '../fixtures/pg-migrations'
import { migrationTouchesFinancialTables } from '../../scripts/check-refute-required'
import { QB_ACCOUNT_TYPES } from '../../server/lib/qb-iif-accounts'

const FILE = '0025_gl_qb_account_type.sql'
const E1 = '00000000-0000-4000-8000-0000000000e1'

describe('migration 0025 — gl_accounts.qb_account_type', () => {
  let db: MigratedDb
  beforeEach(() => {
    db = freshMigratedDb()
    db.none(`INSERT INTO gl_entities (id, name, accounting_basis) VALUES ('${E1}', 'Raytown Flex Holdings LLC', 'accrual')`)
  })
  const ins = (name: string, type: string, qb: string | null) =>
    db.none(`INSERT INTO gl_accounts (entity_id, qb_name, account_type, qb_account_type) VALUES ('${E1}', '${name}', '${type}', ${qb === null ? 'NULL' : `'${qb}'`})`)

  it('ships as the only 0025 migration', () => {
    expect(migrationFiles().filter((f) => f.startsWith('0025_'))).toEqual([FILE])
  })

  it('accepts every QB type with its matching ledger type, and NULL', () => {
    Object.entries(QB_ACCOUNT_TYPES).forEach(([qb, type], i) => ins(`A${i}`, type, qb))
    ins('Manual', 'asset', null)
  })

  it.each([
    ['BANK', 'expense'], ['AR', 'income'], ['CCARD', 'asset'], ['EQUITY', 'liability'],
    ['INC', 'expense'], ['COGS', 'income'], ['NONPOSTING', 'asset'], ['SAVINGS', 'asset'], ['bank', 'asset'],
  ])('rejects QB type %s on a %s account', (qb, type) => {
    expect(() => ins('X', type, qb)).toThrow(/gl_accounts_qb_type_check/)
  })

  it('the database mapping matches the importer mapping exactly', () => {
    const sql = readMigration(FILE)
    const byLedger: Record<string, string[]> = {}
    for (const [qb, t] of Object.entries(QB_ACCOUNT_TYPES)) (byLedger[t] ??= []).push(qb)
    for (const [t, qbs] of Object.entries(byLedger)) {
      const list = qbs.length === 1 ? `= '${qbs[0]}'` : `IN \\(${qbs.map((q) => `'${q}'`).join(', ')}\\)`
      expect(sql).toMatch(new RegExp(`qb_account_type ${list} AND account_type = '${t}'`))
    }
  })

  it('is refute-gated as a money migration', () => {
    expect(migrationTouchesFinancialTables(readMigration(FILE))).toBe(true)
  })
})
