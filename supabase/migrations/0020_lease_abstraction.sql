-- 0020: lease abstraction + rent-schedule data model (plan: docs/plans/2026-11-10-lease-abstraction-auto-billing-plan.md, Phase 1).
--
-- SCHEMA ONLY. Nothing reads or writes these tables yet: billing (server/lib/billing.ts) still bills
-- leases.base_rent_monthly + cam_estimate_monthly unchanged. Phase 2 (rent-schedule engine, REFUTE-gated)
-- is the first reader; it also owns the charges.schedule_id/concession_id traceability columns and the
-- current_rent() derivation, which are deliberately NOT in this migration so this one carries no
-- billing behaviour at all.
--
-- Tables:
--   lease_abstracts          one immutable snapshot per extraction run (audit trail; draft -> approved -> superseded)
--   lease_rent_schedule      base-rent steps; the future billing source of truth; no overlapping rows per lease
--   lease_escalation_rules   formula escalations that GENERATE schedule rows (CPI never auto-posts)
--   lease_concessions        abatements / waivers / free rent
--   lease_recurring_charges  CAM estimate, escrows, utilities, other monthly lines with their own effective dates
--   lease_provisions         structured tenant rights / rules ("Rights & Rules" section)
--   lease_critical_dates     option notice deadlines, step dates, abatement ends, etc.
-- plus party/notice columns on tenants.
--
-- Nullable-column CHECKs spell out `col IS NULL OR ...` (identical semantics in Postgres; pg-mem would
-- otherwise reject NULL).
-- Conventions: money NUMERIC(12,2) (0011); percentages are FRACTIONS (0.03 = 3%); every date range is
-- INCLUSIVE on both ends, like leases.start_date/end_date. Every CHECK is named. Every rule row carries
-- `source`, and rows that came from an extraction must point at the lease_abstracts row they came from.
--
-- RLS: enabled with NO policies on every new table: default-deny for anon/authenticated, service role
-- only (the 0013/0018 posture; server/db/client.ts uses the service-role key). Verify after apply with
-- scripts/verify-rls.sql Part 7.
--
-- Overlap guards use EXCLUDE USING gist, which needs the btree_gist extension for the `lease_id WITH =`
-- term (available on Supabase). They are added inside guarded DO blocks so the file stays re-runnable
-- (Postgres has no ADD CONSTRAINT IF NOT EXISTS). pg-mem cannot run DO blocks or CREATE EXTENSION, so
-- tests/db/lease-abstraction-migration-0020.test.ts pins them textually.
--
-- Integrity rules enforced HERE: a row may only cite an abstract of its own lease (composite FK on
-- (abstract_id, lease_id)); abstracts can never be deleted out from under the rows they produced, and a
-- lease with abstracts cannot be deleted (leases with charges already cannot be: 0002).
-- Integrity rules NOT expressible as a CHECK, owned by the Phase 4 approve RPC instead: only an APPROVED
-- abstract may be cited; source='amendment' must cite a kind='amendment' abstract; active schedule rows
-- must cover the lease term without gaps; a 'rent'/'cam_estimate' concession must not overlap an 'all' one.
--
-- Pre-flight before applying to prod: none (additive tables + nullable columns, no data). pg-mem cannot
-- run the DO block, so apply this file TWICE to a Supabase branch or local stack before prod: proves the
-- gist guards build and the file is re-runnable.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ── tenants: party + notice fields the abstract fills ────────────────────────
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS legal_name TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS dba TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS entity_type TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS state_of_formation TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS notice_address TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_address TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS guarantor_name TEXT;
-- CHECKs as DROP IF EXISTS + ADD (the 0016 pattern) rather than inline on ADD COLUMN IF NOT EXISTS, so a
-- second apply of this file re-asserts them instead of depending on how IF NOT EXISTS treats inline CHECKs.
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_entity_type_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_entity_type_check
  CHECK (entity_type IS NULL OR entity_type IN ('llc', 'corporation', 'partnership', 'sole_proprietorship', 'individual', 'nonprofit', 'other'));
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_state_of_formation_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_state_of_formation_check
  CHECK (state_of_formation IS NULL OR (state_of_formation = upper(state_of_formation) AND length(state_of_formation) = 2));

-- ── lease_abstracts ──────────────────────────────────────────────────────────
-- lease_id is NULL for a new-lease abstract until it is approved (the approve step creates the lease);
-- an amendment abstract always names the lease it amends. The source PDF is identified by storage path
-- + SHA-256 so an approved abstract is tied to the exact bytes reviewed.
CREATE TABLE IF NOT EXISTS lease_abstracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id UUID REFERENCES leases(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CONSTRAINT lease_abstracts_kind_check CHECK (kind IN ('lease', 'amendment')),
  status TEXT NOT NULL DEFAULT 'draft'
    CONSTRAINT lease_abstracts_status_check CHECK (status IN ('draft', 'approved', 'superseded', 'discarded')),
  storage_path TEXT NOT NULL CONSTRAINT lease_abstracts_storage_path_nonempty CHECK (btrim(storage_path) <> ''),
  file_sha256 TEXT NOT NULL
    CONSTRAINT lease_abstracts_file_sha256_format CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  model TEXT NOT NULL,
  raw_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  citations JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Target of the (abstract_id, lease_id) foreign keys below: a child row can only cite an abstract
  -- of its OWN lease.
  CONSTRAINT lease_abstracts_id_lease_uniq UNIQUE (id, lease_id),
  CONSTRAINT lease_abstracts_amendment_has_lease CHECK (kind = 'lease' OR lease_id IS NOT NULL),
  CONSTRAINT lease_abstracts_approved_has_lease CHECK (status IN ('draft', 'discarded') OR lease_id IS NOT NULL),
  -- approved/superseded rows carry who and when; draft/discarded rows carry neither.
  CONSTRAINT lease_abstracts_approval_pair CHECK (
    (status IN ('approved', 'superseded') AND approved_by IS NOT NULL AND btrim(approved_by) <> '' AND approved_at IS NOT NULL)
    OR (status IN ('draft', 'discarded') AND approved_by IS NULL AND approved_at IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS lease_abstracts_lease_id_idx ON lease_abstracts (lease_id);
-- At most one approved ORIGINAL-lease abstract per lease (amendments can each be approved).
CREATE UNIQUE INDEX IF NOT EXISTS lease_abstracts_one_approved_lease_uniq
  ON lease_abstracts (lease_id) WHERE status = 'approved' AND kind = 'lease';

-- ── lease_rent_schedule ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lease_rent_schedule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id UUID NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  effective_start DATE NOT NULL,
  effective_end DATE NOT NULL,
  base_rent_monthly NUMERIC(12,2) NOT NULL CONSTRAINT lease_rent_schedule_rent_nonneg CHECK (base_rent_monthly >= 0),
  rent_psf_annual NUMERIC(10,4) CONSTRAINT lease_rent_schedule_psf_nonneg CHECK (rent_psf_annual IS NULL OR rent_psf_annual >= 0),
  source TEXT NOT NULL
    CONSTRAINT lease_rent_schedule_source_check CHECK (source IN ('abstract', 'amendment', 'manual', 'backfill')),
  abstract_id UUID,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set when an amendment or re-abstraction replaces this row. Superseded rows are kept as history and
  -- are outside the no-overlap guard; billing reads only rows with superseded_at IS NULL.
  superseded_at TIMESTAMPTZ,
  CONSTRAINT lease_rent_schedule_dates_valid CHECK (effective_end >= effective_start),
  CONSTRAINT lease_rent_schedule_source_abstract CHECK ((source IN ('abstract', 'amendment')) = (abstract_id IS NOT NULL)),
  CONSTRAINT lease_rent_schedule_abstract_same_lease FOREIGN KEY (abstract_id, lease_id) REFERENCES lease_abstracts (id, lease_id)
);
CREATE INDEX IF NOT EXISTS lease_rent_schedule_lease_idx ON lease_rent_schedule (lease_id, effective_start);

-- ── lease_escalation_rules ───────────────────────────────────────────────────
-- fixed_pct: value is a fraction in (0, 1). fixed_amount: value is $/month added per adjustment.
-- cpi: value NULL; cpi_index names the series; optional floor/cap fractions. Phase 2 expands fixed rules
-- into lease_rent_schedule rows; a cpi rule only ever raises a review item.
CREATE TABLE IF NOT EXISTS lease_escalation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id UUID NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CONSTRAINT lease_escalation_rules_kind_check CHECK (kind IN ('fixed_pct', 'fixed_amount', 'cpi')),
  value NUMERIC(12,4),
  anniversary_basis TEXT NOT NULL DEFAULT 'commencement'
    CONSTRAINT lease_escalation_rules_anniversary_check CHECK (anniversary_basis IN ('commencement', 'rent_commencement', 'calendar')),
  cadence_months INTEGER NOT NULL DEFAULT 12 CONSTRAINT lease_escalation_rules_cadence_check CHECK (cadence_months > 0),
  first_adjustment_date DATE NOT NULL,
  applies_until DATE,
  cpi_index TEXT,
  cpi_floor NUMERIC(6,4),
  cpi_cap NUMERIC(6,4),
  source TEXT NOT NULL
    CONSTRAINT lease_escalation_rules_source_check CHECK (source IN ('abstract', 'amendment', 'manual', 'backfill')),
  abstract_id UUID,
  clause_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set when an amendment or re-abstraction replaces this row. Superseded rows are kept as history and
  -- are outside the no-overlap guard; billing reads only rows with superseded_at IS NULL.
  superseded_at TIMESTAMPTZ,
  CONSTRAINT lease_escalation_rules_value_check CHECK (
    (kind = 'fixed_pct' AND value > 0 AND value < 1)
    OR (kind = 'fixed_amount' AND value > 0)
    OR (kind = 'cpi' AND value IS NULL)
  ),
  CONSTRAINT lease_escalation_rules_cpi_fields CHECK (
    kind = 'cpi' OR (cpi_index IS NULL AND cpi_floor IS NULL AND cpi_cap IS NULL)
  ),
  CONSTRAINT lease_escalation_rules_cpi_bounds CHECK (
    (cpi_floor IS NULL OR (cpi_floor >= 0 AND cpi_floor < 1)) AND (cpi_cap IS NULL OR (cpi_cap > 0 AND cpi_cap < 1))
    AND (cpi_floor IS NULL OR cpi_cap IS NULL OR cpi_floor <= cpi_cap)
  ),
  CONSTRAINT lease_escalation_rules_until_valid CHECK (applies_until IS NULL OR applies_until >= first_adjustment_date),
  CONSTRAINT lease_escalation_rules_source_abstract CHECK ((source IN ('abstract', 'amendment')) = (abstract_id IS NOT NULL)),
  CONSTRAINT lease_escalation_rules_abstract_same_lease FOREIGN KEY (abstract_id, lease_id) REFERENCES lease_abstracts (id, lease_id)
);
CREATE INDEX IF NOT EXISTS lease_escalation_rules_lease_idx ON lease_escalation_rules (lease_id);

-- ── lease_concessions ────────────────────────────────────────────────────────
-- full_waiver: value NULL. pct: fraction in (0, 1) waived. fixed_amount: $/month waived.
-- Two concessions on the same lease AND charge_type may not overlap (gist guard below). A 'rent' or
-- 'cam_estimate' row overlapping an 'all' row is not blocked here: Phase 2's engine must fail closed on it.
CREATE TABLE IF NOT EXISTS lease_concessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id UUID NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  charge_type TEXT NOT NULL
    CONSTRAINT lease_concessions_charge_type_check CHECK (charge_type IN ('rent', 'cam_estimate', 'all')),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  kind TEXT NOT NULL CONSTRAINT lease_concessions_kind_check CHECK (kind IN ('full_waiver', 'pct', 'fixed_amount')),
  value NUMERIC(12,4),
  reason TEXT NOT NULL CONSTRAINT lease_concessions_reason_nonempty CHECK (btrim(reason) <> ''),
  clause_ref TEXT,
  clawback_on_default BOOLEAN NOT NULL DEFAULT false,
  source TEXT NOT NULL
    CONSTRAINT lease_concessions_source_check CHECK (source IN ('abstract', 'amendment', 'manual', 'backfill')),
  abstract_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set when an amendment or re-abstraction replaces this row. Superseded rows are kept as history and
  -- are outside the no-overlap guard; billing reads only rows with superseded_at IS NULL.
  superseded_at TIMESTAMPTZ,
  CONSTRAINT lease_concessions_dates_valid CHECK (period_end >= period_start),
  CONSTRAINT lease_concessions_value_check CHECK (
    (kind = 'full_waiver' AND value IS NULL)
    OR (kind = 'pct' AND value > 0 AND value < 1)
    OR (kind = 'fixed_amount' AND value > 0)
  ),
  CONSTRAINT lease_concessions_source_abstract CHECK ((source IN ('abstract', 'amendment')) = (abstract_id IS NOT NULL)),
  CONSTRAINT lease_concessions_abstract_same_lease FOREIGN KEY (abstract_id, lease_id) REFERENCES lease_abstracts (id, lease_id)
);
CREATE INDEX IF NOT EXISTS lease_concessions_lease_idx ON lease_concessions (lease_id, period_start);

-- ── lease_recurring_charges ──────────────────────────────────────────────────
-- type is a subset of charges.type (0002): the lines that recur monthly at a stated amount. Tax and
-- insurance escrows are 'other' with a description. Overlap is blocked per (lease, type) except 'other'.
CREATE TABLE IF NOT EXISTS lease_recurring_charges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id UUID NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  type TEXT NOT NULL CONSTRAINT lease_recurring_charges_type_check CHECK (type IN (
    'cam_estimate', 'utility_water', 'utility_gas', 'utility_electric', 'utility_other', 'other'
  )),
  description TEXT NOT NULL CONSTRAINT lease_recurring_charges_description_nonempty CHECK (btrim(description) <> ''),
  amount_monthly NUMERIC(12,2) NOT NULL CONSTRAINT lease_recurring_charges_amount_pos CHECK (amount_monthly > 0),
  effective_start DATE NOT NULL,
  effective_end DATE NOT NULL,
  source TEXT NOT NULL
    CONSTRAINT lease_recurring_charges_source_check CHECK (source IN ('abstract', 'amendment', 'manual', 'backfill')),
  abstract_id UUID,
  clause_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set when an amendment or re-abstraction replaces this row. Superseded rows are kept as history and
  -- are outside the no-overlap guard; billing reads only rows with superseded_at IS NULL.
  superseded_at TIMESTAMPTZ,
  CONSTRAINT lease_recurring_charges_dates_valid CHECK (effective_end >= effective_start),
  CONSTRAINT lease_recurring_charges_source_abstract CHECK ((source IN ('abstract', 'amendment')) = (abstract_id IS NOT NULL)),
  CONSTRAINT lease_recurring_charges_abstract_same_lease FOREIGN KEY (abstract_id, lease_id) REFERENCES lease_abstracts (id, lease_id)
);
CREATE INDEX IF NOT EXISTS lease_recurring_charges_lease_idx ON lease_recurring_charges (lease_id, effective_start);

-- ── lease_provisions ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lease_provisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id UUID NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  category TEXT NOT NULL CONSTRAINT lease_provisions_category_check CHECK (category IN (
    'renewal_option', 'expansion', 'rofr_rofo', 'termination', 'exclusive_use', 'permitted_use', 'signage',
    'parking', 'assignment_sublet', 'insurance_req', 'maintenance_split', 'hvac', 'holdover', 'late_fee',
    'guaranty', 'relocation', 'other'
  )),
  summary TEXT NOT NULL CONSTRAINT lease_provisions_summary_nonempty CHECK (btrim(summary) <> ''),
  verbatim_excerpt TEXT,
  page_ref INTEGER CONSTRAINT lease_provisions_page_ref_pos CHECK (page_ref IS NULL OR page_ref > 0),
  clause_ref TEXT,
  notice_deadline DATE,
  exercise_window_start DATE,
  exercise_window_end DATE,
  source TEXT NOT NULL
    CONSTRAINT lease_provisions_source_check CHECK (source IN ('abstract', 'amendment', 'manual', 'backfill')),
  abstract_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT lease_provisions_window_pair CHECK ((exercise_window_start IS NULL) = (exercise_window_end IS NULL)),
  CONSTRAINT lease_provisions_window_valid CHECK (exercise_window_end IS NULL OR exercise_window_end >= exercise_window_start),
  CONSTRAINT lease_provisions_source_abstract CHECK ((source IN ('abstract', 'amendment')) = (abstract_id IS NOT NULL)),
  CONSTRAINT lease_provisions_abstract_same_lease FOREIGN KEY (abstract_id, lease_id) REFERENCES lease_abstracts (id, lease_id)
);
CREATE INDEX IF NOT EXISTS lease_provisions_lease_idx ON lease_provisions (lease_id, category);

-- ── lease_critical_dates ─────────────────────────────────────────────────────
-- Distinct from the critical_dates VIEW (0004), which keeps working unchanged; Phase 5 extends the
-- alert cron to read this table too.
CREATE TABLE IF NOT EXISTS lease_critical_dates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id UUID NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  provision_id UUID REFERENCES lease_provisions(id) ON DELETE CASCADE,
  critical_date DATE NOT NULL,
  kind TEXT NOT NULL CONSTRAINT lease_critical_dates_kind_check CHECK (kind IN (
    'option_notice', 'rent_step', 'concession_end', 'insurance_cert', 'cam_reconciliation', 'expiration',
    'termination_notice', 'other'
  )),
  description TEXT NOT NULL CONSTRAINT lease_critical_dates_description_nonempty CHECK (btrim(description) <> ''),
  source TEXT NOT NULL
    CONSTRAINT lease_critical_dates_source_check CHECK (source IN ('abstract', 'amendment', 'manual', 'backfill', 'derived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS lease_critical_dates_date_idx ON lease_critical_dates (critical_date);
CREATE INDEX IF NOT EXISTS lease_critical_dates_lease_idx ON lease_critical_dates (lease_id);

-- ── Overlap guards (real Postgres only; pinned textually in the test) ─────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lease_rent_schedule_no_overlap') THEN
    ALTER TABLE lease_rent_schedule ADD CONSTRAINT lease_rent_schedule_no_overlap
      EXCLUDE USING gist (lease_id WITH =, daterange(effective_start, effective_end, '[]') WITH &&)
      WHERE (superseded_at IS NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lease_concessions_no_overlap') THEN
    ALTER TABLE lease_concessions ADD CONSTRAINT lease_concessions_no_overlap
      EXCLUDE USING gist (lease_id WITH =, charge_type WITH =, daterange(period_start, period_end, '[]') WITH &&)
      WHERE (superseded_at IS NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lease_recurring_charges_no_overlap') THEN
    ALTER TABLE lease_recurring_charges ADD CONSTRAINT lease_recurring_charges_no_overlap
      EXCLUDE USING gist (lease_id WITH =, type WITH =, daterange(effective_start, effective_end, '[]') WITH &&)
      WHERE (type <> 'other' AND superseded_at IS NULL);
  END IF;
  -- 'other' lines (tax escrow, insurance escrow, ...) may run side by side, but not two with the same
  -- description over the same days: that is a double bill.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lease_recurring_charges_other_no_overlap') THEN
    ALTER TABLE lease_recurring_charges ADD CONSTRAINT lease_recurring_charges_other_no_overlap
      EXCLUDE USING gist (lease_id WITH =, (lower(btrim(description))) WITH =, daterange(effective_start, effective_end, '[]') WITH &&)
      WHERE (type = 'other' AND superseded_at IS NULL);
  END IF;
  -- Two active escalation rules over the same span would compound on each other. applies_until NULL is
  -- an open upper bound (a daterange with a NULL bound is unbounded on that side).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lease_escalation_rules_no_overlap') THEN
    ALTER TABLE lease_escalation_rules ADD CONSTRAINT lease_escalation_rules_no_overlap
      EXCLUDE USING gist (lease_id WITH =, daterange(first_adjustment_date, applies_until, '[]') WITH &&)
      WHERE (superseded_at IS NULL);
  END IF;
END
$$;

-- ── RLS: default-deny, no policies (0013/0018 posture) ────────────────────────
ALTER TABLE lease_abstracts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE lease_rent_schedule     ENABLE ROW LEVEL SECURITY;
ALTER TABLE lease_escalation_rules  ENABLE ROW LEVEL SECURITY;
ALTER TABLE lease_concessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE lease_recurring_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE lease_provisions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE lease_critical_dates    ENABLE ROW LEVEL SECURITY;

-- Rollback (manual; only while no Phase 2+ code reads these tables):
-- DROP TABLE IF EXISTS lease_critical_dates;
-- DROP TABLE IF EXISTS lease_provisions;
-- DROP TABLE IF EXISTS lease_recurring_charges;
-- DROP TABLE IF EXISTS lease_concessions;
-- DROP TABLE IF EXISTS lease_escalation_rules;
-- DROP TABLE IF EXISTS lease_rent_schedule;
-- DROP TABLE IF EXISTS lease_abstracts;
-- ALTER TABLE tenants DROP COLUMN IF EXISTS legal_name, DROP COLUMN IF EXISTS dba,
--   DROP COLUMN IF EXISTS entity_type, DROP COLUMN IF EXISTS state_of_formation,
--   DROP COLUMN IF EXISTS notice_address, DROP COLUMN IF EXISTS billing_address,
--   DROP COLUMN IF EXISTS guarantor_name;
-- (btree_gist is left installed; it is harmless and other objects may come to depend on it.)
