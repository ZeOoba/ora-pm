// B8 slice 4 (supabase/migrations/0029_gl_ar_cash_posting.sql). Tables run on the real migration
// chain in pg-mem; the triggers and functions that carry rules C1–C5 are pinned textually here and
// exercised on real Postgres by supabase/tests/gl_ar_cash_posting.test.sql.
import { describe, it, expect, beforeEach } from 'vitest'
import { freshMigratedDb, migrationFiles, readMigration, splitSqlStatements, statementBody, type MigratedDb } from '../fixtures/pg-migrations'
import { migrationTouchesFinancialTables } from '../../scripts/check-refute-required'
import { CASH_PRIORITY } from '../../server/lib/gl-ar-cash-posting'

const FILE = '0029_gl_ar_cash_posting.sql'

describe('migration 0029 — cash AR tables', () => {
  let db: MigratedDb
  beforeEach(() => { db = freshMigratedDb() })
  it('ships as the only 0029 migration', () => {
    expect(migrationFiles().filter((f) => f.startsWith('0029_'))).toEqual([FILE])
  })
  it('creates the event and entry-link tables', () => {
    for (const t of ['gl_ar_cash_events', 'gl_ar_cash_entries']) expect(() => db.many(`SELECT * FROM ${t}`), t).not.toThrow()
  })
})

describe('migration 0029 — cash posting rules (textual pins)', () => {
  const sql = readMigration(FILE)
  const body = splitSqlStatements(sql).map(statementBody)
  const has = (re: RegExp) => expect(body.some((s) => re.test(s)), String(re)).toBe(true)

  it('the database priority order is the planner order', () => {
    const m = /CASE p_type\s+([\s\S]*?) ELSE 99 END/.exec(sql)
    expect(m).not.toBeNull()
    const db = Object.fromEntries([...m![1].matchAll(/WHEN '(\w+)' THEN (\d+)/g)].map((x) => [x[1], Number(x[2])]))
    expect(db).toEqual(CASH_PRIORITY)
  })

  it('C1/C2: events verified at commit; seq assigned by the database under the entity lock; insert-only', () => {
    has(/^CREATE CONSTRAINT TRIGGER gl_ar_cash_events_verify\s+AFTER INSERT ON gl_ar_cash_events\s+DEFERRABLE INITIALLY DEFERRED/)
    has(/^CREATE CONSTRAINT TRIGGER gl_ar_cash_entries_verify\s+AFTER INSERT ON gl_ar_cash_entries\s+DEFERRABLE INITIALLY DEFERRED/)
    has(/^CREATE TRIGGER gl_ar_cash_events_seq_assign BEFORE INSERT ON gl_ar_cash_events/)
    expect(sql).toMatch(/PERFORM 1 FROM gl_entities WHERE id = NEW\.entity_id FOR UPDATE;\s+NEW\.seq := pg_catalog\.nextval/)
    expect(sql).toMatch(/REVOKE UPDATE ON SEQUENCE gl_ar_cash_events_seq FROM service_role/)
    expect(sql).toMatch(/REVOKE TRIGGER, TRUNCATE, REFERENCES, UPDATE, DELETE ON gl_ar_cash_events, gl_ar_cash_entries FROM service_role/)
    for (const m of sql.matchAll(/SET CONSTRAINTS (gl_journal_entries_balanced[^;]+);/g)) expect(m[1]).toMatch(/gl_ar_cash_events_verify, gl_ar_cash_entries_verify/)
  })

  it('REFUTE-7: replay dates monotonic per lease; billing-order allocation; tie-outs re-verified at commit; cash roles fixed', () => {
    expect(sql).toMatch(/CONSTRAINT gl_ar_cash_events_dates CHECK \(alloc_date >= event_date\)/)
    expect(sql).toMatch(/ORDER BY live\.live, live\.due_date, gl_ar_cash_priority\(live\.type\), live\.id/)
    has(/^CREATE CONSTRAINT TRIGGER gl_ar_tieouts_verify\s+AFTER INSERT ON gl_ar_tieouts\s+DEFERRABLE INITIALLY DEFERRED/)
    has(/^CREATE TRIGGER gl_ar_tieout_items_stamp BEFORE INSERT ON gl_ar_tieout_items/)
    expect(sql).toMatch(/fixed once the AR tie-out is confirmed for this cash-basis entity/)
    expect(sql).toMatch(/deposits do not tie/)
    // The tie-out leaves its commit-time check queued (SET ... IMMEDIATE would consume it).
    const confirm = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION gl_confirm_ar_tieout'))
    expect(confirm.slice(0, confirm.indexOf('$$;'))).not.toMatch(/gl_ar_tieouts_verify IMMEDIATE/)
  })

  it('C3–C5: cash ahead of a live charge refused; tie-out for both bases; guards extended', () => {
    expect(sql).toMatch(/would post before a charge live on its date/)
    expect(sql).toMatch(/v_what := 'tenant credits'/)
    expect(sql).toMatch(/its due date cannot change/)
    expect(sql).toMatch(/NEW\.role IN \('ar', 'undeposited_funds', 'prepaid_rent'\)/)
    expect(sql).toMatch(/FROM gl_ar_cash_events WHERE source_id = p_id/)
  })

  it('write function: service_role only, READ COMMITTED, pinned search_path, no SECURITY DEFINER', () => {
    has(/^REVOKE EXECUTE ON FUNCTION gl_post_ar_cash_batch\(UUID, DATE, JSONB, TEXT\) FROM PUBLIC, anon, authenticated$/)
    has(/^GRANT EXECUTE ON FUNCTION gl_post_ar_cash_batch\(UUID, DATE, JSONB, TEXT\) TO service_role$/)
    expect(sql).not.toMatch(/SECURITY DEFINER/i)
    expect(sql).not.toMatch(/CREATE TEMP TABLE/i)
    const fns = (sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length
    expect((sql.match(/SET search_path = public, pg_temp/g) ?? []).length).toBe(fns)
  })

  it('is refute-gated as a money migration', () => {
    expect(migrationTouchesFinancialTables(sql)).toBe(true)
  })
})
