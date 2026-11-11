-- CAM recoverable categories, annual cap, not-reconciled flag (lease level).
--
-- Gabriel rulings 2026-11-10. The 2026-11-10 extraction of all 139 active leases found leases the
-- engine overbills, because it billed every lease a share of the WHOLE recoverable pool:
--   * partial recovery: REDACTED-019 passes through Taxes only ("pay when due all Taxes for the
--     Building", Operating Expenses "Intentionally Omitted"); REDACTED-012 and REDACTED-037 pass
--     through common area maintenance and water/storm/sewer but not taxes ("Landlord shall pay all
--     real estate taxes") or the landlord's building insurance;
--   * an annual cap: REDACTED-002 504-507 "Taxes, Insurance, and CAM expense incurred by
--     the tenant shall not exceed $15,000 annually" for the initial term;
--   * leases never reconciled: REDACTED-030 and REDACTED-036 (tenant pays taxes/insurance directly),
--     the REDACTED-007 legacy form (fixed charge "already included in the Minimum Rent").
--
-- Columns:
--   leases.recoverable_categories  TEXT[]: the subset of expenses.category values (0002) the lease
--                                  passes through. NULL = every recoverable expense (the pre-0026
--                                  behaviour, kept for every existing lease). Non-empty, no
--                                  duplicates, every element a 0002 category (cam_categories_valid).
--   leases.base_year_categories    TEXT[]: the categories base_year_expense_amount covers (NULL = every
--                                  recoverable expense). /cam/calculate refuses a base-year lease
--                                  whose recoverable_categories differ (REFUTE 0026: a base total
--                                  for one category set against another pool zeroes or overbills
--                                  recovery, and the 3x guard does not catch it).
--   leases.cam_annual_cap          annual $ cap on what the tenant owes for the year, prorated by
--                                  days in effect. NULL = no cap.
--   leases.cam_cap_through         last day the cap applies (e.g. the initial term's end). NULL = no
--                                  end. Only with a cap. A date inside a reconciliation year caps
--                                  that whole year and warns (ruling: never overbills).
--   leases.cam_reconciled          false = /cam/calculate refuses the lease (422) with:
--   leases.cam_exclusion_reason    why — required, non-blank, when cam_reconciled = false.
--   cam_reconciliations.recoverable_categories / cam_annual_cap_applied
--                                  the categories a draft billed (NULL = all) and the prorated cap
--                                  when it bound (NULL = did not bind), shown before Approve & Bill;
--                                  /approve's recompute compares both, so a later edit blocks it.
-- total_property_recoverable_expenses on a draft now holds the LEASE's category pool.
--
-- expenses.recoverable stays the per-expense gate (landlord carve-outs stay recoverable = false).
-- Deploy the application AFTER this migration: the app selects these columns and a read against
-- the old schema fails closed (42703 -> 500, nothing saved).
--
-- RE-RUNNABLE: IF NOT EXISTS / CREATE OR REPLACE / DROP CONSTRAINT IF EXISTS-then-ADD throughout.

-- ---------------------------------------------------------------------------
-- 1) Category list validator. IMMUTABLE so a CHECK can use it (a CHECK cannot hold a subquery).
CREATE OR REPLACE FUNCTION cam_categories_valid(cats TEXT[]) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT cats IS NULL OR (
    cardinality(cats) > 0
    AND array_position(cats, NULL) IS NULL
    AND cats <@ ARRAY['taxes','insurance','maintenance','utilities','management','capital','other']::TEXT[]
    AND cardinality(cats) = (SELECT count(DISTINCT c) FROM unnest(cats) AS c)
  )
$$;

-- ---------------------------------------------------------------------------
-- 2) leases
ALTER TABLE leases ADD COLUMN IF NOT EXISTS recoverable_categories TEXT[];
COMMENT ON COLUMN leases.recoverable_categories IS 'Expense categories the lease passes through (expenses.category values). NULL = every recoverable expense.';

ALTER TABLE leases ADD COLUMN IF NOT EXISTS base_year_categories TEXT[];
COMMENT ON COLUMN leases.base_year_categories IS 'Categories base_year_expense_amount covers. NULL = every recoverable expense. Must equal recoverable_categories for a base-year lease to reconcile.';

ALTER TABLE leases ADD COLUMN IF NOT EXISTS cam_annual_cap NUMERIC(12,2);
ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_cam_annual_cap_check;
ALTER TABLE leases ADD CONSTRAINT leases_cam_annual_cap_check
  CHECK (cam_annual_cap IS NULL OR cam_annual_cap > 0);
COMMENT ON COLUMN leases.cam_annual_cap IS 'Annual $ cap on the tenant''s CAM owed for a year (prorated by days in effect). NULL = no cap.';

ALTER TABLE leases ADD COLUMN IF NOT EXISTS cam_cap_through DATE;
ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_cam_cap_through_check;
ALTER TABLE leases ADD CONSTRAINT leases_cam_cap_through_check
  CHECK (cam_cap_through IS NULL OR cam_annual_cap IS NOT NULL);
COMMENT ON COLUMN leases.cam_cap_through IS 'Last day the annual CAM cap applies (e.g. initial term end). NULL = no end. Requires cam_annual_cap.';

ALTER TABLE leases ADD COLUMN IF NOT EXISTS cam_reconciled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE leases ADD COLUMN IF NOT EXISTS cam_exclusion_reason TEXT;
ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_cam_exclusion_reason_check;
ALTER TABLE leases ADD CONSTRAINT leases_cam_exclusion_reason_check
  CHECK (cam_reconciled OR (cam_exclusion_reason IS NOT NULL AND btrim(cam_exclusion_reason) <> ''));
COMMENT ON COLUMN leases.cam_reconciled IS 'false = never CAM-reconciled (tenant pays directly, or a fixed charge is in rent); /cam/calculate refuses it.';
COMMENT ON COLUMN leases.cam_exclusion_reason IS 'Why the lease is not CAM-reconciled. Required when cam_reconciled = false.';

-- ---------------------------------------------------------------------------
-- 3) cam_reconciliations: what a draft billed
ALTER TABLE cam_reconciliations ADD COLUMN IF NOT EXISTS recoverable_categories TEXT[];
COMMENT ON COLUMN cam_reconciliations.recoverable_categories IS 'Categories the draft''s pool summed. NULL = every recoverable expense (or calculated before 0026).';
ALTER TABLE cam_reconciliations ADD COLUMN IF NOT EXISTS cam_annual_cap_applied NUMERIC(12,2);
ALTER TABLE cam_reconciliations DROP CONSTRAINT IF EXISTS cam_reconciliations_cam_annual_cap_applied_check;
ALTER TABLE cam_reconciliations ADD CONSTRAINT cam_reconciliations_cam_annual_cap_applied_check
  CHECK (cam_annual_cap_applied IS NULL OR cam_annual_cap_applied >= 0);
COMMENT ON COLUMN cam_reconciliations.cam_annual_cap_applied IS 'The prorated annual cap actual_cam_owed was reduced to. NULL = the cap did not bind (or none).';

-- ---------------------------------------------------------------------------
-- 4) Category CHECKs (DO block: re-runnable, and outside pg-mem, which has no SQL functions;
--    tests/db/cam-categories-migration-0026.test.ts exercises them on real Postgres).
DO $$
BEGIN
  ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_recoverable_categories_check;
  ALTER TABLE leases ADD CONSTRAINT leases_recoverable_categories_check
    CHECK (cam_categories_valid(recoverable_categories));
  ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_base_year_categories_check;
  ALTER TABLE leases ADD CONSTRAINT leases_base_year_categories_check
    CHECK (cam_categories_valid(base_year_categories));
  ALTER TABLE cam_reconciliations DROP CONSTRAINT IF EXISTS cam_reconciliations_recoverable_categories_check;
  ALTER TABLE cam_reconciliations ADD CONSTRAINT cam_reconciliations_recoverable_categories_check
    CHECK (cam_categories_valid(recoverable_categories));
END $$;
