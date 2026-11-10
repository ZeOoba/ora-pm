/// <reference types="node" />
// tests/db/cam-approve-atomic-0023.test.ts
//
// approve_cam_reconciliation() (migration 0023) on real PostgreSQL 17 (PGlite). pg-mem has no plpgsql,
// so this is the only test that executes the function body. Every migration is applied in order on
// one PGlite instance with the same Supabase stubs as tests/db/real-postgres-migrations.test.ts; each
// test runs inside BEGIN ... ROLLBACK so they cannot leak state into each other.
//
// PGlite is a single connection, so two transactions cannot genuinely contend here. What this file
// proves is the function's contract per state (every outcome), that a failure anywhere rolls back the
// charge AND the status together, and the conflict re-read path (a key holder appearing between the
// lookup and the INSERT, injected with a trigger). The row lock itself is plain SELECT ... FOR UPDATE
// and is pinned textually below.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'

const DIR = join(__dirname, '../../supabase/migrations')
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
const FILE = '0023_cam_approve_atomic.sql'

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
const TENANT = '30000000-0000-0000-0000-000000000001'
const LEASE = '40000000-0000-0000-0000-000000000001'
const OTHER_LEASE = '40000000-0000-0000-0000-000000000002'
const REC = '50000000-0000-0000-0000-000000000001'
const YEAR = 2025
const KEY = `cam_true_up:${LEASE}:${YEAR}`
const TODAY = '2026-11-10'

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
    INSERT INTO units (id, property_id, suite, sf) VALUES
      ('${UNIT}', '${PROP}', '100', 1000), ('${UNIT2}', '${PROP}', '200', 1000);
    INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Acme');
    INSERT INTO leases (id, tenant_id, unit_id, start_date, end_date, base_rent_monthly) VALUES
      ('${LEASE}', '${TENANT}', '${UNIT}', '2020-01-01', '2030-12-31', 5000),
      ('${OTHER_LEASE}', '${TENANT}', '${UNIT2}', '2020-01-01', '2030-12-31', 5000);
  `)
})

afterEach(async () => { await db.exec('ROLLBACK') })

type Rec = { trueUp?: string; shareBasis?: string | null; status?: string }
async function seedRec({ trueUp = '500.00', shareBasis = 'premises_rsf_over_denominator', status = 'draft' }: Rec = {}) {
  await db.query(
    `INSERT INTO cam_reconciliations (id, lease_id, reconciliation_year, total_property_recoverable_expenses,
       tenant_pro_rata_share_pct, estimated_cam_paid, actual_cam_owed, true_up_amount, status, share_basis)
     VALUES ($1, $2, $3, 25000, 0.02, 0, 500, $4, $5, $6)`,
    [REC, LEASE, YEAR, trueUp, status, shareBasis],
  )
}

type Holder = { type?: string; lease?: string; amount?: string; voided?: boolean }
async function seedHolder({ type = 'cam_true_up', lease = LEASE, amount = '500.00', voided = false }: Holder = {}) {
  await db.query(
    `INSERT INTO charges (lease_id, charge_date, due_date, period_start, period_end, type, amount, source, idempotency_key, voided_at, void_reason)
     VALUES ($1, '2026-01-01', '2026-01-01', '2025-01-01', '2025-12-31', $2, $3, 'manual', $4, $5, $6)`,
    [lease, type, amount, KEY, voided ? '2026-11-01T00:00:00Z' : null, voided ? 'test' : null],
  )
}

type Outcome = Record<string, unknown> & { outcome: string }
async function approve(trueUp: string | number = 500, shareBasis = 'premises_rsf_over_denominator', id = REC): Promise<Outcome> {
  const r = await db.query<{ r: Outcome }>('SELECT approve_cam_reconciliation($1, $2, $3, $4) AS r', [id, trueUp, shareBasis, TODAY])
  return r.rows[0].r
}

async function recRow() {
  return (await db.query<{ status: string; billed_date: string | null; notes: string | null }>(
    `SELECT status, billed_date::text AS billed_date, notes FROM cam_reconciliations WHERE id = '${REC}'`,
  )).rows[0]
}

async function keyCharges() {
  return (await db.query<{ amount: string; type: string; lease_id: string; charge_date: string; period_start: string; period_end: string; description: string; source: string }>(
    `SELECT amount::text AS amount, type, lease_id::text AS lease_id, charge_date::text AS charge_date,
       period_start::text AS period_start, period_end::text AS period_end, description, source
     FROM charges WHERE idempotency_key = '${KEY}'`,
  )).rows
}

describe('migration 0023 — shape', () => {
  const sql = readFileSync(join(DIR, FILE), 'utf8')

  it('ships as the only 0023 migration file', () => {
    expect(FILES.filter((f) => f.startsWith('0023_'))).toEqual([FILE])
  })

  it('locks the reconciliation row and the key holder FOR UPDATE', () => {
    expect(sql).toMatch(/FROM cam_reconciliations WHERE id = p_id FOR UPDATE/)
    expect(sql).toMatch(/FROM charges WHERE idempotency_key = v_key FOR UPDATE/)
  })

  it('is executable by service_role only', async () => {
    const priv = async (role: string) => (await db.query<{ ok: boolean }>(
      `SELECT has_function_privilege('${role}', 'approve_cam_reconciliation(uuid, numeric, text, date)', 'EXECUTE') AS ok`,
    )).rows[0].ok
    expect(await priv('service_role')).toBe(true)
    expect(await priv('anon')).toBe(false)
    expect(await priv('authenticated')).toBe(false)
  })

  it('is SECURITY INVOKER with a pinned search_path', async () => {
    const r = await db.query<{ secdef: boolean; cfg: string[] | null }>(
      `SELECT prosecdef AS secdef, proconfig AS cfg FROM pg_proc WHERE proname = 'approve_cam_reconciliation'`,
    )
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].secdef).toBe(false)
    expect(r.rows[0].cfg).toContain('search_path=public')
  })
})

describe('approve_cam_reconciliation — positive true-up', () => {
  it('posts the charge and bills the row in one call', async () => {
    await seedRec()
    const out = await approve()
    expect(out).toMatchObject({ outcome: 'billed', inserted: true })
    expect(await recRow()).toMatchObject({ status: 'billed', billed_date: TODAY })
    expect(await keyCharges()).toEqual([{
      amount: '500.00', type: 'cam_true_up', lease_id: LEASE, charge_date: TODAY,
      period_start: '2025-01-01', period_end: '2025-12-31', description: '2025 CAM True-Up', source: 'manual',
    }])
  })

  it('a second call is not_draft and posts nothing more', async () => {
    await seedRec()
    await approve()
    expect(await approve()).toMatchObject({ outcome: 'not_draft', status: 'billed' })
    expect(await keyCharges()).toHaveLength(1)
  })

  it('a live charge equal to the draft (left by the old two-call path) is billed without a second insert', async () => {
    await seedRec()
    await seedHolder({ amount: '500' })
    expect(await approve()).toMatchObject({ outcome: 'billed', inserted: false })
    expect((await recRow()).status).toBe('billed')
    expect(await keyCharges()).toHaveLength(1)
  })

  it('a live charge of a different amount: live_mismatch, row stays a draft', async () => {
    await seedRec({ trueUp: '600.00' })
    await seedHolder({ amount: '500.00' })
    expect(await approve(600)).toMatchObject({ outcome: 'live_mismatch' })
    expect(Number((await approve(600)).charge_amount)).toBe(500)
    expect((await recRow()).status).toBe('draft')
  })
})

describe('approve_cam_reconciliation — credits and balanced drafts', () => {
  it('a credit with no holder: billed_credit, nothing posted, manual-credit note', async () => {
    await seedRec({ trueUp: '-75.00' })
    expect(await approve(-75)).toMatchObject({ outcome: 'billed_credit' })
    expect(await recRow()).toEqual({
      status: 'billed', billed_date: TODAY,
      notes: 'Credit of 75.00 owed to tenant — handle manually (Phase 1 limitation)',
    })
    expect(await keyCharges()).toHaveLength(0)
  })

  it('THE LOUD PATH: a credit is never billed while a +true-up charge is live', async () => {
    await seedRec({ trueUp: '-75.00' })
    await seedHolder({ amount: '500.00' })
    expect(await approve(-75)).toMatchObject({ outcome: 'live_mismatch' })
    expect((await recRow()).status).toBe('draft')
  })

  it('balanced with no holder: balanced, nothing changed', async () => {
    await seedRec({ trueUp: '0' })
    expect(await approve(0)).toEqual({ outcome: 'balanced' })
    expect((await recRow()).status).toBe('draft')
    expect(await keyCharges()).toHaveLength(0)
  })

  it('balanced with a live $0.00 holder: live_mismatch (a balanced draft is never billed)', async () => {
    await seedRec({ trueUp: '0' })
    await seedHolder({ amount: '0.00' })
    expect(await approve(0)).toMatchObject({ outcome: 'live_mismatch' })
    expect((await recRow()).status).toBe('draft')
  })

  it('balanced with a live charge: live_mismatch', async () => {
    await seedRec({ trueUp: '0' })
    await seedHolder()
    expect(await approve(0)).toMatchObject({ outcome: 'live_mismatch' })
    expect((await recRow()).status).toBe('draft')
  })
})

describe('approve_cam_reconciliation — refusals change nothing', () => {
  it.each<[string, Rec, Holder | null, string | number, string, string]>([
    ['unknown id', {}, null, 500, 'premises_rsf_over_denominator', 'not_found'],
    ['already billed', { status: 'billed' }, null, 500, 'premises_rsf_over_denominator', 'not_draft'],
    ['collected', { status: 'collected' }, null, 500, 'premises_rsf_over_denominator', 'not_draft'],
    ['no share_basis', { shareBasis: null }, null, 500, 'premises_rsf_over_denominator', 'no_basis'],
    ['true-up changed since it was priced', { trueUp: '600.00' }, null, 500, 'premises_rsf_over_denominator', 'changed'],
    ['share_basis changed since it was priced', {}, null, 500, 'lease_stated_pct', 'changed'],
    ['voided holder', {}, { voided: true }, 500, 'premises_rsf_over_denominator', 'voided'],
    ['holder of another type', {}, { type: 'other' }, 500, 'premises_rsf_over_denominator', 'foreign'],
    ['holder on another lease', {}, { lease: OTHER_LEASE }, 500, 'premises_rsf_over_denominator', 'foreign'],
  ])('%s -> %s', async (name, rec, holder, trueUp, basis, expected) => {
    await seedRec(rec)
    if (holder) await seedHolder(holder)
    const before = await keyCharges()
    const statusBefore = (await recRow()).status
    const out = await approve(trueUp, basis, name === 'unknown id' ? '59999999-0000-0000-0000-000000000009' : REC)
    expect(out.outcome).toBe(expected)
    expect(await keyCharges()).toEqual(before)
    expect((await recRow()).status).toBe(statusBefore)
  })

  it('changed reports the row\'s current figures', async () => {
    await seedRec({ trueUp: '600.00' })
    const out = await approve(500)
    expect(Number(out.true_up_amount)).toBe(600)
    expect(out.share_basis).toBe('premises_rsf_over_denominator')
  })

  it('compares money as NUMERIC, so 500 and 500.00 are the same figure', async () => {
    await seedRec({ trueUp: '500.00' })
    expect((await approve('500')).outcome).toBe('billed')
  })

  it('missing arguments raise (nothing silently defaulted)', async () => {
    await seedRec()
    await db.exec('SAVEPOINT s')
    await expect(db.query('SELECT approve_cam_reconciliation($1, NULL, $2, $3)', [REC, 'premises_rsf_over_denominator', TODAY])).rejects.toThrow(/required/)
    await db.exec('ROLLBACK TO SAVEPOINT s')
  })
})

// The pre-deploy DATA CHECK in the 0023 header / README: must flag every live true-up the function
// cannot see, and none of the function's own postings. Read from the migration text so it cannot drift.
describe('0023 pre-flight data check query', () => {
  const sql = readFileSync(join(DIR, FILE), 'utf8')
  const query = (/-- {3}(SELECT id, lease_id, period_start, amount FROM charges\r?\n(?:-- {3}.*\r?\n)+)/.exec(sql)?.[1] ?? '')
    .replace(/^--\s+/gm, '').trim().replace(/;$/, '')
  const flagged = async () => (await db.query<{ amount: string }>(query)).rows

  it('is present in the header', () => { expect(query).toMatch(/IS DISTINCT FROM/) })

  it('does not flag a true-up the function posted', async () => {
    await seedRec()
    expect((await approve()).outcome).toBe('billed')
    expect(await flagged()).toEqual([])
  })

  it.each([
    ['a manual: key', 'manual:abc'],
    ['another lease\'s reserved key', `cam_true_up:${OTHER_LEASE}:${YEAR}`],
    ['another year\'s reserved key', `cam_true_up:${LEASE}:2024`],
    ['a look-alike key (LIKE wildcard)', `cam-true-up:${LEASE}:${YEAR}`],
  ])('flags a hand-posted true-up under %s', async (_n, key) => {
    await db.query(
      `INSERT INTO charges (lease_id, charge_date, due_date, period_start, period_end, type, amount, source, idempotency_key)
       VALUES ($1, '2026-01-01', '2026-01-01', '2025-01-01', '2025-12-31', 'cam_true_up', 500, 'manual', $2)`,
      [LEASE, key],
    )
    expect(await flagged()).toHaveLength(1)
  })
})

describe('approve_cam_reconciliation — atomicity', () => {
  it('THE SILENT PATH: a failure after the insert rolls back the charge with the status', async () => {
    await seedRec()
    // A failure on the status UPDATE (stands in for a DB error, a cancelled request or a dropped
    // connection after the charge INSERT inside the same call).
    await db.exec(`
      CREATE FUNCTION pg_temp.fail_bill() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status = 'billed' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_bill BEFORE UPDATE ON cam_reconciliations FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_bill();
      SAVEPOINT s;
    `)
    await expect(approve()).rejects.toThrow(/injected failure/)
    await db.exec('ROLLBACK TO SAVEPOINT s')
    expect(await keyCharges()).toHaveLength(0)
    expect((await recRow()).status).toBe('draft')
  })

  it.each<[string, Holder, string]>([
    ['an equal live charge', { amount: '500.00' }, 'billed'],
    ['a different live charge', { amount: '450.00' }, 'live_mismatch'],
    ['a foreign charge', { type: 'other' }, 'foreign'],
  ])('a holder committed between the lookup and the INSERT (%s) is re-read and classified -> %s', async (_n, holder, expected) => {
    await seedRec()
    // Inject the holder from a BEFORE INSERT trigger on the function's own INSERT: the INSERT then
    // conflicts (ON CONFLICT DO NOTHING) and the function's second pass must classify the holder.
    const type = holder.type ?? 'cam_true_up'
    await db.exec(`
      CREATE FUNCTION pg_temp.inject_holder() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF pg_trigger_depth() = 1 AND NEW.idempotency_key = '${KEY}' THEN
          INSERT INTO charges (lease_id, charge_date, due_date, period_start, period_end, type, amount, source, idempotency_key)
          VALUES ('${LEASE}', '2026-01-01', '2026-01-01', '2025-01-01', '2025-12-31', '${type}', ${holder.amount ?? '500.00'}, 'manual', '${KEY}');
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER inject_holder BEFORE INSERT ON charges FOR EACH ROW EXECUTE FUNCTION pg_temp.inject_holder();
    `)
    const out = await approve()
    expect(out.outcome).toBe(expected)
    const charges = await keyCharges()
    expect(charges).toHaveLength(1)
    expect(charges[0].amount).toBe(holder.amount ?? '500.00')
    expect((await recRow()).status).toBe(expected === 'billed' ? 'billed' : 'draft')
    if (expected === 'billed') expect(out.inserted).toBe(false)
  })
})
