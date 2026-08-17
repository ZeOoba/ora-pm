/// <reference types="node" />
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS_DIR = join(__dirname, '../../supabase/migrations')

// OI-078: companion to rls-inventory.test.ts's OI-048 manifest, scoped to
// 0013_enable_rls_remaining_tables.sql — the 17 tables that had NO
// ENABLE ROW LEVEL SECURITY anywhere before this fix. Kept as a separate
// file/manifest rather than folded into EXPECTED_MANIFEST because this
// migration deliberately carries zero CREATE POLICY statements
// (default-deny — see the migration's own header comment for why that is
// correct here), so it would fail rls-inventory.test.ts's "every policy
// targets an RLS-enabled table" symmetry check for the wrong reason.
const EXPECTED_TABLES = [
  'properties',
  'units',
  'tenants',
  'leases',
  'expenses',
  'budgets',
  'renewals',
  'broker_commissions',
  'cam_reconciliations',
  'correspondence_log',
  'journal_entry_exports',
  'lease_move_events',
  'sent_notifications',
  'stripe_webhook_events',
  'tenant_sales_reports',
  'utility_meters',
  'utility_readings',
].sort()

function extractRlsEnabledTables(sql: string): string[] {
  const re = /ALTER TABLE\s+([\w.]+)\s+ENABLE ROW LEVEL SECURITY/gi
  const found: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    found.push(m[1])
  }
  return found
}

describe('RLS inventory — remaining tables match the OI-078 manifest', () => {
  it('0013_enable_rls_remaining_tables.sql enables RLS on exactly the 17 tables the manifest expects', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0013_enable_rls_remaining_tables.sql'), 'utf8')
    const tables = extractRlsEnabledTables(sql).sort()
    expect(tables).toEqual(EXPECTED_TABLES)
  })

  it('0013 carries no CREATE POLICY statements (default-deny is deliberate, not an oversight)', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0013_enable_rls_remaining_tables.sql'), 'utf8')
    // Anchored to line-start (matches rls-inventory.test.ts's own extraction
    // convention) so this checks actual SQL statements, not prose mentioning
    // the phrase "CREATE POLICY" in a comment.
    expect(/^\s*CREATE POLICY\b/im.test(sql)).toBe(false)
  })
})
