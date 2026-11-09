/// <reference types="node" />
// tests/db/cam-share-migration-0019.test.ts
//
// Gabriel ruling 2026-11-08: CAM Proportionate Share on building/project RENTABLE SF, a lease-stated
// share that overrides it, and base-year recovery. Runs the REAL migration chain on pg-mem
// (tests/fixtures/pg-migrations.ts) so the CHECKs pinned here are the SQL that ships.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import { freshMigratedDb, migrationFiles, type MigratedDb } from '../fixtures/pg-migrations'

const FILE = '0019_cam_proportionate_share_base_year.sql'
const PROP = '00000000-0000-0000-0000-000000000001'
const UNIT = '00000000-0000-0000-0000-000000000002'
const TENANT = '00000000-0000-0000-0000-000000000003'
const LEASE = '00000000-0000-0000-0000-000000000004'

function seed(db: MigratedDb) {
  db.none(`
    INSERT INTO properties (id, name, address, city, state) VALUES ('${PROP}', 'P', '1 Main', 'Columbus', 'OH');
    INSERT INTO units (id, property_id, suite, sf) VALUES ('${UNIT}', '${PROP}', 'A', 1000);
    INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'T');
    INSERT INTO leases (id, tenant_id, unit_id, start_date, end_date, base_rent_monthly)
      VALUES ('${LEASE}', '${TENANT}', '${UNIT}', '2025-01-01', '2027-12-31', 1000);
  `)
}

describe('migration 0019 — CAM share basis + base year (runtime, real migration SQL on pg-mem)', () => {
  let db: MigratedDb
  beforeEach(() => {
    db = freshMigratedDb()
    seed(db)
  })

  it('ships as the only 0019 migration file', () => {
    expect(migrationFiles().filter((f) => f.startsWith('0019_'))).toEqual([FILE])
  })

  it('every new column defaults to NULL on existing rows', () => {
    expect(db.one(`SELECT cam_denominator_rsf FROM properties WHERE id = '${PROP}'`).cam_denominator_rsf).toBeNull()
    const l = db.one(`SELECT proportionate_share_pct, base_year, base_year_expense_amount FROM leases WHERE id = '${LEASE}'`)
    expect(l).toEqual({ proportionate_share_pct: null, base_year: null, base_year_expense_amount: null })
  })

  it('cam_denominator_rsf must be > 0', () => {
    db.none(`UPDATE properties SET cam_denominator_rsf = 31200 WHERE id = '${PROP}'`)
    expect(() => db.none(`UPDATE properties SET cam_denominator_rsf = 0 WHERE id = '${PROP}'`)).toThrow()
    expect(() => db.none(`UPDATE properties SET cam_denominator_rsf = -1 WHERE id = '${PROP}'`)).toThrow()
  })

  it('proportionate_share_pct is a fraction in (0, 1]', () => {
    db.none(`UPDATE leases SET proportionate_share_pct = 0.125 WHERE id = '${LEASE}'`)
    db.none(`UPDATE leases SET proportionate_share_pct = 1 WHERE id = '${LEASE}'`)
    expect(() => db.none(`UPDATE leases SET proportionate_share_pct = 0 WHERE id = '${LEASE}'`)).toThrow()
    expect(() => db.none(`UPDATE leases SET proportionate_share_pct = 12.5 WHERE id = '${LEASE}'`)).toThrow()
  })

  it('base_year is a plausible calendar year and base_year_expense_amount is >= 0', () => {
    db.none(`UPDATE leases SET base_year = 2024, base_year_expense_amount = 0 WHERE id = '${LEASE}'`)
    expect(() => db.none(`UPDATE leases SET base_year = 24 WHERE id = '${LEASE}'`)).toThrow()
    expect(() => db.none(`UPDATE leases SET base_year_expense_amount = -1 WHERE id = '${LEASE}'`)).toThrow()
  })

  it('cam_reconciliations.share_basis / recovery_basis accept only the values the app writes', () => {
    const ins = (share: string, rec: string) => db.none(`
      INSERT INTO cam_reconciliations (lease_id, reconciliation_year, total_property_recoverable_expenses,
        tenant_pro_rata_share_pct, estimated_cam_paid, actual_cam_owed, true_up_amount, share_basis, recovery_basis)
      VALUES ('${LEASE}', 2025, 1, 0.1, 0, 0, 0, '${share}', '${rec}')`)
    for (const share of ['lease_stated_pct', 'premises_rsf_over_denominator']) {
      for (const rec of ['full_pro_rata', 'above_expense_stop', 'none_gross', 'above_base_year']) {
        db.none(`DELETE FROM cam_reconciliations`)
        ins(share, rec)
      }
    }
    db.none(`DELETE FROM cam_reconciliations`)
    expect(() => ins('leased_sf', 'full_pro_rata')).toThrow()
    db.none(`DELETE FROM cam_reconciliations`)
    expect(() => ins('lease_stated_pct', 'something_else')).toThrow()
  })
})

// The importer fills properties.total_sf with the SUM of rent-roll suite SF. That figure must never
// become the CAM denominator (ruling 2026-11-08): pin that the importer does not write it.
describe('import-from-pipeline never fills cam_denominator_rsf', () => {
  it('the importer source does not name the column outside comments', () => {
    const src = readFileSync(join(__dirname, '../../scripts/import-from-pipeline.mjs'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    expect(src).not.toMatch(/cam_denominator_rsf/)
  })
})
