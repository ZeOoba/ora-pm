import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { newDb } from 'pg-mem'

const MIGRATIONS_DIR = join(__dirname, '../../supabase/migrations')

// Extracts a single "CREATE OR REPLACE VIEW <name> AS ... ;" statement verbatim starting at `from`
// in `sql`, ending at the LAST ";" before the next CREATE/top-level statement (so a trailing
// comment line before the next statement isn't swept into the extracted text).
function extractViewStatementAt(sql: string, from: number): string {
  const nextStmtStart = sql.indexOf('CREATE OR REPLACE VIEW', from + 1)
  const searchEnd = nextStmtStart === -1 ? sql.length : nextStmtStart
  const terminatingSemicolon = sql.lastIndexOf(';', searchEnd)
  if (terminatingSemicolon === -1 || terminatingSemicolon < from) {
    throw new Error('could not find the view statement\'s terminating ";" — extraction boundary may be wrong')
  }
  const stmt = sql.slice(from, terminatingSemicolon + 1).trim()
  if (!stmt.endsWith(';')) throw new Error('view statement did not end with ";" as expected — extraction boundary may be wrong')
  return stmt
}

// Scans EVERY migration file in filename order and returns the LAST "CREATE OR REPLACE VIEW
// ar_ledger" definition found — i.e. whatever is actually live today, regardless of how many
// migrations have redefined it. This is what makes the test immune to drift: it can never
// silently test stale SQL, and it fails the moment the live view regresses to a fan-out join.
function extractLiveArLedgerViewSql(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  let latest: string | null = null
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    let searchFrom = 0
    for (;;) {
      const idx = sql.indexOf('CREATE OR REPLACE VIEW ar_ledger AS', searchFrom)
      if (idx === -1) break
      latest = extractViewStatementAt(sql, idx)
      searchFrom = idx + 1
    }
  }
  if (!latest) throw new Error('no "CREATE OR REPLACE VIEW ar_ledger" definition found in any migration file')
  return latest
}

function freshLedgerDb() {
  const db = newDb()
  const { public: pub } = db
  pub.none(`
    CREATE TABLE properties (id UUID PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE units (id UUID PRIMARY KEY, property_id UUID NOT NULL REFERENCES properties(id), suite TEXT NOT NULL);
    CREATE TABLE tenants (id UUID PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE leases (id UUID PRIMARY KEY, tenant_id UUID NOT NULL REFERENCES tenants(id), unit_id UUID NOT NULL REFERENCES units(id));
    CREATE TABLE charges (id UUID PRIMARY KEY, lease_id UUID NOT NULL REFERENCES leases(id), amount NUMERIC NOT NULL);
    CREATE TABLE payments (id UUID PRIMARY KEY, lease_id UUID NOT NULL REFERENCES leases(id), amount NUMERIC NOT NULL, method TEXT NOT NULL, stripe_status TEXT);
  `)
  pub.none(extractLiveArLedgerViewSql())
  return pub
}

const PROP = '00000000-0000-0000-0000-000000000001'
const UNIT = '00000000-0000-0000-0000-000000000002'
const TENANT = '00000000-0000-0000-0000-000000000003'
const LEASE = '00000000-0000-0000-0000-000000000004'

describe('ar_ledger view — balance arithmetic under multiple charges + payments', () => {
  let db: ReturnType<typeof freshLedgerDb>

  beforeEach(() => {
    db = freshLedgerDb()
    db.none(`
      INSERT INTO properties (id, name) VALUES ('${PROP}', '9050 Red Branch');
      INSERT INTO units (id, property_id, suite) VALUES ('${UNIT}', '${PROP}', 'A1');
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Acme Co');
      INSERT INTO leases (id, tenant_id, unit_id) VALUES ('${LEASE}', '${TENANT}', '${UNIT}');
    `)
  })

  it('computes the correct balance for a single charge and single payment (the case the old view got right)', () => {
    db.none(`
      INSERT INTO charges (id, lease_id, amount) VALUES ('c0000000-0000-0000-0000-000000000001', '${LEASE}', 1000);
      INSERT INTO payments (id, lease_id, amount, method, stripe_status) VALUES ('a0000000-0000-0000-0000-000000000001', '${LEASE}', 400, 'check', NULL);
    `)
    const [row] = db.many(`SELECT total_charged, total_paid, balance FROM ar_ledger WHERE lease_id = '${LEASE}'`)
    expect(Number(row.total_charged)).toBe(1000)
    expect(Number(row.total_paid)).toBe(400)
    expect(Number(row.balance)).toBe(600)
  })

  it('computes the correct balance with 2 charges and 2 payments — the fan-out case', () => {
    // Ground truth: 2 charges totalling 1500, 2 payments totalling 900 -> balance 600.
    // The buggy view (LEFT JOIN charges + LEFT JOIN payments + single GROUP BY) instead produces a
    // 2x2=4-row cross join per lease, summing each charge twice and each payment twice.
    db.none(`
      INSERT INTO charges (id, lease_id, amount) VALUES
        ('c0000000-0000-0000-0000-000000000001', '${LEASE}', 1000),
        ('c0000000-0000-0000-0000-000000000002', '${LEASE}', 500);
      INSERT INTO payments (id, lease_id, amount, method, stripe_status) VALUES
        ('a0000000-0000-0000-0000-000000000001', '${LEASE}', 400, 'check', NULL),
        ('a0000000-0000-0000-0000-000000000002', '${LEASE}', 500, 'ach_stripe', 'succeeded');
    `)
    const [row] = db.many(`SELECT total_charged, total_paid, balance FROM ar_ledger WHERE lease_id = '${LEASE}'`)
    expect(Number(row.total_charged)).toBe(1500)
    expect(Number(row.total_paid)).toBe(900)
    expect(Number(row.balance)).toBe(600)
  })

  it('a lease with 3 charges and 0 payments shows the full amount owed, not tripled or zeroed', () => {
    db.none(`
      INSERT INTO charges (id, lease_id, amount) VALUES
        ('c0000000-0000-0000-0000-000000000001', '${LEASE}', 300),
        ('c0000000-0000-0000-0000-000000000002', '${LEASE}', 300),
        ('c0000000-0000-0000-0000-000000000003', '${LEASE}', 300);
    `)
    const [row] = db.many(`SELECT total_charged, total_paid, balance FROM ar_ledger WHERE lease_id = '${LEASE}'`)
    expect(Number(row.total_charged)).toBe(900)
    expect(Number(row.total_paid)).toBe(0)
    expect(Number(row.balance)).toBe(900)
  })

  it('a lease with 0 charges and 0 payments has a zero balance (no phantom rows from the joins)', () => {
    const [row] = db.many(`SELECT total_charged, total_paid, balance FROM ar_ledger WHERE lease_id = '${LEASE}'`)
    expect(Number(row.total_charged)).toBe(0)
    expect(Number(row.total_paid)).toBe(0)
    expect(Number(row.balance)).toBe(0)
  })

  it('an unsuccessful Stripe payment does not count toward total_paid (unrelated to the fan-out, guards the CASE logic survives the rewrite)', () => {
    db.none(`
      INSERT INTO charges (id, lease_id, amount) VALUES ('c0000000-0000-0000-0000-000000000001', '${LEASE}', 1000);
      INSERT INTO payments (id, lease_id, amount, method, stripe_status) VALUES ('a0000000-0000-0000-0000-000000000001', '${LEASE}', 1000, 'ach_stripe', 'pending');
    `)
    const [row] = db.many(`SELECT total_charged, total_paid, balance FROM ar_ledger WHERE lease_id = '${LEASE}'`)
    expect(Number(row.total_paid)).toBe(0)
    expect(Number(row.balance)).toBe(1000)
  })

  it('two leases with different charge/payment counts do not contaminate each other (the exact shape a fan-out regression would break)', () => {
    const TENANT_B = '00000000-0000-0000-0000-000000000005'
    const UNIT_B = '00000000-0000-0000-0000-000000000006'
    const LEASE_B = '00000000-0000-0000-0000-000000000007'
    db.none(`
      INSERT INTO units (id, property_id, suite) VALUES ('${UNIT_B}', '${PROP}', 'B2');
      INSERT INTO tenants (id, name) VALUES ('${TENANT_B}', 'Beta LLC');
      INSERT INTO leases (id, tenant_id, unit_id) VALUES ('${LEASE_B}', '${TENANT_B}', '${UNIT_B}');

      INSERT INTO charges (id, lease_id, amount) VALUES
        ('c0000000-0000-0000-0000-000000000001', '${LEASE}', 1000),
        ('c0000000-0000-0000-0000-000000000002', '${LEASE}', 500);
      INSERT INTO payments (id, lease_id, amount, method, stripe_status) VALUES
        ('a0000000-0000-0000-0000-000000000001', '${LEASE}', 400, 'check', NULL),
        ('a0000000-0000-0000-0000-000000000002', '${LEASE}', 500, 'ach_stripe', 'succeeded');

      INSERT INTO charges (id, lease_id, amount) VALUES
        ('c0000000-0000-0000-0000-000000000004', '${LEASE_B}', 300);
      INSERT INTO payments (id, lease_id, amount, method, stripe_status) VALUES
        ('a0000000-0000-0000-0000-000000000004', '${LEASE_B}', 100, 'check', NULL),
        ('a0000000-0000-0000-0000-000000000005', '${LEASE_B}', 100, 'check', NULL),
        ('a0000000-0000-0000-0000-000000000006', '${LEASE_B}', 100, 'check', NULL);
    `)
    const rows = db.many(`SELECT lease_id, total_charged, total_paid, balance FROM ar_ledger ORDER BY lease_id`)
    expect(rows).toHaveLength(2)
    const a = rows.find((r) => r.lease_id === LEASE)!
    const b = rows.find((r) => r.lease_id === LEASE_B)!
    expect(Number(a.total_charged)).toBe(1500)
    expect(Number(a.total_paid)).toBe(900)
    expect(Number(a.balance)).toBe(600)
    expect(Number(b.total_charged)).toBe(300)
    expect(Number(b.total_paid)).toBe(300)
    expect(Number(b.balance)).toBe(0)
  })
})
