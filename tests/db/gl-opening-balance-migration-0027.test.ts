// B8 slice 2 (supabase/migrations/0027_gl_opening_balance.sql). The start-date CHECK runs on the
// real migration chain in pg-mem; the triggers and functions that carry rules O2–O6 are pinned
// textually here and exercised on real Postgres by supabase/tests/gl_opening_balance.test.sql.
import { describe, it, expect, beforeEach } from 'vitest'
import { freshMigratedDb, migrationFiles, readMigration, splitSqlStatements, statementBody, type MigratedDb } from '../fixtures/pg-migrations'
import { migrationTouchesFinancialTables } from '../../scripts/check-refute-required'

const FILE = '0027_gl_opening_balance.sql'
const E1 = '00000000-0000-4000-8000-0000000000e1'

describe('migration 0027 — ledger start date', () => {
  let db: MigratedDb
  beforeEach(() => {
    db = freshMigratedDb()
    db.none(`INSERT INTO gl_entities (id, name, accounting_basis) VALUES ('${E1}', 'Raytown Flex Holdings LLC', 'accrual')`)
  })

  it('ships as the only 0027 migration', () => {
    expect(migrationFiles().filter((f) => f.startsWith('0027_'))).toEqual([FILE])
  })

  it('start date: first of a month, 2000–2100, or NULL', () => {
    db.none(`UPDATE gl_entities SET ledger_start_date = '2027-01-01' WHERE id = '${E1}'`)
    db.none(`UPDATE gl_entities SET ledger_start_date = NULL WHERE id = '${E1}'`)
    expect(() => db.none(`UPDATE gl_entities SET ledger_start_date = '2027-01-15' WHERE id = '${E1}'`)).toThrow(/gl_entities_start_month/)
    expect(() => db.none(`UPDATE gl_entities SET ledger_start_date = '1999-12-01' WHERE id = '${E1}'`)).toThrow(/gl_entities_start_month/)
  })
})

describe('migration 0027 — opening-balance rules (textual pins)', () => {
  const sql = readMigration(FILE)
  const body = splitSqlStatements(sql).map(statementBody)
  const has = (re: RegExp) => expect(body.some((s) => re.test(s)), String(re)).toBe(true)

  it('O2–O4: entry insert guard (after 0023 insert_guard by name order)', () => {
    has(/^CREATE TRIGGER gl_journal_entries_start_guard\s+BEFORE INSERT ON gl_journal_entries/)
    expect('gl_journal_entries_insert_guard' < 'gl_journal_entries_start_guard').toBe(true)
    expect(sql).toMatch(/NEW\.entry_date <> v_start - 1/)
    expect(sql).toMatch(/already has an opening balance; reverse it before posting a new one/)
    expect(sql).toMatch(/an opening balance is reversed on its own date/)
    expect(sql).toMatch(/that period belongs to QuickBooks/)
  })

  it('O5: start date fixed once used; O3/O5 READ COMMITTED only', () => {
    has(/^CREATE TRIGGER gl_entities_start_guard\s+BEFORE UPDATE ON gl_entities/)
    expect((sql.match(/pg_catalog\.current_setting\('transaction_isolation'\) <> 'read committed'/g) ?? []).length).toBe(3)
    expect(sql).toMatch(/FROM gl_entities WHERE id = NEW\.entity_id FOR UPDATE;/)
  })

  it('O6: line guard exempts opening balances as well as reversals, nothing else changed', () => {
    expect(sql).toMatch(/v_entry\.source NOT IN \('reversal', 'opening_balance'\) AND v_active IS NOT TRUE/)
    const core = readMigration('0023_gl_core.sql')
    const fn = (s: string) => s.slice(s.indexOf('CREATE OR REPLACE FUNCTION gl_assert_line_insert'), s.indexOf('$$;', s.indexOf('CREATE OR REPLACE FUNCTION gl_assert_line_insert')))
    expect(fn(sql).replace("v_entry.source NOT IN ('reversal', 'opening_balance')", "v_entry.source <> 'reversal'")).toBe(fn(core))
  })

  it('write function: service_role only, pinned search_path, no SECURITY DEFINER', () => {
    has(/^CREATE OR REPLACE FUNCTION gl_post_opening_balance\(/)
    has(/^REVOKE EXECUTE ON FUNCTION gl_post_opening_balance\(UUID, DATE, JSONB, TEXT\) FROM PUBLIC, anon, authenticated$/)
    has(/^GRANT EXECUTE ON FUNCTION gl_post_opening_balance\(UUID, DATE, JSONB, TEXT\) TO service_role$/)
    expect(sql).not.toMatch(/SET search_path = public\n/)
    expect(sql).not.toMatch(/SECURITY DEFINER/i)
  })

  it('is refute-gated as a money migration', () => {
    expect(migrationTouchesFinancialTables(sql)).toBe(true)
  })
})
