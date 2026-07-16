-- Fix ar_ledger cartesian-fan-out bug (2026-07-16 audit finding #1).
-- 0004's view LEFT JOINed both charges and payments directly onto leases under one GROUP BY: a
-- lease with C charges and P payments produced C*P rows, so SUM(c.amount) counted each charge P
-- times and the payment SUM counted each payment C times. Fix: pre-aggregate each child table to
-- exactly one row per lease_id in its own CTE first, then LEFT JOIN those (already 1:1) onto leases.
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
  COALESCE(ct.total_charged, 0) - COALESCE(pt.total_paid, 0) AS balance
FROM leases l
JOIN tenants t ON t.id = l.tenant_id
JOIN units u ON u.id = l.unit_id
LEFT JOIN charge_totals ct ON ct.lease_id = l.id
LEFT JOIN payment_totals pt ON pt.lease_id = l.id;
