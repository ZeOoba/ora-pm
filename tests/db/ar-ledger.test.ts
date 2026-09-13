/// <reference types="node" />
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { newDb } from 'pg-mem'

const MIGRATIONS_DIR = join(__dirname, '../../supabase/migrations')

// Matches the head of an ar_ledger definition, with or without a view-options clause:
//   CREATE OR REPLACE VIEW ar_ledger AS
//   CREATE OR REPLACE VIEW ar_ledger WITH (security_invoker = true) AS
// Anchored to line start (`m` flag) so a copy quoted inside a "--" rollback comment (0014) is
// never mistaken for the live statement.
const AR_LEDGER_HEAD_RE = /^CREATE OR REPLACE VIEW ar_ledger(\s+WITH\s*\([^)]*\))?\s+AS\b/gm

// Extracts a single "CREATE OR REPLACE VIEW <name> ... AS ... ;" statement verbatim starting at
// `from` in `sql`, ending at the statement's OWN terminating ";" — the first ";" that is outside a
// single-quoted string and outside a "--" line comment. Terminating on the statement's own ";"
// (rather than the last ";" before the next CREATE VIEW) lets a migration put further statements
// after the view (0014 re-runs ALTER VIEW ... SET (security_invoker) right after recreating it).
function extractViewStatementAt(sql: string, from: number): string {
  let i = from
  let inString = false
  let inLineComment = false
  while (i < sql.length) {
    const ch = sql[i]
    if (inLineComment) {
      if (ch === '\n') inLineComment = false
    } else if (inString) {
      if (ch === "'") inString = false
    } else if (ch === "'") {
      inString = true
    } else if (ch === '-' && sql[i + 1] === '-') {
      inLineComment = true
    } else if (ch === ';') {
      return sql.slice(from, i + 1).trim()
    }
    i++
  }
  throw new Error('could not find the view statement\'s terminating ";" — extraction boundary may be wrong')
}

// Scans EVERY migration file in filename order and returns the LAST "CREATE OR REPLACE VIEW
// ar_ledger" definition found — i.e. whatever is actually live today, regardless of how many
// migrations have redefined it. This is what makes the test immune to drift: it can never
// silently test stale SQL, and it fails the moment the live view regresses to a fan-out join.
// Returns the raw statement (options clause included) plus the file it came from and the file's
// full text, so the security_invoker assertions below can check the SAME definition pg-mem runs.
export function extractLiveArLedgerView(): { sql: string; file: string; fileSql: string } {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  let latest: { sql: string; file: string; fileSql: string } | null = null
  for (const file of files) {
    const fileSql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    AR_LEDGER_HEAD_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = AR_LEDGER_HEAD_RE.exec(fileSql)) !== null) {
      latest = { sql: extractViewStatementAt(fileSql, m.index), file, fileSql }
    }
  }
  if (!latest) throw new Error('no "CREATE OR REPLACE VIEW ar_ledger" definition found in any migration file')
  return latest
}

// pg-mem 3.0.14 cannot parse a view-options clause (`WITH (security_invoker = true)`), so the
// clause is stripped before the definition is executed here. It is asserted on separately below
// — stripping it for execution must never let its absence in the migration pass unnoticed.
function pgMemExecutable(viewSql: string): string {
  return viewSql.replace(/^CREATE OR REPLACE VIEW ar_ledger\s+WITH\s*\([^)]*\)\s+AS\b/, 'CREATE OR REPLACE VIEW ar_ledger AS')
}

function freshLedgerDb() {
  const db = newDb()
  const { public: pub } = db
  // Column subset the live view reads. `voided_at` (migration 0014): a voided charge stays on the
  // table as an audit row but must not count toward total_charged/balance.
  pub.none(`
    CREATE TABLE properties (id UUID PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE units (id UUID PRIMARY KEY, property_id UUID NOT NULL REFERENCES properties(id), suite TEXT NOT NULL);
    CREATE TABLE tenants (id UUID PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE leases (id UUID PRIMARY KEY, tenant_id UUID NOT NULL REFERENCES tenants(id), unit_id UUID NOT NULL REFERENCES units(id));
    CREATE TABLE charges (id UUID PRIMARY KEY, lease_id UUID NOT NULL REFERENCES leases(id), amount NUMERIC NOT NULL, voided_at TIMESTAMPTZ, void_reason TEXT);
    CREATE TABLE payments (id UUID PRIMARY KEY, lease_id UUID NOT NULL REFERENCES leases(id), amount NUMERIC NOT NULL, method TEXT NOT NULL, stripe_status TEXT);
  `)
  pub.none(pgMemExecutable(extractLiveArLedgerView().sql))
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

  it('returns the property name, not just property_id (cron.ts and reports.ts read ar.property_name)', () => {
    const [row] = db.many(`SELECT property_name FROM ar_ledger WHERE lease_id = '${LEASE}'`)
    expect(row.property_name).toBe('9050 Red Branch')
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

  // OI-278 (migration 0014): a voided charge is an audit row, not money owed. It must be excluded
  // from total_charged (and so from balance) while a sibling non-voided charge still counts.
  it('excludes voided charges from total_charged and balance (voided_at IS NOT NULL)', () => {
    db.none(`
      INSERT INTO charges (id, lease_id, amount, voided_at, void_reason) VALUES
        ('c0000000-0000-0000-0000-000000000001', '${LEASE}', 1000, NULL, NULL),
        ('c0000000-0000-0000-0000-000000000002', '${LEASE}', 50, '2026-09-13T12:00:00Z', 'OI-278 test void');
      INSERT INTO payments (id, lease_id, amount, method, stripe_status) VALUES ('a0000000-0000-0000-0000-000000000001', '${LEASE}', 400, 'check', NULL);
    `)
    const [row] = db.many(`SELECT total_charged, total_paid, balance FROM ar_ledger WHERE lease_id = '${LEASE}'`)
    expect(Number(row.total_charged)).toBe(1000)
    expect(Number(row.total_paid)).toBe(400)
    expect(Number(row.balance)).toBe(600)
  })

  it('a lease whose only charges are voided has a zero balance, not a phantom debit', () => {
    db.none(`
      INSERT INTO charges (id, lease_id, amount, voided_at, void_reason) VALUES
        ('c0000000-0000-0000-0000-000000000001', '${LEASE}', 50, '2026-09-13T12:00:00Z', 'OI-278 test void'),
        ('c0000000-0000-0000-0000-000000000002', '${LEASE}', 50, '2026-09-13T12:00:00Z', 'OI-278 test void');
    `)
    const [row] = db.many(`SELECT total_charged, balance FROM ar_ledger WHERE lease_id = '${LEASE}'`)
    expect(Number(row.total_charged)).toBe(0)
    expect(Number(row.balance)).toBe(0)
  })
})

// OI-079 (migration 0012) set security_invoker = true on ar_ledger so the view runs with the
// caller's privileges and the underlying tables' RLS applies. In Postgres, CREATE OR REPLACE VIEW
// REPLACES the view's whole reloptions list with the new statement's WITH clause — "even if it's
// empty" (src/backend/commands/view.c, DefineVirtualRelation, AT_ReplaceRelOptions; verified
// against REL_15_STABLE 2026-09-13). So any later redefinition without WITH (security_invoker =
// true) silently drops the OI-079 fix. These assertions run against the SAME definition the
// behavioral suite above executes, so they cannot check a stale copy.
describe('ar_ledger view — security_invoker survives redefinition (OI-079 + migration 0014)', () => {
  const live = extractLiveArLedgerView()

  it('the live definition carries WITH (security_invoker = true) in the CREATE statement itself', () => {
    expect(live.sql).toMatch(/^CREATE OR REPLACE VIEW ar_ledger\s+WITH\s*\(\s*security_invoker\s*=\s*true\s*\)\s+AS\b/)
  })

  it('the same migration re-asserts ALTER VIEW ar_ledger SET (security_invoker = true) after the CREATE (belt and braces)', () => {
    const createIdx = live.fileSql.indexOf(live.sql)
    const alterRe = /ALTER VIEW ar_ledger SET \(security_invoker = true\);/g
    const alters: number[] = []
    let m: RegExpExecArray | null
    while ((m = alterRe.exec(live.fileSql)) !== null) alters.push(m.index)
    expect(createIdx).toBeGreaterThan(-1)
    expect(alters.some((idx) => idx > createIdx)).toBe(true)
  })

  it('the live definition is in a migration at or after 0012 (0012 is where security_invoker was introduced)', () => {
    expect(live.file >= '0012').toBe(true)
  })
})
