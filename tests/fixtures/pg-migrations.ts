// Shared live-SQL migration loader for pg-mem-backed schema tests (extracted
// from tests/db/appsec-migration-0011.test.ts so tests/db/payment-intent-
// migration-0014.test.ts can apply the same real migration chain).
//
// Every supabase/migrations/*.sql file is applied to a fresh pg-mem instance
// in filename order, statement by statement, so these tests exercise the REAL
// migration SQL — they can never drift from what ships to Supabase.
//
// pg-mem 3.x cannot parse/execute a few construct classes, so a fixed,
// explicit skip list exists. Anything NOT on the list that fails to apply
// throws loudly with file + statement context — a future migration that
// pg-mem chokes on surfaces immediately instead of being silently dropped.
//
// Skip list rationale (verified empirically against pg-mem 3.0.14):
//  - ENABLE ROW LEVEL SECURITY / CREATE POLICY: not parseable; RLS behavior
//    is not under test here.
//  - CREATE OR REPLACE VIEW: the CTE-based ar_ledger redefinitions (0009/0010)
//    and NULLIF/INTERVAL usages (0004) hit pg-mem gaps. Views are not under
//    test in this file — tests/db/ar-ledger.test.ts covers the live view via
//    its own extraction pattern.
//  - DELETE FROM payments a USING ...: pg-mem cannot parse DELETE ... USING.
//    This is migration 0011's one-time dedupe backfill; it is a no-op on the
//    empty test database, and its presence in the migration TEXT is asserted
//    separately so it cannot be silently dropped.
//  - DROP VIEW IF EXISTS: not parseable; 0011 uses it to release ar_ledger's
//    dependency on charges.amount/payments.amount before ALTER COLUMN TYPE
//    (the drop/recreate ordering is asserted textually).
//  - ALTER VIEW ... SET (security_invoker = true): pg-mem's grammar doesn't
//    recognize this Postgres-15 view-option syntax (0012, OI-079). Not under
//    test here for the same reason as the other RLS/policy statements above.
//  - CREATE OR REPLACE FUNCTION ... LANGUAGE plpgsql: pg-mem has no plpgsql
//    interpreter and no pg_advisory_xact_lock. 0014's reserve_payment_intent()
//    is skipped here and its structure pinned textually by
//    tests/db/payment-intent-migration-0014.test.ts; its behavior is
//    exercised at the route seam by tests/routes/stripe.test.ts with a
//    stateful stand-in that models the same contract.
//  - GRANT / REVOKE: not parseable; privilege statements are not under test.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { newDb, DataType } from 'pg-mem'

export const MIGRATIONS_DIR = join(__dirname, '../../supabase/migrations')

export const PG_MEM_SKIP: RegExp[] = [
  /^ALTER TABLE\s+\S+\s+ENABLE ROW LEVEL SECURITY$/i,
  /^CREATE POLICY\b/i,
  /^CREATE OR REPLACE VIEW\b/i,
  /^DELETE FROM payments a\s+USING\b/i,
  /^DROP VIEW IF EXISTS\b/i,
  /^ALTER VIEW\s+\S+\s+SET\s*\(\s*security_invoker\s*=\s*true\s*\)$/i,
  /^CREATE (OR REPLACE )?FUNCTION\b/i,
  /^(GRANT|REVOKE)\b/i,
]

// Splits SQL into statements on ";" while respecting single-quoted strings
// (including '' escapes), "--" line comments, and dollar-quoted bodies
// ($$ ... $$ or $tag$ ... $tag$ — a plpgsql function body is full of ";"
// that must NOT terminate the CREATE FUNCTION statement).
export function splitSqlStatements(sql: string): string[] {
  const stmts: string[] = []
  let cur = ''
  let i = 0
  let inString = false
  let inLineComment = false
  let dollarTag: string | null = null
  while (i < sql.length) {
    const ch = sql[i]
    if (inLineComment) {
      if (ch === '\n') inLineComment = false
      cur += ch
      i++
      continue
    }
    if (dollarTag !== null) {
      if (sql.startsWith(dollarTag, i)) {
        cur += dollarTag
        i += dollarTag.length
        dollarTag = null
        continue
      }
      cur += ch
      i++
      continue
    }
    if (inString) {
      cur += ch
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          cur += "'"
          i += 2
          continue
        }
        inString = false
      }
      i++
      continue
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))
      if (m) {
        dollarTag = m[0]
        cur += dollarTag
        i += dollarTag.length
        continue
      }
    }
    if (ch === "'") {
      inString = true
      cur += ch
      i++
      continue
    }
    if (ch === '-' && sql[i + 1] === '-') {
      inLineComment = true
      cur += ch
      i++
      continue
    }
    if (ch === ';') {
      stmts.push(cur.trim())
      cur = ''
      i++
      continue
    }
    cur += ch
    i++
  }
  if (cur.trim()) stmts.push(cur.trim())
  // drop comment-only fragments
  return stmts.filter((s) => s.replace(/--[^\n]*/g, '').trim().length > 0)
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

export function allMigrationText(): string {
  return migrationFiles()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n')
}

export function freshMigratedDb() {
  const db = newDb()
  const pub = db.public
  // Supabase-environment stubs pg-mem doesn't ship: the auth schema that
  // tenants.auth_user_id references, and pgcrypto's gen_random_uuid().
  pub.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    implementation: () => randomUUID(),
    impure: true,
  })
  pub.none('CREATE SCHEMA auth; CREATE TABLE auth.users (id UUID PRIMARY KEY);')
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    for (const stmt of splitSqlStatements(sql)) {
      const body = stmt.replace(/^(\s*--[^\n]*\n)+/, '').trim()
      if (PG_MEM_SKIP.some((re) => re.test(body))) continue
      try {
        pub.none(stmt)
      } catch (e) {
        throw new Error(
          `pg-mem failed to apply a statement from ${file} (add to PG_MEM_SKIP only if genuinely untestable):\n` +
            `${body.slice(0, 200)}\n--- cause: ${(e as Error).message}`,
        )
      }
    }
  }
  return pub
}

export type MigratedDb = ReturnType<typeof freshMigratedDb>
