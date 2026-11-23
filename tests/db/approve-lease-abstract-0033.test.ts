/// <reference types="node" />
// tests/db/approve-lease-abstract-0033.test.ts
//
// approve_lease_abstract() (migration 0033, lease abstraction Phase 4) on real PostgreSQL (PGlite): pg-mem
// has no plpgsql. Every migration is applied in order with the same Supabase stubs as
// tests/db/autopay-reservation-0031.test.ts; each test runs inside BEGIN ... ROLLBACK.
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
const OLD_TENANT = '30000000-0000-0000-0000-000000000001'
const OLD_LEASE = '40000000-0000-0000-0000-000000000001'
const SHA = 'a'.repeat(64)

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
    INSERT INTO tenants (id, name, notes) VALUES ('${OLD_TENANT}', 'Old Co', 'keep me');
    INSERT INTO leases (id, tenant_id, unit_id, start_date, end_date, base_rent_monthly) VALUES
      ('${OLD_LEASE}', '${OLD_TENANT}', '${UNIT}', '2022-01-01', '2027-12-31', 4000);
  `)
})

afterEach(async () => { await db.exec('ROLLBACK') })

type Payload = Record<string, unknown>
function payload(over: Payload = {}): Payload {
  return {
    unit_id: UNIT,
    today: '2026-11-23',
    tenant: { mode: 'new', name: 'New Co LLC', legal_name: 'New Co LLC', entity_type: 'llc', state_of_formation: 'OH', notice_address: '9 Elm St' },
    replace: { lease_id: OLD_LEASE, end_date: '2026-11-15' },
    lease: { start_date: '2026-11-16', end_date: '2031-11-30', rent_type: 'nnn', base_rent_monthly: 5000, cam_estimate_monthly: 750, security_deposit: 10000, proportionate_share_pct: 0.25, notes: 'Renewal option: one 5-year term.' },
    abstract: { storage_path: `abstracts/${SHA}.pdf`, file_sha256: SHA, model: 'claude-opus-5', raw_fields: { x: 1 }, warnings: [], approved_by: 'admin@example.com' },
    document: { name: 'New Co Lease.pdf' },
    rent_schedule: [
      { effective_start: '2026-11-16', effective_end: '2027-11-30', base_rent_monthly: 5000, rent_psf_annual: null },
      { effective_start: '2027-12-01', effective_end: '2031-11-30', base_rent_monthly: 5150, rent_psf_annual: null },
    ],
    escalation: { kind: 'fixed_pct', value: 0.03, cadence_months: 12, first_adjustment_date: '2027-12-01', applies_until: '2031-11-30' },
    concessions: [{ charge_type: 'rent', period_start: '2026-11-16', period_end: '2026-12-31', kind: 'full_waiver', value: null, reason: 'Free rent' }],
    recurring_charges: [{ type: 'cam_estimate', description: 'CAM estimate', amount_monthly: 750, effective_start: '2026-11-16', effective_end: '2031-11-30' }],
    provisions: [
      { category: 'renewal_option', summary: 'One 5-year renewal option.', verbatim_excerpt: 'Tenant shall have one option', page_ref: 4, notice_deadline: '2031-05-31', exercise_window_start: null, exercise_window_end: null },
      { category: 'permitted_use', summary: 'Light manufacturing.', verbatim_excerpt: null, page_ref: 1, notice_deadline: null, exercise_window_start: null, exercise_window_end: null },
    ],
    critical_dates: [{ critical_date: '2031-11-30', kind: 'expiration', description: 'Lease expires' }],
    ...over,
  }
}

async function approve(p: Payload) {
  const r = await db.query<{ r: Record<string, unknown> }>('SELECT approve_lease_abstract($1::jsonb) AS r', [JSON.stringify(p)])
  return r.rows[0].r
}
async function one<T = Record<string, unknown>>(sql: string): Promise<T> {
  return (await db.query<T>(sql)).rows[0]
}

describe('approve_lease_abstract — replace the prior tenant', () => {
  it('creates the new tenant + lease + every abstract row and closes the prior lease without touching the prior tenant', async () => {
    const r = await approve(payload())
    expect(r.outcome).toBe('approved')
    expect(r.status).toBe('active')
    const leaseId = r.lease_id as string

    const old = await one<{ status: string; end_date: string }>(`SELECT status, end_date::text FROM leases WHERE id = '${OLD_LEASE}'`)
    expect(old).toEqual({ status: 'terminated', end_date: '2026-11-15' })
    const oldTenant = await one<{ name: string; notes: string }>(`SELECT name, notes FROM tenants WHERE id = '${OLD_TENANT}'`)
    expect(oldTenant).toEqual({ name: 'Old Co', notes: 'keep me' })

    const lease = await one<Record<string, unknown>>(`SELECT l.status, l.base_rent_monthly::text AS rent, l.cam_estimate_monthly::text AS cam, l.proportionate_share_pct::text AS share, l.notes, t.name, t.legal_name, t.entity_type, t.notice_address FROM leases l JOIN tenants t ON t.id = l.tenant_id WHERE l.id = '${leaseId}'`)
    expect(lease).toMatchObject({ status: 'active', rent: '5000', cam: '750', share: '0.25', name: 'New Co LLC', entity_type: 'llc', notice_address: '9 Elm St', notes: 'Renewal option: one 5-year term.' })

    const counts = await one<Record<string, number>>(`SELECT
      (SELECT count(*)::int FROM lease_rent_schedule WHERE lease_id = '${leaseId}' AND source = 'abstract') AS rent,
      (SELECT count(*)::int FROM lease_escalation_rules WHERE lease_id = '${leaseId}') AS esc,
      (SELECT count(*)::int FROM lease_concessions WHERE lease_id = '${leaseId}') AS conc,
      (SELECT count(*)::int FROM lease_recurring_charges WHERE lease_id = '${leaseId}') AS rec,
      (SELECT count(*)::int FROM lease_provisions WHERE lease_id = '${leaseId}') AS prov,
      (SELECT count(*)::int FROM lease_critical_dates WHERE lease_id = '${leaseId}') AS crit,
      (SELECT count(*)::int FROM lease_documents WHERE lease_id = '${leaseId}') AS docs,
      (SELECT count(*)::int FROM lease_abstracts WHERE lease_id = '${leaseId}' AND status = 'approved') AS abs,
      (SELECT count(*)::int FROM lease_move_events WHERE lease_id = '${OLD_LEASE}' AND event_type = 'move_out') AS moveout,
      (SELECT count(*)::int FROM lease_move_events WHERE lease_id = '${leaseId}' AND event_type = 'move_in') AS movein`)
    // crit: 1 derived expiration + 1 renewal notice deadline tied to its provision
    expect(counts).toEqual({ rent: 2, esc: 1, conc: 1, rec: 1, prov: 2, crit: 2, docs: 1, abs: 1, moveout: 1, movein: 1 })
    const notice = await one<{ kind: string; linked: boolean }>(`SELECT kind, provision_id IS NOT NULL AS linked FROM lease_critical_dates WHERE lease_id = '${leaseId}' AND source = 'abstract'`)
    expect(notice).toEqual({ kind: 'option_notice', linked: true })
  })

  it('counts (never voids) prior-lease charges billed past its new end date', async () => {
    await db.exec(`INSERT INTO charges (lease_id, charge_date, due_date, period_start, period_end, type, amount, description, source, idempotency_key)
      VALUES ('${OLD_LEASE}', '2026-12-01', '2026-12-01', '2026-12-01', '2026-12-31', 'rent', 4000, 'Dec rent', 'auto', 'k-dec')`)
    // REFUTE D5: the straddling final month (Nov, end date 11-15) counts too; an October charge does not.
    await db.exec(`INSERT INTO charges (lease_id, charge_date, due_date, period_start, period_end, type, amount, description, source, idempotency_key) VALUES
      ('${OLD_LEASE}', '2026-11-01', '2026-11-01', '2026-11-01', '2026-11-30', 'rent', 4000, 'Nov rent', 'auto', 'k-nov'),
      ('${OLD_LEASE}', '2026-10-01', '2026-10-01', '2026-10-01', '2026-10-31', 'rent', 4000, 'Oct rent', 'auto', 'k-oct')`)
    const r = await approve(payload())
    expect(r.prior_charges_after_end).toBe(2)
    const c = await one<{ voided: number }>(`SELECT count(*)::int AS voided FROM charges WHERE voided_at IS NOT NULL`)
    expect(c.voided).toBe(0)
  })

  it('refuses a pending lease overlapping another pending lease on the unit (REFUTE D1)', async () => {
    const future = { lease: { ...(payload().lease as object), start_date: '2028-01-01', end_date: '2030-12-31' }, rent_schedule: [{ effective_start: '2028-01-01', effective_end: '2030-12-31', base_rent_monthly: 5000 }], concessions: [], replace: null }
    const first = await approve(payload(future))
    expect(first).toMatchObject({ outcome: 'approved', status: 'pending' })
    const abs = { ...(payload().abstract as object), file_sha256: 'b'.repeat(64), storage_path: 'abstracts/b.pdf' }
    const second = await approve(payload({ ...future, abstract: abs }))
    expect(second).toEqual({ outcome: 'unit_occupied', lease_id: first.lease_id })
  })

  it('records an already-ended historic lease as expired without taking the unit (REFUTE D3)', async () => {
    const r = await approve(payload({
      unit_id: UNIT2, replace: null,
      lease: { ...(payload().lease as object), start_date: '2020-01-01', end_date: '2021-12-31' },
      rent_schedule: [{ effective_start: '2020-01-01', effective_end: '2021-12-31', base_rent_monthly: 3000 }], concessions: [],
    }))
    expect(r).toMatchObject({ outcome: 'approved', status: 'expired' })
    const u = await one<{ status: string }>(`SELECT status FROM units WHERE id = '${UNIT2}'`)
    expect(u.status).toBe('vacant')
  })

  it('never extends a prior lease that already ends before the given end date', async () => {
    await db.exec(`UPDATE leases SET end_date = '2026-06-30' WHERE id = '${OLD_LEASE}'`)
    const r = await approve(payload())
    expect(r.outcome).toBe('approved')
    const old = await one<{ status: string; end_date: string }>(`SELECT status, end_date::text FROM leases WHERE id = '${OLD_LEASE}'`)
    expect(old).toEqual({ status: 'expired', end_date: '2026-06-30' })
  })

  it('future-dated new lease: new lease pending, prior lease stays active until its new end date', async () => {
    const r = await approve(payload({
      replace: { lease_id: OLD_LEASE, end_date: '2027-01-31' },
      lease: { ...(payload().lease as object), start_date: '2027-02-01' },
      rent_schedule: [{ effective_start: '2027-02-01', effective_end: '2031-11-30', base_rent_monthly: 5000 }],
      concessions: [],
    }))
    expect(r.status).toBe('pending')
    const old = await one<{ status: string; end_date: string }>(`SELECT status, end_date::text FROM leases WHERE id = '${OLD_LEASE}'`)
    expect(old).toEqual({ status: 'active', end_date: '2027-01-31' })
  })
})

describe('approve_lease_abstract — guards decide before any write', () => {
  it('refuses an occupied unit without a replacement, writing nothing', async () => {
    const r = await approve(payload({ replace: null }))
    expect(r.outcome).toBe('unit_occupied')
    expect(r.lease_id).toBe(OLD_LEASE)
    const n = await one<{ t: number; l: number }>(`SELECT (SELECT count(*)::int FROM tenants) AS t, (SELECT count(*)::int FROM leases) AS l`)
    expect(n).toEqual({ t: 1, l: 1 })
  })

  it('an already-ended historic upload cannot replace the current tenant (REFUTE round 2 D8)', async () => {
    await db.exec(`UPDATE leases SET start_date = '2019-01-01' WHERE id = '${OLD_LEASE}'`)
    const r = await approve(payload({
      replace: { lease_id: OLD_LEASE, end_date: '2019-12-31' },
      lease: { ...(payload().lease as object), start_date: '2020-01-01', end_date: '2021-12-31' },
      rent_schedule: [{ effective_start: '2020-01-01', effective_end: '2021-12-31', base_rent_monthly: 3000 }], concessions: [],
    }))
    expect(r.outcome).toBe('replace_historic')
    const old = await one<{ status: string; end_date: string }>(`SELECT status, end_date::text FROM leases WHERE id = '${OLD_LEASE}'`)
    expect(old).toEqual({ status: 'active', end_date: '2027-12-31' })
  })

  it('refuses a replace end date on or after the new start', async () => {
    const r = await approve(payload({ replace: { lease_id: OLD_LEASE, end_date: '2026-11-16' } }))
    expect(r.outcome).toBe('replace_bad_end_date')
    const old = await one<{ end_date: string }>(`SELECT end_date::text FROM leases WHERE id = '${OLD_LEASE}'`)
    expect(old.end_date).toBe('2027-12-31')
  })

  it('refuses replacing a lease on another unit', async () => {
    const r = await approve(payload({ unit_id: UNIT2 }))
    expect(r.outcome).toBe('replace_wrong_unit')
  })

  it('vacant unit, existing tenant: fills blank party fields only, never overwrites one (REFUTE D6)', async () => {
    await db.exec(`UPDATE tenants SET dba = 'Keep DBA', notice_address = '1 Old Rd' WHERE id = '${OLD_TENANT}'`)
    const r = await approve(payload({ unit_id: UNIT2, replace: null, tenant: { mode: 'existing', id: OLD_TENANT, legal_name: 'Old Company Inc.', dba: 'Other DBA', notice_address: '1 New Rd' } }))
    expect(r.outcome).toBe('approved')
    const t = await one<{ legal_name: string; dba: string; name: string; notice_address: string }>(`SELECT legal_name, dba, name, notice_address FROM tenants WHERE id = '${OLD_TENANT}'`)
    expect(t).toEqual({ legal_name: 'Old Company Inc.', dba: 'Keep DBA', name: 'Old Co', notice_address: '1 Old Rd' })
    const u = await one<{ status: string }>(`SELECT status FROM units WHERE id = '${UNIT2}'`)
    expect(u.status).toBe('occupied')
  })

  it('is idempotent on (file hash, unit): a second approve returns the first lease', async () => {
    const first = await approve(payload())
    const second = await approve(payload())
    expect(second).toEqual({ outcome: 'already_approved', lease_id: first.lease_id })
    const n = await one<{ l: number }>(`SELECT count(*)::int AS l FROM leases`)
    expect(n.l).toBe(2)
  })

  it('an invalid child row rolls the whole approval back', async () => {
    await db.exec('SAVEPOINT s')
    await expect(approve(payload({ rent_schedule: [{ effective_start: '2026-11-16', effective_end: '2026-11-01', base_rent_monthly: 5000 }] }))).rejects.toThrow()
    await db.exec('ROLLBACK TO SAVEPOINT s')
    const n = await one<{ t: number; l: number; end_date: string }>(`SELECT (SELECT count(*)::int FROM tenants) AS t, (SELECT count(*)::int FROM leases) AS l, (SELECT end_date::text FROM leases WHERE id = '${OLD_LEASE}') AS end_date`)
    expect(n).toEqual({ t: 1, l: 1, end_date: '2027-12-31' })
  })

  it('is service-role only', async () => {
    const r = await one<{ anon: boolean; auth: boolean; svc: boolean }>(`SELECT
      has_function_privilege('anon', 'approve_lease_abstract(jsonb)', 'EXECUTE') AS anon,
      has_function_privilege('authenticated', 'approve_lease_abstract(jsonb)', 'EXECUTE') AS auth,
      has_function_privilege('service_role', 'approve_lease_abstract(jsonb)', 'EXECUTE') AS svc`)
    expect(r).toEqual({ anon: false, auth: false, svc: true })
  })
})
