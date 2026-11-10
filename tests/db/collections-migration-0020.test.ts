/// <reference types="node" />
// B1: promises_to_pay and ar_disputes (supabase/migrations/0020_collections_workflow.sql).
// Runs the REAL migration chain on pg-mem (tests/fixtures/pg-migrations.ts) and exercises each
// constraint; textual assertions cover what pg-mem skips (RLS) and the re-runnable form.
import { describe, it, expect, beforeEach } from 'vitest'
import { freshMigratedDb, migrationFiles, readMigration, splitSqlStatements, statementBody, type MigratedDb } from '../fixtures/pg-migrations'
import { migrationTouchesFinancialTables } from '../../scripts/check-refute-required'

const FILE = '0020_collections_workflow.sql'
const PROP = '00000000-0000-4000-8000-000000000001'
const UNIT = '00000000-0000-4000-8000-000000000002'
const TENANT = '00000000-0000-4000-8000-000000000003'
const LEASE = '00000000-0000-4000-8000-000000000004'
const NOPE = '00000000-0000-4000-8000-000000000099'

function seed(db: MigratedDb) {
  db.none(`
    INSERT INTO properties (id, name, address, city, state) VALUES ('${PROP}', 'Test Park', '1 Test Way', 'Testville', 'OH');
    INSERT INTO units (id, property_id, suite, sf) VALUES ('${UNIT}', '${PROP}', '3', 1000);
    INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Acme Co');
    INSERT INTO leases (id, tenant_id, unit_id, start_date, end_date, base_rent_monthly)
      VALUES ('${LEASE}', '${TENANT}', '${UNIT}', '2026-01-01', '2027-01-01', 1000);
  `)
}

describe('migration 0020 — collections workflow tables (runtime, real SQL on pg-mem)', () => {
  let db: MigratedDb
  beforeEach(() => { db = freshMigratedDb(); seed(db) })

  it('ships as the only 0020 migration', () => {
    expect(migrationFiles().filter((f) => f.startsWith('0020_'))).toEqual([FILE])
  })

  it('a promise defaults to open with no resolved_at', () => {
    db.none(`INSERT INTO promises_to_pay (lease_id, amount, promised_date) VALUES ('${LEASE}', 6340.18, '2026-11-20')`)
    expect(db.one(`SELECT status, resolved_at FROM promises_to_pay`)).toEqual({ status: 'open', resolved_at: null })
  })

  it.each([
    ['zero amount', `('${LEASE}', 0, '2026-11-20', 'open', NULL)`, /promises_to_pay_amount_positive/],
    ['unknown status', `('${LEASE}', 10, '2026-11-20', 'lapsed', now())`, /promises_to_pay_status_check/],
    ['open with resolved_at', `('${LEASE}', 10, '2026-11-20', 'open', now())`, /promises_to_pay_resolved_pair/],
    ['kept without resolved_at', `('${LEASE}', 10, '2026-11-20', 'kept', NULL)`, /promises_to_pay_resolved_pair/],
  ])('promises_to_pay rejects %s', (_n, values, re) => {
    expect(() => db.none(`INSERT INTO promises_to_pay (lease_id, amount, promised_date, status, resolved_at) VALUES ${values}`)).toThrow(re)
  })

  it('promises_to_pay requires a real lease', () => {
    expect(() => db.none(`INSERT INTO promises_to_pay (lease_id, amount, promised_date) VALUES ('${NOPE}', 10, '2026-11-20')`)).toThrow(/foreign key|violates/i)
  })

  it('ar_disputes: amount optional but positive, reason non-blank, status and resolved pair checked', () => {
    db.none(`INSERT INTO ar_disputes (lease_id, reason) VALUES ('${LEASE}', 'CAM 2025')`)
    expect(db.one(`SELECT status, amount FROM ar_disputes`)).toEqual({ status: 'open', amount: null })
    expect(() => db.none(`INSERT INTO ar_disputes (lease_id, amount, reason) VALUES ('${LEASE}', -1, 'x')`)).toThrow(/ar_disputes_amount_positive/)
    expect(() => db.none(`INSERT INTO ar_disputes (lease_id, reason) VALUES ('${LEASE}', '   ')`)).toThrow(/ar_disputes_reason_nonempty/)
    expect(() => db.none(`INSERT INTO ar_disputes (lease_id, reason, status) VALUES ('${LEASE}', 'x', 'closed')`)).toThrow(/ar_disputes_status_check/)
    expect(() => db.none(`INSERT INTO ar_disputes (lease_id, reason, status) VALUES ('${LEASE}', 'x', 'resolved')`)).toThrow(/ar_disputes_resolved_pair/)
  })

  it('records cascade with the lease', () => {
    db.none(`INSERT INTO promises_to_pay (lease_id, amount, promised_date) VALUES ('${LEASE}', 10, '2026-11-20')`)
    db.none(`INSERT INTO ar_disputes (lease_id, reason) VALUES ('${LEASE}', 'x')`)
    db.none(`DELETE FROM leases WHERE id = '${LEASE}'`)
    expect(db.many(`SELECT 1 FROM promises_to_pay`)).toHaveLength(0)
    expect(db.many(`SELECT 1 FROM ar_disputes`)).toHaveLength(0)
  })
})

describe('migration 0020 — text', () => {
  const sql = readMigration(FILE)
  const body = splitSqlStatements(sql).map(statementBody)

  it('enables RLS on both tables and adds no policy (default-deny)', () => {
    expect(body).toContain('ALTER TABLE promises_to_pay ENABLE ROW LEVEL SECURITY')
    expect(body).toContain('ALTER TABLE ar_disputes ENABLE ROW LEVEL SECURITY')
    expect(sql).not.toMatch(/CREATE POLICY/i)
  })

  it('is re-runnable: every CREATE uses IF NOT EXISTS', () => {
    for (const s of body.filter((b) => /^CREATE\b/i.test(b))) expect(s).toMatch(/^CREATE (TABLE|INDEX) IF NOT EXISTS\b/i)
  })

  it('does not reference the money tables (no billing/late-fee/balance coupling)', () => {
    expect(migrationTouchesFinancialTables(sql)).toBe(false)
  })
})
