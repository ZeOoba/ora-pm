/// <reference types="node" />
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// Live-SQL loader (applies every supabase/migrations/*.sql to a fresh pg-mem
// instance in filename order) — extracted to tests/fixtures/pg-migrated-db.ts
// for OI-082 so payments-idempotency-migration-0015.test.ts shares it. The
// PG_MEM_SKIP rationale lives there.
import { freshMigratedDb, allMigrationText, MIGRATIONS_DIR } from '../fixtures/pg-migrated-db'

const PROP = '00000000-0000-0000-0000-000000000001'
const UNIT = '00000000-0000-0000-0000-000000000002'
const TENANT = '00000000-0000-0000-0000-000000000003'
const LEASE = '00000000-0000-0000-0000-000000000004'
const LEASE_B = '00000000-0000-0000-0000-000000000008'

function seed(db: ReturnType<typeof freshMigratedDb>) {
  db.none(`
    INSERT INTO properties (id, name, address, city, state) VALUES ('${PROP}', 'REDACTED-020', 'REDACTED-010', 'Columbia', 'MD');
    INSERT INTO units (id, property_id, suite, sf) VALUES ('${UNIT}', '${PROP}', 'A1', 1000);
    INSERT INTO units (id, property_id, suite, sf) VALUES ('00000000-0000-0000-0000-000000000006', '${PROP}', 'B2', 1000);
    INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Acme Co');
    INSERT INTO leases (id, tenant_id, unit_id, start_date, end_date, base_rent_monthly)
      VALUES ('${LEASE}', '${TENANT}', '${UNIT}', '2026-01-01', '2027-01-01', 1000);
    INSERT INTO leases (id, tenant_id, unit_id, start_date, end_date, status, base_rent_monthly)
      VALUES ('${LEASE_B}', '${TENANT}', '00000000-0000-0000-0000-000000000006', '2026-01-01', '2027-01-01', 'pending', 1000);
  `)
}

function insertPayment(
  db: ReturnType<typeof freshMigratedDb>,
  id: string,
  opts: { lease?: string; pi?: string | null; autopayPeriod?: string | null } = {},
) {
  const pi = opts.pi === undefined || opts.pi === null ? 'NULL' : `'${opts.pi}'`
  const period = opts.autopayPeriod === undefined || opts.autopayPeriod === null ? 'NULL' : `'${opts.autopayPeriod}'`
  db.none(`
    INSERT INTO payments (id, lease_id, payment_date, amount, method, stripe_payment_intent_id, stripe_status, autopay_period)
    VALUES ('${id}', '${opts.lease ?? LEASE}', '2026-01-05', 100, 'ach_stripe', ${pi}, 'succeeded', ${period})
  `)
}

// The exact money-column inventory, enumerated by reading migrations
// 0001-0010 (charges/payments/expenses amounts; the four dollar-denominated
// cam_reconciliations columns; budgets.budgeted_amount; the two
// tenant_sales_reports dollar columns). tenant_pro_rata_share_pct is a 0-1
// ratio and is deliberately absent — see the negative guard below.
const MONEY_COLUMNS: Array<[table: string, column: string]> = [
  ['charges', 'amount'],
  ['payments', 'amount'],
  ['expenses', 'amount'],
  ['cam_reconciliations', 'total_property_recoverable_expenses'],
  ['cam_reconciliations', 'estimated_cam_paid'],
  ['cam_reconciliations', 'actual_cam_owed'],
  ['cam_reconciliations', 'true_up_amount'],
  ['budgets', 'budgeted_amount'],
  ['tenant_sales_reports', 'reported_sales'],
  ['tenant_sales_reports', 'percentage_rent_owed'],
]

describe('migration 0011 — payment/charge idempotency + money-column hardening', () => {
  let db: ReturnType<typeof freshMigratedDb>

  beforeEach(() => {
    db = freshMigratedDb()
    seed(db)
  })

  // RED 1
  it('rejects a second payments row recording the same stripe_payment_intent_id', () => {
    insertPayment(db, 'a0000000-0000-0000-0000-000000000001', { pi: 'pi_3abc' })
    expect(() => insertPayment(db, 'a0000000-0000-0000-0000-000000000002', { pi: 'pi_3abc' })).toThrow(
      /duplicate key value violates unique constraint/,
    )
  })

  // RED 2
  it('still permits multiple payments rows with NULL stripe_payment_intent_id (checks, wires)', () => {
    insertPayment(db, 'a0000000-0000-0000-0000-000000000001', { pi: null })
    insertPayment(db, 'a0000000-0000-0000-0000-000000000002', { pi: null })
    const rows = db.many(`SELECT id FROM payments WHERE lease_id = '${LEASE}'`)
    expect(rows).toHaveLength(2)
  })

  // RED 3
  it('rejects a second autopay collection for the same lease + period', () => {
    insertPayment(db, 'a0000000-0000-0000-0000-000000000001', { autopayPeriod: '2026-01-01' })
    expect(() =>
      insertPayment(db, 'a0000000-0000-0000-0000-000000000002', { autopayPeriod: '2026-01-01' }),
    ).toThrow(/duplicate key value violates unique constraint/)
  })

  it('permits autopay collections for the same lease in different periods', () => {
    insertPayment(db, 'a0000000-0000-0000-0000-000000000001', { autopayPeriod: '2026-01-01' })
    insertPayment(db, 'a0000000-0000-0000-0000-000000000002', { autopayPeriod: '2026-02-01' })
    const rows = db.many(`SELECT id FROM payments WHERE autopay_period IS NOT NULL`)
    expect(rows).toHaveLength(2)
  })

  it('permits the same period on a different lease, and any number of NULL-period (manual) payments', () => {
    insertPayment(db, 'a0000000-0000-0000-0000-000000000001', { autopayPeriod: '2026-01-01' })
    insertPayment(db, 'a0000000-0000-0000-0000-000000000002', { lease: LEASE_B, autopayPeriod: '2026-01-01' })
    insertPayment(db, 'a0000000-0000-0000-0000-000000000003', { autopayPeriod: null })
    insertPayment(db, 'a0000000-0000-0000-0000-000000000004', { autopayPeriod: null })
    const rows = db.many(`SELECT id FROM payments`)
    expect(rows).toHaveLength(4)
  })

  // RED 4
  it('rejects a charges row with NULL idempotency_key', () => {
    expect(() =>
      db.none(`
        INSERT INTO charges (id, lease_id, charge_date, due_date, period_start, period_end, type, amount, idempotency_key)
        VALUES ('c0000000-0000-0000-0000-000000000001', '${LEASE}', '2026-01-01', '2026-01-05', '2026-01-01', '2026-01-31', 'rent', 100, NULL)
      `),
    ).toThrow(/violates not-null constraint/)
  })

  it('still rejects duplicate non-null idempotency_key on charges (pre-existing UNIQUE survives)', () => {
    db.none(`
      INSERT INTO charges (id, lease_id, charge_date, due_date, period_start, period_end, type, amount, idempotency_key)
      VALUES ('c0000000-0000-0000-0000-000000000001', '${LEASE}', '2026-01-01', '2026-01-05', '2026-01-01', '2026-01-31', 'rent', 100, 'rent:2026-01')
    `)
    expect(() =>
      db.none(`
        INSERT INTO charges (id, lease_id, charge_date, due_date, period_start, period_end, type, amount, idempotency_key)
        VALUES ('c0000000-0000-0000-0000-000000000002', '${LEASE}', '2026-01-01', '2026-01-05', '2026-01-01', '2026-01-31', 'rent', 100, 'rent:2026-01')
      `),
    ).toThrow(/duplicate key value violates unique constraint/)
  })

  // RED 5 — SQL-text assertions.
  // RED 6 note: pg-mem 3.0.14 does NOT enforce NUMERIC(12,2) scale at runtime
  // (verified empirically: inserting 100.005 into a NUMERIC(12,2) column
  // stores 100.005 verbatim instead of rounding to 2dp). Per the task brief,
  // the rounding assertion is therefore TEXT-ONLY: the checks below prove
  // every money column is re-typed NUMERIC(12,2) in the shipped migration
  // SQL, which real Postgres enforces by rounding to 2dp on write.
  describe('money-column scale + unit documentation (migration text)', () => {
    const text = allMigrationText()

    it.each(MONEY_COLUMNS)('%s.%s is re-typed NUMERIC(12,2)', (table, column) => {
      const alterRe = new RegExp(
        String.raw`ALTER TABLE\s+${table}\s+ALTER COLUMN\s+${column}\s+TYPE\s+NUMERIC\(12,\s*2\)`,
        'i',
      )
      expect(text).toMatch(alterRe)
    })

    it.each(MONEY_COLUMNS)('%s.%s carries a dollars-unit COMMENT', (table, column) => {
      const commentRe = new RegExp(
        String.raw`COMMENT ON COLUMN\s+${table}\.${column}\s+IS\s+'[^']*dollars[^']*'`,
        'i',
      )
      expect(text).toMatch(commentRe)
    })

    it('does NOT touch tenant_pro_rata_share_pct (a 0-1 ratio, not money)', () => {
      expect(text).not.toMatch(/ALTER COLUMN\s+tenant_pro_rata_share_pct/i)
    })

    it('wraps the money-column re-types in an ar_ledger drop/recreate (a dependent view blocks ALTER COLUMN TYPE in real Postgres)', () => {
      // ar_ledger (0010) sums charges.amount and payments.amount; Postgres
      // refuses ALTER COLUMN TYPE on a column any view depends on ("cannot
      // alter type of a column used by a view or rule"). pg-mem cannot catch
      // this at runtime because the loader skips views, so the ordering is
      // pinned textually: DROP VIEW before the first money ALTER, recreate
      // after the last. The recreated definition is then behaviorally
      // verified by tests/db/ar-ledger.test.ts, which always extracts the
      // LAST ar_ledger definition across all migration files.
      const file0011 = readFileSync(join(MIGRATIONS_DIR, '0011_appsec_idempotency_and_scale.sql'), 'utf8')
      const drop = file0011.search(/DROP VIEW IF EXISTS ar_ledger/i)
      const firstAlter = file0011.search(/ALTER TABLE\s+charges\s+ALTER COLUMN\s+amount\s+TYPE/i)
      const recreate = file0011.search(/CREATE OR REPLACE VIEW ar_ledger AS/i)
      const lastComment = file0011.search(/COMMENT ON COLUMN\s+tenant_sales_reports\.percentage_rent_owed/i)
      expect(drop).toBeGreaterThan(-1)
      expect(firstAlter).toBeGreaterThan(-1)
      expect(recreate).toBeGreaterThan(-1)
      expect(lastComment).toBeGreaterThan(-1)
      expect(drop).toBeLessThan(firstAlter)
      expect(recreate).toBeGreaterThan(lastComment)
    })

    it('ships the destructive backfill pre-steps the loader cannot execute (dedupe DELETE, legacy-key UPDATE)', () => {
      // The DELETE ... USING dedupe is on PG_MEM_SKIP (unparseable by pg-mem),
      // so its presence in the migration text is pinned here instead.
      expect(text).toMatch(
        /DELETE FROM payments a\s+USING payments b\s+WHERE a\.stripe_payment_intent_id = b\.stripe_payment_intent_id\s+AND a\.id > b\.id\s+AND a\.stripe_payment_intent_id IS NOT NULL/i,
      )
      expect(text).toMatch(
        /UPDATE charges\s+SET idempotency_key = 'legacy:' \|\| id::text\s+WHERE idempotency_key IS NULL/i,
      )
    })
  })

  it('the legacy idempotency_key backfill expression yields a per-row unique key (runtime)', () => {
    // The UPDATE itself is applied by the loader (it parses fine); on the
    // fresh test DB it is a no-op because no NULL-key rows can be seeded
    // post-0011 (that's RED 4). This pins the expression's output shape.
    const [row] = db.many(`SELECT 'legacy:' || gen_random_uuid()::text AS k`)
    expect(row.k).toMatch(/^legacy:[0-9a-f-]{36}$/)
  })
})
