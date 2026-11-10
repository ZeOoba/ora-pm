-- CAM Proportionate Share on BUILDING (or project) RENTABLE SF, plus base-year recovery.
--
-- Gabriel ruling 2026-11-08. PR #53 computed the CAM pro-rata denominator from LEASED SF weighted
-- by days in effect, so every tenant's share rose as the building emptied. The rule is the standard
-- NNN Proportionate Share: premises RSF over the building/project RSF the lease form names; the
-- landlord carries the vacancy share. ORA's forms:
--   * v2.8 §47: "the proportion that the rentable square footage of the Demised Premises bears to
--     the total rentable square footage of the Building, being [BUILDING RSF] square feet ...
--     estimated to be [X]%".
--   * v3.1 §36: "Tenant's Proportionate Share is stated in the Basic Lease Information" (a stated
--     %, shown as [PREMISES RSF] / [BUILDING RSF]; one property-specific v3.1 form names the
--     PROJECT RSF across several buildings instead).
--   * v3.1 §35 / generic v2.8 §40: tenant pays its share of the INCREASE over a Base Year.
--
-- Columns:
--   properties.cam_denominator_rsf   the building or project RSF the lease form names. Separate
--                                    from properties.total_sf on purpose: the importer fills
--                                    total_sf with the SUM of rent-roll suite SF, which is not the
--                                    lease's RSF. Nothing may derive this column from unit SF.
--   leases.proportionate_share_pct   the share the lease states, as a FRACTION in (0, 1]
--                                    (12.5% is stored as 0.125). Overrides the computed share.
--   leases.base_year                 calendar year; set = recover only the increase over it.
--   leases.base_year_expense_amount  that base year's recoverable Operating Costs + Taxes total
--                                    for the lease's CAM pool, in dollars (not $/SF).
--   cam_reconciliations.share_basis / recovery_basis / basis_warnings
--                                    how a saved draft's share and owed amount were derived, so a
--                                    reviewer can see the basis before Approve & Bill.
--
-- All new columns are NULLable: existing rows keep working until a human enters the lease data.
-- /cam/calculate returns 422 (nothing saved) when a lease has neither a stated share nor a
-- property RSF, when the RSF is smaller than the SF leased in the pool, or when a base year has no
-- base amount. Deploy the application AFTER this migration: the app selects these columns and a
-- read against the old schema fails closed (42703 -> 500, nothing saved).
--
-- RE-RUNNABLE: IF NOT EXISTS / DROP CONSTRAINT IF EXISTS-then-ADD throughout.

-- ---------------------------------------------------------------------------
-- 1) properties.cam_denominator_rsf
ALTER TABLE properties ADD COLUMN IF NOT EXISTS cam_denominator_rsf NUMERIC;
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_cam_denominator_rsf_check;
ALTER TABLE properties ADD CONSTRAINT properties_cam_denominator_rsf_check
  CHECK (cam_denominator_rsf IS NULL OR cam_denominator_rsf > 0);
COMMENT ON COLUMN properties.cam_denominator_rsf IS 'CAM Proportionate Share denominator: the building or project rentable SF named in the lease form. Never derived from summed unit SF. NULL = not entered.';

-- ---------------------------------------------------------------------------
-- 2) leases: stated share and base year
ALTER TABLE leases ADD COLUMN IF NOT EXISTS proportionate_share_pct NUMERIC;
ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_proportionate_share_pct_check;
ALTER TABLE leases ADD CONSTRAINT leases_proportionate_share_pct_check
  CHECK (proportionate_share_pct IS NULL OR (proportionate_share_pct > 0 AND proportionate_share_pct <= 1));
COMMENT ON COLUMN leases.proportionate_share_pct IS 'Tenant''s Proportionate Share as stated in the lease, a fraction in (0,1] (12.5% = 0.125). Overrides premises SF / properties.cam_denominator_rsf.';

ALTER TABLE leases ADD COLUMN IF NOT EXISTS base_year INTEGER;
ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_base_year_check;
ALTER TABLE leases ADD CONSTRAINT leases_base_year_check
  CHECK (base_year IS NULL OR (base_year >= 1900 AND base_year <= 2200));
COMMENT ON COLUMN leases.base_year IS 'CAM base year (calendar). Set = tenant pays its share of the increase over base_year_expense_amount.';

ALTER TABLE leases ADD COLUMN IF NOT EXISTS base_year_expense_amount NUMERIC;
ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_base_year_expense_amount_check;
ALTER TABLE leases ADD CONSTRAINT leases_base_year_expense_amount_check
  CHECK (base_year_expense_amount IS NULL OR base_year_expense_amount >= 0);
COMMENT ON COLUMN leases.base_year_expense_amount IS 'Base-year TOTAL recoverable expenses for the whole building/project pool ($/yr) - not the tenant''s share. Dollars, not $/SF.';

-- ---------------------------------------------------------------------------
-- 3) cam_reconciliations: persisted basis of each draft
ALTER TABLE cam_reconciliations ADD COLUMN IF NOT EXISTS share_basis TEXT;
ALTER TABLE cam_reconciliations DROP CONSTRAINT IF EXISTS cam_reconciliations_share_basis_check;
ALTER TABLE cam_reconciliations ADD CONSTRAINT cam_reconciliations_share_basis_check
  CHECK (share_basis IS NULL OR share_basis IN ('lease_stated_pct', 'premises_rsf_over_denominator'));

ALTER TABLE cam_reconciliations ADD COLUMN IF NOT EXISTS recovery_basis TEXT;
ALTER TABLE cam_reconciliations DROP CONSTRAINT IF EXISTS cam_reconciliations_recovery_basis_check;
ALTER TABLE cam_reconciliations ADD CONSTRAINT cam_reconciliations_recovery_basis_check
  CHECK (recovery_basis IS NULL OR recovery_basis IN ('full_pro_rata', 'above_expense_stop', 'none_gross', 'above_base_year'));

ALTER TABLE cam_reconciliations ADD COLUMN IF NOT EXISTS basis_warnings TEXT;
COMMENT ON COLUMN cam_reconciliations.share_basis IS 'lease_stated_pct | premises_rsf_over_denominator. NULL = calculated before 0021.';
COMMENT ON COLUMN cam_reconciliations.recovery_basis IS 'How actual_cam_owed was derived. NULL = calculated before 0021.';
COMMENT ON COLUMN cam_reconciliations.basis_warnings IS 'Non-blocking warnings from the calculation (e.g. stated share vs computed share > 0.5 pp), newline-separated.';
