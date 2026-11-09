/// <reference types="node" />
// tests/db/sent-notifications-tier-migration-0019.test.ts
//
// OI-321: sent_notifications gains alert_tier + alert_date so critical-date dedup is per
// (reference_id, urgency tier, critical date): an alert fires again as it escalates, and again
// for a date edited in place. Rows are written only by POST /api/cron/critical-dates-alerts/ack
// after a confirmed send (server/routes/cron.ts).
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
const R4 = '00000000-0000-4000-8000-000000000004'
const R5 = '00000000-0000-4000-8000-000000000005'
const ME = 'ggoldberg@oxfordra.net'
const D = '2026-07-01'

function ins(db: MigratedDb, ref: string, tier: string | null, date: string | null = tier === null ? null : D,
  opts: { type?: string; sentAt?: string } = {}) {
  const q = (v: string | null) => (v === null ? 'NULL' : `'${v}'`)
  db.none(`INSERT INTO sent_notifications (notification_type, reference_id, recipient, alert_tier, alert_date${opts.sentAt ? ', sent_at' : ''})
           VALUES ('${opts.type ?? 'critical_date_alert'}', '${ref}', '${ME}', ${q(tier)}, ${q(date)}${opts.sentAt ? `, '${opts.sentAt}'` : ''})`)
}
function backfillStatement(): string {
  const stmts = splitSqlStatements(readMigration(FILE)).map(statementBody)
  const upd = stmts.filter(s => /^UPDATE sent_notifications\b/i.test(s))
  expect(upd).toHaveLength(1)
  return upd[0]
}
function row(db: MigratedDb, ref: string, type = 'critical_date_alert') {
  return db.one(`SELECT alert_tier, alert_date FROM sent_notifications WHERE reference_id = '${ref}' AND notification_type = '${type}'`)
}
const iso = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v)

describe('migration 0019 — sent_notifications.alert_tier / alert_date (runtime, real migration SQL on pg-mem)', () => {
  let db: MigratedDb
  beforeEach(() => { db = freshMigratedDb() })

  it('ships as the only 0019 migration file', () => {
    expect(migrationFiles().filter(f => f.startsWith('0019_'))).toEqual([FILE])
  })

  it('allows the same reference at each of the four tiers, and again for a new date; once each', () => {
    for (const t of ['notice', 'warning', 'urgent', 'overdue']) ins(db, R1, t)
    ins(db, R1, 'urgent', '2027-07-01')
    expect(db.many(`SELECT 1 FROM sent_notifications WHERE reference_id = '${R1}'`)).toHaveLength(5)
    expect(() => ins(db, R1, 'urgent')).toThrow(/duplicate key|unique/i)
  })

  it('rejects a tier outside the four', () => {
    expect(() => ins(db, R1, 'someday')).toThrow(/check constraint "sent_notifications_alert_tier_check"/)
  })

  it('rejects a half-tagged row (tier without date or date without tier)', () => {
    expect(() => ins(db, R1, 'urgent', null)).toThrow(/check constraint "sent_notifications_alert_tag_pair_check"/)
    expect(() => ins(db, R1, null, D)).toThrow(/check constraint "sent_notifications_alert_tag_pair_check"/)
  })

  it('keeps the pre-0019 guarantee for legacy (untagged) rows: one per (type, reference, recipient)', () => {
    ins(db, R1, null)
    expect(() => ins(db, R1, null)).toThrow(/duplicate key|unique/i)
    ins(db, R1, 'urgent')
  })

  it('the ack upsert target (ON CONFLICT on the five columns) is inferable and idempotent', () => {
    const up = `INSERT INTO sent_notifications (notification_type, reference_id, recipient, alert_tier, alert_date)
                VALUES ('critical_date_alert', '${R1}', '${ME}', 'urgent', '${D}')
                ON CONFLICT (notification_type, reference_id, recipient, alert_tier, alert_date) DO NOTHING`
    db.none(up)
    db.none(up)
    expect(db.many(`SELECT 1 FROM sent_notifications`)).toHaveLength(1)
  })

  it('backfill: a legacy row takes the tier its date had WHEN IT WAS SENT (from sent_at) and the date itself', () => {
    // REFUTE C7: tagging with today's tier would silently drop the warning/urgent escalation of
    // every date first alerted at notice — the exact alerts OI-321 exists to deliver.
    db.none(`CREATE TABLE critical_dates (reference_id UUID, critical_date DATE, urgency TEXT)`)
    db.none(`INSERT INTO critical_dates VALUES
      ('${R1}', '2026-12-01', 'urgent'),
      ('${R3}', '2026-12-01', 'urgent'),
      ('${R4}', '2026-11-20', 'urgent'),
      ('${R5}', '2026-11-01', 'overdue')`)
    ins(db, R1, null, null, { sentAt: '2026-09-05T13:00:00Z' })   // 87 days out at send -> notice
    ins(db, R2, null, null, { sentAt: '2026-09-05T13:00:00Z' })   // left the view -> untouched
    ins(db, R3, 'warning', '2026-12-01')                          // already tagged -> untouched
    ins(db, R3, null, null, { type: 'insurance_expiry' })         // other type -> untouched
    ins(db, R4, null, null, { sentAt: '2026-10-25T13:00:00Z' })   // 26 days out at send -> urgent
    ins(db, R5, null, null, { sentAt: '2026-11-03T13:00:00Z' })   // past due at send -> overdue
    db.none(backfillStatement())
    expect(row(db, R1).alert_tier).toBe('notice')
    expect(iso(row(db, R1).alert_date)).toBe('2026-12-01')
    expect(row(db, R2).alert_tier).toBeNull()
    expect(row(db, R3).alert_tier).toBe('warning')
    expect(row(db, R3, 'insurance_expiry').alert_tier).toBeNull()
    expect(row(db, R4).alert_tier).toBe('urgent')
    expect(row(db, R5).alert_tier).toBe('overdue')
    // Re-running is a no-op (replayable: db reset / branch DB / repeated Dashboard paste).
    db.none(backfillStatement())
    expect(db.many(`SELECT 1 FROM sent_notifications WHERE alert_tier IS NOT NULL`)).toHaveLength(4)
  })

  it('the backfill uses the view thresholds (30 / 60 days, past due = overdue)', () => {
    const sql = backfillStatement()
    expect(sql).toMatch(/<\s*sent_notifications\.sent_at::date\s+THEN\s+'overdue'/)
    expect(sql).toMatch(/<=\s*sent_notifications\.sent_at::date \+ 30\s+THEN\s+'urgent'/)
    expect(sql).toMatch(/<=\s*sent_notifications\.sent_at::date \+ 60\s+THEN\s+'warning'/)
    expect(sql).toMatch(/ELSE\s+'notice'/)
  })

  it('the backfill is the only skipped statement in 0019, and is skipped by a narrow pattern', () => {
    const skipped = splitSqlStatements(readMigration(FILE)).map(statementBody).filter(b => PG_MEM_SKIP.some(re => re.test(b)))
    expect(skipped).toEqual([backfillStatement()])
  })
})
