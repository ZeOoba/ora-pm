import { describe, it, expect } from 'vitest'
import {
  FINANCIAL_SOURCE_PATHS,
  isFinancialSourcePath,
  isMigrationPath,
  migrationTouchesFinancialTables,
  selectFinancialChanges,
  hasRefuteApproval,
} from '../../scripts/check-refute-required'

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
    // Reporting / export only — reads charges, never posts or debits
    expect(isFinancialSourcePath('server/routes/exports.ts')).toBe(false)
    expect(isFinancialSourcePath('server/routes/reports.ts')).toBe(false)
    expect(isFinancialSourcePath('server/lib/ar-aging.ts')).toBe(false)
    expect(isFinancialSourcePath('server/lib/iif-export.ts')).toBe(false)
    expect(isFinancialSourcePath('scripts/check-refute-required.ts')).toBe(false)
  })

  it('exposes the financial path set with the expected membership', () => {
    expect(FINANCIAL_SOURCE_PATHS.size).toBe(11)
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
    ]) {
      expect(FINANCIAL_SOURCE_PATHS.has(p)).toBe(true)
    }
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
