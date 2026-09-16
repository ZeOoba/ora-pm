/// <reference types="node" />
// Live-SQL migration loader shared by tests/db/** (moved out of
// tests/db/appsec-migration-0011.test.ts so 0014/0016's tests apply the same
// real migration files instead of a second, drift-prone copy of this loader).
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
//  - CREATE OR REPLACE VIEW: the CTE-based ar_ledger redefinitions (0009/0010/
//    0011/0014) and NULLIF/INTERVAL usages (0004) hit pg-mem gaps. Views are
//    not under test in this loader — tests/db/ar-ledger.test.ts covers the
//    live ar_ledger view via its own extraction pattern.
//  - DELETE FROM payments a USING ...: pg-mem cannot parse DELETE ... USING.
//    This is migration 0011's one-time dedupe backfill; it is a no-op on the
//    empty test database, and its presence in the migration TEXT is asserted
//    separately so it cannot be silently dropped.
//  - DROP VIEW IF EXISTS: not parseable; 0011 uses it to release ar_ledger's
//    dependency on charges.amount/payments.amount before ALTER COLUMN TYPE
//    (the drop/recreate ordering is asserted textually).
//  - ALTER VIEW ... SET (security_invoker = true): pg-mem's grammar doesn't
//    recognize this Postgres-15 view-option syntax (0012, OI-079; re-run by
//    0014 after recreating ar_ledger).
//  - DO $$ ... $$: pg-mem ships no plpgsql. 0016's guarded data migration is
//    a DO block; its guard + UPDATE are extracted and verified textually and
//    at runtime (the UPDATE statement alone) by tests/db/charges-void.test.ts.
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
  /^DO\s+\$\$/i,
]

// Splits SQL into statements on ";" while respecting single-quoted strings
// (including '' escapes), "--" line comments, and $$-dollar-quoted bodies (a
// DO block's plpgsql contains its own ";" separators and must stay one
// statement).
export function splitSqlStatements(sql: string): string[] {
  const stmts: string[] = []
  let cur = ''
  let i = 0
  let inString = false
  let inLineComment = false
  let inDollar = false
  while (i < sql.length) {
    const ch = sql[i]
    if (inLineComment) {
      if (ch === '\n') inLineComment = false
      cur += ch
      i++
      continue
    }
    if (inDollar) {
      cur += ch
      if (ch === '$' && sql[i + 1] === '$') {
        cur += '$'
        i += 2
        inDollar = false
        continue
      }
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
    if (ch === '$' && sql[i + 1] === '$') {
      inDollar = true
      cur += '$$'
      i += 2
      continue
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

export function readMigration(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
}

// Strips leading comment lines so the skip regexes see the statement's first
// real token.
export function statementBody(stmt: string): string {
  return stmt.replace(/^(\s*--[^\n]*\n)+/, '').trim()
}

export function freshMigratedDb() {
  const db = newDb()
  const pub = db.public
  // Supabase-environment stubs pg-mem doesn't ship: the auth schema that
  // tenants.auth_user_id references, pgcrypto's gen_random_uuid(), and the
  // btrim() builtin (used by 0014's void-pair CHECK; pg-mem has no string
  // trimming functions at all, so this is the real Postgres semantics).
  pub.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    implementation: () => randomUUID(),
    impure: true,
  })
  pub.registerFunction({
    name: 'btrim',
    args: [DataType.text],
    returns: DataType.text,
    implementation: (s: string | null) => (s === null ? null : s.trim()),
  })
  pub.none('CREATE SCHEMA auth; CREATE TABLE auth.users (id UUID PRIMARY KEY);')
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    for (const stmt of splitSqlStatements(sql)) {
      const body = statementBody(stmt)
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
