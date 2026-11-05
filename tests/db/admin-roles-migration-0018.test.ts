/// <reference types="node" />
// tests/db/admin-roles-migration-0018.test.ts
//
// P1 T12 (roadmap gap G10): the admin roles DATA MODEL — admin_users(email, role, entity_scope).
// server/middleware/admin-auth.ts records the role on the request context; nothing enforces it in
// P1, and ADMIN_EMAILS stays the sole authority for admin access (pinned by
// tests/middleware/admin-auth.test.ts).
//
// Runtime assertions run the REAL migration chain on pg-mem (tests/fixtures/pg-migrations.ts), so
// they can never drift from the SQL that ships. pg-mem cannot execute ENABLE ROW LEVEL SECURITY
// (it is on PG_MEM_SKIP), so the default-deny posture is pinned textually instead — the same
// manifest-style check tests/db/rls-inventory-remaining-tables.test.ts applies to 0013.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import {
  PG_MEM_SKIP,
  freshMigratedDb,
  migrationFiles,
  readMigration,
  splitSqlStatements,
  statementBody,
  type MigratedDb,
} from '../fixtures/pg-migrations'

const FILE = '0018_admin_roles.sql'
const VERIFY_RLS = join(__dirname, '../../scripts/verify-rls.sql')
const CHECK_NAMES = ['admin_users_email_lowercase', 'admin_users_email_trimmed_nonempty', 'admin_users_role_check']
const ROLES = ['owner', 'manager', 'bookkeeper', 'viewer']
const SCOPE_A = '00000000-0000-0000-0000-00000000000a'
const SCOPE_B = '00000000-0000-0000-0000-00000000000b'

function insertAdmin(db: MigratedDb, email: string, role: string) {
  db.none(`INSERT INTO admin_users (email, role) VALUES ('${email}', '${role}')`)
}

describe('migration 0018 — admin_users (runtime, real migration SQL on pg-mem)', () => {
  let db: MigratedDb
  beforeEach(() => {
    db = freshMigratedDb()
  })

  it('ships as the only 0018 migration file', () => {
    expect(migrationFiles().filter((f) => f.startsWith('0018_'))).toEqual([FILE])
  })

  it('creates admin_users; a minimal row gets a generated uuid id, a created_at, and a NULL entity_scope', () => {
    insertAdmin(db, 'manager@example.test', 'manager')
    const rows = db.many(`SELECT id, email, role, entity_scope, created_at FROM admin_users`)
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(row.email).toBe('manager@example.test')
    expect(row.role).toBe('manager')
    expect(row.entity_scope).toBeNull()
    expect(row.created_at).not.toBeNull()
  })

  it('accepts each of the four roles', () => {
    for (const role of ROLES) insertAdmin(db, `${role}@example.test`, role)
    const roles = db.many(`SELECT role FROM admin_users ORDER BY role`).map((r) => r.role)
    expect(roles).toEqual([...ROLES].sort())
  })

  it("rejects a role outside the four ('admin')", () => {
    expect(() => insertAdmin(db, 'someone@example.test', 'admin')).toThrow(/check constraint "admin_users_role_check"/)
  })

  it('rejects role values that differ only by case or are blank', () => {
    expect(() => insertAdmin(db, 'a@example.test', 'Owner')).toThrow(/check constraint "admin_users_role_check"/)
    expect(() => insertAdmin(db, 'b@example.test', '')).toThrow(/check constraint "admin_users_role_check"/)
  })

  it("rejects a mixed-case email ('Gabriel@X.com') — emails are stored lower-cased", () => {
    expect(() => insertAdmin(db, 'Gabriel@X.com', 'viewer')).toThrow(/check constraint "admin_users_email_lowercase"/)
    insertAdmin(db, 'gabriel@x.com', 'viewer')
    expect(db.many(`SELECT email FROM admin_users`).map((r) => r.email)).toEqual(['gabriel@x.com'])
  })

  it('rejects an UPDATE that would store a mixed-case email', () => {
    insertAdmin(db, 'gabriel@x.com', 'viewer')
    expect(() => db.none(`UPDATE admin_users SET email = 'Gabriel@x.com'`)).toThrow(/check constraint "admin_users_email_lowercase"/)
  })

  // The middleware looks rows up by the exact lower-cased auth email, so a padded or empty email
  // could never match anyone: it would only be a silently dead row.
  it.each([
    ['a leading space', ' a@x.com'],
    ['a trailing space', 'a@x.com '],
    ['an empty string', ''],
    ['only spaces', '   '],
  ])('rejects an email with %s (admin_users_email_trimmed_nonempty)', (_label, email) => {
    expect(() => insertAdmin(db, email, 'viewer')).toThrow(/check constraint "admin_users_email_trimmed_nonempty"/)
    expect(db.many(`SELECT email FROM admin_users`)).toEqual([])
  })

  it('rejects an UPDATE that would pad or blank a stored email', () => {
    insertAdmin(db, 'a@x.com', 'viewer')
    expect(() => db.none(`UPDATE admin_users SET email = ' a@x.com'`)).toThrow(/check constraint "admin_users_email_trimmed_nonempty"/)
    expect(() => db.none(`UPDATE admin_users SET email = ''`)).toThrow(/check constraint "admin_users_email_trimmed_nonempty"/)
    expect(db.many(`SELECT email FROM admin_users`).map((r) => r.email)).toEqual(['a@x.com'])
  })

  it('rejects a second row for the same email (one role per admin)', () => {
    insertAdmin(db, 'dup@example.test', 'viewer')
    expect(() => insertAdmin(db, 'dup@example.test', 'owner')).toThrow(/duplicate key value violates unique constraint/)
  })

  it('rejects a NULL email, a NULL role and a NULL created_at', () => {
    expect(() => db.none(`INSERT INTO admin_users (role) VALUES ('viewer')`)).toThrow(
      /null value in column "email" violates not-null constraint/,
    )
    // Real Postgres raises the NOT NULL violation here. pg-mem 3.0.14 evaluates the role CHECK
    // first and treats NULL as a violation, so it reports the CHECK instead — either way the row
    // is rejected; the NOT NULL itself is pinned textually below.
    expect(() => db.none(`INSERT INTO admin_users (email) VALUES ('norole@example.test')`)).toThrow(
      /null value in column "role" violates not-null constraint|check constraint "admin_users_role_check"/,
    )
    expect(() =>
      db.none(`INSERT INTO admin_users (email, role, created_at) VALUES ('nots@example.test', 'viewer', NULL)`),
    ).toThrow(/null value in column "created_at" violates not-null constraint/)
  })

  it('stores an entity_scope uuid[]', () => {
    db.none(`INSERT INTO admin_users (email, role, entity_scope) VALUES ('scoped@example.test', 'bookkeeper', '{${SCOPE_A},${SCOPE_B}}')`)
    const [row] = db.many(`SELECT entity_scope FROM admin_users WHERE email = 'scoped@example.test'`)
    expect(row.entity_scope).toEqual([SCOPE_A, SCOPE_B])
  })
})

describe('migration 0018 — text pins (what pg-mem cannot execute)', () => {
  let sql = ''
  // Executable SQL only — prose in the header may legitimately mention these keywords.
  let code = ''
  beforeAll(() => {
    sql = readMigration(FILE)
    code = sql.replace(/--[^\n]*/g, '')
  })

  it('enables RLS on admin_users, and on nothing else', () => {
    const tables = [...code.matchAll(/ALTER TABLE\s+([\w.]+)\s+ENABLE ROW LEVEL SECURITY/gi)].map((m) => m[1])
    expect(tables).toEqual(['admin_users'])
  })

  it('carries no CREATE POLICY — default-deny for anon/authenticated, service role only (the 0013 pattern)', () => {
    expect(/^\s*CREATE POLICY\b/im.test(sql)).toBe(false)
  })

  it('seeds no rows and writes no data', () => {
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|COPY|TRUNCATE)\b/i)
  })

  it('pins the role CHECK to exactly the four roles', () => {
    expect(code).toMatch(/CHECK \(role IN \('owner', 'manager', 'bookkeeper', 'viewer'\)\)/)
  })

  it('declares exactly the three named CHECK constraints', () => {
    expect([...code.matchAll(/CONSTRAINT\s+(\w+)\s+CHECK\b/gi)].map((m) => m[1]).sort()).toEqual(CHECK_NAMES)
  })

  it('pins the trimmed, non-empty email CHECK', () => {
    expect(code).toMatch(/CONSTRAINT admin_users_email_trimmed_nonempty CHECK \(email = btrim\(email\) AND email <> ''\)/)
  })

  it('pins the lower-case email CHECK, UNIQUE email, and the NOT NULL columns', () => {
    expect(code).toMatch(/CHECK \(email = lower\(email\)\)/)
    expect(code).toMatch(/\bemail TEXT NOT NULL UNIQUE\b/)
    expect(code).toMatch(/\brole TEXT NOT NULL\b/)
    expect(code).toMatch(/\bcreated_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/)
    expect(code).toMatch(/\bentity_scope UUID\[\],/)
  })

  it('is re-runnable: CREATE TABLE IF NOT EXISTS, and a second apply of every other executable statement is a no-op', () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS admin_users\b/)
    // Every CREATE in the file is guarded, so a partially applied Dashboard paste can be re-pasted.
    expect(code.match(/\bCREATE\s+(TABLE|INDEX|UNIQUE INDEX|TYPE|FUNCTION|VIEW)\b(?!\s+IF NOT EXISTS)/gi) ?? []).toEqual([])
    const db = freshMigratedDb()
    insertAdmin(db, 'kept@example.test', 'viewer')
    for (const stmt of splitSqlStatements(sql)) {
      const body = statementBody(stmt)
      if (PG_MEM_SKIP.some((re) => re.test(body))) continue
      // Real Postgres skips CREATE TABLE IF NOT EXISTS on an existing table with a NOTICE. pg-mem
      // 3.0.14 instead throws "Not supported" from its AST-coverage check (the skipped column list
      // is "unread"), so that one statement is pinned textually above rather than re-executed.
      if (/^CREATE TABLE IF NOT EXISTS\b/i.test(body)) continue
      expect(() => db.none(stmt), `re-applying: ${body.slice(0, 80)}`).not.toThrow()
    }
    // The existing row survived and the CHECKs are still enforced after the re-apply.
    expect(db.many(`SELECT email FROM admin_users`).map((r) => r.email)).toEqual(['kept@example.test'])
    expect(() => insertAdmin(db, 'x@example.test', 'admin')).toThrow(/check constraint "admin_users_role_check"/)
    expect(() => insertAdmin(db, 'X@example.test', 'viewer')).toThrow(/check constraint "admin_users_email_lowercase"/)
    expect(() => insertAdmin(db, ' x@example.test', 'viewer')).toThrow(/check constraint "admin_users_email_trimmed_nonempty"/)
  })

  it('carries a commented rollback block that drops the table', () => {
    expect(sql).toMatch(/--\s*Rollback/i)
    expect(sql).toMatch(/--\s*DROP TABLE IF EXISTS admin_users;/)
  })
})

// CREATE TABLE IF NOT EXISTS silently skips over an admin_users table that already exists (made by
// hand, or by an older draft), so after the apply nothing proves the CHECKs are there. Part 6 of the
// manual live-database script must look them up in pg_constraint, by name AND by definition: Postgres
// auto-names an unnamed column CHECK on admin_users.role "admin_users_role_check" too, so a name
// match alone would accept a hand-made table with a different role list.
describe('scripts/verify-rls.sql Part 6 — live check of the 0018 CHECK constraints', () => {
  let part6 = ''
  beforeAll(() => {
    const verify = readFileSync(VERIFY_RLS, 'utf8')
    const start = verify.indexOf('Part 6')
    expect(start, 'verify-rls.sql has no Part 6').toBeGreaterThan(-1)
    part6 = verify.slice(start)
  })

  it('queries pg_constraint for CHECK constraints on public.admin_users', () => {
    expect(part6).toMatch(/\bFROM\s+pg_constraint\b|\bJOIN\s+pg_constraint\b/i)
    expect(part6).toMatch(/contype\s*=\s*'c'/)
    expect(part6).toMatch(/to_regclass\('public\.admin_users'\)/)
  })

  it('expects every CHECK constraint 0018 declares, by name and by definition', () => {
    const declared = [...readMigration(FILE).replace(/--[^\n]*/g, '').matchAll(/CONSTRAINT\s+(\w+)\s+CHECK\b/gi)].map((m) => m[1])
    expect(declared.sort()).toEqual(CHECK_NAMES)
    for (const name of declared) expect(part6, `Part 6 does not check ${name}`).toContain(`'${name}'`)
    expect(part6).toMatch(/pg_get_constraintdef\(/)
    // The expected definitions, in pg_get_constraintdef's form, so a weaker or different CHECK
    // carrying the right name is reported.
    expect(part6).toContain(`CHECK ((email = lower(email)))`)
    expect(part6).toContain(`CHECK (((email = btrim(email)) AND (email <> ''::text)))`)
    expect(part6).toContain(`CHECK ((role = ANY (ARRAY['owner'::text, 'manager'::text, 'bookkeeper'::text, 'viewer'::text])))`)
  })
})
