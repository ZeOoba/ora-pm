-- OI-278 (schema half): charges become VOIDABLE.
--
-- Context: the delinquency cron posted 103 auto late fees ($5,150.00) between
-- 2026-08-04 and 2026-09-07 while the payments table had 0 rows ever — every
-- ar_ledger balance was a lifetime charge total, so every lease past the grace
-- window looked delinquent. The feed guard (ora-pm PR #26, live 2026-09-12)
-- stops new ones; this migration gives the ledger a way to retire the old ones
-- WITHOUT deleting them (Gabriel ruling 2026-09-13: keep the audit trail,
-- reversible, no row deletion). charges.amount has CHECK (amount >= 0)
-- (0002_financial_tables.sql), so an offsetting credit charge is impossible —
-- a void marker is the only non-destructive mechanism.
--
-- 0015_void_oi278_pre_guard_late_fees.sql is the DATA half (the guarded UPDATE
-- of exactly those 103 rows). Apply 0014 first; 0015 is a separate,
-- separately-confirmed step.
--
-- Application code (server/routes/cron.ts, portal.ts, exports.ts, reports.ts,
-- cam.ts) filters `voided_at IS NULL` wherever it sums or lists charges as
-- money, so balances agree with ar_ledger; the admin list (charges.ts GET)
-- still returns voided rows and the UI marks them.

-- ---------------------------------------------------------------------------
-- 1) Void columns. Both NULL = live charge. Both set = voided. A half-void
--    (one set, one NULL) or a blank reason is rejected at the DB, so a void
--    can never be silent about why.
ALTER TABLE charges ADD COLUMN voided_at TIMESTAMPTZ;
ALTER TABLE charges ADD COLUMN void_reason TEXT;

ALTER TABLE charges ADD CONSTRAINT charges_void_pair_check CHECK (
  (voided_at IS NULL AND void_reason IS NULL)
  OR (voided_at IS NOT NULL AND void_reason IS NOT NULL AND btrim(void_reason) <> '')
);

COMMENT ON COLUMN charges.voided_at IS 'When the charge was voided (audit row; excluded from every money sum incl. ar_ledger). NULL = live.';
COMMENT ON COLUMN charges.void_reason IS 'Why the charge was voided (non-blank whenever voided_at is set; NULL when live).';

-- ---------------------------------------------------------------------------
-- 2) ar_ledger: exclude voided charges from total_charged (and so balance).
--
--    VERBATIM copy of the live definition from 0011 (itself verbatim 0010)
--    except for the single `WHERE voided_at IS NULL` in charge_totals.
--    payment_totals and the outer SELECT are unchanged. tests/db/ar-ledger.test.ts
--    extracts the LAST ar_ledger definition across all migrations, so THIS copy
--    is what its behavioral suite verifies.
--
--    security_invoker (0012, OI-079): in Postgres, CREATE OR REPLACE VIEW
--    REPLACES the view's entire reloptions list with the new statement's WITH
--    clause — "even if it's empty" (src/backend/commands/view.c,
--    DefineVirtualRelation → AT_ReplaceRelOptions; verified against
--    REL_15_STABLE 2026-09-13). A bare CREATE OR REPLACE here would therefore
--    silently DROP security_invoker and reopen the OI-079 exposure. The WITH
--    clause carries it through the replace, and the ALTER after re-asserts it
--    so the property does not depend on anyone remembering the clause.
--
--    rent_roll and critical_dates read no charges columns — untouched.
CREATE OR REPLACE VIEW ar_ledger WITH (security_invoker = true) AS
WITH charge_totals AS (
  SELECT lease_id, COALESCE(SUM(amount), 0) AS total_charged
  FROM charges
  WHERE voided_at IS NULL
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

ALTER VIEW ar_ledger SET (security_invoker = true);

-- POST-APPLY CHECK (run against the live database; must return `true`):
--   SELECT 'security_invoker=true' = ANY(reloptions) FROM pg_class WHERE relname = 'ar_ledger';

-- ---------------------------------------------------------------------------
-- Rollback (reference) — restores the 0011 view text and drops the columns.
-- Run 0015's rollback FIRST if it has been applied (un-void the rows), or the
-- DROP COLUMN below discards the void markers with no way to recover which
-- rows they were on.
--   CREATE OR REPLACE VIEW ar_ledger WITH (security_invoker = true) AS
--     <0011_appsec_idempotency_and_scale.sql ar_ledger body, verbatim>;
--   ALTER VIEW ar_ledger SET (security_invoker = true);
--   ALTER TABLE charges DROP CONSTRAINT IF EXISTS charges_void_pair_check;
--   ALTER TABLE charges DROP COLUMN IF EXISTS void_reason;
--   ALTER TABLE charges DROP COLUMN IF EXISTS voided_at;
