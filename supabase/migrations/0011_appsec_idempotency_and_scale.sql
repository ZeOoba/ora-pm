-- Payment/charge idempotency + money-column hardening
-- (schema halves of OI-034, OI-035, OI-039, OI-046 — appsec sweep 2026-08)
--
-- PRE-FLIGHT (run against the LIVE database BEFORE applying; every check must
-- return zero rows — if any returns rows, STOP and investigate, do not apply):
--
--   1. Duplicate Stripe PaymentIntents (would make the dedupe DELETE below
--      destructive on real data):
--        SELECT stripe_payment_intent_id, count(*) FROM payments
--        WHERE stripe_payment_intent_id IS NOT NULL
--        GROUP BY 1 HAVING count(*) > 1;
--
--   2. Backfill-value collision for charges.idempotency_key (astronomically
--      unlikely since id is a uuid, but check):
--        SELECT c.id FROM charges c
--        WHERE c.idempotency_key IS NULL
--          AND EXISTS (SELECT 1 FROM charges d
--                      WHERE d.idempotency_key = 'legacy:' || c.id::text);
--
--   3. Sub-cent precision in any money column (would be silently rounded by
--      the type change; real sub-cent data means STOP, not round):
--        SELECT * FROM <table> WHERE <col> <> round(<col>, 2) LIMIT 5;
--      ... for each of the 10 columns altered in section 4 below.

-- ---------------------------------------------------------------------------
-- 1) payments.stripe_payment_intent_id: one payments row per PaymentIntent.
--    The old partial index was non-unique, so nothing stopped two rows from
--    recording the same PI — silently under-stating tenant balances via
--    ar_ledger. Dedupe (keeps lowest id; expected no-op per pre-flight 1),
--    then replace the index with a partial UNIQUE one.
DELETE FROM payments a
  USING payments b
  WHERE a.stripe_payment_intent_id = b.stripe_payment_intent_id
    AND a.id > b.id
    AND a.stripe_payment_intent_id IS NOT NULL;

DROP INDEX IF EXISTS payments_stripe_pi_idx;

CREATE UNIQUE INDEX payments_stripe_pi_uniq
  ON payments(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2) Autopay period marker: "already collected this period" recognition that
--    survives Stripe's ~24h idempotency-key expiry (the scheduler fleet has a
--    documented catch-up-burst behavior that can re-run days later). NULL for
--    non-autopay payments; cron.ts stamps the billing period date on autopay
--    collections (application wiring lands in a later task).
ALTER TABLE payments ADD COLUMN autopay_period DATE;

CREATE UNIQUE INDEX payments_autopay_period_uniq
  ON payments(lease_id, autopay_period)
  WHERE autopay_period IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3) charges.idempotency_key NOT NULL: TEXT UNIQUE alone is useless while
--    NULLs are allowed (Postgres treats NULLs as distinct), so manual charges
--    had zero duplicate protection. Backfill legacy NULLs with a per-row
--    unique value, then forbid NULL.
UPDATE charges
  SET idempotency_key = 'legacy:' || id::text
  WHERE idempotency_key IS NULL;

ALTER TABLE charges ALTER COLUMN idempotency_key SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 4) Money-column scale + unit documentation. Bare NUMERIC declared no scale
--    and no unit while the API boundary speaks amount_cents — the ambiguity
--    behind a prior divide-by-100 display bug. All money columns become
--    NUMERIC(12,2) with the unit documented. Ratio/percentage columns
--    (e.g. cam_reconciliations.tenant_pro_rata_share_pct, 0-1 CHECK) are
--    deliberately untouched.
--
--    ar_ledger (last defined in 0010) sums charges.amount and payments.amount,
--    and Postgres refuses ALTER COLUMN TYPE on a column a view depends on
--    ("cannot alter type of a column used by a view or rule") — even for a
--    binary-compatible re-type. Drop the view first, recreate it (verbatim
--    0010 definition) after the re-types. rent_roll/critical_dates touch none
--    of the altered columns.
DROP VIEW IF EXISTS ar_ledger;

ALTER TABLE charges ALTER COLUMN amount TYPE NUMERIC(12,2);
COMMENT ON COLUMN charges.amount IS 'US dollars (not cents), 2dp';

ALTER TABLE payments ALTER COLUMN amount TYPE NUMERIC(12,2);
COMMENT ON COLUMN payments.amount IS 'US dollars (not cents), 2dp';

ALTER TABLE expenses ALTER COLUMN amount TYPE NUMERIC(12,2);
COMMENT ON COLUMN expenses.amount IS 'US dollars (not cents), 2dp';

ALTER TABLE cam_reconciliations ALTER COLUMN total_property_recoverable_expenses TYPE NUMERIC(12,2);
COMMENT ON COLUMN cam_reconciliations.total_property_recoverable_expenses IS 'US dollars (not cents), 2dp';

ALTER TABLE cam_reconciliations ALTER COLUMN estimated_cam_paid TYPE NUMERIC(12,2);
COMMENT ON COLUMN cam_reconciliations.estimated_cam_paid IS 'US dollars (not cents), 2dp';

ALTER TABLE cam_reconciliations ALTER COLUMN actual_cam_owed TYPE NUMERIC(12,2);
COMMENT ON COLUMN cam_reconciliations.actual_cam_owed IS 'US dollars (not cents), 2dp';

ALTER TABLE cam_reconciliations ALTER COLUMN true_up_amount TYPE NUMERIC(12,2);
COMMENT ON COLUMN cam_reconciliations.true_up_amount IS 'US dollars (not cents), 2dp; negative = tenant credit';

ALTER TABLE budgets ALTER COLUMN budgeted_amount TYPE NUMERIC(12,2);
COMMENT ON COLUMN budgets.budgeted_amount IS 'US dollars (not cents), 2dp';

ALTER TABLE tenant_sales_reports ALTER COLUMN reported_sales TYPE NUMERIC(12,2);
COMMENT ON COLUMN tenant_sales_reports.reported_sales IS 'US dollars (not cents), 2dp';

ALTER TABLE tenant_sales_reports ALTER COLUMN percentage_rent_owed TYPE NUMERIC(12,2);
COMMENT ON COLUMN tenant_sales_reports.percentage_rent_owed IS 'US dollars (not cents), 2dp';

-- Recreate ar_ledger — VERBATIM copy of the live definition from
-- 0010_ar_ledger_property_name.sql (no behavior change; dropped above only to
-- release the column dependency). tests/db/ar-ledger.test.ts extracts the
-- LAST ar_ledger definition across all migrations, so this copy is what its
-- behavioral suite now verifies — any accidental divergence from 0010 fails
-- those tests.
CREATE OR REPLACE VIEW ar_ledger AS
WITH charge_totals AS (
  SELECT lease_id, COALESCE(SUM(amount), 0) AS total_charged
  FROM charges
  GROUP BY lease_id
),
payment_totals AS (
  SELECT lease_id, COALESCE(SUM(
    CASE
      WHEN method = 'ach_stripe' AND stripe_status = 'succeeded' THEN amount
      WHEN method IN ('check','wire','other') THEN amount
      ELSE 0
    END
  ), 0) AS total_paid
  FROM payments
  GROUP BY lease_id
)
SELECT
  l.id AS lease_id,
  l.tenant_id,
  l.unit_id,
  t.name AS tenant_name,
  u.property_id,
  u.suite,
  COALESCE(ct.total_charged, 0) AS total_charged,
  COALESCE(pt.total_paid, 0) AS total_paid,
  COALESCE(ct.total_charged, 0) - COALESCE(pt.total_paid, 0) AS balance,
  p.name AS property_name
FROM leases l
JOIN tenants t ON t.id = l.tenant_id
JOIN units u ON u.id = l.unit_id
JOIN properties p ON p.id = u.property_id
LEFT JOIN charge_totals ct ON ct.lease_id = l.id
LEFT JOIN payment_totals pt ON pt.lease_id = l.id;

-- ---------------------------------------------------------------------------
-- Rollback (reference):
--   DROP INDEX IF EXISTS payments_stripe_pi_uniq;
--   CREATE INDEX payments_stripe_pi_idx ON payments(stripe_payment_intent_id)
--     WHERE stripe_payment_intent_id IS NOT NULL;
--   DROP INDEX IF EXISTS payments_autopay_period_uniq;
--   ALTER TABLE payments DROP COLUMN autopay_period;
--   ALTER TABLE charges ALTER COLUMN idempotency_key DROP NOT NULL;
--   ALTER TABLE <table> ALTER COLUMN <col> TYPE NUMERIC;  -- per column
-- No data loss on rollback: this migration only tightens constraints and
-- (per pre-flight 3) re-types values already at 2dp in practice.
