/// <reference types="node" />
// tests/db/lease-abstraction-migration-0020.test.ts
//
// Phase 1 of docs/plans/2026-11-10-lease-abstraction-auto-billing-plan.md: the lease-abstraction and
// rent-schedule DATA MODEL. Runtime assertions run the REAL migration chain on pg-mem
// (tests/fixtures/pg-migrations.ts). What pg-mem cannot execute (RLS, btree_gist, the EXCLUDE overlap
// guards inside the DO block) is pinned textually, plus a live check in scripts/verify-rls.sql Part 7.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import {
  PG_MEM_SKIP,
  freshMigratedDb,
  migrationFiles,
  readMigration,
  splitSqlStatements,
  statementBody,
  type MigratedDb,
} from '../fixtures/pg-migrations'

const FILE = '0020_lease_abstraction.sql'
const VERIFY_RLS = join(__dirname, '../../scripts/verify-rls.sql')
const NEW_TABLES = [
  'lease_abstracts',
  'lease_rent_schedule',
  'lease_escalation_rules',
  'lease_concessions',
  'lease_recurring_charges',
  'lease_provisions',
  'lease_critical_dates',
]
const EXCLUSIONS = [
  'lease_rent_schedule_no_overlap',
  'lease_concessions_no_overlap',
  'lease_recurring_charges_no_overlap',
  'lease_recurring_charges_other_no_overlap',
  'lease_escalation_rules_no_overlap',
]
const SHA = 'a'.repeat(64)

function seed(db: MigratedDb): { leaseId: string } {
  const [p] = db.many(`INSERT INTO properties (name, address, city, state, zip) VALUES ('P', '1 Main', 'Columbus', 'OH', '43215') RETURNING id`)
  const [u] = db.many(`INSERT INTO units (property_id, suite, sf) VALUES ('${p.id}', '100', 5000) RETURNING id`)
  const [t] = db.many(`INSERT INTO tenants (name) VALUES ('Acme') RETURNING id`)
  const [l] = db.many(
    `INSERT INTO leases (tenant_id, unit_id, start_date, end_date, base_rent_monthly)
     VALUES ('${t.id}', '${u.id}', '2026-01-01', '2030-12-31', 5000) RETURNING id`,
  )
  return { leaseId: l.id }
}

function abstractRow(db: MigratedDb, leaseId: string | null, extra = ''): string {
  const cols = extra ? `, ${extra.split('=')[0]}` : ''
  const vals = extra ? `, ${extra.split('=').slice(1).join('=')}` : ''
  const [r] = db.many(
    `INSERT INTO lease_abstracts (lease_id, kind, storage_path, file_sha256, model${cols})
     VALUES (${leaseId ? `'${leaseId}'` : 'NULL'}, 'lease', 'leases/x.pdf', '${SHA}', 'claude-opus-5-5'${vals}) RETURNING id`,
  )
  return r.id
}

describe('migration 0020 — runtime (real migration SQL on pg-mem)', () => {
  let db: MigratedDb
  let leaseId: string
  beforeEach(() => {
    db = freshMigratedDb()
    ;({ leaseId } = seed(db))
  })

  it('ships as the only 0020 migration file', () => {
    expect(migrationFiles().filter((f) => f.startsWith('0020_'))).toEqual([FILE])
  })

  describe('tenants columns', () => {
    it('accepts the new party fields', () => {
      db.none(`UPDATE tenants SET legal_name = 'Acme Holdings LLC', dba = 'Acme', entity_type = 'llc',
        state_of_formation = 'OH', notice_address = '1 Main', billing_address = 'PO Box 1', guarantor_name = 'J. Doe'`)
      const [t] = db.many(`SELECT legal_name, entity_type, state_of_formation FROM tenants`)
      expect(t).toEqual({ legal_name: 'Acme Holdings LLC', entity_type: 'llc', state_of_formation: 'OH' })
    })
    it('rejects an unknown entity_type and a malformed state', () => {
      expect(() => db.none(`UPDATE tenants SET entity_type = 'LLC'`)).toThrow(/tenants_entity_type_check/)
      expect(() => db.none(`UPDATE tenants SET state_of_formation = 'oh'`)).toThrow(/tenants_state_of_formation_check/)
      expect(() => db.none(`UPDATE tenants SET state_of_formation = 'OHI'`)).toThrow(/tenants_state_of_formation_check/)
    })
    it('leaves existing tenants valid (all new columns nullable)', () => {
      expect(db.many(`SELECT legal_name, entity_type FROM tenants`)).toEqual([{ legal_name: null, entity_type: null }])
    })
  })

  describe('lease_abstracts', () => {
    it('defaults to draft with empty JSON maps and allows a NULL lease for a new-lease draft', () => {
      const id = abstractRow(db, null)
      const [r] = db.many(`SELECT status, raw_fields, citations, confidence, warnings, approved_at FROM lease_abstracts WHERE id = '${id}'`)
      expect(r).toEqual({ status: 'draft', raw_fields: {}, citations: {}, confidence: {}, warnings: [], approved_at: null })
    })
    it('requires a lease for an amendment', () => {
      expect(() =>
        db.none(`INSERT INTO lease_abstracts (kind, storage_path, file_sha256, model) VALUES ('amendment', 'a.pdf', '${SHA}', 'm')`),
      ).toThrow(/lease_abstracts_amendment_has_lease/)
    })
    it('requires a lease, approver and timestamp to approve, and forbids them on a draft', () => {
      expect(() => abstractRow(db, null, `status='approved'`)).toThrow(/lease_abstracts_approved_has_lease|lease_abstracts_approval_pair/)
      expect(() => abstractRow(db, leaseId, `status='approved'`)).toThrow(/lease_abstracts_approval_pair/)
      expect(() => abstractRow(db, leaseId, `approved_by='g@x'`)).toThrow(/lease_abstracts_approval_pair/)
      const id = abstractRow(db, leaseId)
      db.none(`UPDATE lease_abstracts SET status = 'approved', approved_by = 'ggoldberg@oxfordra.net', approved_at = NOW() WHERE id = '${id}'`)
      expect(db.many(`SELECT status FROM lease_abstracts WHERE id = '${id}'`)).toEqual([{ status: 'approved' }])
    })
    it('allows only one approved original-lease abstract per lease', () => {
      const a = abstractRow(db, leaseId)
      const b = abstractRow(db, leaseId)
      db.none(`UPDATE lease_abstracts SET status = 'approved', approved_by = 'g', approved_at = NOW() WHERE id = '${a}'`)
      expect(() =>
        db.none(`UPDATE lease_abstracts SET status = 'approved', approved_by = 'g', approved_at = NOW() WHERE id = '${b}'`),
      ).toThrow(/duplicate key value violates unique constraint/)
      db.none(`UPDATE lease_abstracts SET status = 'superseded' WHERE id = '${a}'`)
      db.none(`UPDATE lease_abstracts SET status = 'approved', approved_by = 'g', approved_at = NOW() WHERE id = '${b}'`)
    })
    it('rejects a malformed sha256 and an unknown status', () => {
      expect(() =>
        db.none(`INSERT INTO lease_abstracts (kind, storage_path, file_sha256, model) VALUES ('lease', 'a.pdf', 'abc', 'm')`),
      ).toThrow(/lease_abstracts_file_sha256_format/)
      expect(() =>
        db.none(`INSERT INTO lease_abstracts (kind, storage_path, file_sha256, model) VALUES ('lease', 'a.pdf', '${SHA.toUpperCase()}', 'm')`),
      ).toThrow(/lease_abstracts_file_sha256_format/)
      expect(() => abstractRow(db, null, `status='pending'`)).toThrow(/lease_abstracts_status_check/)
    })
  })

  describe('lease_rent_schedule', () => {
    const ins = (db: MigratedDb, leaseId: string, cols: string, vals: string) =>
      db.none(`INSERT INTO lease_rent_schedule (lease_id, ${cols}) VALUES ('${leaseId}', ${vals})`)

    it('accepts a manual step and stores money at 2 dp', () => {
      ins(db, leaseId, 'effective_start, effective_end, base_rent_monthly, source', `'2026-01-01', '2026-12-31', 5000, 'manual'`)
      expect(db.many(`SELECT base_rent_monthly FROM lease_rent_schedule`)).toEqual([{ base_rent_monthly: 5000 }])
    })
    it('rejects end before start, negative rent, and an unknown source', () => {
      expect(() => ins(db, leaseId, 'effective_start, effective_end, base_rent_monthly, source', `'2026-02-01', '2026-01-31', 1, 'manual'`)).toThrow(/lease_rent_schedule_dates_valid/)
      expect(() => ins(db, leaseId, 'effective_start, effective_end, base_rent_monthly, source', `'2026-01-01', '2026-01-31', -1, 'manual'`)).toThrow(/lease_rent_schedule_rent_nonneg/)
      expect(() => ins(db, leaseId, 'effective_start, effective_end, base_rent_monthly, source', `'2026-01-01', '2026-01-31', 1, 'model'`)).toThrow(/lease_rent_schedule_source_check/)
    })
    it('ties source=abstract to an abstract_id and forbids an abstract_id on a manual row', () => {
      expect(() => ins(db, leaseId, 'effective_start, effective_end, base_rent_monthly, source', `'2026-01-01', '2026-01-31', 1, 'abstract'`)).toThrow(/lease_rent_schedule_source_abstract/)
      const a = abstractRow(db, leaseId)
      expect(() => ins(db, leaseId, 'effective_start, effective_end, base_rent_monthly, source, abstract_id', `'2026-01-01', '2026-01-31', 1, 'manual', '${a}'`)).toThrow(/lease_rent_schedule_source_abstract/)
      ins(db, leaseId, 'effective_start, effective_end, base_rent_monthly, source, abstract_id', `'2026-01-01', '2026-01-31', 1, 'abstract', '${a}'`)
    })
    it('blocks deleting an abstract that schedule rows came from', () => {
      const a = abstractRow(db, leaseId)
      ins(db, leaseId, 'effective_start, effective_end, base_rent_monthly, source, abstract_id', `'2026-01-01', '2026-01-31', 1, 'abstract', '${a}'`)
      expect(() => db.none(`DELETE FROM lease_abstracts WHERE id = '${a}'`)).toThrow(/foreign key/i)
    })
  })

  describe('lease_escalation_rules', () => {
    const ins = (db: MigratedDb, leaseId: string, kind: string, value: string, extra = '') =>
      db.none(`INSERT INTO lease_escalation_rules (lease_id, kind, value, first_adjustment_date, source${extra ? ', ' + extra.split('|')[0] : ''})
        VALUES ('${leaseId}', '${kind}', ${value}, '2027-01-01', 'manual'${extra ? ', ' + extra.split('|')[1] : ''})`)

    it('accepts 3% as a fraction, a fixed $ bump, and a CPI rule with floor/cap', () => {
      ins(db, leaseId, 'fixed_pct', '0.03')
      ins(db, leaseId, 'fixed_amount', '250')
      ins(db, leaseId, 'cpi', 'NULL', `cpi_index, cpi_floor, cpi_cap|'CPI-U', 0.02, 0.05`)
      expect(db.many(`SELECT kind, cadence_months FROM lease_escalation_rules ORDER BY kind`).map((r) => r.cadence_months)).toEqual([12, 12, 12])
    })
    it('rejects a percentage written as a whole number (3 instead of 0.03)', () => {
      expect(() => ins(db, leaseId, 'fixed_pct', '3')).toThrow(/lease_escalation_rules_value_check/)
    })
    it('rejects a value on a CPI rule, CPI fields on a fixed rule, and floor above cap', () => {
      expect(() => ins(db, leaseId, 'cpi', '0.03')).toThrow(/lease_escalation_rules_value_check/)
      expect(() => ins(db, leaseId, 'fixed_pct', '0.03', `cpi_index|'CPI-U'`)).toThrow(/lease_escalation_rules_cpi_fields/)
      expect(() => ins(db, leaseId, 'cpi', 'NULL', `cpi_floor, cpi_cap|0.05, 0.02`)).toThrow(/lease_escalation_rules_cpi_bounds/)
    })
    it('rejects a zero cadence and an applies_until before the first adjustment', () => {
      expect(() => ins(db, leaseId, 'fixed_pct', '0.03', `cadence_months|0`)).toThrow(/lease_escalation_rules_cadence_check/)
      expect(() => ins(db, leaseId, 'fixed_pct', '0.03', `applies_until|'2026-12-31'`)).toThrow(/lease_escalation_rules_until_valid/)
    })
  })

  describe('lease_concessions', () => {
    const ins = (db: MigratedDb, leaseId: string, kind: string, value: string, reason = `'Free rent §4.3'`) =>
      db.none(`INSERT INTO lease_concessions (lease_id, charge_type, period_start, period_end, kind, value, reason, source)
        VALUES ('${leaseId}', 'rent', '2026-01-01', '2026-03-31', '${kind}', ${value}, ${reason}, 'manual')`)

    it('accepts a full waiver, a 50% abatement and a fixed-dollar waiver', () => {
      ins(db, leaseId, 'full_waiver', 'NULL')
      ins(db, leaseId, 'pct', '0.5')
      ins(db, leaseId, 'fixed_amount', '1000')
      expect(db.many(`SELECT clawback_on_default FROM lease_concessions`).every((r) => r.clawback_on_default === false)).toBe(true)
    })
    it('rejects a value on a full waiver, pct >= 1, and a non-positive fixed amount', () => {
      expect(() => ins(db, leaseId, 'full_waiver', '1')).toThrow(/lease_concessions_value_check/)
      expect(() => ins(db, leaseId, 'pct', '1')).toThrow(/lease_concessions_value_check/)
      expect(() => ins(db, leaseId, 'pct', '50')).toThrow(/lease_concessions_value_check/)
      expect(() => ins(db, leaseId, 'fixed_amount', '0')).toThrow(/lease_concessions_value_check/)
    })
    it('requires a non-blank reason', () => {
      expect(() => ins(db, leaseId, 'full_waiver', 'NULL', `'  '`)).toThrow(/lease_concessions_reason_nonempty/)
    })
  })

  describe('lease_recurring_charges', () => {
    it('accepts an escrow as type other with a description, and rejects rent/late_fee types and non-positive amounts', () => {
      db.none(`INSERT INTO lease_recurring_charges (lease_id, type, description, amount_monthly, effective_start, effective_end, source)
        VALUES ('${leaseId}', 'other', 'Real estate tax escrow', 812.5, '2026-01-01', '2026-12-31', 'manual')`)
      for (const type of ['rent', 'late_fee', 'security_deposit']) {
        expect(() => db.none(`INSERT INTO lease_recurring_charges (lease_id, type, description, amount_monthly, effective_start, effective_end, source)
          VALUES ('${leaseId}', '${type}', 'x', 1, '2026-01-01', '2026-12-31', 'manual')`)).toThrow(/lease_recurring_charges_type_check/)
      }
      expect(() => db.none(`INSERT INTO lease_recurring_charges (lease_id, type, description, amount_monthly, effective_start, effective_end, source)
        VALUES ('${leaseId}', 'cam_estimate', 'CAM', 0, '2026-01-01', '2026-12-31', 'manual')`)).toThrow(/lease_recurring_charges_amount_pos/)
    })
  })

  describe('lease_provisions + lease_critical_dates', () => {
    it('stores a renewal option with its window, and its notice date cascades away with it', () => {
      const [p] = db.many(`INSERT INTO lease_provisions (lease_id, category, summary, page_ref, notice_deadline, exercise_window_start, exercise_window_end, source)
        VALUES ('${leaseId}', 'renewal_option', 'One 5-yr option at 95% FMV', 14, '2030-06-30', '2030-01-01', '2030-06-30', 'manual') RETURNING id`)
      db.none(`INSERT INTO lease_critical_dates (lease_id, provision_id, critical_date, kind, description, source)
        VALUES ('${leaseId}', '${p.id}', '2030-06-30', 'option_notice', 'Renewal notice due', 'derived')`)
      db.none(`DELETE FROM lease_provisions WHERE id = '${p.id}'`)
      expect(db.many(`SELECT id FROM lease_critical_dates`)).toEqual([])
    })
    it('rejects an unknown category, a half-open window, page 0, and an unknown date kind', () => {
      const base = `INSERT INTO lease_provisions (lease_id, category, summary, source`
      expect(() => db.none(`${base}) VALUES ('${leaseId}', 'roof', 's', 'manual')`)).toThrow(/lease_provisions_category_check/)
      expect(() => db.none(`${base}, exercise_window_start) VALUES ('${leaseId}', 'expansion', 's', 'manual', '2027-01-01')`)).toThrow(/lease_provisions_window_pair/)
      expect(() => db.none(`${base}, page_ref) VALUES ('${leaseId}', 'expansion', 's', 'manual', 0)`)).toThrow(/lease_provisions_page_ref_pos/)
      expect(() => db.none(`INSERT INTO lease_critical_dates (lease_id, critical_date, kind, description, source)
        VALUES ('${leaseId}', '2027-01-01', 'party', 'x', 'manual')`)).toThrow(/lease_critical_dates_kind_check/)
    })
  })

  describe('review fixes (adversarial pass, 2026-11-10)', () => {
    const secondLease = (): string => seed(db).leaseId
    it('rejects a row that cites ANOTHER lease\'s abstract, on every child table', () => {
      const other = secondLease()
      const foreign = abstractRow(db, other)
      const fk = /foreign key|violates/i
      expect(() => db.none(`INSERT INTO lease_rent_schedule (lease_id, effective_start, effective_end, base_rent_monthly, source, abstract_id)
        VALUES ('${leaseId}', '2026-01-01', '2026-01-31', 1, 'abstract', '${foreign}')`)).toThrow(fk)
      expect(() => db.none(`INSERT INTO lease_escalation_rules (lease_id, kind, value, first_adjustment_date, source, abstract_id)
        VALUES ('${leaseId}', 'fixed_pct', 0.03, '2027-01-01', 'abstract', '${foreign}')`)).toThrow(fk)
      expect(() => db.none(`INSERT INTO lease_concessions (lease_id, charge_type, period_start, period_end, kind, reason, source, abstract_id)
        VALUES ('${leaseId}', 'rent', '2026-01-01', '2026-01-31', 'full_waiver', 'r', 'abstract', '${foreign}')`)).toThrow(fk)
      expect(() => db.none(`INSERT INTO lease_recurring_charges (lease_id, type, description, amount_monthly, effective_start, effective_end, source, abstract_id)
        VALUES ('${leaseId}', 'cam_estimate', 'CAM', 1, '2026-01-01', '2026-01-31', 'abstract', '${foreign}')`)).toThrow(fk)
      expect(() => db.none(`INSERT INTO lease_provisions (lease_id, category, summary, source, abstract_id)
        VALUES ('${leaseId}', 'signage', 's', 'abstract', '${foreign}')`)).toThrow(fk)
    })
    it('rejects a 64-char non-hex sha256', () => {
      expect(() =>
        db.none(`INSERT INTO lease_abstracts (kind, storage_path, file_sha256, model) VALUES ('lease', 'a.pdf', '${'z'.repeat(64)}', 'm')`),
      ).toThrow(/lease_abstracts_file_sha256_format/)
    })
    it('rejects a CPI floor or cap written as a whole number (3 instead of 0.03)', () => {
      const ins = (floor: string, cap: string) => db.none(`INSERT INTO lease_escalation_rules (lease_id, kind, first_adjustment_date, source, cpi_floor, cpi_cap)
        VALUES ('${leaseId}', 'cpi', '2027-01-01', 'manual', ${floor}, ${cap})`)
      expect(() => ins('NULL', '3')).toThrow(/lease_escalation_rules_cpi_bounds/)
      expect(() => ins('2', 'NULL')).toThrow(/lease_escalation_rules_cpi_bounds/)
      ins('0.02', '0.05')
    })
    it('defaults anniversary_basis to commencement and rejects an unknown basis', () => {
      db.none(`INSERT INTO lease_escalation_rules (lease_id, kind, value, first_adjustment_date, source) VALUES ('${leaseId}', 'fixed_pct', 0.03, '2027-01-01', 'manual')`)
      expect(db.many(`SELECT anniversary_basis, superseded_at FROM lease_escalation_rules`)).toEqual([{ anniversary_basis: 'commencement', superseded_at: null }])
      expect(() => db.none(`INSERT INTO lease_escalation_rules (lease_id, kind, value, first_adjustment_date, source, anniversary_basis)
        VALUES ('${leaseId}', 'fixed_pct', 0.03, '2028-01-01', 'manual', 'fiscal')`)).toThrow(/lease_escalation_rules_anniversary_check/)
    })
    it('refuses to delete a lease that has abstracts (abstracts are the audit trail)', () => {
      abstractRow(db, leaseId)
      db.none(`DELETE FROM renewals WHERE lease_id = '${leaseId}'`)
      expect(() => db.none(`DELETE FROM leases WHERE id = '${leaseId}'`)).toThrow(/foreign key|violates/i)
    })
  })

  it('cascades every new child row when a lease with no charges is deleted', () => {
    db.none(`INSERT INTO lease_rent_schedule (lease_id, effective_start, effective_end, base_rent_monthly, source) VALUES ('${leaseId}', '2026-01-01', '2026-12-31', 1, 'manual')`)
    db.none(`INSERT INTO lease_provisions (lease_id, category, summary, source) VALUES ('${leaseId}', 'signage', 's', 'manual')`)
    db.none(`DELETE FROM renewals WHERE lease_id = '${leaseId}'`)
    db.none(`DELETE FROM leases WHERE id = '${leaseId}'`)
    expect(db.many(`SELECT id FROM lease_rent_schedule`)).toEqual([])
    expect(db.many(`SELECT id FROM lease_provisions`)).toEqual([])
  })
})

describe('migration 0020 — text pins (what pg-mem cannot execute)', () => {
  let sql = ''
  let code = ''
  beforeAll(() => {
    sql = readMigration(FILE)
    code = sql.replace(/--[^\n]*/g, '')
  })

  it('enables RLS on exactly the seven new tables', () => {
    const tables = [...code.matchAll(/ALTER TABLE\s+([\w.]+)\s+ENABLE ROW LEVEL SECURITY/gi)].map((m) => m[1])
    expect(tables.sort()).toEqual([...NEW_TABLES].sort())
  })

  it('carries no CREATE POLICY (default-deny, service role only)', () => {
    expect(/^\s*CREATE POLICY\b/im.test(sql)).toBe(false)
  })

  it('writes no data and touches no billing table (charges, payments, leases, ar_ledger)', () => {
    // Statement-leading keywords only: `ON DELETE CASCADE` inside a column definition is not a write.
    expect(code).not.toMatch(/(^|;)\s*(INSERT|UPDATE|DELETE|COPY|TRUNCATE)\b/i)
    expect(code).not.toMatch(/\bALTER TABLE\s+(charges|payments|leases)\b/i)
    expect(code).not.toMatch(/\bar_ledger\b/i)
  })

  it('installs btree_gist and declares the five gist overlap guards, each behind a pg_constraint existence check', () => {
    expect(code).toMatch(/CREATE EXTENSION IF NOT EXISTS btree_gist;/)
    expect([...code.matchAll(/ADD CONSTRAINT (\w+)\s+EXCLUDE USING gist/g)].map((m) => m[1]).sort()).toEqual([...EXCLUSIONS].sort())
    for (const name of EXCLUSIONS) {
      expect(code).toContain(`IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}')`)
    }
    const flat = code.replace(/\s+/g, ' ')
    // Every guard covers ACTIVE rows only, so superseded history can overlap the rows that replaced it.
    expect(flat).toContain(`EXCLUDE USING gist (lease_id WITH =, daterange(effective_start, effective_end, '[]') WITH &&) WHERE (superseded_at IS NULL)`)
    expect(flat).toContain(`EXCLUDE USING gist (lease_id WITH =, charge_type WITH =, daterange(period_start, period_end, '[]') WITH &&) WHERE (superseded_at IS NULL)`)
    expect(flat).toContain(`EXCLUDE USING gist (lease_id WITH =, type WITH =, daterange(effective_start, effective_end, '[]') WITH &&) WHERE (type <> 'other' AND superseded_at IS NULL)`)
    expect(flat).toContain(`EXCLUDE USING gist (lease_id WITH =, (lower(btrim(description))) WITH =, daterange(effective_start, effective_end, '[]') WITH &&) WHERE (type = 'other' AND superseded_at IS NULL)`)
    expect(flat).toContain(`EXCLUDE USING gist (lease_id WITH =, daterange(first_adjustment_date, applies_until, '[]') WITH &&) WHERE (superseded_at IS NULL)`)
  })

  it('re-asserts the tenants CHECKs with DROP IF EXISTS + ADD (no inline CHECK on ADD COLUMN IF NOT EXISTS)', () => {
    expect(code).not.toMatch(/ADD COLUMN IF NOT EXISTS[^;]*\bCHECK\b/i)
    for (const c of ['tenants_entity_type_check', 'tenants_state_of_formation_check']) {
      expect(code).toContain(`ALTER TABLE tenants DROP CONSTRAINT IF EXISTS ${c};`)
      expect(code).toContain(`ALTER TABLE tenants ADD CONSTRAINT ${c}`)
    }
  })

  it('is re-runnable: every CREATE is guarded, and re-applying the executable statements is a no-op', () => {
    expect(code.match(/\bCREATE\s+(TABLE|INDEX|UNIQUE INDEX|TYPE|FUNCTION|VIEW|EXTENSION)\b(?!\s+IF NOT EXISTS)/gi) ?? []).toEqual([])
    expect(code.match(/\bADD COLUMN\b(?!\s+IF NOT EXISTS)/gi) ?? []).toEqual([])
    const db = freshMigratedDb()
    const { leaseId } = seed(db)
    db.none(`INSERT INTO lease_provisions (lease_id, category, summary, source) VALUES ('${leaseId}', 'signage', 'kept', 'manual')`)
    for (const stmt of splitSqlStatements(sql)) {
      const body = statementBody(stmt)
      if (PG_MEM_SKIP.some((re) => re.test(body))) continue
      // pg-mem throws on a skipped CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS (see 0018's test).
      if (/^(CREATE TABLE IF NOT EXISTS|ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS)\b/i.test(body)) continue
      expect(() => db.none(stmt), `re-applying: ${body.slice(0, 80)}`).not.toThrow()
    }
    expect(db.many(`SELECT summary FROM lease_provisions`)).toEqual([{ summary: 'kept' }])
  })

  it('carries a commented rollback block', () => {
    expect(sql).toMatch(/--\s*Rollback/i)
    for (const t of NEW_TABLES) expect(sql).toMatch(new RegExp(`--\\s*DROP TABLE IF EXISTS ${t};`))
  })
})

describe('scripts/verify-rls.sql Part 7 — live check of 0020', () => {
  let part7 = ''
  beforeAll(() => {
    const verify = readFileSync(VERIFY_RLS, 'utf8')
    const start = verify.indexOf('Part 7')
    expect(start, 'verify-rls.sql has no Part 7').toBeGreaterThan(-1)
    part7 = verify.slice(start)
  })
  it('checks rowsecurity + zero policies on all seven tables, and the three exclusion constraints', () => {
    for (const t of NEW_TABLES) expect(part7).toContain(`'${t}'`)
    for (const x of EXCLUSIONS) expect(part7).toContain(`'${x}'`)
    expect(part7).toMatch(/contype\s*=\s*'x'/)
    expect(part7).toMatch(/pg_policies/)
  })
})
