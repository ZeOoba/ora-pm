// 0032 (supabase/migrations/0032_gl_balance_forwards.sql): the ledger counts balance forwards from
// QuickBooks. Rules BF1–BF8 are exercised on real Postgres by supabase/tests/gl_balance_forwards.test.sql;
// the cross-language contracts (roles, priority, ordering, locks) are pinned here.
import { describe, it, expect } from 'vitest'
import { migrationFiles, readMigration } from '../fixtures/pg-migrations'
import { migrationTouchesFinancialTables } from '../../scripts/check-refute-required'
import { CASH_PRIORITY } from '../../server/lib/gl-ar-cash-posting'
import { AR_ROLES } from '../../server/lib/gl-ar-posting'

const FILE = '0032_gl_balance_forwards.sql'
const sql = readMigration(FILE)
const fnBody = (name: string) => {
  const i = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`)
  expect(i, name).toBeGreaterThan(-1)
  return sql.slice(i, sql.indexOf('$$;', sql.indexOf('AS $$', i) + 5))
}

describe('migration 0032 — balance forwards in the ledger (textual pins)', () => {
  it('ships as the only 0032 migration and is refute-gated', () => {
    expect(migrationFiles().filter((f) => f.startsWith('0032_'))).toEqual([FILE])
    expect(migrationTouchesFinancialTables(sql)).toBe(true)
  })

  it('the role CHECK lists exactly the planner roles (balance_forward included)', () => {
    const m = /gl_ar_accounts_role_check CHECK \(role IN \(([^)]*)\)\)/.exec(sql)
    expect(m).not.toBeNull()
    expect(m![1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean).sort()).toEqual([...AR_ROLES].sort())
  })

  it('the database priority order is the planner order', () => {
    const m = /CASE p_type\s+([\s\S]*?) ELSE 99 END/.exec(fnBody('gl_ar_cash_priority'))
    const db = Object.fromEntries([...m![1].matchAll(/WHEN '(\w+)' THEN (-?\d+)/g)].map((x) => [x[1], Number(x[2])]))
    expect(db).toEqual(CASH_PRIORITY)
  })

  it('BF3: the allocation reads counted forwards from the snapshot and orders them after a same-day deposit', () => {
    const alloc = fnBody('gl_ar_cash_alloc')
    expect(alloc).toMatch(/JOIN gl_ar_tieout_items i ON i\.kind = 'balance_forward' AND i\.source_id = b\.id AND i\.counted/)
    expect(alloc).toContain('ORDER BY live.live, live.due_date, gl_ar_cash_priority(live.type), live.is_bf, live.id')
    expect(alloc).not.toMatch(/b\.voided_at/) // never the live row's state
  })

  it('BF8: void and apply lock the entity FOR SHARE; a tie-out insert locks it FOR UPDATE; confirm does not lock balance_forwards rows', () => {
    expect(fnBody('void_balance_forward')).toMatch(/FROM gl_entities WHERE id = v_entity FOR SHARE/)
    expect(fnBody('apply_balance_forwards')).toMatch(/FROM gl_entities WHERE id = v_entity FOR SHARE/)
    expect(fnBody('gl_ar_tieout_no_balance_forward')).toMatch(/FROM gl_entities WHERE id = NEW\.entity_id FOR UPDATE/)
    expect(fnBody('gl_confirm_ar_tieout')).not.toMatch(/FROM balance_forwards[^;]*FOR SHARE/)
  })

  it('BF6: the immutability trigger refuses voiding a counted forward', () => {
    const f = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION balance_forward_immutable()'))
    expect(f.slice(0, f.indexOf('END $$;'))).toMatch(/gl_ar_tieout_items i WHERE i\.kind = 'balance_forward' AND i\.source_id = OLD\.id/)
  })

  it('BF4: confirm and the commit-time check use the same formulas', () => {
    for (const name of ['gl_confirm_ar_tieout', 'gl_check_ar_tieout']) {
      const f = fnBody(name)
      expect(f, name).toContain("sum(CASE WHEN s.kind = 'payment' THEN -s.cents ELSE s.cents END) FILTER (WHERE s.counted)")
      expect(f, name).toContain("sum(-s.cents) FILTER (WHERE s.kind = 'balance_forward' AND s.counted AND s.cents < 0)")
      expect(f, name).toContain("sum(s.cents) FILTER (WHERE s.kind = 'balance_forward' AND s.counted AND s.cents > 0)")
      expect(f, name).toMatch(/after the AR tie-out date/)
    }
  })

  it('REFUTE-9: apply and void hold the lease chain; moves lock both entities; inserts are guarded; void needs READ COMMITTED', () => {
    expect(fnBody('apply_balance_forwards')).toMatch(/FOR SHARE OF u, pr;\s+v_entity := gl_lease_entity\(v_lease\)/)
    const v = fnBody('void_balance_forward')
    expect(v).toMatch(/FOR SHARE OF l, u, pr/)
    expect(v).toMatch(/must run in READ COMMITTED/)
    const move = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION balance_forward_entity_move()'))
    expect(move.slice(0, move.indexOf('END $$;'))).toMatch(/WHERE id IN \(v_entity, v_old\) ORDER BY id FOR SHARE/)
    expect(sql).toMatch(/CREATE TRIGGER balance_forwards_insert_guard BEFORE INSERT ON balance_forwards/)
    // Move vs move: a unit/lease move locks its target property/unit before reading its LLC.
    expect(move).toMatch(/FROM properties p WHERE p\.id = NEW\.property_id FOR SHARE;/)
    expect(move).toMatch(/WHERE u\.id = NEW\.unit_id FOR SHARE OF u, p;/)
  })

  it('REFUTE-9 F1: inside a live forward, items count by their current state', () => {
    const src = fnBody('gl_ar_tieout_source')
    expect(src).toMatch(/c\.charge_date <= b\.as_of\)\s+THEN c\.voided_at IS NULL/)
    expect(src).toMatch(/p\.payment_date <= b\.as_of\)\s+THEN gl_payment_counts\(p\.method, p\.stripe_status\)/)
  })
})

