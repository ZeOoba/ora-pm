/// <reference types="node" />
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS_DIR = join(__dirname, '../../supabase/migrations')

// OI-048: this manifest is the checked-in claim set — the set of tables that
// should have RLS enabled and the policies that should exist on them, per
// 0004_views_and_rls.sql and 0008_storage_rls.sql as of this task. It exists
// so that a future migration silently dropping a policy (or a table's RLS
// being disabled) is caught here, in CI, instead of only being discoverable
// by someone manually diffing SQL files. scripts/verify-rls.sql checks this
// SAME claim set against the live database — if you change this manifest,
// update that script's expected list too.
const EXPECTED_MANIFEST = {
  // Tables with `ALTER TABLE <name> ENABLE ROW LEVEL SECURITY` in 0004_views_and_rls.sql
  rlsEnabledTables: [
    'charges',
    'payments',
    'lease_documents',
    'lease_amendments',
    'tenant_notices',
    'insurance_certificates',
  ].sort(),
  // Every `CREATE POLICY` in 0004_views_and_rls.sql + 0008_storage_rls.sql, as { name, table } pairs.
  policies: [
    { name: 'tenant_own_charges', table: 'charges' },
    { name: 'tenant_own_payments', table: 'payments' },
    { name: 'tenant_own_documents', table: 'lease_documents' },
    { name: 'tenant_own_amendments', table: 'lease_amendments' },
    { name: 'tenant_own_notices', table: 'tenant_notices' },
    { name: 'tenant_own_insurance_select', table: 'insurance_certificates' },
    { name: 'tenant_own_insurance_insert', table: 'insurance_certificates' },
    { name: 'tenant_upload_insurance', table: 'storage.objects' },
    { name: 'tenant_read_insurance', table: 'storage.objects' },
    { name: 'tenant_read_lease_docs', table: 'storage.objects' },
  ].sort((a, b) => a.name.localeCompare(b.name)),
}

interface PolicyRecord {
  name: string
  table: string
}

// Extracts every `ALTER TABLE <name> ENABLE ROW LEVEL SECURITY` table name
// from raw migration SQL text.
function extractRlsEnabledTables(sql: string): string[] {
  const re = /ALTER TABLE\s+([\w.]+)\s+ENABLE ROW LEVEL SECURITY/gi
  const found: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    found.push(m[1])
  }
  return found
}

// Extracts every `CREATE POLICY <name-or-"name"> ON <table>` from raw
// migration SQL text. Handles both the quoted-identifier style used in
// 0004 (`CREATE POLICY "tenant_own_charges" ON charges`) and the bare
// identifier style used in 0008 (`CREATE POLICY tenant_upload_insurance
// ON storage.objects`).
function extractPolicies(sql: string): PolicyRecord[] {
  const re = /CREATE POLICY\s+"?([\w]+)"?\s+ON\s+([\w.]+)/gi
  const found: PolicyRecord[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    found.push({ name: m[1], table: m[2] })
  }
  return found
}

function readMigration(filename: string): string {
  return readFileSync(join(MIGRATIONS_DIR, filename), 'utf8')
}

describe('RLS inventory — migrations match the checked-in manifest (OI-048)', () => {
  it('0004_views_and_rls.sql enables RLS on exactly the tables the manifest expects', () => {
    const sql = readMigration('0004_views_and_rls.sql')
    const tables = extractRlsEnabledTables(sql).sort()
    expect(tables).toEqual(EXPECTED_MANIFEST.rlsEnabledTables)
  })

  it('0004_views_and_rls.sql + 0008_storage_rls.sql define exactly the policies the manifest expects', () => {
    const sql0004 = readMigration('0004_views_and_rls.sql')
    const sql0008 = readMigration('0008_storage_rls.sql')
    const policies = [...extractPolicies(sql0004), ...extractPolicies(sql0008)].sort((a, b) =>
      a.name.localeCompare(b.name)
    )
    expect(policies).toEqual(EXPECTED_MANIFEST.policies)
  })

  it('every policy targets a table for which RLS is either enabled in 0004 or is the out-of-band storage.objects table from 0008', () => {
    const sql0004 = readMigration('0004_views_and_rls.sql')
    const rlsTables = new Set(extractRlsEnabledTables(sql0004))
    for (const policy of EXPECTED_MANIFEST.policies) {
      const isStorageObjects = policy.table === 'storage.objects'
      expect(
        rlsTables.has(policy.table) || isStorageObjects,
        `policy "${policy.name}" targets "${policy.table}", which has no matching ENABLE ROW LEVEL SECURITY statement`
      ).toBe(true)
    }
  })
})
