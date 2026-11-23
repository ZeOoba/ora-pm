/// <reference types="node" />
// tests/db/activate-pending-leases-0034.test.ts
//
// activate_pending_leases() and the lease_concessions 'all' + fixed_amount CHECK (migration 0034, lease
// abstraction Phase 7) on real PostgreSQL (PGlite). Same harness as approve-lease-abstract-0033.test.ts.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'

const DIR = join(__dirname, '../../supabase/migrations')
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()

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
const UNIT2 = '20000000-0000-0000-0000-000000000002'
const T1 = '30000000-0000-0000-0000-000000000001'
const T2 = '30000000-0000-0000-0000-000000000002'
const OLD = '40000000-0000-0000-0000-000000000001'
const NEW = '40000000-0000-0000-0000-000000000002'
const OTHER = '40000000-0000-0000-0000-000000000003'

let db: PGlite

beforeAll(async () => {
  db = new PGlite({ extensions: { btree_gist } })
  await db.exec(STUBS)
  for (const f of FILES) await db.exec(readFileSync(join(DIR, f), 'utf8'))
}, 120_000)

afterAll(async () => { await db?.close() })

beforeEach(async () => {
  await db.exec('BEGIN')
  await db.exec(`
    INSERT INTO properties (id, name, address, city, state, zip) VALUES ('${PROP}', 'P', '1 Main', 'Columbus', 'OH', '43215');
    INSERT INTO units (id, property_id, suite, sf, status) VALUES ('${UNIT}', '${PROP}', '100', 5000, 'occupied'), ('${UNIT2}', '${PROP}', '200', 5000, 'vacant');
    INSERT INTO tenants (id, name) VALUES ('${T1}', 'Old Co'), ('${T2}', 'New Co');
  `)
})

afterEach(async () => { await db.exec('ROLLBACK') })

type Result = { activated: Array<Record<string, string | null>>; blocked: Array<Record<string, string>>; dry_run: boolean }
async function activate(today: string, dryRun = false): Promise<Result> {
  const r = await db.query<{ r: Result }>('SELECT activate_pending_leases($1::date, $2) AS r', [today, dryRun])
  return r.rows[0].r
}
async function statusOf(id: string): Promise<string> {
  return (await db.query<{ status: string }>('SELECT status FROM leases WHERE id = $1', [id])).rows[0].status
}
async function lease(id: string, tenant: string, unit: string, start: string, end: string, status: string) {
  await db.query(`INSERT INTO leases (id, tenant_id, unit_id, start_date, end_date, base_rent_monthly, status) VALUES ($1, $2, $3, $4, $5, 1000, $6)`,
    [id, tenant, unit, start, end, status])
}

describe('activate_pending_leases (0034)', () => {
  it('activates a replacement lease on its start date and expires the prior lease that ended before it', async () => {
    await lease(OLD, T1, UNIT, '2022-01-01', '2026-11-15', 'active')
    await lease(NEW, T2, UNIT, '2026-11-16', '2031-11-30', 'pending')
    const r = await activate('2026-11-16')
    expect(r.activated).toEqual([{ lease_id: NEW, unit_id: UNIT, start_date: '2026-11-16', prior_lease_id: OLD }])
    expect(r.blocked).toEqual([])
    expect(await statusOf(NEW)).toBe('active')
    expect(await statusOf(OLD)).toBe('expired')
  })

  it('leaves a lease pending until its start date', async () => {
    await lease(OLD, T1, UNIT, '2022-01-01', '2026-11-15', 'active')
    await lease(NEW, T2, UNIT, '2026-11-16', '2031-11-30', 'pending')
    const r = await activate('2026-11-15')
    expect(r.activated).toEqual([])
    expect(await statusOf(NEW)).toBe('pending')
    expect(await statusOf(OLD)).toBe('active')
  })

  it('activates on a vacant unit and marks the unit occupied', async () => {
    await lease(NEW, T2, UNIT2, '2026-11-01', '2031-11-30', 'pending')
    const r = await activate('2026-11-23')
    expect(r.activated).toEqual([{ lease_id: NEW, unit_id: UNIT2, start_date: '2026-11-01', prior_lease_id: null }])
    expect((await db.query<{ status: string }>('SELECT status FROM units WHERE id = $1', [UNIT2])).rows[0].status).toBe('occupied')
  })

  it('refuses while the unit\'s active lease overlaps the pending one, and changes nothing', async () => {
    await lease(OLD, T1, UNIT, '2022-01-01', '2027-12-31', 'active')
    await lease(NEW, T2, UNIT, '2026-11-16', '2031-11-30', 'pending')
    const r = await activate('2026-11-23')
    expect(r.activated).toEqual([])
    expect(r.blocked).toEqual([expect.objectContaining({ lease_id: NEW, reason: 'unit_has_active_lease', blocking_lease_id: OLD })])
    expect(await statusOf(NEW)).toBe('pending')
    expect(await statusOf(OLD)).toBe('active')
  })

  it('never activates a pending lease whose whole term is already over', async () => {
    await lease(NEW, T2, UNIT2, '2025-01-01', '2025-12-31', 'pending')
    const r = await activate('2026-11-23')
    expect(r.blocked).toEqual([expect.objectContaining({ lease_id: NEW, reason: 'term_already_ended' })])
    expect(await statusOf(NEW)).toBe('pending')
  })

  it('does not expire an active lease past its end date that has no successor (holdover is a human decision)', async () => {
    await lease(OLD, T1, UNIT, '2022-01-01', '2026-06-30', 'active')
    await lease(OTHER, T2, UNIT2, '2026-11-01', '2031-11-30', 'pending')
    await activate('2026-11-23')
    expect(await statusOf(OLD)).toBe('active')
  })

  it('dry run reports the same outcomes and writes nothing', async () => {
    await lease(OLD, T1, UNIT, '2022-01-01', '2026-11-15', 'active')
    await lease(NEW, T2, UNIT, '2026-11-16', '2031-11-30', 'pending')
    const r = await activate('2026-11-23', true)
    expect(r.dry_run).toBe(true)
    expect(r.activated).toEqual([expect.objectContaining({ lease_id: NEW, prior_lease_id: OLD })])
    expect(await statusOf(NEW)).toBe('pending')
    expect(await statusOf(OLD)).toBe('active')
  })

  it('is idempotent: a second run changes nothing', async () => {
    await lease(NEW, T2, UNIT2, '2026-11-01', '2031-11-30', 'pending')
    await activate('2026-11-23')
    const r = await activate('2026-11-23')
    expect(r.activated).toEqual([])
    expect(r.blocked).toEqual([])
  })

  it('is service_role only', async () => {
    const r = await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(`SELECT
      has_function_privilege('anon', 'activate_pending_leases(date, boolean)', 'EXECUTE') AS anon,
      has_function_privilege('authenticated', 'activate_pending_leases(date, boolean)', 'EXECUTE') AS auth,
      has_function_privilege('service_role', 'activate_pending_leases(date, boolean)', 'EXECUTE') AS svc`)
    expect(r.rows[0]).toEqual({ anon: false, auth: false, svc: true })
  })
})

describe("lease_concessions refuses 'all' + fixed_amount (plan §5a item 6)", () => {
  it('rejects the row; a per-class fixed concession is fine', async () => {
    await lease(NEW, T2, UNIT2, '2026-11-01', '2031-11-30', 'active')
    await db.exec('SAVEPOINT bad')
    await expect(db.query(`INSERT INTO lease_concessions (lease_id, charge_type, period_start, period_end, kind, value, reason, source)
      VALUES ($1, 'all', '2026-11-01', '2026-11-30', 'fixed_amount', 500, 'x', 'manual')`, [NEW])).rejects.toThrow(/lease_concessions_all_not_fixed/)
    await db.exec('ROLLBACK TO SAVEPOINT bad')
    await db.query(`INSERT INTO lease_concessions (lease_id, charge_type, period_start, period_end, kind, value, reason, source)
      VALUES ($1, 'rent', '2026-11-01', '2026-11-30', 'fixed_amount', 500, 'x', 'manual')`, [NEW])
  })
})

describe('sync_scheduled_lease_amounts (0034, plan §5a item 2)', () => {
  async function sync(asOf: string) {
    return (await db.query<{ r: { rent_updated: number; cam_updated: number } }>('SELECT sync_scheduled_lease_amounts($1::date) AS r', [asOf])).rows[0].r
  }
  async function amounts(id: string) {
    return (await db.query<{ base_rent_monthly: string; cam_estimate_monthly: string }>('SELECT base_rent_monthly::float8::text AS base_rent_monthly, cam_estimate_monthly::float8::text AS cam_estimate_monthly FROM leases WHERE id = $1', [id])).rows[0]
  }
  async function rent(lease: string, start: string, end: string, amount: number, superseded = false) {
    await db.query(`INSERT INTO lease_rent_schedule (lease_id, effective_start, effective_end, base_rent_monthly, source, superseded_at)
      VALUES ($1, $2, $3, $4, 'manual', ${superseded ? 'now()' : 'NULL'})`, [lease, start, end, amount])
  }
  async function cam(lease: string, start: string, end: string, amount: number) {
    await db.query(`INSERT INTO lease_recurring_charges (lease_id, type, description, amount_monthly, effective_start, effective_end, source)
      VALUES ($1, 'cam_estimate', 'CAM', $2, $3, $4, 'manual')`, [lease, amount, start, end])
  }

  it('sets the lease row to the schedule step in effect', async () => {
    await lease(NEW, T2, UNIT2, '2026-01-01', '2028-12-31', 'active')
    await rent(NEW, '2026-01-01', '2026-12-31', 1000)
    await rent(NEW, '2027-01-01', '2028-12-31', 1030)
    expect(await sync('2027-01-01')).toEqual({ rent_updated: 1, cam_updated: 0 })
    expect((await amounts(NEW)).base_rent_monthly).toBe('1030')
    expect(await sync('2027-01-01')).toEqual({ rent_updated: 0, cam_updated: 0 })
  })

  it('ignores superseded rows and leaves the row alone where no active row covers the date', async () => {
    await lease(NEW, T2, UNIT2, '2026-01-01', '2028-12-31', 'active')
    await rent(NEW, '2026-01-01', '2028-12-31', 9999, true)
    expect(await sync('2027-01-01')).toEqual({ rent_updated: 0, cam_updated: 0 })
    expect((await amounts(NEW)).base_rent_monthly).toBe('1000')
  })

  it('syncs CAM only for leases whose CAM comes from recurring rows, 0 once those rows end', async () => {
    await lease(NEW, T2, UNIT2, '2026-01-01', '2028-12-31', 'active')
    await lease(OTHER, T1, UNIT, '2026-01-01', '2028-12-31', 'active')
    await db.query(`UPDATE leases SET cam_estimate_monthly = 300 WHERE id IN ($1, $2)`, [NEW, OTHER])
    await cam(NEW, '2026-01-01', '2026-12-31', 450)
    await sync('2026-06-01')
    expect((await amounts(NEW)).cam_estimate_monthly).toBe('450')
    expect((await amounts(OTHER)).cam_estimate_monthly).toBe('300')
    await sync('2027-06-01')
    expect((await amounts(NEW)).cam_estimate_monthly).toBe('0')
  })

  it('never rewrites an expired lease', async () => {
    await lease(NEW, T2, UNIT2, '2020-01-01', '2028-12-31', 'expired')
    await rent(NEW, '2020-01-01', '2028-12-31', 5000)
    expect(await sync('2027-01-01')).toEqual({ rent_updated: 0, cam_updated: 0 })
  })
})
