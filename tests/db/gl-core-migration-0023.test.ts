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
    expect(() => db.none(`INSERT INTO gl_periods (entity_id, period_start, locked_by) VALUES ('${E1}', '2026-11-01', 'x')`)).toThrow(/gl_periods_lock_pair/)
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

  it('insert guards, reversal mirror, period guard, no truncate, frozen type/basis (REFUTE D1–D4)', () => {
    has(/^CREATE TRIGGER gl_journal_entries_insert_guard\s+BEFORE INSERT ON gl_journal_entries/)
    has(/^CREATE TRIGGER gl_journal_lines_insert_guard\s+BEFORE INSERT ON gl_journal_lines/)
    has(/^CREATE CONSTRAINT TRIGGER gl_journal_entries_reversal_mirror\s+AFTER INSERT ON gl_journal_entries\s+DEFERRABLE INITIALLY DEFERRED/)
    has(/^CREATE TRIGGER gl_periods_guard\s+BEFORE INSERT OR UPDATE OR DELETE ON gl_periods/)
    // the mirror is checked from the lines too (REFUTE-2 B1), and re-checks the target's source (S1)
    has(/^CREATE CONSTRAINT TRIGGER gl_journal_lines_reversal_mirror\s+AFTER INSERT ON gl_journal_lines\s+DEFERRABLE INITIALLY DEFERRED/)
    expect(sql).toMatch(/WHERE id = v_target AND source = 'reversal'/)
    // account and entity rows held against concurrent reclassification (REFUTE-2 S3)
    expect(sql).toMatch(/FROM gl_accounts WHERE id = NEW\.account_id AND entity_id = NEW\.entity_id FOR SHARE;/)
    expect(sql).toMatch(/FROM gl_entities WHERE id = NEW\.entity_id FOR SHARE;/)
    // periods are born open; the lock transition checks the month and the locker (REFUTE-2 S2)
    expect(sql).toMatch(/a period row is created open/)
    expect(sql).toMatch(/NEW\.period_start >= pg_catalog\.date_trunc\('month', \(gl_today\(\)\)::timestamp\)::date/)
    expect(sql).toMatch(/now\(\) AT TIME ZONE 'America\/Chicago'/)
    expect(sql).toMatch(/CONSTRAINT gl_journal_entries_date_range CHECK/)
    for (const t of ['gl_periods', 'gl_accounts', 'gl_entities']) {
      has(new RegExp(`^CREATE TRIGGER ${t}_no_truncate BEFORE TRUNCATE ON ${t}`))
    }
    has(/^CREATE TRIGGER gl_accounts_guard\s+BEFORE UPDATE/)
    has(/^CREATE TRIGGER gl_entities_guard\s+BEFORE UPDATE/)
    // same-transaction lines by top-level transaction id, not now() (D1)
    expect(sql).toMatch(/NEW\.posted_at := now\(\);/)
    expect(sql).toMatch(/NEW\.posted_txid := pg_current_xact_id\(\)::text::bigint;/)
    expect(sql).toMatch(/posted_txid IS DISTINCT FROM pg_current_xact_id\(\)::text::bigint/)
    expect(sql).not.toMatch(/e\.posted_at = now\(\)/)
    // only ended months lock
    expect(sql).toMatch(/p_period_start >= pg_catalog\.date_trunc\('month', \(gl_today\(\)\)::timestamp\)::date/)
    // REFUTE-4 F1: no unqualified date_trunc a public overload could capture
    expect(sql.replace(/^--.*$/gm, '')).not.toMatch(/(?<!pg_catalog\.)date_trunc\(/)
    // REFUTE-4 F2: reclassification only at READ COMMITTED
    expect((sql.match(/pg_catalog\.current_setting\('transaction_isolation'\) <> 'read committed'/g) ?? []).length).toBe(2)
    expect(sql).not.toMatch(/current_date/)
  })

  it('write functions: post and lock serialize on the period row', () => {
    expect(sql).toMatch(/FROM gl_periods[\s\S]{0,200}FOR SHARE;/)
    expect(sql).toMatch(/FROM gl_periods[\s\S]{0,200}FOR UPDATE;/)
    for (const fn of ['gl_post_entry', 'gl_reverse_entry', 'gl_lock_period', 'gl_hold_open_period', 'gl_check_reversal', 'gl_today']) {
      has(new RegExp(`^CREATE OR REPLACE FUNCTION ${fn}\\(`))
      has(new RegExp(`^REVOKE EXECUTE ON FUNCTION ${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated$`))
      has(new RegExp(`^GRANT EXECUTE ON FUNCTION ${fn}\\([^)]*\\) TO service_role$`))
    }
    expect(sql).not.toMatch(/SECURITY DEFINER/i)
  })

  it('REFUTE pass 3: pg_temp searched last, no caller triggers, forged lock fields impossible', () => {
    // F1: every function pins search_path with pg_temp LAST (a bare `public` searches pg_temp first)
    expect(sql).not.toMatch(/SET search_path = public\n/)
    expect((sql.match(/SET search_path = public, pg_temp\n/g) ?? []).length).toBeGreaterThanOrEqual(15)
    // F2: Supabase's default GRANT ALL is cut back
    has(/^REVOKE ALL ON gl_entities, gl_accounts, gl_periods, gl_journal_entries, gl_journal_lines FROM PUBLIC, anon, authenticated$/)
    has(/^REVOKE TRIGGER, TRUNCATE, REFERENCES ON gl_entities, gl_accounts, gl_periods, gl_journal_entries, gl_journal_lines FROM service_role$/)
    // F3: the DB stamps locked_at; open rows carry no lock fields
    expect(sql).toMatch(/NEW\.locked_at := now\(\);/)
    expect(sql).toMatch(/status = 'open' AND locked_at IS NULL AND locked_by IS NULL/)
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
