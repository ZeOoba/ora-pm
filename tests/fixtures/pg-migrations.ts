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
//  - CREATE EXTENSION btree_gist (0020): pg-mem ships no extensions.
//  - DO $$ ... $$: pg-mem ships no plpgsql. 0017's guarded data migration
//    (OI-278 late-fee void) is a DO block; its guards are pinned textually
//    and its UPDATE is run standalone by tests/db/charges-void.test.ts.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { newDb, DataType } from 'pg-mem'

export const MIGRATIONS_DIR = join(__dirname, '../../supabase/migrations')

export const PG_MEM_SKIP: RegExp[] = [
  /^ALTER TABLE\s+\S+\s+ENABLE ROW LEVEL SECURITY$/i,
  /^CREATE POLICY\b/i,
  /^DROP POLICY IF EXISTS\b/i,
  /^CREATE OR REPLACE VIEW\b/i,
  /^DELETE FROM payments a\s+USING\b/i,
  /^DROP VIEW IF EXISTS\b/i,
  /^ALTER VIEW\s+\S+\s+SET\s*\(\s*security_invoker\s*=\s*true\s*\)$/i,
  /^CREATE (OR REPLACE )?FUNCTION\b/i,
  /^(GRANT|REVOKE)\b/i,
  /^DO\s+\$\$/i,
  // 0020: btree_gist backs the EXCLUDE USING gist overlap guards (themselves inside a DO block above);
  // pg-mem ships no extensions. tests/db/lease-abstraction-migration-0020.test.ts pins both textually.
  /^CREATE EXTENSION IF NOT EXISTS btree_gist$/i,
  // 0019's backfill reads the critical_dates VIEW, which pg-mem never creates (views are skipped
  // above); tests/db/sent-notifications-tier-migration-0019.test.ts runs it standalone.
  /^UPDATE sent_notifications\s+SET alert_tier = CASE\b[\s\S]*\bFROM critical_dates cd\b/i,
  // 0023 (B8 GL core): triggers and constraint triggers carry the ledger's money rules (balanced
  // at commit, immutability, period lock, same-transaction lines). pg-mem parses neither CREATE
  // [CONSTRAINT] TRIGGER nor DROP TRIGGER, and has no plpgsql. Those rules are tested on REAL
  // Postgres by supabase/tests/gl_core.test.sql via scripts/verify-gl-sql.sh; their presence is
  // pinned textually by tests/db/gl-core-migration-0023.test.ts.
  /^(DROP TRIGGER IF EXISTS|CREATE (CONSTRAINT )?TRIGGER)\b/i,
]

// pg-mem gives an unnamed table constraint NO name, while Postgres names it
// <table>_<cols>_key (truncated only past 63 chars). A later migration that drops
// such a constraint by its Postgres name (0019 drops 0003's sent_notifications
// UNIQUE) would fail here though it is correct on Supabase. These rewrites give the
// constraint, in pg-mem only, exactly the name Postgres assigns. Each must match once.
export const PG_MEM_NAME_CONSTRAINTS: { file: string; from: string; to: string }[] = [
  {
    file: '0003_operations_tables.sql',
    from: '  UNIQUE(notification_type, reference_id, recipient)\n',
    to: '  CONSTRAINT sent_notifications_notification_type_reference_id_recipient_key UNIQUE(notification_type, reference_id, recipient)\n',
  },
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
  // btrim()/length() builtins (btrim used by 0016's void-pair CHECK; pg-mem has no string
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
  // length(text) for 0020's tenants.state_of_formation CHECK: character count, NULL-preserving
  // (Array.from counts code points, as Postgres does for a UTF-8 database).
  // text ~ text (POSIX regex match) for 0020's lease_abstracts.file_sha256 CHECK. JS RegExp agrees with
  // Postgres ARE syntax for the anchored character-class patterns used in these migrations.
  pub.registerOperator({
    operator: '~',
    left: DataType.text,
    right: DataType.text,
    returns: DataType.bool,
    implementation: (a: string, b: string) => new RegExp(b).test(a),
  })
  pub.registerFunction({
    name: 'length',
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (s: string | null) => (s === null ? null : Array.from(s).length),
  })
  pub.none('CREATE SCHEMA auth; CREATE TABLE auth.users (id UUID PRIMARY KEY);')
  for (const file of migrationFiles()) {
    let sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8').replace(/\r\n/g, '\n')
    for (const r of PG_MEM_NAME_CONSTRAINTS.filter((x) => x.file === file)) {
      if (sql.split(r.from).length !== 2) throw new Error(`PG_MEM_NAME_CONSTRAINTS: expected exactly one match in ${file} for ${JSON.stringify(r.from)}`)
      sql = sql.replace(r.from, r.to)
    }
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
