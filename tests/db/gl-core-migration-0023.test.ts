/// <reference types="node" />
// B8 ledger core (supabase/migrations/0023_gl_core.sql).
//
// Two layers, because pg-mem has no plpgsql and cannot parse triggers:
//   * runtime (pg-mem, real migration chain): the table-level rules: CHECKs, composite FKs,
//     UNIQUEs, debit XOR credit.
//   * textual pins: every trigger, function, grant and RLS statement that carries the money rules
//     is present. Their BEHAVIOUR is tested on real Postgres by supabase/tests/gl_core.test.sql
//     (scripts/verify-gl-sql.sh); a pin here fails CI if one is dropped from the migration.
import { describe, it, expect, beforeEach } from 'vitest'
import { freshMigratedDb, migrationFiles, readMigration, splitSqlStatements, statementBody, type MigratedDb } from '../fixtures/pg-migrations'
import { migrationTouchesFinancialTables } from '../../scripts/check-refute-required'

const FILE = '0023_gl_core.sql'
const E1 = '00000000-0000-4000-8000-0000000000e1'
const E2 = '00000000-0000-4000-8000-0000000000e2'
const A1 = '00000000-0000-4000-8000-0000000000a1'
const A2 = '00000000-0000-4000-8000-0000000000a2'
const X2 = '00000000-0000-4000-8000-0000000000b1'
const J1 = '00000000-0000-4000-8000-0000000000f1'

function seed(db: MigratedDb) {
  db.none(`
    INSERT INTO gl_entities (id, name, accounting_basis) VALUES ('${E1}', 'Raytown Flex Holdings LLC', 'accrual'), ('${E2}', 'Columbia Trade LLC', 'cash');
    INSERT INTO gl_accounts (id, entity_id, number, qb_name, account_type) VALUES
      ('${A1}', '${E1}', '1000', 'Operating Cash', 'asset'),
      ('${A2}', '${E1}', '4000', 'Rental Income', 'income'),
      ('${X2}', '${E2}', '1000', 'Operating Cash', 'asset');
    INSERT INTO gl_journal_entries (id, entity_id, entry_date, memo, source, posted_by) VALUES ('${J1}', '${E1}', '2026-10-05', 'Oct rent', 'manual', 't');
  `)
}

describe('migration 0023 — GL core tables (runtime, real SQL on pg-mem)', () => {
  let db: MigratedDb
  beforeEach(() => { db = freshMigratedDb(); seed(db) })

  it('ships as the only 0023 migration', () => {
    expect(migrationFiles().filter((f) => f.startsWith('0023_'))).toEqual([FILE])
  })

  it('entities: basis is accrual or cash; names unique and non-blank', () => {
    expect(() => db.none(`INSERT INTO gl_entities (name, accounting_basis) VALUES ('X', 'modified')`)).toThrow(/gl_entities_basis_check/)
    expect(() => db.none(`INSERT INTO gl_entities (name, accounting_basis) VALUES ('Columbia Trade LLC', 'cash')`)).toThrow(/duplicate|unique/i)
    expect(() => db.none(`INSERT INTO gl_entities (name, accounting_basis) VALUES ('  ', 'cash')`)).toThrow(/gl_entities_name_nonempty/)
  })

  it('accounts mirror QB: qb_name and number unique per entity, but the same across entities is fine', () => {
    expect(() => db.none(`INSERT INTO gl_accounts (entity_id, qb_name, account_type) VALUES ('${E1}', 'Operating Cash', 'asset')`)).toThrow(/duplicate|unique/i)
    expect(() => db.none(`INSERT INTO gl_accounts (entity_id, number, qb_name, account_type) VALUES ('${E1}', '1000', 'Other', 'asset')`)).toThrow(/duplicate|unique/i)
    expect(() => db.none(`INSERT INTO gl_accounts (entity_id, qb_name, account_type) VALUES ('${E1}', 'Z', 'revenue')`)).toThrow(/gl_accounts_type_check/)
    db.none(`INSERT INTO gl_accounts (entity_id, qb_name, account_type) VALUES ('${E1}', 'No Number A', 'expense'), ('${E1}', 'No Number B', 'expense')`)
  })

  it('lines: debit XOR credit, never negative, and only accounts of the entry\'s own entity', () => {
    const ins = (acct: string, entity: string, d: number, c: number, n: number) =>
      db.none(`INSERT INTO gl_journal_lines (entry_id, entity_id, account_id, line_no, debit_cents, credit_cents) VALUES ('${J1}', '${entity}', '${acct}', ${n}, ${d}, ${c})`)
    expect(() => ins(A1, E1, 5, 5, 1)).toThrow(/gl_journal_lines_one_side/)
    expect(() => ins(A1, E1, 0, 0, 1)).toThrow(/gl_journal_lines_one_side/)
    expect(() => ins(A1, E1, -5, 0, 1)).toThrow(/gl_journal_lines_debit_nonneg|gl_journal_lines_one_side/)
    // the other entity's account, labelled with this entry's entity: composite account FK fails
    expect(() => ins(X2, E1, 5, 0, 1)).toThrow(/foreign key|violates/i)
    // the other entity's account labelled with its own entity: composite entry FK fails
    expect(() => ins(X2, E2, 5, 0, 1)).toThrow(/foreign key|violates/i)
    ins(A1, E1, 5, 0, 1)
    expect(() => ins(A2, E1, 0, 5, 1)).toThrow(/duplicate|unique/i)
  })

  it('reversal pair: source reversal ⇔ reverses_entry_id, same entity, once', () => {
    expect(() => db.none(`INSERT INTO gl_journal_entries (entity_id, entry_date, memo, source, posted_by) VALUES ('${E1}', '2026-10-06', 'r', 'reversal', 't')`)).toThrow(/gl_journal_entries_reversal_pair/)
    expect(() => db.none(`INSERT INTO gl_journal_entries (entity_id, entry_date, memo, source, reverses_entry_id, posted_by) VALUES ('${E1}', '2026-10-06', 'r', 'manual', '${J1}', 't')`)).toThrow(/gl_journal_entries_reversal_pair/)
    expect(() => db.none(`INSERT INTO gl_journal_entries (entity_id, entry_date, memo, source, reverses_entry_id, posted_by) VALUES ('${E2}', '2026-10-06', 'r', 'reversal', '${J1}', 't')`)).toThrow(/foreign key|violates/i)
  })

  it('periods: first of month; locked ⇔ locked_at and locked_by', () => {
    expect(() => db.none(`INSERT INTO gl_periods (entity_id, period_start) VALUES ('${E1}', '2026-11-15')`)).toThrow(/gl_periods_month_start/)
    expect(() => db.none(`INSERT INTO gl_periods (entity_id, period_start, status) VALUES ('${E1}', '2026-11-01', 'locked')`)).toThrow(/gl_periods_lock_pair/)
    db.none(`INSERT INTO gl_periods (entity_id, period_start) VALUES ('${E1}', '2026-11-01')`)
  })
})

describe('migration 0023 — money-rule triggers, functions and access (textual pins)', () => {
  const sql = readMigration(FILE)
  const body = splitSqlStatements(sql).map(statementBody)
  const has = (re: RegExp) => expect(body.some((s) => re.test(s)), String(re)).toBe(true)

  it('balanced-at-commit constraint triggers on both journal tables', () => {
    has(/^CREATE CONSTRAINT TRIGGER gl_journal_entries_balanced\s+AFTER INSERT ON gl_journal_entries\s+DEFERRABLE INITIALLY DEFERRED/)
    has(/^CREATE CONSTRAINT TRIGGER gl_journal_lines_balanced\s+AFTER INSERT ON gl_journal_lines\s+DEFERRABLE INITIALLY DEFERRED/)
    expect(sql).toMatch(/v_lines < 2 OR v_debits <> v_credits OR v_debits = 0/)
  })

  it('immutability on entries and lines (update, delete, truncate)', () => {
    has(/^CREATE TRIGGER gl_journal_entries_immutable\s+BEFORE UPDATE OR DELETE ON gl_journal_entries/)
    has(/^CREATE TRIGGER gl_journal_lines_immutable\s+BEFORE UPDATE OR DELETE ON gl_journal_lines/)
    has(/^CREATE TRIGGER gl_journal_entries_no_truncate\s+BEFORE TRUNCATE ON gl_journal_entries/)
    has(/^CREATE TRIGGER gl_journal_lines_no_truncate\s+BEFORE TRUNCATE ON gl_journal_lines/)
  })

  it('period lock, permanent lock, active accounts, same-transaction lines, db-set posted_at', () => {
    has(/^CREATE TRIGGER gl_journal_entries_period_open\s+BEFORE INSERT ON gl_journal_entries/)
    has(/^CREATE TRIGGER gl_periods_guard\s+BEFORE UPDATE OR DELETE ON gl_periods/)
    has(/^CREATE TRIGGER gl_journal_lines_account_active\s+BEFORE INSERT ON gl_journal_lines/)
    has(/^CREATE TRIGGER gl_journal_lines_same_tx\s+BEFORE INSERT ON gl_journal_lines/)
    expect(sql).toMatch(/NEW\.posted_at := now\(\);/)
    expect(sql).toMatch(/e\.posted_at = now\(\)/)
  })

  it('write functions: post and lock serialize on the period row', () => {
    expect(sql).toMatch(/FROM gl_periods[\s\S]{0,200}FOR SHARE;/)
    expect(sql).toMatch(/FROM gl_periods[\s\S]{0,200}FOR UPDATE;/)
    for (const fn of ['gl_post_entry', 'gl_reverse_entry', 'gl_lock_period', 'gl_hold_open_period']) {
      has(new RegExp(`^CREATE OR REPLACE FUNCTION ${fn}\\(`))
      has(new RegExp(`^REVOKE EXECUTE ON FUNCTION ${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated$`))
      has(new RegExp(`^GRANT EXECUTE ON FUNCTION ${fn}\\([^)]*\\) TO service_role$`))
    }
    expect(sql).not.toMatch(/SECURITY DEFINER/i)
  })

  it('RLS on every gl_ table, no policies', () => {
    for (const t of ['gl_entities', 'gl_accounts', 'gl_periods', 'gl_journal_entries', 'gl_journal_lines']) {
      has(new RegExp(`^ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY$`))
    }
    expect(sql).not.toMatch(/CREATE POLICY/i)
  })

  it('is refute-gated as a money migration', () => {
    expect(migrationTouchesFinancialTables(sql)).toBe(true)
  })
})
