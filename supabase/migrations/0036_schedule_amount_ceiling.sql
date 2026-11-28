-- 0036: $50,000-per-month ceiling on the schedule rows monthly billing reads (follow-up to d51dca8).
--
-- LeaseInsertSchema / LeaseUpdateSchema (server/lib/schemas.ts) cap leases.base_rent_monthly and
-- cam_estimate_monthly at MAX_PAYMENT_CENTS / 100 = $50,000 and require whole cents. approve_lease_abstract()
-- (0033) writes lease_rent_schedule and lease_recurring_charges, which billing bills and autopay debits in the
-- same run, without passing through those schemas. server/lib/lease-approve.ts now refuses the same values
-- before the RPC; these CHECKs are the database's own floor under every writer of these two tables.
--
-- Whole cents needs no CHECK: both columns are NUMERIC(12,2). The TypeScript check refuses a sub-cent value
-- rather than letting the cast round it.
--
-- NOT VALID: existing rows are not re-checked, so the migration cannot fail on data already stored (none is
-- expected over the ceiling; d51dca8's live read found every lease under it). Every INSERT, and every UPDATE
-- of a row, is checked from here on. Re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lease_rent_schedule_amount_ceiling') THEN
    ALTER TABLE lease_rent_schedule ADD CONSTRAINT lease_rent_schedule_amount_ceiling
      CHECK (base_rent_monthly <= 50000) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lease_recurring_charges_amount_ceiling') THEN
    ALTER TABLE lease_recurring_charges ADD CONSTRAINT lease_recurring_charges_amount_ceiling
      CHECK (amount_monthly <= 50000) NOT VALID;
  END IF;
END
$$;

-- Rollback:
-- ALTER TABLE lease_rent_schedule DROP CONSTRAINT IF EXISTS lease_rent_schedule_amount_ceiling;
-- ALTER TABLE lease_recurring_charges DROP CONSTRAINT IF EXISTS lease_recurring_charges_amount_ceiling;
