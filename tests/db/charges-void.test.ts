/// <reference types="node" />
// OI-278 (ruled 2026-09-13, Gabriel): the 103 auto late fees posted before the payments-feed
// guard (ora-pm PR #26, live 2026-09-12) were computed on artifact data — the payments table had
// 0 rows EVER, so every lease looked delinquent. They are VOIDED, not deleted: the rows stay as an
// audit trail (reversible), and money math everywhere excludes them.
//
//   0014_charges_void.sql            schema: charges.voided_at / void_reason + pair CHECK,
//                                    ar_ledger recreated to exclude voided rows, security_invoker
//                                    kept (see tests/db/ar-ledger.test.ts for the view itself).
//   0016_void_oi278_pre_guard_late_fees.sql
//                                    data: a DO block that asserts the target population is
//                                    EXACTLY 103 rows / $5,150.00 before and after voiding, and
//                                    RAISEs (aborting the transaction) on any drift.
//
// Runtime assertions run the real migration SQL on pg-mem (tests/fixtures/migrations.ts). pg-mem
// has no plpgsql, so 0016's DO block is verified textually AND by extracting its UPDATE/predicate
// and running that against seeded rows.
import { describe, it, expect, beforeEach } from 'vitest'
import { PG_MEM_SKIP, freshMigratedDb, readMigration, splitSqlStatements, statementBody } from '../fixtures/migrations'

const FILE_0014 = '0014_charges_void.sql'
const FILE_0016 = '0016_void_oi278_pre_guard_late_fees.sql'

// Verified read-only census of production charges, 2026-09-13 (PR body carries the breakdown).
const EXPECTED_COUNT = 103
const EXPECTED_SUM = '5150.00'
const GUARD_CUTOFF = '2026-09-12T00:00:00Z'
const VOID_REASON = 'OI-278: posted while payments feed absent (payments table empty); voided per Gabriel ruling 2026-09-13'
// The exact population predicate. Anchored to the pre-guard window by created_at (the guard went
// live 2026-09-12; max created_at in the census is 2026-09-07T16:19:30Z) so a fee the guarded
// endpoint legitimately posts later can never be swept in.
const PREDICATE = `type = 'late_fee' AND source = 'auto' AND voided_at IS NULL AND created_at < '${GUARD_CUTOFF}'`

const PROP = '00000000-0000-0000-0000-000000000001'
const UNIT = '00000000-0000-0000-0000-000000000002'
const TENANT = '00000000-0000-0000-0000-000000000003'
const LEASE = '00000000-0000-0000-0000-000000000004'

type Db = ReturnType<typeof freshMigratedDb>

function seedLease(db: Db) {
  db.none(`
    INSERT INTO properties (id, name, address, city, state) VALUES ('${PROP}', 'REDACTED-020', 'REDACTED-010', 'Columbia', 'MD');
    INSERT INTO units (id, property_id, suite, sf) VALUES ('${UNIT}', '${PROP}', 'A1', 1000);
    INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Acme Co');
    INSERT INTO leases (id, tenant_id, unit_id, start_date, end_date, base_rent_monthly)
      VALUES ('${LEASE}', '${TENANT}', '${UNIT}', '2026-01-01', '2027-01-01', 1000);
  `)
}

let seq = 0
function insertCharge(
  db: Db,
  opts: { type?: string; source?: string; amount?: number; createdAt?: string; voidedAt?: string | null; voidReason?: string | null } = {},
) {
  const id = `c0000000-0000-0000-0000-${String(++seq).padStart(12, '0')}`
  const key = `k_${id}`
  const voidedAt = opts.voidedAt ? `'${opts.voidedAt}'` : 'NULL'
  const voidReason = opts.voidReason !== undefined && opts.voidReason !== null ? `'${opts.voidReason}'` : 'NULL'
  db.none(`
    INSERT INTO charges (id, lease_id, charge_date, due_date, period_start, period_end, type, amount, source, idempotency_key, created_at, voided_at, void_reason)
    VALUES ('${id}', '${LEASE}', '2026-09-02', '2026-09-02', '2026-09-01', '2026-09-02', '${opts.type ?? 'late_fee'}', ${opts.amount ?? 50},
            '${opts.source ?? 'auto'}', '${key}', '${opts.createdAt ?? '2026-09-02T16:00:00Z'}', ${voidedAt}, ${voidReason})
  `)
  return id
}

describe('migration 0014 — charges.voided_at / void_reason (runtime, real migration SQL on pg-mem)', () => {
  let db: Db
  beforeEach(() => {
    db = freshMigratedDb()
    seedLease(db)
  })

  it('adds nullable voided_at and void_reason; an ordinary insert leaves both NULL', () => {
    const id = insertCharge(db)
    const [row] = db.many(`SELECT voided_at, void_reason FROM charges WHERE id = '${id}'`)
    expect(row.voided_at).toBeNull()
    expect(row.void_reason).toBeNull()
  })

  it('accepts a void when BOTH voided_at and a non-blank void_reason are set', () => {
    const id = insertCharge(db, { voidedAt: '2026-09-13T12:00:00Z', voidReason: 'OI-278 test' })
    const [row] = db.many(`SELECT void_reason FROM charges WHERE id = '${id}'`)
    expect(row.void_reason).toBe('OI-278 test')
  })

  it('rejects voided_at without a void_reason (a void must always say why)', () => {
    expect(() => insertCharge(db, { voidedAt: '2026-09-13T12:00:00Z', voidReason: null })).toThrow(/check constraint/)
  })

  it('rejects a void_reason without voided_at (a reason on a live charge is a half-void)', () => {
    expect(() => insertCharge(db, { voidedAt: null, voidReason: 'orphan reason' })).toThrow(/check constraint/)
  })

  it('rejects a blank / whitespace-only void_reason', () => {
    expect(() => insertCharge(db, { voidedAt: '2026-09-13T12:00:00Z', voidReason: '' })).toThrow(/check constraint/)
    expect(() => insertCharge(db, { voidedAt: '2026-09-13T12:00:00Z', voidReason: '   ' })).toThrow(/check constraint/)
  })

  it('rejects an UPDATE that sets voided_at alone on a live row', () => {
    const id = insertCharge(db)
    expect(() => db.none(`UPDATE charges SET voided_at = now() WHERE id = '${id}'`)).toThrow(/check constraint/)
  })

  it('the un-void (rollback) shape — both columns back to NULL — is accepted', () => {
    const id = insertCharge(db, { voidedAt: '2026-09-13T12:00:00Z', voidReason: 'OI-278 test' })
    db.none(`UPDATE charges SET voided_at = NULL, void_reason = NULL WHERE id = '${id}'`)
    const [row] = db.many(`SELECT voided_at FROM charges WHERE id = '${id}'`)
    expect(row.voided_at).toBeNull()
  })
})

describe('migration 0014 — text pins (what pg-mem cannot execute)', () => {
  const sql = readMigration(FILE_0014)

  it('recreates ar_ledger with charge_totals filtered to voided_at IS NULL', () => {
    // The CTE that feeds total_charged must carry the exclusion; the payment_totals CTE and the
    // outer SELECT are verbatim 0011 (behaviorally pinned by tests/db/ar-ledger.test.ts).
    expect(sql).toMatch(/charge_totals AS \(\s*SELECT lease_id, COALESCE\(SUM\(amount\), 0\) AS total_charged\s+FROM charges\s+WHERE voided_at IS NULL\s+GROUP BY lease_id\s*\)/)
  })

  it('does not touch rent_roll or critical_dates (neither reads charges)', () => {
    expect(sql).not.toMatch(/CREATE OR REPLACE VIEW (rent_roll|critical_dates)/)
  })

  // PR #42 refute (Minor 4): a partially-applied Dashboard run must be re-runnable — the column
  // adds are IF NOT EXISTS and the CHECK is dropped-if-exists before it is added.
  it('is re-runnable: ADD COLUMN IF NOT EXISTS for both columns, DROP CONSTRAINT IF EXISTS before ADD CONSTRAINT', () => {
    expect(sql).toMatch(/ALTER TABLE charges ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;/)
    expect(sql).toMatch(/ALTER TABLE charges ADD COLUMN IF NOT EXISTS void_reason TEXT;/)
    const drop = sql.search(/^ALTER TABLE charges DROP CONSTRAINT IF EXISTS charges_void_pair_check;/m)
    const add = sql.search(/^ALTER TABLE charges ADD CONSTRAINT charges_void_pair_check CHECK/m)
    expect(drop).toBeGreaterThan(-1)
    expect(add).toBeGreaterThan(-1)
    expect(drop).toBeLessThan(add)
  })

  it('applies cleanly a SECOND time on an already-migrated database (runtime, every executable statement)', () => {
    const db = freshMigratedDb()
    seedLease(db)
    for (const stmt of splitSqlStatements(sql)) {
      const body = statementBody(stmt)
      if (PG_MEM_SKIP.some((re) => re.test(body))) continue
      expect(() => db.none(stmt), `re-applying: ${body.slice(0, 80)}`).not.toThrow()
    }
    // The CHECK is still enforced after the re-apply (the drop/add pair really re-created it).
    expect(() => insertCharge(db, { voidedAt: '2026-09-13T12:00:00Z', voidReason: null })).toThrow(/check constraint/)
  })

  it('carries a commented rollback block that drops the pair CHECK and both columns', () => {
    expect(sql).toMatch(/--\s*Rollback/i)
    expect(sql).toMatch(/--\s*ALTER TABLE charges DROP CONSTRAINT IF EXISTS charges_void_pair_check/)
    expect(sql).toMatch(/--\s*ALTER TABLE charges DROP COLUMN (IF EXISTS )?voided_at/)
    expect(sql).toMatch(/--\s*ALTER TABLE charges DROP COLUMN (IF EXISTS )?void_reason/)
  })
})

describe('migration 0016 — guarded void of the OI-278 pre-guard late fees', () => {
  const sql = readMigration(FILE_0016)
  const stmts = splitSqlStatements(sql).map(statementBody)
  const doBlocks = stmts.filter((s) => /^DO\s+\$\$/i.test(s))

  it('is exactly one DO block (one transaction-scoped unit; a RAISE aborts the whole void)', () => {
    expect(doBlocks).toHaveLength(1)
    // Nothing executable outside the block — every other statement is a comment-only fragment.
    expect(stmts.filter((s) => !/^DO\s+\$\$/i.test(s))).toHaveLength(0)
  })

  const block = () => doBlocks[0]

  it('counts and sums the exact target population BEFORE updating, into locals it then checks', () => {
    expect(block()).toMatch(new RegExp(String.raw`SELECT count\(\*\), COALESCE\(SUM\(amount\), 0\)\s+INTO v_count, v_sum\s+FROM charges\s+WHERE ${escapeRe(PREDICATE)}`))
  })

  it(`RAISEs EXCEPTION unless the pre-count is exactly ${EXPECTED_COUNT} and the pre-sum exactly $${EXPECTED_SUM}`, () => {
    const b = block()
    expect(b).toMatch(new RegExp(String.raw`IF v_count <> ${EXPECTED_COUNT} OR v_sum <> ${escapeRe(EXPECTED_SUM)} THEN\s+RAISE EXCEPTION`))
  })

  // PR #42 refute (Important 2): the block must be REPLAYABLE. `supabase db push` applies every
  // untracked migration in order, `db reset` / a branch DB / a fresh project replay all of them,
  // and a second Dashboard paste re-runs it — on none of those is the population at census state,
  // and an unconditional RAISE at count=0 would block every later migration. Two, and only two,
  // count=0 shapes are benign and RETURN with a NOTICE; everything else still RAISEs.
  describe('replay branches (NOTICE + RETURN, before the exact-count assertion)', () => {
    const alreadyRe = new RegExp(String.raw`IF v_count = 0 AND v_already = ${EXPECTED_COUNT} THEN\s+RAISE NOTICE '[^']*already applied[^']*';\s+RETURN;\s+END IF;`)
    const nothingRe = /IF v_count = 0 AND v_already = 0 THEN\s+RAISE NOTICE '[^']*no pre-guard late fees present; nothing to void[^']*';\s+RETURN;\s+END IF;/

    it('counts rows already carrying the exact OI-278 void_reason into v_already before deciding', () => {
      expect(block()).toMatch(new RegExp(String.raw`SELECT count\(\*\)\s+INTO v_already\s+FROM charges\s+WHERE void_reason = '${escapeRe(VOID_REASON)}'`))
    })

    it('count=0 AND exactly 103 already voided with the OI-278 reason -> NOTICE "already applied", RETURN', () => {
      expect(block()).toMatch(alreadyRe)
    })

    it('count=0 AND zero rows carry the OI-278 reason (fresh / non-prod DB) -> NOTICE "nothing to void", RETURN', () => {
      expect(block()).toMatch(nothingRe)
    })

    it('both benign branches precede the exact 103 / 5150.00 assertion, which is unchanged for the real apply', () => {
      const b = block()
      const exact = b.search(new RegExp(String.raw`IF v_count <> ${EXPECTED_COUNT} OR v_sum <> ${escapeRe(EXPECTED_SUM)} THEN`))
      expect(exact).toBeGreaterThan(-1)
      expect(b.search(alreadyRe)).toBeLessThan(exact)
      expect(b.search(nothingRe)).toBeLessThan(exact)
      expect(b.search(alreadyRe)).toBeGreaterThan(-1)
      expect(b.search(nothingRe)).toBeGreaterThan(-1)
    })

    it('no other count=0 shape returns early — a partial prior void (0 < v_already <> 103) falls through to the RAISE', () => {
      // Only the two pinned `IF v_count = 0 AND v_already = <n>` guards may RETURN.
      const returns = block().match(/RETURN;/g) ?? []
      expect(returns).toHaveLength(2)
      const guards = block().match(/IF v_count = 0 AND v_already = (\d+) THEN/g) ?? []
      expect(guards.map((g) => /(\d+) THEN/.exec(g)![1]).sort()).toEqual(['0', String(EXPECTED_COUNT)])
    })
  })

  it('the RAISE message names the expected and actual figures so drift is diagnosable from the error alone', () => {
    const b = block()
    const raiseIdx = b.search(/RAISE EXCEPTION/)
    const msg = b.slice(raiseIdx, b.indexOf(';', raiseIdx))
    expect(msg).toMatch(/OI-278/)
    expect(msg).toMatch(/expected 103/)
    expect(msg).toMatch(/5150\.00/)
    expect(msg).toMatch(/v_count/)
    expect(msg).toMatch(/v_sum/)
  })

  it('the UPDATE uses the SAME predicate as the pre-check and sets both void columns together', () => {
    expect(block()).toMatch(new RegExp(
      String.raw`UPDATE charges\s+SET voided_at = now\(\),\s+void_reason = '${escapeRe(VOID_REASON)}'\s+WHERE ${escapeRe(PREDICATE)}`,
    ))
  })

  it('the void_reason is the exact ruled text', () => {
    expect(block()).toContain(`void_reason = '${VOID_REASON}'`)
  })

  it('asserts the row count of the UPDATE itself, and the post-void population, are both exactly 103', () => {
    const b = block()
    expect(b).toMatch(/GET DIAGNOSTICS v_updated = ROW_COUNT/)
    expect(b).toMatch(new RegExp(String.raw`IF v_updated <> ${EXPECTED_COUNT} THEN\s+RAISE EXCEPTION`))
    expect(b).toMatch(new RegExp(String.raw`SELECT count\(\*\)\s+INTO v_voided\s+FROM charges\s+WHERE void_reason = '${escapeRe(VOID_REASON)}'`))
    expect(b).toMatch(new RegExp(String.raw`IF v_voided <> ${EXPECTED_COUNT} THEN\s+RAISE EXCEPTION`))
  })

  it('never deletes anything', () => {
    expect(sql).not.toMatch(/^\s*DELETE\b/im)
    expect(block()).not.toMatch(/\bDELETE\b/i)
  })

  it('carries a commented rollback that un-voids ONLY rows carrying this exact void_reason', () => {
    expect(sql).toMatch(/--\s*Rollback/i)
    expect(sql).toMatch(new RegExp(String.raw`--\s*UPDATE charges SET voided_at = NULL, void_reason = NULL\s*\n?\s*--?\s*WHERE void_reason = '${escapeRe(VOID_REASON)}'`))
  })

  // PR #42 refute (Minor 5): a commented post-apply verification block the operator runs after
  // the real apply — no live auto late fee from the pre-guard window, and exactly 103 / 5150.00
  // voided under the exact reason.
  it('carries a commented post-apply verification block', () => {
    expect(sql).toMatch(/--\s*POST-APPLY/i)
    expect(sql).toMatch(/--\s*SELECT count\(\*\) FROM charges WHERE type = 'late_fee' AND voided_at IS NULL;\s*--\s*expect 0/)
    expect(sql).toMatch(new RegExp(String.raw`--\s*SELECT count\(\*\), SUM\(amount\) FROM charges\s*\n?\s*--\s*WHERE void_reason = '${escapeRe(VOID_REASON)}';\s*--\s*expect 103 \| 5150\.00`))
  })

  describe('the predicate and UPDATE, run for real against seeded rows (pg-mem, post-0014 schema)', () => {
    let db: Db
    // Extracted from the migration text so the runtime check can never test a different predicate
    // than the one that ships.
    const updateStmt = () => {
      const m = /UPDATE charges\s+SET voided_at = now\(\),\s+void_reason = '[^']*'\s+WHERE [^;]*;/.exec(block())
      if (!m) throw new Error('0016: could not extract the UPDATE statement from the DO block')
      return m[0]
    }
    const predicateFromUpdate = () => {
      const m = /WHERE ([^;]*);$/.exec(updateStmt())
      if (!m) throw new Error('0016: could not extract the UPDATE predicate')
      return m[1].trim()
    }

    beforeEach(() => {
      db = freshMigratedDb()
      seedLease(db)
      seq = 0
    })

    it('selects auto late fees created before the guard cutoff and nothing else', () => {
      const target1 = insertCharge(db, { createdAt: '2026-08-04T15:00:00Z' })
      const target2 = insertCharge(db, { createdAt: '2026-09-07T16:19:30Z' }) // census max created_at
      insertCharge(db, { source: 'manual' }) // manual late fee: operator-posted, not an artifact
      insertCharge(db, { type: 'rent' }) // not a late fee
      insertCharge(db, { createdAt: '2026-09-12T00:00:00Z' }) // at the cutoff: guarded endpoint era
      insertCharge(db, { createdAt: '2026-09-13T09:00:00Z' }) // after the cutoff
      insertCharge(db, { voidedAt: '2026-09-10T00:00:00Z', voidReason: 'already voided' }) // idempotent re-run

      const rows = db.many(`SELECT id FROM charges WHERE ${predicateFromUpdate()} ORDER BY id`)
      expect(rows.map((r) => r.id)).toEqual([target1, target2].sort())
      const [agg] = db.many(`SELECT count(*) AS n, COALESCE(SUM(amount), 0) AS s FROM charges WHERE ${predicateFromUpdate()}`)
      expect(Number(agg.n)).toBe(2)
      expect(Number(agg.s)).toBe(100)
    })

    it('the UPDATE voids exactly that population, stamps both columns, and leaves every other row untouched', () => {
      const t1 = insertCharge(db, { createdAt: '2026-08-04T15:00:00Z' })
      const t2 = insertCharge(db, { createdAt: '2026-09-07T16:19:30Z' })
      const keepManual = insertCharge(db, { source: 'manual' })
      const keepRent = insertCharge(db, { type: 'rent' })
      const keepPostGuard = insertCharge(db, { createdAt: '2026-09-13T09:00:00Z' })

      db.none(updateStmt())

      const voided = db.many(`SELECT id, void_reason FROM charges WHERE voided_at IS NOT NULL ORDER BY id`)
      expect(voided.map((r) => r.id)).toEqual([t1, t2].sort())
      for (const r of voided) expect(r.void_reason).toBe(VOID_REASON)
      const live = db.many(`SELECT id FROM charges WHERE voided_at IS NULL AND void_reason IS NULL ORDER BY id`)
      expect(live.map((r) => r.id)).toEqual([keepManual, keepRent, keepPostGuard].sort())
      // Row count unchanged: void, never delete.
      expect(db.many(`SELECT count(*) AS n FROM charges`)[0].n).toBe(5)
    })

    // A second run of the UPDATE alone touches nothing because `voided_at IS NULL` is in the
    // predicate; the DO block around it does not re-void either — it takes the "already applied"
    // NOTICE branch (pinned textually above, pg-mem cannot execute plpgsql).
    it('the UPDATE re-run matches zero rows — already-voided rows are never re-stamped', () => {
      insertCharge(db, { createdAt: '2026-08-04T15:00:00Z' })
      db.none(updateStmt())
      const [again] = db.many(`SELECT count(*) AS n FROM charges WHERE ${predicateFromUpdate()}`)
      expect(Number(again.n)).toBe(0)
    })
  })
})

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
