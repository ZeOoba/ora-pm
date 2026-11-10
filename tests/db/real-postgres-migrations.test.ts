/// <reference types="node" />
// tests/db/real-postgres-migrations.test.ts
//
// Replays EVERY supabase/migrations/*.sql file on real PostgreSQL 17 (PGlite: Postgres compiled to WASM,
// in-process, no Docker) — the coverage pg-mem cannot give: DO blocks, CREATE EXTENSION btree_gist,
// EXCLUDE USING gist, plpgsql, views, RLS statements. Supabase branching is not available on this
// project's plan, so this is the real-Postgres gate before the DB Migrate workflow (see db-migrate.yml).
//
// Supabase-only objects the migrations reference are stubbed minimally: roles anon/authenticated/
// service_role, auth.users + auth.uid(), storage.objects + storage.foldername(). The stubs are not under
// test; what Supabase itself provides is checked after a real apply with scripts/verify-rls.sql.
//
// Re-runnability: migrations from 0020 on are written to be re-applied safely (IF NOT EXISTS, guarded DO
// blocks, DROP IF EXISTS + ADD), so each is applied a SECOND time here. Older files predate that rule.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'

const DIR = join(__dirname, '../../supabase/migrations')
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
const RERUNNABLE_FROM = '0020'

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

let db: PGlite
const applied: string[] = []

beforeAll(async () => {
  db = new PGlite({ extensions: { btree_gist } })
  await db.exec(STUBS)
  for (const f of FILES) {
    try {
      await db.exec(readFileSync(join(DIR, f), 'utf8'))
      applied.push(f)
    } catch (e) {
      throw new Error(`real Postgres failed to apply ${f}: ${(e as Error).message}`)
    }
  }
}, 120_000)

afterAll(async () => { await db?.close() })

describe('every migration applies on real PostgreSQL 17', () => {
  it('applies all files in order', () => {
    expect(applied).toEqual(FILES)
  })

  it.each(FILES.filter((f) => f >= RERUNNABLE_FROM))('%s re-applies cleanly (re-paste safe)', async (f) => {
    await expect(db.exec(readFileSync(join(DIR, f), 'utf8'))).resolves.not.toThrow()
  })
})

// 0020's overlap guards and composite FKs, exercised for real (pg-mem skips the DO block that adds them).
describe('0020 guards on real Postgres', () => {
  const L1 = `'40000000-0000-0000-0000-000000000001'`
  const L2 = `'40000000-0000-0000-0000-000000000002'`
  const base = `
    INSERT INTO properties (id, name, address, city, state, zip) VALUES ('10000000-0000-0000-0000-000000000001', 'P', '1 Main', 'Columbus', 'OH', '43215');
    INSERT INTO units (id, property_id, suite, sf) VALUES
      ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '100', 5000),
      ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '200', 5000);
    INSERT INTO tenants (id, name) VALUES ('30000000-0000-0000-0000-000000000001', 'Acme');
    INSERT INTO leases (id, tenant_id, unit_id, start_date, end_date, base_rent_monthly) VALUES
      (${L1}, '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '2026-01-01', '2030-12-31', 5000),
      (${L2}, '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', '2031-01-01', '2031-12-31', 5000);
  `
  const rent = (s: string, e: string, superseded = false) =>
    `INSERT INTO lease_rent_schedule (lease_id, effective_start, effective_end, base_rent_monthly, source${superseded ? ', superseded_at' : ''})
     VALUES (${L1}, '${s}', '${e}', 5000, 'manual'${superseded ? ', now()' : ''});`

  /** Runs sql in a rolled-back transaction; resolves to the Postgres SQLSTATE, or null on success. */
  async function sqlstate(sql: string): Promise<string | null> {
    await db.exec('BEGIN')
    try {
      await db.exec(base + sql)
      return null
    } catch (e) {
      return (e as { code?: string }).code ?? 'unknown'
    } finally {
      await db.exec('ROLLBACK')
    }
  }

  it('has exactly five EXCLUDE constraints, each scoped to active (non-superseded) rows', async () => {
    const r = await db.query<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype = 'x'`)
    expect(r.rows).toHaveLength(5)
    for (const { def } of r.rows) expect(def).toMatch(/superseded_at IS NULL/)
  })

  it.each<[string, string, string | null]>([
    ['contiguous rent steps', rent('2026-01-01', '2026-12-31') + rent('2027-01-01', '2030-12-31'), null],
    ['overlapping active rent steps', rent('2026-01-01', '2026-12-31') + rent('2026-12-31', '2030-12-31'), '23P01'],
    ['overlap with a superseded row', rent('2026-01-01', '2030-12-31', true) + rent('2026-01-01', '2030-12-31'), null],
    ['same-class concession overlap',
      `INSERT INTO lease_concessions (lease_id, charge_type, period_start, period_end, kind, reason, source) VALUES
        (${L1}, 'rent', '2026-01-01', '2026-03-31', 'full_waiver', 'a', 'manual'), (${L1}, 'rent', '2026-03-01', '2026-04-30', 'full_waiver', 'b', 'manual');`, '23P01'],
    ['"other" lines equal modulo case/space',
      `INSERT INTO lease_recurring_charges (lease_id, type, description, amount_monthly, effective_start, effective_end, source) VALUES
        (${L1}, 'other', 'Tax escrow', 10, '2026-01-01', '2026-12-31', 'manual'), (${L1}, 'other', '  TAX ESCROW ', 10, '2026-06-01', '2026-12-31', 'manual');`, '23P01'],
    ['open-ended escalation overlapping a later one',
      `INSERT INTO lease_escalation_rules (lease_id, kind, value, first_adjustment_date, source) VALUES
        (${L1}, 'fixed_pct', 0.03, '2027-01-01', 'manual'), (${L1}, 'fixed_pct', 0.03, '2029-01-01', 'manual');`, '23P01'],
    ['a row citing another lease\'s abstract',
      `INSERT INTO lease_abstracts (id, lease_id, kind, storage_path, file_sha256, model) VALUES ('50000000-0000-0000-0000-000000000002', ${L2}, 'lease', 'x.pdf', '${'a'.repeat(64)}', 'm');
       INSERT INTO lease_rent_schedule (lease_id, effective_start, effective_end, base_rent_monthly, source, abstract_id) VALUES (${L1}, '2026-01-01', '2026-12-31', 1, 'abstract', '50000000-0000-0000-0000-000000000002');`, '23503'],
    ['deleting a lease that has abstracts',
      `INSERT INTO lease_abstracts (lease_id, kind, storage_path, file_sha256, model) VALUES (${L1}, 'lease', 'x.pdf', '${'a'.repeat(64)}', 'm');
       DELETE FROM leases WHERE id = ${L1};`, '23001'],
  ])('%s → %s', async (_name, sql, expected) => {
    expect(await sqlstate(sql)).toBe(expected)
  })
})
