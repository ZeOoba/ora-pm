/// <reference types="node" />
// tests/db/autopay-reservation-0031.test.ts
//
// reserve_autopay_payment() (migration 0031, audit 2026-11-12 finding 1) on real PostgreSQL
// (PGlite). pg-mem has no plpgsql, so this is the test that executes the function body; the route
// tests (tests/routes/cron-billing.test.ts) drive the cron's control flow around each outcome
// through a JS stand-in of the same formula. Every migration is applied in order on one PGlite
// instance with the same Supabase stubs as tests/db/cam-approve-atomic-0024.test.ts; each test runs
// inside BEGIN ... ROLLBACK.
//
// PGlite is one connection, so two transactions cannot genuinely contend here. What this file
// proves is the per-state contract (every outcome and the amount formula), that the lock key is
// byte-identical to reserve_payment_intent()'s (so the two paths serialize), and that each path
// sees the other's in-flight row in sequence.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'

const DIR = join(__dirname, '../../supabase/migrations')
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
const FILE = '0031_autopay_reservation.sql'

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
const START = '2026-06-01'
const END = '2026-06-30'
const TODAY = '2026-06-03'

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
    INSERT INTO units (id, property_id, suite, sf) VALUES ('${UNIT}', '${PROP}', '100', 1000);
    INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Acme');
    INSERT INTO leases (id, tenant_id, unit_id, start_date, end_date, base_rent_monthly) VALUES
      ('${LEASE}', '${TENANT}', '${UNIT}', '2020-01-01', '2030-12-31', 5000);
  `)
})

afterEach(async () => { await db.exec('ROLLBACK') })

let keySeq = 0
async function charge(amount: string, due: string, voided = false) {
  keySeq++
  await db.query(
    `INSERT INTO charges (lease_id, charge_date, due_date, period_start, period_end, type, amount, source, idempotency_key, voided_at, void_reason)
     VALUES ($1, $2, $2, $2, $2, 'rent', $3, 'auto', $4, $5, $6)`,
    [LEASE, due, amount, `test-${keySeq}`, voided ? '2026-06-02T00:00:00Z' : null, voided ? 'test' : null],
  )
}

async function payment(amount: string, date: string, method: string, status: string | null, extra: { autopay_period?: string; pi?: string } = {}) {
  await db.query(
    `INSERT INTO payments (lease_id, payment_date, amount, method, stripe_status, stripe_payment_intent_id, autopay_period)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [LEASE, date, amount, method, status, extra.pi ?? null, extra.autopay_period ?? null],
  )
}

type Outcome = Record<string, unknown> & { outcome: string }
async function reserve(): Promise<Outcome> {
  const r = await db.query<{ r: Outcome }>('SELECT reserve_autopay_payment($1, $2, $3, $4, $5) AS r', [LEASE, START, END, TODAY, `Autopay — ${START}`])
  return r.rows[0].r
}

async function autopayRows() {
  return (await db.query<{ amount: string; stripe_status: string; autopay_period: string; client_request_id: string | null; stripe_payment_intent_id: string | null; payment_date: string }>(
    `SELECT amount::text AS amount, stripe_status, autopay_period::text AS autopay_period, client_request_id::text AS client_request_id,
            stripe_payment_intent_id, payment_date::text AS payment_date
       FROM payments WHERE lease_id = '${LEASE}' AND autopay_period IS NOT NULL`,
  )).rows
}

describe('migration 0031 — shape', () => {
  const sql = readFileSync(join(DIR, FILE), 'utf8')
  const lockOf = (text: string, fn: string) => {
    const body = text.slice(text.indexOf(`FUNCTION ${fn}(`))
    const m = body.match(/PERFORM\s+pg_advisory_xact_lock\(([^;]+)\);/i)
    return m?.[1].replace(/\s+/g, ' ').trim()
  }

  it('takes exactly the advisory lock key reserve_payment_intent() takes (0014), so portal ACH and autopay serialize per lease', () => {
    const portal = lockOf(readFileSync(join(DIR, '0014_payment_intent_pending_row.sql'), 'utf8'), 'reserve_payment_intent')
    const autopay = lockOf(sql, 'reserve_autopay_payment')
    expect(portal).toBeTruthy()
    expect(autopay).toBe(portal)
  })

  it('locks before reading anything and before inserting', () => {
    const body = sql.slice(sql.indexOf('FUNCTION reserve_autopay_payment('))
    const lock = body.search(/pg_advisory_xact_lock/i)
    expect(lock).toBeGreaterThan(0)
    expect(body.search(/FROM payments/i)).toBeGreaterThan(lock)
    expect(body.search(/FROM ar_ledger/i)).toBeGreaterThan(lock)
    expect(body.search(/INSERT INTO payments/i)).toBeGreaterThan(lock)
  })

  it('is service_role only', async () => {
    const r = await db.query<{ anon: boolean; authn: boolean; svc: boolean }>(`
      SELECT has_function_privilege('anon', 'reserve_autopay_payment(uuid, date, date, date, text)', 'EXECUTE') AS anon,
             has_function_privilege('authenticated', 'reserve_autopay_payment(uuid, date, date, date, text)', 'EXECUTE') AS authn,
             has_function_privilege('service_role', 'reserve_autopay_payment(uuid, date, date, date, text)', 'EXECUTE') AS svc`)
    expect(r.rows[0]).toEqual({ anon: false, authn: false, svc: true })
  })
})

describe('reserve_autopay_payment() — outcomes', () => {
  it('reserves the full period rent when nothing is paid or in flight, BEFORE any Stripe call (pending, PI null)', async () => {
    await charge('5000.00', '2026-06-01')
    const r = await reserve()
    expect(r).toMatchObject({ outcome: 'reserved', amount_cents: 500000, in_flight_cents: 0, balance_cents: 500000 })
    expect(typeof r.client_request_id).toBe('string')
    const rows = await autopayRows()
    expect(rows).toEqual([{ amount: '5000.00', stripe_status: 'pending', autopay_period: START, client_request_id: r.client_request_id, stripe_payment_intent_id: null, payment_date: TODAY }])
  })

  it('nothing_due when an in-period portal ACH for the full rent is still processing (the audit scenario)', async () => {
    await charge('5000.00', '2026-06-01')
    await payment('5000.00', '2026-06-01', 'ach_stripe', 'processing', { pi: 'pi_portal' })
    expect(await reserve()).toMatchObject({ outcome: 'nothing_due', period_in_flight_cents: 500000, in_flight_cents: 500000 })
    expect(await autopayRows()).toEqual([])
  })

  it('reserves only the remainder when part of the rent is pending in the portal', async () => {
    await charge('5000.00', '2026-06-01')
    await payment('2000.00', '2026-06-02', 'ach_stripe', 'pending', { pi: 'pi_portal' })
    expect(await reserve()).toMatchObject({ outcome: 'reserved', amount_cents: 300000 })
  })

  it('caps at the balance net of ALL in-flight ACH, including a prepayment dated last month', async () => {
    await charge('5000.00', '2026-06-01')
    await payment('5000.00', '2026-05-30', 'ach_stripe', 'processing', { pi: 'pi_prepay' })
    expect(await reserve()).toMatchObject({ outcome: 'nothing_due', period_in_flight_cents: 0, in_flight_cents: 500000, balance_cents: 500000 })
  })

  it('never sweeps prior arrears: the period term binds even when the balance has headroom', async () => {
    await charge('1000.00', '2026-04-01') // arrears
    await charge('5000.00', '2026-06-01')
    await payment('5000.00', '2026-06-10', 'check', null)
    expect(await reserve()).toMatchObject({ outcome: 'nothing_due', balance_cents: 100000 })
  })

  it('counts succeeded ACH and manual payments in-period as paid, ignores failed ACH and voided charges', async () => {
    await charge('5000.00', '2026-06-01')
    await charge('50.00', '2026-06-02', true) // voided
    await payment('1000.00', '2026-06-02', 'ach_stripe', 'succeeded', { pi: 'pi_ok' })
    await payment('500.00', '2026-06-02', 'wire', null)
    await payment('3000.00', '2026-06-02', 'ach_stripe', 'failed', { pi: 'pi_bad' })
    expect(await reserve()).toMatchObject({ outcome: 'reserved', amount_cents: 350000, period_paid_cents: 150000 })
  })

  it.each(['processing', 'succeeded'])('a prior period\'s catch-up autopay (%s) dated inside this period does not count against this period', async (status) => {
    await charge('5000.00', '2026-05-01') // May rent
    await charge('5000.00', '2026-06-01') // June rent
    await payment('5000.00', '2026-06-02', 'ach_stripe', status, { pi: 'pi_may', autopay_period: '2026-05-01' })
    // June still owes its rent: in flight → cap 10000 − 5000; settled → balance 5000.
    expect(await reserve()).toMatchObject({ outcome: 'reserved', amount_cents: 500000, period_paid_cents: 0, period_in_flight_cents: 0 })
  })

  it('existing when the period already has an autopay row, and writes nothing', async () => {
    await charge('5000.00', '2026-06-01')
    const first = await reserve()
    const second = await reserve()
    expect(second).toMatchObject({ outcome: 'existing', payment_id: first.payment_id, stripe_status: 'pending', stripe_payment_intent_id: null, amount_cents: 500000 })
    expect(await autopayRows()).toHaveLength(1)
  })

  it('a released (failed, period cleared) reservation frees the period for a later run', async () => {
    await charge('5000.00', '2026-06-01')
    const first = await reserve()
    await db.query(`UPDATE payments SET stripe_status = 'failed', autopay_period = NULL WHERE id = $1`, [first.payment_id])
    expect(await reserve()).toMatchObject({ outcome: 'reserved', amount_cents: 500000 })
  })

  it('rejects missing arguments and an inverted period', async () => {
    await expect(db.query('SELECT reserve_autopay_payment(NULL, $1, $2, $3)', [START, END, TODAY])).rejects.toThrow(/required/)
    await db.exec('ROLLBACK; BEGIN')
    await expect(db.query('SELECT reserve_autopay_payment($1, $2, $3, $4)', [LEASE, END, START, TODAY])).rejects.toThrow(/before/)
    await db.exec('ROLLBACK; BEGIN')
  })
})

describe('autopay and portal ACH see each other in flight', () => {
  it('a portal payment after an autopay reservation is capped by it (reserve_payment_intent counts the autopay row)', async () => {
    await charge('5000.00', '2026-06-01')
    await reserve()
    const r = await db.query<{ r: Outcome }>('SELECT reserve_payment_intent($1, $2, $3) AS r', [LEASE, '99999999-9999-4999-8999-999999999999', 500000])
    expect(r.rows[0].r).toMatchObject({ outcome: 'exceeds_balance', in_flight_cents: 500000, available_cents: 0 })
  })

  it('an autopay reservation after a portal reservation is nothing_due', async () => {
    await charge('5000.00', '2026-06-01')
    const p = await db.query<{ r: Outcome }>('SELECT reserve_payment_intent($1, $2, $3) AS r', [LEASE, '99999999-9999-4999-8999-999999999998', 500000])
    expect(p.rows[0].r.outcome).toBe('reserved')
    // The portal row is dated CURRENT_DATE (not inside the fixed test period), so this exercises
    // the lifetime in-flight cap, not the in-period term.
    expect(await reserve()).toMatchObject({ outcome: 'nothing_due', in_flight_cents: 500000 })
  })
})
