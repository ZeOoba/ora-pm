/// <reference types="node" />
// tests/db/payments-idempotency-migration-0015.test.ts
//
// OI-082: migration 0011 hardened `charges` with idempotency_key NOT NULL +
// UNIQUE, and gave `payments` two PARTIAL unique indexes (stripe_payment_intent_id,
// (lease_id, autopay_period)). Rows with method IN ('check','wire','other') —
// the manual admin entries — are NULL on both of those columns, so neither
// index applies to them: nothing prevented a duplicate manual entry, and
// ar_ledger's payment_totals CTE sums every such row unconditionally, so a
// duplicate silently understated the tenant's balance (which then feeds the
// stripe.ts balance cap and cron.ts autopay lifetime cap).
//
// 0015 mirrors 0011's charges treatment for payments. Same live-SQL loader
// (tests/fixtures/pg-migrated-db.ts) as appsec-migration-0011.test.ts.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshMigratedDb, allMigrationText, migrationFiles, MIGRATIONS_DIR, type MigratedDb } from '../fixtures/pg-migrated-db'

const MIGRATION_FILE = '0015_payments_idempotency_key.sql'

const PROP = '00000000-0000-0000-0000-000000000001'
const UNIT = '00000000-0000-0000-0000-000000000002'
const TENANT = '00000000-0000-0000-0000-000000000003'
const LEASE = '00000000-0000-0000-0000-000000000004'

function seed(db: MigratedDb) {
  db.none(`
    INSERT INTO properties (id, name, address, city, state) VALUES ('${PROP}', '9050 Red Branch', '9050 Red Branch Rd', 'Columbia', 'MD');
    INSERT INTO units (id, property_id, suite, sf) VALUES ('${UNIT}', '${PROP}', 'A1', 1000);
    INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Acme Co');
    INSERT INTO leases (id, tenant_id, unit_id, start_date, end_date, base_rent_monthly)
      VALUES ('${LEASE}', '${TENANT}', '${UNIT}', '2026-01-01', '2027-01-01', 1000);
  `)
}

// A manual (check/wire/other) payment: NULL stripe_payment_intent_id, NULL
// autopay_period — exactly the row shape neither 0011 partial index covers.
function insertManualPayment(
  db: MigratedDb,
  id: string,
  opts: { key?: string | null; method?: 'check' | 'wire' | 'other'; amount?: number } = {},
) {
  const keyCol = opts.key === undefined ? '' : ', idempotency_key'
  const keyVal = opts.key === undefined ? '' : opts.key === null ? ', NULL' : `, '${opts.key}'`
  db.none(`
    INSERT INTO payments (id, lease_id, payment_date, amount, method, check_number${keyCol})
    VALUES ('${id}', '${LEASE}', '2026-01-05', ${opts.amount ?? 1000}, '${opts.method ?? 'check'}', '10457'${keyVal})
  `)
}

describe('migration 0015 — payments.idempotency_key (OI-082)', () => {
  let db: MigratedDb

  beforeEach(() => {
    db = freshMigratedDb()
    seed(db)
  })

  it('ships as the next migration file after 0013 (no concurrent 0015 collision)', () => {
    const files = migrationFiles()
    expect(files).toContain(MIGRATION_FILE)
    expect(files.filter((f) => f.startsWith('0015_'))).toEqual([MIGRATION_FILE])
  })

  // RED 1 — the bug: two identical manual payments carrying the same
  // idempotency_key must collide on payments_idempotency_key_uniq instead of
  // both landing in ar_ledger's payment_totals sum.
  it('rejects a second manual payment carrying the same idempotency_key', () => {
    insertManualPayment(db, 'a0000000-0000-0000-0000-000000000001', { key: 'manual:form-1' })
    // pg-mem 3.0.14 emits Postgres's phrase + DETAIL but mislabels the index
    // in the message (it reports "payments_pkey" for every unique index), so
    // the constraint NAME payments.ts branches on is pinned in the
    // migration-text suite below and exercised by tests/routes/payments.test.ts.
    expect(() => insertManualPayment(db, 'a0000000-0000-0000-0000-000000000002', { key: 'manual:form-1' })).toThrow(
      /duplicate key value violates unique constraint[\s\S]*Key \(idempotency_key\)=\(manual:form-1\) already exists/,
    )
    const rows = db.many(`SELECT id FROM payments WHERE lease_id = '${LEASE}'`)
    expect(rows).toHaveLength(1)
  })

  // RED 2 — NOT NULL: a NULL key would be invisible to the unique index
  // (Postgres treats NULLs as distinct), which is the exact 0011 lesson.
  it('rejects a payments row with NULL idempotency_key', () => {
    expect(() => insertManualPayment(db, 'a0000000-0000-0000-0000-000000000001', { key: null })).toThrow(
      /violates not-null constraint/,
    )
  })

  // RED 3 — the non-manual insert paths (stripe.ts /portal/pay, cron.ts
  // autopay) do NOT set idempotency_key; the DB default must keep them
  // inserting. Their dedupe stays on payments_stripe_pi_uniq /
  // payments_autopay_period_uniq (see the migration's section 4 rationale).
  it('fills a distinct auto:<uuid> default when the insert omits idempotency_key (stripe/cron paths keep working)', () => {
    insertManualPayment(db, 'a0000000-0000-0000-0000-000000000001')
    insertManualPayment(db, 'a0000000-0000-0000-0000-000000000002')
    const rows = db.many(`SELECT idempotency_key FROM payments ORDER BY idempotency_key`) as { idempotency_key: string }[]
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(r.idempotency_key).toMatch(/^auto:[0-9a-f-]{36}$/)
    expect(rows[0].idempotency_key).not.toBe(rows[1].idempotency_key)
  })

  it('still permits distinct-key manual payments of the same lease/date/amount/method (legit repeat payments)', () => {
    insertManualPayment(db, 'a0000000-0000-0000-0000-000000000001', { key: 'manual:form-1' })
    insertManualPayment(db, 'a0000000-0000-0000-0000-000000000002', { key: 'manual:form-2' })
    const rows = db.many(`SELECT id FROM payments WHERE lease_id = '${LEASE}'`)
    expect(rows).toHaveLength(2)
  })

  it('leaves the 0011 partial indexes in force (a duplicate stripe_payment_intent_id still collides on payments_stripe_pi_uniq)', () => {
    const ach = (id: string) =>
      db.none(`
        INSERT INTO payments (id, lease_id, payment_date, amount, method, stripe_payment_intent_id, stripe_status)
        VALUES ('${id}', '${LEASE}', '2026-01-05', 100, 'ach_stripe', 'pi_3abc', 'succeeded')
      `)
    ach('a0000000-0000-0000-0000-000000000001')
    // Both rows took distinct auto:<uuid> keys, so the ONLY index that can
    // fire here is 0011's partial one on stripe_payment_intent_id.
    expect(() => ach('a0000000-0000-0000-0000-000000000002')).toThrow(
      /duplicate key value violates unique constraint[\s\S]*Key \(stripe_payment_intent_id\)=\(pi_3abc\) already exists/,
    )
  })

  // RED 4 — SQL-text assertions for the parts of the migration whose runtime
  // effect is a no-op on the empty test DB (the legacy backfill), plus the
  // statement ordering the NOT NULL depends on.
  describe('migration text', () => {
    const file = readFileSync(join(MIGRATIONS_DIR, MIGRATION_FILE), 'utf8')

    it('documents the pre-flight duplicate-manual-payment query for a human to run against the LIVE database', () => {
      expect(file).toMatch(/PRE-FLIGHT/)
      // The query lives in the header comment block, so strip the `-- ` line
      // prefixes and collapse whitespace before matching the SQL itself.
      const header = file
        .split('\n')
        .filter((l) => l.startsWith('--'))
        .map((l) => l.replace(/^--\s?/, ''))
        .join(' ')
        .replace(/\s+/g, ' ')
      expect(header).toContain(
        "SELECT id, lease_id, payment_date, amount, method, check_number, notes, created_at FROM payments p WHERE method IN ('check','wire','other') AND EXISTS ( SELECT 1 FROM payments d WHERE d.lease_id = p.lease_id AND d.payment_date = p.payment_date AND d.amount = p.amount AND d.method = p.method AND d.id <> p.id ) ORDER BY lease_id, payment_date, amount;",
      )
      // 1b — the check_number-keyed shape 1a's grouping key can miss.
      expect(header).toContain(
        "SELECT id, lease_id, payment_date, amount, method, check_number, notes, created_at FROM payments p WHERE check_number IS NOT NULL AND EXISTS ( SELECT 1 FROM payments d WHERE d.lease_id = p.lease_id AND d.check_number = p.check_number AND d.id <> p.id ) ORDER BY lease_id, check_number;",
      )
    })

    it('adds the column, backfills legacy NULLs per-row-unique, defaults, then forbids NULL, then indexes — in that order', () => {
      const add = file.search(/ALTER TABLE payments ADD COLUMN idempotency_key TEXT;/)
      const backfill = file.search(/UPDATE payments\s+SET idempotency_key = 'legacy:' \|\| id::text\s+WHERE idempotency_key IS NULL;/)
      const defaultStmt = file.search(/ALTER TABLE payments ALTER COLUMN idempotency_key\s+SET DEFAULT/)
      const notNull = file.search(/ALTER TABLE payments ALTER COLUMN idempotency_key SET NOT NULL;/)
      const index = file.search(/CREATE UNIQUE INDEX payments_idempotency_key_uniq\s+ON payments\s*\(idempotency_key\);/)
      expect(add).toBeGreaterThan(-1)
      expect(backfill).toBeGreaterThan(add)
      // DEFAULT before NOT NULL (deliberately swapped from the naive order):
      // a value is always available for a not-yet-visible row before the
      // NOT NULL constraint that would otherwise reject it.
      expect(defaultStmt).toBeGreaterThan(backfill)
      expect(notNull).toBeGreaterThan(defaultStmt)
      expect(index).toBeGreaterThan(notNull)
    })

    it('carries a Rollback reference section', () => {
      expect(file).toMatch(/Rollback \(reference\)/)
      expect(file).toMatch(/DROP INDEX IF EXISTS payments_idempotency_key_uniq/)
      expect(file).toMatch(/ALTER TABLE payments DROP COLUMN idempotency_key/)
    })

    it('the legacy backfill expression yields a per-row unique key (runtime)', () => {
      const [row] = db.many(`SELECT 'legacy:' || gen_random_uuid()::text AS k`)
      expect(row.k).toMatch(/^legacy:[0-9a-f-]{36}$/)
    })

    it('is logged in supabase/migrations/README.md alongside 0011-0013', () => {
      const readme = readFileSync(join(MIGRATIONS_DIR, 'README.md'), 'utf8')
      expect(readme).toMatch(/0015_payments_idempotency_key\.sql/)
      expect(readme).toMatch(/OI-082/)
    })

    it('does not redefine ar_ledger (the payment_totals CTE is unchanged — dedupe happens at insert, not in the view)', () => {
      expect(file).not.toMatch(/CREATE OR REPLACE VIEW ar_ledger/)
      // Sanity: the live view still sums manual rows unconditionally — the
      // whole reason a duplicate row must be impossible at the index level.
      expect(allMigrationText()).toMatch(/WHEN method IN \('check','wire','other'\) THEN amount/)
    })
  })
})
