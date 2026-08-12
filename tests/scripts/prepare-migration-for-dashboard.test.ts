import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  deriveVersionAndName,
  buildTrackingInsert,
  prepareForDashboard,
  assertTransactionSafe,
  assertBalancedComments,
} from '../../scripts/prepare-migration-for-dashboard.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(__dirname, '../../scripts/prepare-migration-for-dashboard.mjs')

describe('the script source stays importable under vitest', () => {
  // Regression guard for the shebang trap. This test file imports functions
  // from the .mjs, so vitest runs the .mjs through Vite's SSR transform, which
  // hoists injected `__vite_ssr_import__` boilerplate to the top of the module.
  // A leading `#!/usr/bin/env node` shebang then ends up mid-module, and V8
  // only accepts `#!` at byte 0 — anywhere else it throws
  // "SyntaxError: Invalid or unexpected token", which fails the ENTIRE suite at
  // load time (0 tests run). That manifested only on some platforms (Windows /
  // newer Node), so CI stayed green while local runs went red. This assertion
  // reads the raw source and runs identically everywhere, so a re-added shebang
  // is caught on every platform — not just the ones where the transform trips.
  // The script is always invoked as `node scripts/…` (see its usage banner and
  // supabase/migrations/README.md) and is not marked executable, so it needs no
  // shebang.
  it('does not begin with a shebang (breaks Vite SSR transform when imported)', () => {
    const source = readFileSync(scriptPath, 'utf8')
    expect(source.startsWith('#!')).toBe(false)
  })
})

describe('deriveVersionAndName', () => {
  it('splits a well-formed migration filename', () => {
    expect(deriveVersionAndName('0012_add_foo.sql')).toEqual({ version: '0012', name: 'add_foo' })
  })
  it('works with a full path, not just a basename', () => {
    expect(deriveVersionAndName('supabase/migrations/0009_fix_ar_ledger_view.sql')).toEqual({
      version: '0009',
      name: 'fix_ar_ledger_view',
    })
  })
  it('throws on a filename with no version prefix', () => {
    expect(() => deriveVersionAndName('storage_rls.sql')).toThrow(/doesn't match/)
  })
  it('throws on a non-.sql filename', () => {
    expect(() => deriveVersionAndName('0012_add_foo.txt')).toThrow(/doesn't match/)
  })
})

describe('buildTrackingInsert', () => {
  it('emits an idempotent INSERT for the schema_migrations tracker', () => {
    const sql = buildTrackingInsert('0012', 'add_foo')
    expect(sql).toContain('INSERT INTO supabase_migrations.schema_migrations (version, name)')
    expect(sql).toContain("VALUES ('0012', 'add_foo')")
    expect(sql).toContain('ON CONFLICT (version) DO NOTHING;')
  })
  it('escapes single quotes in the name so a pasted apostrophe cannot break the statement', () => {
    const sql = buildTrackingInsert('0012', "tenant's_view")
    expect(sql).toContain("'tenant''s_view'")
    expect(sql).not.toContain("'tenant's_view'")
  })
})

describe('prepareForDashboard', () => {
  it('wraps the migration body and tracking insert in one BEGIN/COMMIT transaction', () => {
    const out = prepareForDashboard('CREATE TABLE foo (id uuid PRIMARY KEY);', '0012_add_foo.sql')
    const beginIdx = out.indexOf('BEGIN;')
    const bodyIdx = out.indexOf('CREATE TABLE foo')
    const trackingIdx = out.indexOf('INSERT INTO supabase_migrations.schema_migrations')
    const commitIdx = out.indexOf('COMMIT;')

    expect(beginIdx).toBeGreaterThanOrEqual(0)
    expect(bodyIdx).toBeGreaterThan(beginIdx)
    expect(trackingIdx).toBeGreaterThan(bodyIdx)
    expect(commitIdx).toBeGreaterThan(trackingIdx)
  })
  it('places the tracking insert AFTER the migration body, so a failed migration rolls back before it is ever tracked', () => {
    const out = prepareForDashboard('SELECT 1;', '0007_x.sql')
    expect(out.indexOf('SELECT 1;')).toBeLessThan(
      out.indexOf('INSERT INTO supabase_migrations.schema_migrations')
    )
  })
  it('derives version/name from the filename argument, not the SQL content', () => {
    const out = prepareForDashboard('-- anything', '0003_operations_tables.sql')
    expect(out).toContain("VALUES ('0003', 'operations_tables')")
  })
})

describe('assertTransactionSafe', () => {
  it('allows ordinary DDL/DML', () => {
    expect(() => assertTransactionSafe('CREATE TABLE foo (id uuid PRIMARY KEY);')).not.toThrow()
  })
  it('rejects CREATE INDEX CONCURRENTLY', () => {
    expect(() => assertTransactionSafe('CREATE INDEX CONCURRENTLY foo_idx ON foo (id);')).toThrow(
      /CONCURRENTLY/
    )
  })
  it('rejects VACUUM', () => {
    expect(() => assertTransactionSafe('VACUUM ANALYZE foo;')).toThrow(/VACUUM/)
  })
  it('rejects ALTER SYSTEM and CREATE DATABASE', () => {
    expect(() => assertTransactionSafe("ALTER SYSTEM SET foo = 'bar';")).toThrow(/ALTER SYSTEM/)
    expect(() => assertTransactionSafe('CREATE DATABASE foo;')).toThrow(/CREATE DATABASE/)
  })
  it('is case-insensitive', () => {
    expect(() => assertTransactionSafe('vacuum foo;')).toThrow(/vacuum/)
  })
})

describe('assertBalancedComments', () => {
  it('allows SQL with no block comments', () => {
    expect(() => assertBalancedComments('SELECT 1; -- a line comment')).not.toThrow()
  })
  it('allows a properly closed block comment', () => {
    expect(() => assertBalancedComments('/* note */ SELECT 1;')).not.toThrow()
  })
  it('rejects an unterminated block comment', () => {
    expect(() => assertBalancedComments('SELECT 1; /* oops, forgot to close')).toThrow(
      /unterminated block comment/
    )
  })
})

describe('prepareForDashboard guard integration', () => {
  it('refuses to wrap a migration containing CONCURRENTLY', () => {
    expect(() =>
      prepareForDashboard('CREATE INDEX CONCURRENTLY foo_idx ON foo (id);', '0012_foo.sql')
    ).toThrow(/CONCURRENTLY/)
  })
  it('refuses to wrap a migration with an unterminated block comment', () => {
    expect(() => prepareForDashboard('SELECT 1; /* unterminated', '0012_foo.sql')).toThrow(
      /unterminated block comment/
    )
  })
})

describe('CLI entry point (real subprocess, not just the imported functions)', () => {
  it('actually runs main() and writes to stdout when invoked as a script', () => {
    // Regression guard: the first version of this script compared
    // `import.meta.url` against a hand-built `file://${argv[1]}` string, which
    // never matches on Windows (backslashes, missing drive-letter slash) — the
    // CLI guard silently no-op'd, exiting 0 with empty stdout. Only a real
    // subprocess invocation (not an import of the functions) exercises that
    // guard, which is why this test shells out instead of calling main()
    // directly.
    const migrationPath = join(__dirname, '../../supabase/migrations/0007_stripe_webhook_events_fix.sql')
    const stdout = execFileSync('node', [scriptPath, migrationPath], { encoding: 'utf8' })
    expect(stdout).toContain('BEGIN;')
    expect(stdout).toContain('INSERT INTO supabase_migrations.schema_migrations')
    expect(stdout).toContain("VALUES ('0007', 'stripe_webhook_events_fix')")
    expect(stdout).toContain('COMMIT;')
  })

  it('exits 2 with a usage message when no file argument is given', () => {
    expect(() => execFileSync('node', [scriptPath], { encoding: 'utf8' })).toThrowError(
      /Command failed/
    )
  })
})
