/// <reference types="node" />
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Migration 0014 — schema half of the payment-intent hardening (OI-065 /
// OI-223 / OI-233). Same live-SQL loader as appsec-migration-0011.test.ts:
// every migration is applied to pg-mem for real, so the column + partial
// unique index below are exercised against the shipped SQL. The plpgsql
// reserve_payment_intent() function cannot run under pg-mem (no plpgsql, no
// pg_advisory_xact_lock) — its STRUCTURE is pinned textually here (lock
// before any read/insert, in-flight statuses, grants) and its CONTRACT is
// exercised at the route seam in tests/routes/stripe.test.ts.
import { MIGRATIONS_DIR, freshMigratedDb } from '../fixtures/pg-migrations'

const FILE_0014 = '0014_payment_intent_pending_row.sql'

const PROP = '00000000-0000-0000-0000-000000000001'
const UNIT = '00000000-0000-0000-0000-000000000002'
const TENANT = '00000000-0000-0000-0000-000000000003'
const LEASE = '00000000-0000-0000-0000-000000000004'

function seed(db: ReturnType<typeof freshMigratedDb>) {
  db.none(`
    INSERT INTO properties (id, name, address, city, state) VALUES ('${PROP}', 'REDACTED-020', 'REDACTED-010', 'Columbia', 'MD');
    INSERT INTO units (id, property_id, suite, sf) VALUES ('${UNIT}', '${PROP}', 'A1', 1000);
    INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Acme Co');
    INSERT INTO leases (id, tenant_id, unit_id, start_date, end_date, base_rent_monthly)
      VALUES ('${LEASE}', '${TENANT}', '${UNIT}', '2026-01-01', '2027-01-01', 1000);
  `)
}

function insertPending(
  db: ReturnType<typeof freshMigratedDb>,
  id: string,
  opts: { clientRequestId?: string | null; pi?: string | null; status?: string } = {},
) {
  const crid = opts.clientRequestId ? `'${opts.clientRequestId}'` : 'NULL'
  const pi = opts.pi ? `'${opts.pi}'` : 'NULL'
  db.none(`
    INSERT INTO payments (id, lease_id, payment_date, amount, method, stripe_payment_intent_id, stripe_status, client_request_id)
    VALUES ('${id}', '${LEASE}', '2026-09-13', 100, 'ach_stripe', ${pi}, '${opts.status ?? 'pending'}', ${crid})
  `)
}

describe('migration 0014 — payments.client_request_id + reserve_payment_intent()', () => {
  let db: ReturnType<typeof freshMigratedDb>

  beforeEach(() => {
    db = freshMigratedDb()
    seed(db)
  })

  // RED 1 (OI-233): a reservation row can be written BEFORE Stripe is called —
  // stripe_payment_intent_id NULL, stripe_status 'pending', keyed only by the
  // client's request id — so a crash after the debit still leaves a trace.
  it('accepts a pending reservation row with a client_request_id and NULL stripe_payment_intent_id', () => {
    insertPending(db, 'a0000000-0000-0000-0000-000000000001', { clientRequestId: 'c0000000-0000-0000-0000-0000000000c1' })
    const rows = db.many(`SELECT client_request_id, stripe_payment_intent_id, stripe_status FROM payments WHERE lease_id = '${LEASE}'`)
    expect(rows).toHaveLength(1)
    expect(rows[0].client_request_id).toBe('c0000000-0000-0000-0000-0000000000c1')
    expect(rows[0].stripe_payment_intent_id).toBeNull()
    expect(rows[0].stripe_status).toBe('pending')
  })

  // RED 2 (OI-065): the same client_request_id can only ever reserve ONE row —
  // a concurrent double-submit serializes on this index instead of both
  // proceeding to Stripe.
  it('rejects a second payments row with the same client_request_id (payments_client_request_id_uniq)', () => {
    insertPending(db, 'a0000000-0000-0000-0000-000000000001', { clientRequestId: 'c0000000-0000-0000-0000-0000000000c1' })
    expect(() =>
      insertPending(db, 'a0000000-0000-0000-0000-000000000002', { clientRequestId: 'c0000000-0000-0000-0000-0000000000c1' }),
    ).toThrow(/duplicate key value violates unique constraint/)
  })

  it('still permits any number of NULL client_request_id rows (checks, wires, autopay from cron.ts)', () => {
    insertPending(db, 'a0000000-0000-0000-0000-000000000001', { clientRequestId: null, pi: 'pi_autopay_1', status: 'processing' })
    insertPending(db, 'a0000000-0000-0000-0000-000000000002', { clientRequestId: null, pi: null, status: 'pending' })
    insertPending(db, 'a0000000-0000-0000-0000-000000000003', { clientRequestId: null, pi: null, status: 'pending' })
    // pg-mem 3.0.14 evaluates `client_request_id IS NULL` to no rows on this
    // ALTER-added column (real Postgres returns all three), so filter in JS.
    const rows = db.many(`SELECT id, client_request_id FROM payments`) as Array<{ id: string; client_request_id: string | null }>
    expect(rows.filter((r) => r.client_request_id === null)).toHaveLength(3)
  })

  it('does not weaken payments_stripe_pi_uniq — a written-back PI id is still one-row-per-PI', () => {
    insertPending(db, 'a0000000-0000-0000-0000-000000000001', { clientRequestId: 'c0000000-0000-0000-0000-0000000000c1', pi: 'pi_x' })
    expect(() =>
      insertPending(db, 'a0000000-0000-0000-0000-000000000002', { clientRequestId: 'c0000000-0000-0000-0000-0000000000c2', pi: 'pi_x' }),
    ).toThrow(/duplicate key value violates unique constraint/)
  })

  describe('reserve_payment_intent() structure (migration text — plpgsql is not executable under pg-mem)', () => {
    const text = readFileSync(join(MIGRATIONS_DIR, FILE_0014), 'utf8')
    const fnStart = text.search(/CREATE OR REPLACE FUNCTION\s+reserve_payment_intent\s*\(/i)
    const fnBody = fnStart === -1 ? '' : text.slice(fnStart)

    it('defines reserve_payment_intent(p_lease_id, p_client_request_id, p_amount_cents, p_notes) in plpgsql', () => {
      expect(fnStart).toBeGreaterThan(-1)
      expect(fnBody).toMatch(/p_lease_id\s+UUID/i)
      expect(fnBody).toMatch(/p_client_request_id\s+UUID/i)
      expect(fnBody).toMatch(/p_amount_cents\s+BIGINT/i)
      expect(fnBody).toMatch(/p_notes\s+TEXT/i)
      expect(fnBody).toMatch(/LANGUAGE\s+plpgsql/i)
    })

    // OI-065: the per-lease advisory lock must be taken BEFORE the balance is
    // read and BEFORE the reservation row is inserted — otherwise two
    // concurrent requests for the same lease can both read the same stale
    // balance and both reserve.
    it('takes a per-lease pg_advisory_xact_lock before reading ar_ledger, before summing in-flight rows, and before inserting', () => {
      const lock = fnBody.search(/pg_advisory_xact_lock\s*\(/i)
      const ledgerRead = fnBody.search(/FROM\s+ar_ledger/i)
      const inFlightRead = fnBody.search(/stripe_status\s+IN\s*\(\s*'pending'\s*,\s*'processing'\s*\)/i)
      const insert = fnBody.search(/INSERT INTO\s+payments/i)
      expect(lock).toBeGreaterThan(-1)
      expect(ledgerRead).toBeGreaterThan(-1)
      expect(inFlightRead).toBeGreaterThan(-1)
      expect(insert).toBeGreaterThan(-1)
      expect(lock).toBeLessThan(ledgerRead)
      expect(lock).toBeLessThan(inFlightRead)
      expect(lock).toBeLessThan(insert)
      // Keyed by the lease — not a global lock (which would serialize every
      // tenant's payments behind each other).
      expect(fnBody).toMatch(/pg_advisory_xact_lock\s*\([^)]*p_lease_id/i)
    })

    // OI-223: in-flight ACH (pending + processing) must be subtracted from the
    // ar_ledger balance inside the same locked transaction — ar_ledger itself
    // only credits 'succeeded' and is deliberately NOT changed by 0014.
    it('subtracts in-flight ach_stripe rows (pending/processing) from the ar_ledger balance and leaves the ar_ledger view untouched', () => {
      expect(fnBody).toMatch(/method\s*=\s*'ach_stripe'/i)
      expect(fnBody).toMatch(/stripe_status\s+IN\s*\(\s*'pending'\s*,\s*'processing'\s*\)/i)
      expect(text).not.toMatch(/CREATE OR REPLACE VIEW\s+ar_ledger/i)
      expect(text).not.toMatch(/DROP VIEW/i)
    })

    it("inserts the reservation with stripe_status 'pending', method 'ach_stripe' and a NULL stripe_payment_intent_id", () => {
      const insertStmt = /INSERT INTO\s+payments\s*\([^)]*\)\s*VALUES\s*\([^;]*\)/i.exec(fnBody)?.[0] ?? ''
      expect(insertStmt).not.toBe('')
      expect(insertStmt).toMatch(/'ach_stripe'/)
      expect(insertStmt).toMatch(/'pending'/)
      expect(insertStmt).toMatch(/p_client_request_id/)
    })

    it('returns the four documented outcomes', () => {
      for (const outcome of ['reserved', 'existing', 'no_balance', 'exceeds_balance']) {
        expect(fnBody).toMatch(new RegExp(`'outcome'\\s*,\\s*'${outcome}'`))
      }
    })

    // Service-role only: the function reads ar_ledger across tenants and
    // writes payments. anon/authenticated (the keys that ship in the client
    // bundle) must not be able to call it via PostgREST /rpc.
    it('is executable only by service_role (REVOKE from PUBLIC/anon/authenticated, GRANT to service_role)', () => {
      expect(text).toMatch(/REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+reserve_payment_intent\s*\([^)]*\)\s+FROM\s+PUBLIC\s*,\s*anon\s*,\s*authenticated/i)
      expect(text).toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+reserve_payment_intent\s*\([^)]*\)\s+TO\s+service_role/i)
    })

    it('follows the 0011 documentation shape: PRE-FLIGHT section, numbered body, Rollback reference', () => {
      expect(text).toMatch(/PRE-FLIGHT/)
      expect(text).toMatch(/^-- 1\)/m)
      expect(text).toMatch(/^-- 2\)/m)
      expect(text).toMatch(/Rollback \(reference\)/)
      expect(text).toMatch(/CREATE UNIQUE INDEX payments_client_request_id_uniq\s+ON payments\(client_request_id\)\s+WHERE client_request_id IS NOT NULL/)
    })
  })
})
