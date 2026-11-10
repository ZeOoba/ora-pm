/// <reference types="node" />
// tests/db/cam-categories-migration-0025.test.ts
//
// Gabriel rulings 2026-11-10: lease recoverable categories, annual CAM cap, not-reconciled flag.
// The CHECKs are exercised on real PostgreSQL (PGlite) — the category CHECK uses a SQL function,
// which pg-mem cannot run — after replaying the whole migration chain; pg-mem only proves the
// chain still applies there and that existing rows keep today's behaviour.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'
import { freshMigratedDb, migrationFiles } from '../fixtures/pg-migrations'
import { EXPENSE_CATEGORIES } from '../../server/lib/cam'

const FILE = '0025_cam_recoverable_categories.sql'
const DIR = join(__dirname, '../../supabase/migrations')
const LEASE = `'40000000-0000-0000-0000-0000000000a1'`

const STUBS = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  CREATE SCHEMA storage;
  CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean);
  CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid);
  CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
`

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist } })
  await pg.exec(STUBS)
  for (const f of readdirSync(DIR).filter((x) => x.endsWith('.sql')).sort()) {
    await pg.exec(readFileSync(join(DIR, f), 'utf8'))
  }
  await pg.exec(`
    INSERT INTO properties (id, name, address, city, state, zip) VALUES ('10000000-0000-0000-0000-0000000000a1', 'P', '1 Main', 'Easton', 'MD', '21601');
    INSERT INTO units (id, property_id, suite, sf) VALUES ('20000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000a1', '507', 6000);
    INSERT INTO tenants (id, name) VALUES ('30000000-0000-0000-0000-0000000000a1', 'T');
    INSERT INTO leases (id, tenant_id, unit_id, start_date, end_date, base_rent_monthly)
      VALUES (${LEASE}, '30000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000a1', '2024-07-01', '2029-06-30', 1000);
  `)
}, 120_000)

afterAll(async () => { await pg?.close() })

const upd = (set: string) => pg.exec(`UPDATE leases SET ${set} WHERE id = ${LEASE}`)
const ok = (set: string) => expect(upd(set)).resolves.not.toThrow()
const bad = (set: string) => expect(upd(set)).rejects.toThrow()

describe('migration 0025 on real Postgres', () => {
  beforeEach(async () => {
    await upd(`recoverable_categories = NULL, base_year_categories = NULL, cam_cap_through = NULL, cam_annual_cap = NULL, cam_reconciled = true, cam_exclusion_reason = NULL`)
  })

  it('ships as the only 0025 migration file', () => {
    expect(migrationFiles().filter((f) => f.startsWith('0025_'))).toEqual([FILE])
  })

  it('existing leases default to today\'s behaviour (all categories, no cap, reconciled)', async () => {
    const r = await pg.query(`SELECT recoverable_categories, cam_annual_cap, cam_cap_through, cam_reconciled, cam_exclusion_reason FROM leases WHERE id = ${LEASE}`)
    expect(r.rows[0]).toEqual({ recoverable_categories: null, cam_annual_cap: null, cam_cap_through: null, cam_reconciled: true, cam_exclusion_reason: null })
  })

  it('recoverable_categories: subsets of the 0002 categories pass', async () => {
    await ok(`recoverable_categories = ARRAY['taxes']`)
    await ok(`recoverable_categories = ARRAY['maintenance','utilities','other']`)
    await ok(`recoverable_categories = ARRAY[${EXPENSE_CATEGORIES.map((c) => `'${c}'`).join(',')}]`)
  })

  it('recoverable_categories: empty, unknown, duplicate or NULL element are refused', async () => {
    await bad(`recoverable_categories = ARRAY[]::text[]`)
    await bad(`recoverable_categories = ARRAY['cam']`)
    await bad(`recoverable_categories = ARRAY['taxes','taxes']`)
    await bad(`recoverable_categories = ARRAY['taxes',NULL]`)
  })

  it('the app\'s category list matches the expenses.category CHECK (0002)', async () => {
    // Every app category is accepted by expenses; anything else is refused there too.
    for (const c of EXPENSE_CATEGORIES) {
      await expect(pg.exec(`INSERT INTO expenses (property_id, expense_date, category, amount) VALUES ('10000000-0000-0000-0000-0000000000a1', '2025-01-01', '${c}', 1)`)).resolves.not.toThrow()
    }
    await expect(pg.exec(`INSERT INTO expenses (property_id, expense_date, category, amount) VALUES ('10000000-0000-0000-0000-0000000000a1', '2025-01-01', 'cam', 1)`)).rejects.toThrow()
  })

  it('base_year_categories uses the same validator', async () => {
    await ok(`base_year_categories = ARRAY['taxes']`)
    await bad(`base_year_categories = ARRAY[]::text[]`)
    await bad(`base_year_categories = ARRAY['cam']`)
  })

  it('cam_annual_cap > 0; cam_cap_through only with a cap', async () => {
    await ok(`cam_annual_cap = 15000, cam_cap_through = '2029-06-30'`)
    await ok(`cam_annual_cap = 15000, cam_cap_through = NULL`)
    await bad(`cam_annual_cap = 0`)
    await bad(`cam_annual_cap = -1`)
    await bad(`cam_annual_cap = NULL, cam_cap_through = '2029-06-30'`)
  })

  it('cam_reconciled = false needs a non-blank reason', async () => {
    await ok(`cam_reconciled = false, cam_exclusion_reason = 'Direct pay: tenant pays taxes to the county'`)
    await bad(`cam_reconciled = false, cam_exclusion_reason = NULL`)
    await bad(`cam_reconciled = false, cam_exclusion_reason = '   '`)
    await bad(`cam_reconciled = NULL`)
  })

  it('cam_reconciliations: categories validated, cap applied >= 0', async () => {
    const ins = (cats: string, cap: string) => pg.exec(`
      DELETE FROM cam_reconciliations;
      INSERT INTO cam_reconciliations (lease_id, reconciliation_year, total_property_recoverable_expenses,
        tenant_pro_rata_share_pct, estimated_cam_paid, actual_cam_owed, true_up_amount, recoverable_categories, cam_annual_cap_applied)
      VALUES (${LEASE}, 2025, 1, 0.1, 0, 0, 0, ${cats}, ${cap})`)
    await expect(ins(`ARRAY['taxes']`, '15000')).resolves.not.toThrow()
    await expect(ins('NULL', 'NULL')).resolves.not.toThrow()
    await expect(ins(`ARRAY['bogus']`, 'NULL')).rejects.toThrow()
    await expect(ins('NULL', '-1')).rejects.toThrow()
  })

  it('re-applies cleanly', async () => {
    await expect(pg.exec(readFileSync(join(DIR, FILE), 'utf8'))).resolves.not.toThrow()
  })
})

describe('migration 0025 on pg-mem (the shared harness)', () => {
  it('the chain still applies and new lease columns default as today', () => {
    const db = freshMigratedDb()
    db.none(`
      INSERT INTO properties (id, name, address, city, state) VALUES ('00000000-0000-0000-0000-000000000001', 'P', '1 Main', 'Columbus', 'OH');
      INSERT INTO units (id, property_id, suite, sf) VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'A', 1000);
      INSERT INTO tenants (id, name) VALUES ('00000000-0000-0000-0000-000000000003', 'T');
      INSERT INTO leases (id, tenant_id, unit_id, start_date, end_date, base_rent_monthly)
        VALUES ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000002', '2025-01-01', '2027-12-31', 1000);
    `)
    const l = db.one(`SELECT cam_reconciled, cam_annual_cap FROM leases WHERE id = '00000000-0000-0000-0000-000000000004'`)
    expect(l).toEqual({ cam_reconciled: true, cam_annual_cap: null })
    expect(() => db.none(`UPDATE leases SET cam_annual_cap = 0`)).toThrow()
  })
})
