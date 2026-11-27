/// <reference types="node" />
// tests/db/schedule-amount-ceiling-0036.test.ts
//
// Migration 0036 on real PostgreSQL (PGlite): the $50,000/month ceiling on lease_rent_schedule and
// lease_recurring_charges, including approve_lease_abstract() (0033), which writes both. Migrations before 0036
// are applied once; each test applies 0036 inside its own transaction and rolls back.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'

const DIR = join(__dirname, '../../supabase/migrations')
const ALL = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
const M0036 = readFileSync(join(DIR, ALL.find((f) => f.startsWith('0036_'))!), 'utf8')

const STUBS = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  CREATE SCHEMA storage;
  CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean);
  CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid);
  CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
`
const PROP = '10000000-0000-0000-0000-000000000001'
const UNIT = '20000000-0000-0000-0000-000000000001'
const TENANT = '30000000-0000-0000-0000-000000000001'
const LEASE = '40000000-0000-0000-0000-000000000001'
const SHA = 'b'.repeat(64)

let db: PGlite
beforeAll(async () => {
  db = new PGlite({ extensions: { btree_gist } })
  await db.exec(STUBS)
  for (const f of ALL.filter((x) => x < '0036')) await db.exec(readFileSync(join(DIR, f), 'utf8'))
}, 120_000)
afterAll(async () => { await db?.close() })
beforeEach(async () => {
  await db.exec('BEGIN')
  await db.exec(`
    INSERT INTO properties (id, name, address, city, state, zip) VALUES ('${PROP}', 'P', '1 Main', 'Columbus', 'OH', '43215');
    INSERT INTO units (id, property_id, suite, sf, status) VALUES ('${UNIT}', '${PROP}', '100', 5000, 'vacant');
    INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'T');
    INSERT INTO leases (id, tenant_id, unit_id, start_date, end_date, base_rent_monthly, status) VALUES ('${LEASE}', '${TENANT}', '${UNIT}', '2020-01-01', '2020-12-31', 3000, 'expired');
  `)
})
afterEach(async () => { await db.exec('ROLLBACK') })

const rentRow = (amount: number) => `INSERT INTO lease_rent_schedule (lease_id, effective_start, effective_end, base_rent_monthly, source) VALUES ('${LEASE}', '2020-01-01', '2020-12-31', ${amount}, 'manual')`
const recRow = (amount: number) => `INSERT INTO lease_recurring_charges (lease_id, type, description, amount_monthly, effective_start, effective_end, source) VALUES ('${LEASE}', 'utility_water', 'Water', ${amount}, '2020-01-01', '2020-12-31', 'manual')`

function approvePayload(rent: number, cam: number) {
  return {
    unit_id: UNIT, today: '2026-11-27',
    tenant: { mode: 'new', name: 'New Co' },
    lease: { start_date: '2026-12-01', end_date: '2031-11-30', rent_type: 'nnn', base_rent_monthly: rent, cam_estimate_monthly: cam },
    abstract: { storage_path: `abstracts/${SHA}.pdf`, file_sha256: SHA, model: 'm', raw_fields: {}, warnings: [], approved_by: 'admin@example.com' },
    document: { name: 'Lease.pdf' },
    rent_schedule: [{ effective_start: '2026-12-01', effective_end: '2031-11-30', base_rent_monthly: rent, rent_psf_annual: null }],
    recurring_charges: [{ type: 'cam_estimate', description: 'CAM estimate', amount_monthly: cam, effective_start: '2026-12-01', effective_end: '2031-11-30' }],
  }
}
const approve = (p: unknown) => db.query(`SELECT approve_lease_abstract($1::jsonb) AS r`, [JSON.stringify(p)])

describe('0036: $50,000/month ceiling on schedule rows', () => {
  it('keeps an existing over-ceiling row (NOT VALID) and is re-runnable', async () => {
    await db.exec(rentRow(60_000))
    await db.exec(M0036)
    await db.exec(M0036)
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM lease_rent_schedule WHERE base_rent_monthly = 60000`)).rows[0].n).toBe(1)
  })

  it('refuses a new rent or recurring row above $50,000 and accepts exactly $50,000', async () => {
    await db.exec(M0036)
    await db.exec('SAVEPOINT s')
    await expect(db.exec(rentRow(50_000.01))).rejects.toThrow(/lease_rent_schedule_amount_ceiling/)
    await db.exec('ROLLBACK TO SAVEPOINT s')
    await expect(db.exec(recRow(50_000.01))).rejects.toThrow(/lease_recurring_charges_amount_ceiling/)
    await db.exec('ROLLBACK TO SAVEPOINT s')
    await db.exec(rentRow(50_000))
    await db.exec(recRow(50_000))
  })

  it('approve_lease_abstract (0033) cannot write an over-ceiling rent or CAM row; at the ceiling it approves', async () => {
    await db.exec(M0036)
    await db.exec('SAVEPOINT s')
    await expect(approve(approvePayload(50_000.01, 500))).rejects.toThrow(/amount_ceiling/)
    await db.exec('ROLLBACK TO SAVEPOINT s')
    await expect(approve(approvePayload(4_000, 75_000))).rejects.toThrow(/amount_ceiling/)
    await db.exec('ROLLBACK TO SAVEPOINT s')
    const ok = await approve(approvePayload(50_000, 50_000))
    expect((ok.rows[0] as { r: { outcome: string } }).r.outcome).toBe('approved')
  })
})
