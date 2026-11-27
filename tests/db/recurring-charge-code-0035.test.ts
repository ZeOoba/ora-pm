/// <reference types="node" />
// tests/db/recurring-charge-code-0035.test.ts
//
// Migration 0035 (lease_recurring_charges.charge_code) on real PostgreSQL (PGlite). Every migration BEFORE 0035
// is applied once; each test writes the pre-deploy state, applies 0035 INSIDE its own transaction (Postgres DDL
// is transactional) and rolls back, so every test starts from the pre-0035 schema.
//
// The money question: an 'other' charge billed before deploy carries the legacy key
// auto:<lease>:<period>:other:<otherKey(description)>. After deploy, billing keys on charge_code. The first run
// after deploy must produce the SAME key for that month, so the charges upsert (ON CONFLICT DO NOTHING on
// idempotency_key, as server/routes/cron.ts posts) inserts nothing.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'
import { otherKey } from '../../server/lib/rent-schedule'
import { buildMonthlyCharges, generateIdempotencyKey, type AutoCharge } from '../../server/lib/billing'
import { groupSchedules, RECURRING_COLUMNS, RENT_SCHEDULE_COLUMNS, CONCESSION_COLUMNS, type DbRecurringRow, type DbRentRow, type DbConcessionRow } from '../../server/lib/billing-run'

const DIR = join(__dirname, '../../supabase/migrations')
const ALL = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
const BEFORE = ALL.filter((f) => f < '0035')
const M0035 = readFileSync(join(DIR, ALL.find((f) => f.startsWith('0035_'))!), 'utf8')

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

let db: PGlite

beforeAll(async () => {
  db = new PGlite({ extensions: { btree_gist } })
  await db.exec(STUBS)
  for (const f of BEFORE) await db.exec(readFileSync(join(DIR, f), 'utf8'))
}, 120_000)

afterAll(async () => { await db?.close() })

beforeEach(async () => {
  await db.exec('BEGIN')
  await db.exec(`
    INSERT INTO properties (id, name, address, city, state, zip) VALUES ('${PROP}', 'P', '1 Main', 'Columbus', 'OH', '43215');
    INSERT INTO units (id, property_id, suite, sf, status) VALUES ('${UNIT}', '${PROP}', '100', 5000, 'occupied');
    INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'T');
    INSERT INTO leases (id, tenant_id, unit_id, start_date, end_date, base_rent_monthly) VALUES ('${LEASE}', '${TENANT}', '${UNIT}', '2025-01-01', '2030-12-31', 3000);
    INSERT INTO lease_rent_schedule (lease_id, effective_start, effective_end, base_rent_monthly, source) VALUES ('${LEASE}', '2025-01-01', '2030-12-31', 3000, 'manual');
  `)
})

afterEach(async () => { await db.exec('ROLLBACK') })

const q = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows
const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`

async function insertOther(description: string, opts: { amount?: number; start?: string; end?: string; superseded?: boolean; code?: string } = {}): Promise<string> {
  const rows = await q<{ id: string }>(
    `INSERT INTO lease_recurring_charges (lease_id, type, description, amount_monthly, effective_start, effective_end, source, superseded_at${opts.code ? ', charge_code' : ''})
     VALUES ($1, 'other', $2, $3, $4, $5, 'manual', $6${opts.code ? ', $7' : ''}) RETURNING id`,
    [LEASE, description, opts.amount ?? 100, opts.start ?? '2025-01-01', opts.end ?? '2030-12-31', opts.superseded ? '2026-01-01T00:00:00Z' : null, ...(opts.code ? [opts.code] : [])],
  )
  return rows[0].id
}

/** What server/routes/cron.ts would build for this lease and month, reading the tables the way it does. */
async function bill(y: number, m: number) {
  const rent = await q<DbRentRow & { id: string }>(`SELECT id, ${RENT_SCHEDULE_COLUMNS} FROM lease_rent_schedule ORDER BY id`)
  const rec = await q<DbRecurringRow>(`SELECT id, ${RECURRING_COLUMNS} FROM lease_recurring_charges ORDER BY id`)
  const con = await q<DbConcessionRow & { id: string }>(`SELECT id, ${CONCESSION_COLUMNS} FROM lease_concessions ORDER BY id`)
  const asIso = <T extends Record<string, unknown>>(r: T) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : v])) as T
  const schedules = groupSchedules(rent.map(asIso), rec.map(asIso), con.map(asIso))
  return buildMonthlyCharges({
    leaseId: LEASE, baseRentMonthly: 3000, camEstimateMonthly: 0, leaseStartDate: '2025-01-01', leaseEndDate: '2030-12-31',
    periodYear: y, periodMonth: m, schedule: schedules.get(LEASE),
  })
}

/** The cron charges upsert: ON CONFLICT (idempotency_key) DO NOTHING. Returns the keys actually inserted. */
async function post(charges: AutoCharge[]): Promise<string[]> {
  const out: string[] = []
  for (const c of charges) {
    const r = await q<{ idempotency_key: string }>(
      `INSERT INTO charges (lease_id, charge_date, due_date, period_start, period_end, type, amount, description, source, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (idempotency_key) DO NOTHING RETURNING idempotency_key`,
      [c.lease_id, c.charge_date, c.due_date, c.period_start, c.period_end, c.type, c.amount, c.description, c.source, c.idempotency_key],
    )
    out.push(...r.map((x) => x.idempotency_key))
  }
  return out
}

describe('0035: months billed under the legacy description key are recognised after deploy', () => {
  it('the first run after deploy re-derives the SAME key for an already-billed month and posts nothing new', async () => {
    const descriptions = ['Real Estate Tax Escrow', '  Insurance — escrow (per §4.2)  ', 'x'.repeat(41) + 'tail', '$$$']
    for (const d of descriptions) await insertOther(d, { amount: 250 })

    // Pre-deploy: what the OLD engine posted for June 2026 (key = other:<otherKey(description)>).
    const legacyKeys = descriptions.map((d) => generateIdempotencyKey({ leaseId: LEASE, periodStart: '2026-06-01', type: `other:${otherKey(d)}` }))
    await db.exec(descriptions.map((d, i) => `INSERT INTO charges (lease_id, charge_date, due_date, period_start, period_end, type, amount, description, source, idempotency_key)
      VALUES ('${LEASE}', '2026-06-01', '2026-06-05', '2026-06-01', '2026-06-30', 'other', 250, ${sqlStr(d)}, 'auto', ${sqlStr(legacyKeys[i])});`).join('\n'))
    await db.exec(`INSERT INTO charges (lease_id, charge_date, due_date, period_start, period_end, type, amount, description, source, idempotency_key)
      VALUES ('${LEASE}', '2026-06-01', '2026-06-05', '2026-06-01', '2026-06-30', 'rent', 3000, 'Rent', 'auto', ${sqlStr(generateIdempotencyKey({ leaseId: LEASE, periodStart: '2026-06-01', type: 'rent' }))});`)

    await db.exec(M0035)

    const out = await bill(2026, 6)
    expect(out.exception).toBeUndefined()
    const otherKeys = out.charges.filter((c) => c.type === 'other').map((c) => c.idempotency_key).sort()
    expect(otherKeys).toEqual([...legacyKeys].sort())
    expect(await post(out.charges)).toEqual([]) // nothing double-billed
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM charges WHERE period_start = '2026-06-01'`))[0].n).toBe(descriptions.length + 1)

    // The next month bills normally, under the same (backfilled) codes.
    const july = await bill(2026, 7)
    expect((await post(july.charges)).length).toBe(descriptions.length + 1)
  })

  it('a superseded row is backfilled too (a later replacement can copy its code)', async () => {
    const id = await insertOther('Old CAM surcharge', { superseded: true })
    await db.exec(M0035)
    expect((await q<{ charge_code: string }>(`SELECT charge_code FROM lease_recurring_charges WHERE id = $1`, [id]))[0].charge_code).toBe('old-cam-surcharge')
  })

  it('non-other rows get no code and keep their type keys', async () => {
    await db.exec(`INSERT INTO lease_recurring_charges (lease_id, type, description, amount_monthly, effective_start, effective_end, source)
      VALUES ('${LEASE}', 'utility_water', 'Water', 50, '2025-01-01', '2030-12-31', 'manual')`)
    await db.exec(M0035)
    expect((await q<{ charge_code: string | null }>(`SELECT charge_code FROM lease_recurring_charges WHERE type = 'utility_water'`))[0].charge_code).toBeNull()
    expect((await bill(2026, 6)).charges.find((c) => c.type === 'utility_water')!.idempotency_key).toBe(`auto:${LEASE}:2026-06-01:utility_water`)
  })

  it('is re-runnable: a second apply changes nothing', async () => {
    await insertOther('Tax escrow')
    await db.exec(M0035)
    const before = await q(`SELECT id, charge_code FROM lease_recurring_charges ORDER BY id`)
    await db.exec(M0035)
    expect(await q(`SELECT id, charge_code FROM lease_recurring_charges ORDER BY id`)).toEqual(before)
  })

  it('refuses to apply (no change) when two active rows would share a legacy key over the same days', async () => {
    // 0020's description guard allows these (different lower(btrim())), but they slug to the same key.
    await insertOther('Tax escrow')
    await insertOther('TAX-ESCROW!')
    await expect(db.exec(M0035)).rejects.toThrow(/share a legacy key/)
  })
})

describe('0035: legacy_other_charge_key is byte-identical to otherKey()', () => {
  async function sqlKeys(inputs: string[]): Promise<string[]> {
    await db.exec(M0035)
    const rows = await q<{ k: string }>(
      `SELECT legacy_other_charge_key(e.value) AS k FROM jsonb_array_elements_text($1::jsonb) WITH ORDINALITY AS e(value, n) ORDER BY e.n`,
      [JSON.stringify(inputs)],
    )
    return rows.map((r) => r.k)
  }

  it('every code point JavaScript lowercases differently, plus all of ASCII', async () => {
    const inputs: string[] = []
    for (let c = 1; c <= 0x10ffff; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue
      const ch = String.fromCodePoint(c)
      if (c < 128 || ch.toLowerCase() !== ch) inputs.push(`a${ch}b`, `${ch}${ch}`, ch)
    }
    const got = await sqlKeys(inputs)
    const bad = inputs.map((s, i) => [s, otherKey(s), got[i]]).filter(([, js, pg]) => js !== pg)
    expect(bad).toEqual([])
  }, 60_000)

  it('random descriptions (separators, unicode, astral, long, the 40-character boundary)', async () => {
    let seed = 12345
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n }
    const alphabet = ['a', 'Z', '9', ' ', '-', '_', '.', '$', 'É', 'ß', 'İ', 'K', 'Ω', '😀', '\t', '́', 'k', 'Ⅻ']
    const inputs = Array.from({ length: 3000 }, () => Array.from({ length: 1 + rnd(70) }, () => alphabet[rnd(alphabet.length)]).join(''))
    inputs.push('', ' ', '-', 'a'.repeat(39) + '-b', 'a'.repeat(40) + 'b', '-'.repeat(50) + 'x')
    const got = await sqlKeys(inputs)
    const bad = inputs.map((s, i) => [s, otherKey(s), got[i]]).filter(([, js, pg]) => js !== pg)
    expect(bad).toEqual([])
  }, 60_000)
})

describe('0035: new rows and the guards', () => {
  it('a new other row with no code gets its own id; two charges whose descriptions slug alike (punctuation) no longer collide', async () => {
    await db.exec(M0035)
    const a = await insertOther('Tax escrow', { amount: 10 })
    const b = await insertOther('TAX-ESCROW!', { amount: 20 })
    const codes = await q<{ id: string; charge_code: string }>(`SELECT id, charge_code FROM lease_recurring_charges WHERE type = 'other'`)
    expect(Object.fromEntries(codes.map((r) => [r.id, r.charge_code]))).toEqual({ [a]: a, [b]: b })
    const out = await bill(2026, 6)
    expect(out.exception).toBeUndefined()
    expect(out.charges.filter((c) => c.type === 'other').map((c) => c.amount).sort((x, y) => x - y)).toEqual([10, 20])
  })

  it('an amendment that rewords the description and carries the code bills an already-billed month zero times', async () => {
    await db.exec(M0035)
    const old = await insertOther('Tax escrow', { amount: 800 })
    const june = await bill(2026, 6)
    expect((await post(june.charges)).length).toBe(2)
    await db.exec(`UPDATE lease_recurring_charges SET superseded_at = now() WHERE id = '${old}'`)
    await insertOther('Real estate tax escrow (Amendment 2)', { amount: 900, code: old })
    expect(await post((await bill(2026, 6)).charges)).toEqual([])
  })

  // REFUTE C2(a): plan §5a item 4's exact scenario — supersede a row and re-enter it with the SAME description
  // but no explicit code (a manual or future writer forgetting to copy it). It must inherit the superseded row's
  // code, not get a fresh id that re-bills the period.
  it('a re-entered row with no code inherits the code of the superseded row with the same legacy key', async () => {
    await insertOther('Tax escrow', { amount: 800 }) // pre-deploy row → backfilled 'tax-escrow'
    await db.exec(M0035)
    const june = await bill(2026, 6)
    expect((await post(june.charges)).length).toBe(2)
    await db.exec(`UPDATE lease_recurring_charges SET superseded_at = now() WHERE type = 'other'`)
    const again = await insertOther('  TAX  Escrow ', { amount: 800 })
    expect((await q<{ charge_code: string }>(`SELECT charge_code FROM lease_recurring_charges WHERE id = $1`, [again]))[0].charge_code).toBe('tax-escrow')
    expect(await post((await bill(2026, 6)).charges)).toEqual([])
    // A row of a DIFFERENT charge on the lease still gets its own id.
    const other = await insertOther('Insurance escrow')
    expect((await q<{ charge_code: string }>(`SELECT charge_code FROM lease_recurring_charges WHERE id = $1`, [other]))[0].charge_code).toBe(other)
  })

  it('the trigger works for the service role (approve_lease_abstract is SECURITY INVOKER and runs as it)', async () => {
    await insertOther('Tax escrow')
    await db.exec(M0035)
    await db.exec(`UPDATE lease_recurring_charges SET superseded_at = now() WHERE type = 'other'`)
    await db.exec('GRANT SELECT, INSERT ON lease_recurring_charges TO service_role')
    await db.exec('SET ROLE service_role')
    try {
      await insertOther('Tax escrow')
      await insertOther('Parking')
    } finally {
      await db.exec('RESET ROLE')
    }
    expect((await q<{ c: string }>(`SELECT charge_code AS c FROM lease_recurring_charges WHERE superseded_at IS NULL AND description = 'Tax escrow'`))[0].c).toBe('tax-escrow')
  })

  it('a set code cannot be changed or cleared', async () => {
    await db.exec(M0035)
    const id = await insertOther('Tax escrow')
    await db.exec('SAVEPOINT s1')
    await expect(db.exec(`UPDATE lease_recurring_charges SET charge_code = 'other-code' WHERE id = '${id}'`)).rejects.toThrow(/immutable/)
    await db.exec('ROLLBACK TO SAVEPOINT s1')
    await expect(db.exec(`UPDATE lease_recurring_charges SET charge_code = NULL WHERE id = '${id}'`)).rejects.toThrow()
    await db.exec('ROLLBACK TO SAVEPOINT s1')
    // Other columns still update.
    await db.exec(`UPDATE lease_recurring_charges SET description = 'Tax escrow (reworded)' WHERE id = '${id}'`)
  })

  it('two active rows with one code over the same day are refused; a malformed code is refused', async () => {
    await db.exec(M0035)
    await insertOther('Tax escrow', { code: 'tax-escrow' })
    await db.exec('SAVEPOINT s1')
    await expect(insertOther('Escrow for taxes', { code: 'tax-escrow', start: '2026-06-15' })).rejects.toThrow(/other_code_no_overlap/)
    await db.exec('ROLLBACK TO SAVEPOINT s1')
    await expect(insertOther('Parking', { code: 'Parking Fee' })).rejects.toThrow(/code_format/)
    await db.exec('ROLLBACK TO SAVEPOINT s1')
    // Non-overlapping successor under the same code is fine (a rent-step style change of the same charge).
    await db.exec(`UPDATE lease_recurring_charges SET effective_end = '2026-06-30' WHERE charge_code = 'tax-escrow'`)
    await insertOther('Tax escrow', { code: 'tax-escrow', start: '2026-07-01', amount: 120 })
  })
})
