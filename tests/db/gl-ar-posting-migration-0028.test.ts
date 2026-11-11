// B8 slice 3 (supabase/migrations/0028_gl_ar_posting.sql). Table shapes and CHECKs run on the real
// migration chain in pg-mem; the triggers and functions that carry the posting rules are pinned
// textually here and exercised on real Postgres by supabase/tests/gl_ar_posting.test.sql.
import { describe, it, expect, beforeEach } from 'vitest'
import { freshMigratedDb, migrationFiles, readMigration, splitSqlStatements, statementBody, type MigratedDb } from '../fixtures/pg-migrations'
import { migrationTouchesFinancialTables } from '../../scripts/check-refute-required'
import { AR_ROLES } from '../../server/lib/gl-ar-posting'

const FILE = '0028_gl_ar_posting.sql'

describe('migration 0028 — AR posting tables', () => {
  let db: MigratedDb
  beforeEach(() => { db = freshMigratedDb() })

  it('ships as the only 0028 migration', () => {
    expect(migrationFiles().filter((f) => f.startsWith('0028_'))).toEqual([FILE])
  })

  it('creates the role map, tie-out, tie-out items and postings tables, and payments.status_changed_at', () => {
    for (const t of ['gl_ar_accounts', 'gl_ar_tieouts', 'gl_ar_tieout_items', 'gl_ar_postings']) {
      expect(() => db.many(`SELECT * FROM ${t}`), t).not.toThrow()
    }
    expect(() => db.many('SELECT status_changed_at FROM payments')).not.toThrow()
  })
})

describe('migration 0028 — posting rules (textual pins)', () => {
  const sql = readMigration(FILE)
  const body = splitSqlStatements(sql).map(statementBody)
  const has = (re: RegExp) => expect(body.some((s) => re.test(s)), String(re)).toBe(true)

  it('the role CHECK lists exactly the planner roles', () => {
    const m = /gl_ar_accounts_role_check CHECK \(role IN \(([^)]*)\)\)/.exec(sql)
    expect(m).not.toBeNull()
    expect(m![1].split(',').map((s) => s.trim().replace(/'/g, '')).sort()).toEqual([...AR_ROLES].sort())
  })

  it('posting kinds and the ar_posting source', () => {
    expect(sql).toMatch(/gl_ar_postings_kind_check CHECK \(kind IN \(\s*'charge', 'charge_void', 'charge_void_pre', 'payment', 'payment_return', 'payment_return_pre'\)\)/)
    expect(sql).toMatch(/'ar_posting'/)
  })

  it('every posting is verified by deferred constraint triggers; sources and the property LLC are guarded', () => {
    has(/^CREATE CONSTRAINT TRIGGER gl_ar_postings_verify/)
    has(/^CREATE CONSTRAINT TRIGGER gl_journal_entries_ar_linked/)
    has(/^CREATE TRIGGER charges_gl_guard/)
    has(/^CREATE TRIGGER payments_gl_guard/)
    has(/^CREATE TRIGGER properties_gl_entity_guard/)
    has(/^CREATE TRIGGER gl_ar_accounts_guard/)
  })

  it('REFUTE-6: tie-out bound to its opening balance; lines re-verified; hand reversals, unit/lease moves refused; no temp table', () => {
    expect(sql).toMatch(/opening_entry_id UUID NOT NULL/)
    has(/^CREATE CONSTRAINT TRIGGER gl_journal_lines_ar_verify\s+AFTER INSERT ON gl_journal_lines\s+DEFERRABLE INITIALLY DEFERRED/)
    has(/^CREATE TRIGGER gl_journal_entries_ar_tie_guard BEFORE INSERT ON gl_journal_entries/)
    has(/^CREATE TRIGGER gl_entities_ar_tie_guard BEFORE UPDATE ON gl_entities/)
    has(/^CREATE TRIGGER units_gl_entity_guard BEFORE UPDATE ON units/)
    has(/^CREATE TRIGGER leases_gl_entity_guard BEFORE UPDATE ON leases/)
    has(/^CREATE TRIGGER payments_status_changed_at\s+BEFORE INSERT OR UPDATE ON payments/)
    expect(sql).toMatch(/reverses an AR posting; void the charge or record the payment''s return in the app instead/)
    expect(sql).not.toMatch(/CREATE TEMP TABLE/i)
    // Every SET CONSTRAINTS in the batch names the new line check.
    for (const m of sql.matchAll(/SET CONSTRAINTS ([^;]+);/g)) expect(m[1]).toMatch(/gl_journal_lines_ar_verify/)
  })

  it('tie-out and posting records are insert-only', () => {
    expect(sql).toMatch(/REVOKE UPDATE, DELETE ON gl_ar_tieouts, gl_ar_tieout_items, gl_ar_postings FROM service_role;/)
  })

  it('write functions: service_role only, READ COMMITTED, pinned search_path, no SECURITY DEFINER', () => {
    for (const sig of ['gl_confirm_ar_tieout\\(UUID, TEXT\\)', 'gl_post_ar_batch\\(UUID, DATE, JSONB, TEXT\\)']) {
      has(new RegExp(`^REVOKE EXECUTE ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated$`))
      has(new RegExp(`^GRANT EXECUTE ON FUNCTION ${sig} TO service_role$`))
    }
    expect(sql).toMatch(/AR posting for cash-basis entities is not available yet/)
    expect(sql).not.toMatch(/SET search_path = public\n/)
    expect(sql).not.toMatch(/SECURITY DEFINER/i)
    const fns = (sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length
    expect((sql.match(/SET search_path = public, pg_temp/g) ?? []).length).toBe(fns)
  })

  it('is refute-gated as a money migration', () => {
    expect(migrationTouchesFinancialTables(sql)).toBe(true)
  })
})
