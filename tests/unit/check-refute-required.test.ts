import { describe, it, expect } from 'vitest'
import {
  FINANCIAL_SOURCE_PATHS,
  isFinancialSourcePath,
  isMigrationPath,
  migrationTouchesFinancialTables,
  selectFinancialChanges,
  hasRefuteApproval,
  runRefuteCheck,
} from '../../scripts/check-refute-required'
import { readFileSync } from 'node:fs'

// OI-255: ora-pm is the only ORA repo that moves real money (Stripe ACH autopay debits, late-fee
// posting). These tests pin the gate's classification so the financial path set cannot drift
// silently — every entry below was verified by reading the file, not inferred from its name.

describe('check-refute-required — financial-source classification', () => {
  it('flags the autopay-debit / late-fee cron (charges upsert, PaymentIntent create, late_fee insert)', () => {
    expect(isFinancialSourcePath('server/routes/cron.ts')).toBe(true)
    // Windows separators normalize before lookup
    expect(isFinancialSourcePath('server\\routes\\cron.ts')).toBe(true)
  })

  it('flags the Stripe ACH path — PaymentIntent creation, payments insert, retry budget', () => {
    expect(isFinancialSourcePath('server/routes/stripe.ts')).toBe(true)
    expect(isFinancialSourcePath('server/lib/stripe.ts')).toBe(true)
  })

  it('flags webhook financial state transitions and the idempotency gate that decides a re-run', () => {
    expect(isFinancialSourcePath('server/lib/stripe-events.ts')).toBe(true)
    expect(isFinancialSourcePath('server/routes/webhook.ts')).toBe(true)
  })

  it('flags CAM true-up math and the route that posts cam_true_up charges', () => {
    expect(isFinancialSourcePath('server/lib/cam.ts')).toBe(true)
    expect(isFinancialSourcePath('server/routes/cam.ts')).toBe(true)
  })

  it('flags manual charge / payment posting and the monthly charge builder', () => {
    expect(isFinancialSourcePath('server/routes/payments.ts')).toBe(true)
    expect(isFinancialSourcePath('server/routes/charges.ts')).toBe(true)
    expect(isFinancialSourcePath('server/lib/billing.ts')).toBe(true)
  })

  it('flags the Zod schemas that bound charge / payment amounts (contract blast radius)', () => {
    expect(isFinancialSourcePath('server/lib/schemas.ts')).toBe(true)
  })

  it('ignores tests, docs, json, frontend, and non-money server code', () => {
    expect(isFinancialSourcePath('tests/lib/billing.test.ts')).toBe(false)
    expect(isFinancialSourcePath('tests/unit/check-refute-required.test.ts')).toBe(false)
    expect(isFinancialSourcePath('README.md')).toBe(false)
    expect(isFinancialSourcePath('package.json')).toBe(false)
    expect(isFinancialSourcePath('src/portal/pages/PortalDashboard.tsx')).toBe(false)
    expect(isFinancialSourcePath('server/routes/tenants.ts')).toBe(false)
    expect(isFinancialSourcePath('server/routes/properties.ts')).toBe(false)
    expect(isFinancialSourcePath('server/routes/reports.ts')).toBe(false)
    expect(isFinancialSourcePath('scripts/check-refute-required.ts')).toBe(false)
  })

  // M3 (2026-11-08 audit): the cron's autopay/delinquency totals, the CAM pool and the IIF journal
  // are only as complete as the PostgREST paging helper that reads them, and the IIF export /
  // AR-aging allocation are books-of-record math. A silent truncation in any of these understates
  // what a tenant owes without touching a gated file.
  it('flags the paging library money totals depend on, the IIF journal and the AR-aging allocation', () => {
    expect(isFinancialSourcePath('server/lib/postgrest-paging.ts')).toBe(true)
    expect(isFinancialSourcePath('server/routes/exports.ts')).toBe(true)
    expect(isFinancialSourcePath('server/lib/iif-export.ts')).toBe(true)
    expect(isFinancialSourcePath('server/lib/ar-aging.ts')).toBe(true)
  })

  it('exposes the financial path set with the expected membership', () => {
    expect(FINANCIAL_SOURCE_PATHS.size).toBe(15)
    for (const p of [
      'server/routes/cron.ts',
      'server/routes/stripe.ts',
      'server/routes/webhook.ts',
      'server/routes/payments.ts',
      'server/routes/charges.ts',
      'server/routes/cam.ts',
      'server/lib/stripe.ts',
      'server/lib/stripe-events.ts',
      'server/lib/cam.ts',
      'server/lib/billing.ts',
      'server/lib/schemas.ts',
      'server/lib/postgrest-paging.ts',
      'server/routes/exports.ts',
      'server/lib/iif-export.ts',
      'server/lib/ar-aging.ts',
    ]) {
      expect(FINANCIAL_SOURCE_PATHS.has(p)).toBe(true)
    }
  })

  // M3 follow-up: closure check. A gated file that imports an UNgated server/lib module would let a
  // money-relevant change land in that module with no attestation (exactly how postgrest-paging
  // slipped through). Every server/lib import of a gated file must be gated itself or be listed
  // here as reviewed non-financial plumbing. Adding a new import fails this test until it is
  // classified one way or the other.
  it('every server/lib module a gated file imports is gated or explicitly non-financial', () => {
    const NON_FINANCIAL_LIBS = new Set([
      'server/lib/api-error.ts', // error-response shaping
      'server/lib/rate-limit.ts', // abuse throttle
      'server/lib/list-query.ts', // list-endpoint sort/page params (display, not totals)
    ])
    const unclassified: string[] = []
    let seen = 0
    for (const gated of FINANCIAL_SOURCE_PATHS) {
      const src = readFileSync(gated, 'utf8')
      const dir = gated.slice(0, gated.lastIndexOf('/'))
      for (const m of src.matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
        const out: string[] = []
        for (const part of [...dir.split('/'), ...m[1].split('/')]) {
          if (part === '..') out.pop()
          else if (part !== '.') out.push(part)
        }
        const resolved = `${out.join('/')}.ts`
        if (!resolved.startsWith('server/lib/')) continue
        seen++
        if (!FINANCIAL_SOURCE_PATHS.has(resolved) && !NON_FINANCIAL_LIBS.has(resolved)) {
          unclassified.push(`${gated} -> ${resolved}`)
        }
      }
    }
    expect(seen).toBeGreaterThan(0) // the import scan itself must be finding imports
    expect(unclassified).toEqual([])
  })
})

describe('check-refute-required — migrations', () => {
  it('recognizes supabase/migrations/*.sql and nothing else under that directory', () => {
    expect(isMigrationPath('supabase/migrations/0002_financial_tables.sql')).toBe(true)
    expect(isMigrationPath('supabase\\migrations\\0009_fix_ar_ledger_view.sql')).toBe(true)
    expect(isMigrationPath('supabase/migrations/README.md')).toBe(false)
    expect(isMigrationPath('supabase/seed.sql')).toBe(false)
    expect(isMigrationPath('scripts/verify-rls.sql')).toBe(false)
  })

  it('flags SQL that touches charges / payments / ar_ledger (identifier-aware, case-insensitive)', () => {
    expect(migrationTouchesFinancialTables('ALTER TABLE charges ADD COLUMN idempotency_key text;')).toBe(true)
    expect(migrationTouchesFinancialTables('create table public.payments (id uuid primary key);')).toBe(true)
    expect(migrationTouchesFinancialTables('CREATE OR REPLACE VIEW ar_ledger AS SELECT 1;')).toBe(true)
    expect(migrationTouchesFinancialTables('CREATE INDEX idx_charges_lease ON "charges" (lease_id);')).toBe(true)
    expect(migrationTouchesFinancialTables('DROP VIEW IF EXISTS ar_ledger_v2;')).toBe(true)
    expect(migrationTouchesFinancialTables('SELECT * FROM PAYMENTS;')).toBe(true)
  })

  it('does not flag SQL whose only identifiers merely contain a table name as a substring', () => {
    expect(migrationTouchesFinancialTables('ALTER TABLE stripe_webhook_events ADD COLUMN status text;')).toBe(false)
    expect(migrationTouchesFinancialTables('ALTER TABLE tenants ADD COLUMN stripe_payment_intent_id text;')).toBe(false)
    expect(migrationTouchesFinancialTables('CREATE TABLE recharges (id uuid);')).toBe(false)
    expect(migrationTouchesFinancialTables('ALTER TABLE properties ALTER COLUMN zip DROP NOT NULL;')).toBe(false)
    expect(migrationTouchesFinancialTables('')).toBe(false)
  })
})

describe('check-refute-required — change selection', () => {
  const sqlByPath: Record<string, string> = {
    'supabase/migrations/0100_money.sql': 'ALTER TABLE charges ADD COLUMN foo text;',
    'supabase/migrations/0101_plain.sql': 'ALTER TABLE properties ADD COLUMN foo text;',
  }
  const readSql = (p: string): string | null => sqlByPath[p] ?? null

  it('selects enumerated financial source without consulting the SQL reader', () => {
    let reads = 0
    const spyReader = (p: string): string | null => {
      reads++
      return readSql(p)
    }
    const out = selectFinancialChanges(['server/routes/cron.ts', 'src/lib/format.ts'], spyReader)
    expect(out).toEqual(['server/routes/cron.ts'])
    expect(reads).toBe(0)
  })

  it('selects a migration only when its SQL touches a financial table', () => {
    const out = selectFinancialChanges(
      ['supabase/migrations/0100_money.sql', 'supabase/migrations/0101_plain.sql', 'supabase/migrations/README.md'],
      readSql,
    )
    expect(out).toEqual(['supabase/migrations/0100_money.sql'])
  })

  it('fails closed on a migration whose SQL cannot be read (deleted or unreadable)', () => {
    const out = selectFinancialChanges(['supabase/migrations/0999_gone.sql'], readSql)
    expect(out).toEqual(['supabase/migrations/0999_gone.sql'])
  })

  it('normalizes Windows separators in the returned paths', () => {
    const out = selectFinancialChanges(['server\\lib\\cam.ts'], readSql)
    expect(out).toEqual(['server/lib/cam.ts'])
  })

  it('returns an empty list when nothing financial changed', () => {
    expect(selectFinancialChanges(['README.md', 'src/App.tsx', 'tests/lib/cam.test.ts'], readSql)).toEqual([])
    expect(selectFinancialChanges([], readSql)).toEqual([])
  })
})

describe('check-refute-required — trailer detection', () => {
  it('detects Refute-Reviewed / Refute-Skip anywhere in the blob (case-insensitive)', () => {
    expect(hasRefuteApproval('fix: x\n\nRefute-Reviewed: wf_abc123')).toBe(true)
    expect(hasRefuteApproval('chore\n\nRefute-Skip: docs-only adjustment')).toBe(true)
    expect(hasRefuteApproval('refute-reviewed: wf_x')).toBe(true)
    expect(hasRefuteApproval('Merge abc into def\n\nfeat: y\n\n  Refute-Skip: reason')).toBe(true)
  })

  it('returns false when no attestation trailer is present', () => {
    expect(hasRefuteApproval('fix: something\n\nCo-Authored-By: someone')).toBe(false)
    expect(hasRefuteApproval('mentions Refute-Reviewed mid-line but not as a trailer')).toBe(false)
    expect(hasRefuteApproval('')).toBe(false)
  })

  it('does not accept prose that starts a line with the token but carries no trailer value', () => {
    // Found while writing this gate's own commit message: a wrapped body line began with
    // "Refute-Reviewed:/Refute-Skip: trailer when it touches…" and the reference regex passed it.
    expect(hasRefuteApproval('body:\n  Refute-Reviewed:/Refute-Skip: trailer when it touches money files')).toBe(false)
    expect(hasRefuteApproval('Refute-Skip:')).toBe(false)
    expect(hasRefuteApproval('Refute-Skip:   \n')).toBe(false)
  })
})

// M12 (2026-11-08 audit): main() was untested and failed OPEN under --strict when the base ref
// could not be resolved, so a CI misconfiguration (shallow clone, renamed base) silently passed
// every money PR. runRefuteCheck is main() with its I/O injected; the spawned-script tests in
// tests/scripts/check-refute-required.cli.test.ts cover the real git + process.exit wiring.
describe('check-refute-required — runRefuteCheck (exit logic)', () => {
  type Logged = { log: string[]; warn: string[]; error: string[] }
  function harness(gitImpl: (args: string[]) => string, argv: string[], env: Record<string, string | undefined> = {}) {
    const logged: Logged = { log: [], warn: [], error: [] }
    const calls: string[][] = []
    const code = runRefuteCheck({
      argv,
      env,
      git: (args) => {
        calls.push(args)
        return gitImpl(args)
      },
      readSql: () => null,
      logger: {
        log: (m) => logged.log.push(m),
        warn: (m) => logged.warn.push(m),
        error: (m) => logged.error.push(m),
      },
    })
    return { code, logged, calls }
  }
  const unresolvable = (): string => {
    throw new Error("fatal: ambiguous argument 'origin/nope...HEAD': unknown revision")
  }
  const repo = (changed: string[], messages: string) => (args: string[]): string =>
    args[0] === 'diff' ? changed.join('\n') + '\n' : messages

  it('--strict FAILS CLOSED (exit 1) when the base ref cannot be resolved', () => {
    const { code, logged } = harness(unresolvable, ['--strict', '--base=origin/nope'])
    expect(code).toBe(1)
    expect(logged.error.join('\n')).toMatch(/origin\/nope/)
  })

  it('default (non-strict) mode still warns and exits 0 on an unresolvable base (local WIP never blocks)', () => {
    const { code, logged } = harness(unresolvable, ['--base=origin/nope'])
    expect(code).toBe(0)
    expect(logged.warn.join('\n')).toMatch(/skipped/)
  })

  it('--strict exits 1 when a financial file changed and no trailer is present', () => {
    const { code, logged } = harness(repo(['server/lib/postgrest-paging.ts'], 'fix: paging\n'), ['--strict'])
    expect(code).toBe(1)
    expect(logged.error.join('\n')).toMatch(/server\/lib\/postgrest-paging\.ts/)
  })

  it('non-strict warns but exits 0 on the same violation', () => {
    const { code, logged } = harness(repo(['server/routes/cron.ts'], 'fix: x\n'), [])
    expect(code).toBe(0)
    expect(logged.warn.join('\n')).toMatch(/WITHOUT a refute attestation/)
  })

  it('--strict exits 0 when a financial file changed and a Refute-Reviewed trailer is present', () => {
    const { code } = harness(repo(['server/routes/cron.ts'], 'fix: x\n\nRefute-Reviewed: agent-123\n'), ['--strict'])
    expect(code).toBe(0)
  })

  it('--strict exits 0 when nothing financial changed', () => {
    const { code, logged } = harness(repo(['README.md'], 'docs\n'), ['--strict'])
    expect(code).toBe(0)
    expect(logged.log.join('\n')).toMatch(/no financial-decision files/)
  })

  it('resolves the base from --base, then $REFUTE_BASE, then origin/main', () => {
    const ok = repo([], '')
    expect(harness(ok, ['--base=feature/x']).calls[0]).toContain('feature/x...HEAD')
    expect(harness(ok, [], { REFUTE_BASE: 'release' }).calls[0]).toContain('release...HEAD')
    expect(harness(ok, []).calls[0]).toContain('origin/main...HEAD')
  })
})
