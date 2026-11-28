-- 0037: validate the two $50,000/month ceilings 0036 added NOT VALID.
--
-- 0036 added lease_rent_schedule_amount_ceiling (base_rent_monthly <= 50000) and
-- lease_recurring_charges_amount_ceiling (amount_monthly <= 50000) NOT VALID, so they refuse new and updated rows
-- but never checked the rows already stored. VALIDATE CONSTRAINT scans every existing row and, if all pass, marks
-- the constraint convalidated = true. It takes SHARE UPDATE EXCLUSIVE on each table: reads and writes continue.
--
-- Pre-flight (read-only; both must return 0 against the live database; on 2026-11-28 both did):
--   SELECT count(*) FROM lease_rent_schedule     WHERE base_rent_monthly > 50000;
--   SELECT count(*) FROM lease_recurring_charges WHERE amount_monthly    > 50000;
-- If either returns rows, this migration fails with 23514 (check_violation), applies nothing, and the constraints
-- stay NOT VALID. Resolve those rows against the lease documents first; never edit the CHECK to fit them.
--
-- Fails with 42704 if 0036 has not been applied. Re-runnable: validating an already-valid constraint is a no-op.
-- pg-mem cannot run this (0036's DO block, which adds the constraints, is skipped there); see PG_MEM_SKIP in
-- tests/fixtures/pg-migrations.ts. tests/db/validate-amount-ceilings-0037.test.ts runs it on real Postgres.
ALTER TABLE lease_rent_schedule VALIDATE CONSTRAINT lease_rent_schedule_amount_ceiling;
ALTER TABLE lease_recurring_charges VALIDATE CONSTRAINT lease_recurring_charges_amount_ceiling;

-- Rollback: none needed. A validated CHECK behaves exactly as the NOT VALID one for new writes; to return to
-- 0036's state, drop and re-add the constraint NOT VALID as 0036 does (that takes ACCESS EXCLUSIVE briefly).
