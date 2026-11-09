/// <reference types="node" />
// tests/db/sent-notifications-tier-migration-0019.test.ts
//
// OI-321: sent_notifications gains alert_tier so critical-date dedup is per (reference_id, urgency
// tier) and an alert fires again as it escalates. Rows are written only by
// POST /api/cron/critical-dates-alerts/ack after a confirmed send (server/routes/cron.ts).
//
// Runtime assertions run the REAL migration chain on pg-mem (tests/fixtures/pg-migrations.ts).
// pg-mem skips views, so the backfill UPDATE (which reads the critical_dates view) is on
// PG_MEM_SKIP and is run standalone here against a seeded critical_dates TABLE with the view's
// columns — the same extract-and-run approach tests/db/charges-void.test.ts uses for 0017.
import { describe, it, expect, beforeEach } from 'vitest'
import { PG_MEM_SKIP, freshMigratedDb, migrationFiles, readMigration, splitSqlStatements, statementBody, type MigratedDb } from '../fixtures/pg-migrations'

const FILE = '0019_sent_notifications_alert_tier.sql'
const R1 = '00000000-0000-4000-8000-000000000001'
const R2 = '00000000-0000-4000-8000-000000000002'
const R3 = '00000000-0000-4000-8000-000000000003'
const ME = 'ggoldberg@oxfordra.net'

function ins(db: MigratedDb, ref: string, tier: string | null, type = 'critical_date_alert', recipient = ME) {
  db.none(`INSERT INTO sent_notifications (notification_type, reference_id, recipient, alert_tier)
           VALUES ('${type}', '${ref}', '${recipient}', ${tier === null ? 'NULL' : `'${tier}'`})`)
}
function backfillStatement(): string {
  const stmts = splitSqlStatements(readMigration(FILE)).map(statementBody)
  const upd = stmts.filter(s => /^UPDATE sent_notifications\b/i.test(s))
  expect(upd).toHaveLength(1)
  return upd[0]
}

describe('migration 0019 — sent_notifications.alert_tier (runtime, real migration SQL on pg-mem)', () => {
  let db: MigratedDb
  beforeEach(() => { db = freshMigratedDb() })

  it('ships as the only 0019 migration file', () => {
    expect(migrationFiles().filter(f => f.startsWith('0019_'))).toEqual([FILE])
  })

  it('allows the same reference at each of the four tiers, once each', () => {
    for (const t of ['notice', 'warning', 'urgent', 'overdue']) ins(db, R1, t)
    expect(db.many(`SELECT alert_tier FROM sent_notifications WHERE reference_id = '${R1}'`)).toHaveLength(4)
    expect(() => ins(db, R1, 'urgent')).toThrow(/duplicate key|unique/i)
  })

  it('rejects a tier outside the four', () => {
    expect(() => ins(db, R1, 'someday')).toThrow(/check constraint "sent_notifications_alert_tier_check"/)
  })

  it('keeps the pre-0019 guarantee for legacy (NULL-tier) rows: one per (type, reference, recipient)', () => {
    ins(db, R1, null)
    expect(() => ins(db, R1, null)).toThrow(/duplicate key|unique/i)
    // ...while a tiered row for the same reference is a different key.
    ins(db, R1, 'urgent')
  })

  it('the ack upsert target (ON CONFLICT on the four columns) is inferable and idempotent', () => {
    const up = `INSERT INTO sent_notifications (notification_type, reference_id, recipient, alert_tier)
                VALUES ('critical_date_alert', '${R1}', '${ME}', 'urgent')
                ON CONFLICT (notification_type, reference_id, recipient, alert_tier) DO NOTHING`
    db.none(up)
    db.none(up)
    expect(db.many(`SELECT 1 FROM sent_notifications`)).toHaveLength(1)
  })

  it('backfill: a legacy critical_date_alert row takes the CURRENT tier of its date; rows out of the view, already tiered, or of another type are untouched', () => {
    db.none(`CREATE TABLE critical_dates (reference_id UUID, urgency TEXT)`)
    db.none(`INSERT INTO critical_dates VALUES ('${R1}', 'urgent'), ('${R3}', 'notice')`)
    ins(db, R1, null)                          // in view -> 'urgent'
    ins(db, R2, null)                          // left the view -> stays NULL
    ins(db, R3, 'warning')                     // already tiered -> untouched
    ins(db, R3, null, 'insurance_expiry')      // other type -> untouched
    db.none(backfillStatement())
    const tier = (ref: string, type = 'critical_date_alert') =>
      db.one(`SELECT alert_tier FROM sent_notifications WHERE reference_id = '${ref}' AND notification_type = '${type}' ORDER BY alert_tier LIMIT 1`).alert_tier
    expect(tier(R1)).toBe('urgent')
    expect(tier(R2)).toBeNull()
    expect(tier(R3)).toBe('warning')
    expect(tier(R3, 'insurance_expiry')).toBeNull()
    // Re-running is a no-op (replayable: db reset / branch DB / repeated Dashboard paste).
    db.none(backfillStatement())
    expect(db.many(`SELECT 1 FROM sent_notifications WHERE alert_tier IS NOT NULL`)).toHaveLength(2)
  })

  it('the backfill is the only skipped statement in 0019, and is skipped by a narrow pattern', () => {
    const skipped = splitSqlStatements(readMigration(FILE)).map(statementBody).filter(b => PG_MEM_SKIP.some(re => re.test(b)))
    expect(skipped).toEqual([backfillStatement()])
  })
})
