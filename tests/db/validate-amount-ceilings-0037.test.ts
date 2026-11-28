/// <reference types="node" />
// tests/db/validate-amount-ceilings-0037.test.ts
//
// Migration 0037 on real PostgreSQL (PGlite): VALIDATE CONSTRAINT on the two $50,000/month ceilings 0036 added
// NOT VALID. Migrations before 0036 are applied once; each test runs inside its own transaction and rolls back.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'
import { PG_MEM_SKIP, splitSqlStatements, statementBody } from '../fixtures/pg-migrations'

const DIR = join(__dirname, '../../supabase/migrations')
const ALL = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
const file = (p: string) => readFileSync(join(DIR, ALL.find((f) => f.startsWith(p))!), 'utf8')
const M0036 = file('0036_')
const M0037 = file('0037_')
// scripts/verify-rls.sql Part 8's constraint query, run here as the live check would run it.
const VERIFY_RLS = readFileSync(join(__dirname, '../../scripts/verify-rls.sql'), 'utf8')
const PART8 = VERIFY_RLS.slice(VERIFY_RLS.indexOf('-- ── Part 8')).match(/^SELECT[\s\S]*?;$/m)![0]

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
const CEILINGS = ['lease_recurring_charges_amount_ceiling', 'lease_rent_schedule_amount_ceiling']

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
const validated = async () =>
  (await db.query<{ conname: string; convalidated: boolean }>(
    `SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY($1::text[]) ORDER BY conname`, [CEILINGS],
  )).rows

describe('0037: validate the $50,000/month ceilings', () => {
  it('flips both ceilings from NOT VALID to validated when existing rows are at or under $50,000, and re-runs cleanly', async () => {
    await db.exec(rentRow(50_000))
    await db.exec(recRow(50_000))
    await db.exec(M0036)
    expect(await validated()).toEqual(CEILINGS.map((conname) => ({ conname, convalidated: false })))
    await db.exec(M0037)
    expect(await validated()).toEqual(CEILINGS.map((conname) => ({ conname, convalidated: true })))
    await db.exec(M0037)
    expect(await validated()).toEqual(CEILINGS.map((conname) => ({ conname, convalidated: true })))
  })

  it.each([
    ['lease_rent_schedule', rentRow, 'lease_rent_schedule_amount_ceiling'],
    ['lease_recurring_charges', recRow, 'lease_recurring_charges_amount_ceiling'],
  ] as const)('fails with check_violation (23514) on an existing %s row over the ceiling; after rollback both stay NOT VALID', async (_t, row, conname) => {
    // Stored before 0036, so the NOT VALID constraint never checked it. The NOT VALID assertion below reads the state
    // after ROLLBACK TO SAVEPOINT; it does not by itself prove supabase db push applies the file atomically.
    await db.exec(row(50_000.01))
    await db.exec(M0036)
    await db.exec('SAVEPOINT s')
    await expect(db.exec(M0037)).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(new RegExp(conname)) })
    await db.exec('ROLLBACK TO SAVEPOINT s')
    expect(await validated()).toEqual(CEILINGS.map((c) => ({ conname: c, convalidated: false })))
  })

  it('fails loudly (42704) when 0036 has not been applied', async () => {
    await db.exec('SAVEPOINT s')
    await expect(db.exec(M0037)).rejects.toMatchObject({ code: '42704' })
    await db.exec('ROLLBACK TO SAVEPOINT s')
  })

  it('pg-mem skips exactly its two VALIDATE statements and nothing else', () => {
    const bodies = splitSqlStatements(M0037).map(statementBody).filter(Boolean)
    expect(bodies).toHaveLength(2)
    for (const b of bodies) expect(PG_MEM_SKIP.some((re) => re.test(b)), b).toBe(true)
    expect(PG_MEM_SKIP.some((re) => re.test('ALTER TABLE leases VALIDATE CONSTRAINT leases_some_check'))).toBe(false)
  })

  it('verify-rls.sql Part 8 reports all five constraints present and validated after 0036 + 0037', async () => {
    await db.exec(M0036)
    const before = (await db.query<{ conname: string; validated: boolean }>(PART8)).rows
    expect(before.filter((r) => !r.validated).map((r) => r.conname)).toEqual(CEILINGS)
    await db.exec(M0037)
    const rows = (await db.query<{ conname: string; present: boolean; validated: boolean }>(PART8)).rows
    expect(rows).toHaveLength(5)
    for (const r of rows) expect({ conname: r.conname, present: r.present, validated: r.validated }).toEqual({ conname: r.conname, present: true, validated: true })
  })
})
