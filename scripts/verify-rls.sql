-- OI-048: manual, read-only RLS verification.
--
-- Run this against the LIVE database (Supabase SQL Editor, or `psql`) once
-- per environment you care about, and paste the output into the PR. It does
-- not change anything — SELECT-only, no side effects.
--
-- Why this is manual and not automated: there is no live Postgres/Supabase
-- instance in the test suite (tests/db/rls-inventory.test.ts checks the
-- MIGRATION SOURCE against a checked-in manifest, which is a different
-- question — "do the migrations still claim what we think they claim" vs.
-- "did those claims actually get applied to this database"). This script
-- answers the second question. It matters most for
-- supabase/migrations/0008_storage_rls.sql, which self-documents as applied
-- out-of-band via a one-off Node script rather than the normal migration
-- runner — so whether its policies exist in any given environment is
-- otherwise unverifiable from the repo alone.
--
-- SEPARATE finding this script does NOT check (policy existence != policy
-- correctness): src/portal/pages/PortalInsurance.tsx uploads COI files
-- straight to Supabase Storage via a direct `supabase-js` client (anon key +
-- tenant JWT), to path `${session.user.id}/${file.name}` — but the
-- `tenant_upload_insurance` WITH CHECK below matches the folder against
-- `tenants.id`, not `auth.users.id`/`session.user.id` (those are different
-- UUIDs — see server/db/client.ts's comment block and
-- supabase/migrations/README.md for the full writeup). If this policy DOES
-- exist per the query below, that mismatch means real uploads through that
-- page are worth testing end-to-end, not just confirming the policy is
-- present.
--
-- Expected result set — this is the SAME claim set locked down by
-- tests/db/rls-inventory.test.ts's EXPECTED_MANIFEST. If you change one,
-- change the other in the same PR.
--
-- rowsecurity (Part 1) should be `true` for exactly:
--   charges, payments, lease_documents, lease_amendments, tenant_notices,
--   insurance_certificates
--
-- policies (Part 2) should be exactly these 10 rows (tablename, policyname):
--   charges                | tenant_own_charges
--   payments               | tenant_own_payments
--   lease_documents        | tenant_own_documents
--   lease_amendments       | tenant_own_amendments
--   tenant_notices         | tenant_own_notices
--   insurance_certificates | tenant_own_insurance_select
--   insurance_certificates | tenant_own_insurance_insert
--   objects                | tenant_upload_insurance
--   objects                | tenant_read_insurance
--   objects                | tenant_read_lease_docs
--
-- A missing row (especially any `objects` row — that's 0008, the
-- out-of-band one) is a real finding: report it, don't silently apply the
-- migration to fix it. Applying a missing policy to prod is a separate,
-- reviewable change (see the task-11 brief's Risk/rollback note).

-- ── Part 1: which public-schema tables have RLS enabled ────────────────────
SELECT
  schemaname,
  tablename,
  rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'charges',
    'payments',
    'lease_documents',
    'lease_amendments',
    'tenant_notices',
    'insurance_certificates'
  )
ORDER BY tablename;

-- ── Part 2: every policy on those tables + on storage.objects ──────────────
SELECT
  schemaname,
  tablename,
  policyname,
  cmd AS command,
  roles,
  qual AS using_expression,
  with_check AS with_check_expression
FROM pg_policies
WHERE (
    schemaname = 'public'
    AND tablename IN (
      'charges',
      'payments',
      'lease_documents',
      'lease_amendments',
      'tenant_notices',
      'insurance_certificates'
    )
  )
  OR (schemaname = 'storage' AND tablename = 'objects')
ORDER BY schemaname, tablename, policyname;

-- ── Part 3: sanity check — any policy referencing a table that ISN'T in the
-- expected set above (catches an undocumented policy this script forgot to
-- account for, e.g. a later migration adding RLS somewhere else) ──────────
SELECT
  schemaname,
  tablename,
  policyname
FROM pg_policies
WHERE NOT (
  (
    schemaname = 'public'
    AND tablename IN (
      'charges',
      'payments',
      'lease_documents',
      'lease_amendments',
      'tenant_notices',
      'insurance_certificates'
    )
  )
  OR (schemaname = 'storage' AND tablename = 'objects')
)
ORDER BY schemaname, tablename, policyname;

-- ── Part 4 (OI-078): rowsecurity should be `true` for all 17 of these, with
-- ZERO matching rows in Part 2/3-style pg_policies output (deliberate
-- default-deny — see 0013_enable_rls_remaining_tables.sql's header) ────────
SELECT
  schemaname,
  tablename,
  rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'properties', 'units', 'tenants', 'leases', 'expenses', 'budgets',
    'renewals', 'broker_commissions', 'cam_reconciliations',
    'correspondence_log', 'journal_entry_exports', 'lease_move_events',
    'sent_notifications', 'stripe_webhook_events', 'tenant_sales_reports',
    'utility_meters', 'utility_readings'
  )
ORDER BY tablename;

-- ── Part 5 (OI-079): reloptions should contain security_invoker=true for
-- all three views ───────────────────────────────────────────────────────
SELECT
  c.relname AS view_name,
  c.reloptions
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('ar_ledger', 'rent_roll', 'critical_dates')
ORDER BY c.relname;

-- ── Part 6 (P1 T12, 0018_admin_roles.sql): admin_users must have
-- rowsecurity = true and ZERO policies — default-deny, service role only, the
-- same deliberate posture as Part 4. Expect exactly one row, `true`, with
-- policy_count = 0. A policy here (it would also surface in Part 3) means the
-- admin role roster is reachable with the public anon key: report it. ─────────
SELECT
  t.schemaname,
  t.tablename,
  t.rowsecurity,
  (SELECT count(*) FROM pg_policies p
    WHERE p.schemaname = t.schemaname AND p.tablename = t.tablename) AS policy_count
FROM pg_tables t
WHERE t.schemaname = 'public'
  AND t.tablename = 'admin_users';

-- ── Part 6b (P1 T12): the three CHECK constraints 0018 declares must exist on
-- public.admin_users. 0018 uses CREATE TABLE IF NOT EXISTS, which silently
-- skips over a table that already existed (made by hand, or by an earlier
-- draft), so Part 6 passing proves nothing about the constraints. Expect
-- exactly three rows, each with present = true AND definition_matches = true.
-- The name alone is not enough: Postgres auto-names an unnamed CHECK on the
-- role column "admin_users_role_check" as well, so a hand-made table with a
-- different role list would still match by name. definition_matches compares
-- pg_get_constraintdef against the expected text with whitespace and
-- parentheses removed; when it is false, compare actual_definition with
-- expected_definition. Any false or NULL is a finding: report it, do not
-- patch the table by hand. ─────────────────────────────────────────────────
SELECT
  expected.conname,
  con.oid IS NOT NULL AS present,
  COALESCE(
    regexp_replace(pg_get_constraintdef(con.oid), '[[:space:]()]', '', 'g')
      = regexp_replace(expected.definition, '[[:space:]()]', '', 'g'),
    false
  ) AS definition_matches,
  pg_get_constraintdef(con.oid) AS actual_definition,
  expected.definition AS expected_definition
FROM (VALUES
  ('admin_users_email_lowercase',
   $$CHECK ((email = lower(email)))$$),
  ('admin_users_email_trimmed_nonempty',
   $$CHECK (((email = btrim(email)) AND (email <> ''::text)))$$),
  ('admin_users_role_check',
   $$CHECK ((role = ANY (ARRAY['owner'::text, 'manager'::text, 'bookkeeper'::text, 'viewer'::text])))$$)
) AS expected(conname, definition)
LEFT JOIN pg_constraint con
  ON con.conrelid = to_regclass('public.admin_users')
 AND con.conname = expected.conname
 AND con.contype = 'c'
ORDER BY expected.conname;

-- ── Part 7 (0020_lease_abstraction.sql): the seven lease-abstraction tables
-- must have rowsecurity = true and ZERO policies — default-deny, service role
-- only, the same posture as Parts 4 and 6. Expect exactly seven rows, each
-- `true` with policy_count = 0. ─────────────────────────────────────────────
SELECT
  expected.tablename,
  t.rowsecurity,
  (SELECT count(*) FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename = expected.tablename) AS policy_count
FROM (VALUES
  ('lease_abstracts'), ('lease_rent_schedule'), ('lease_escalation_rules'),
  ('lease_concessions'), ('lease_recurring_charges'), ('lease_provisions'),
  ('lease_critical_dates')
) AS expected(tablename)
LEFT JOIN pg_tables t
  ON t.schemaname = 'public' AND t.tablename = expected.tablename
ORDER BY expected.tablename;

-- ── Part 7b (0020): the five EXCLUDE USING gist overlap guards must exist.
-- They are added inside a DO block guarded by conname, so a pre-existing
-- constraint of the same name would be silently kept: compare the definition.
-- Expect five rows, each present = true; read actual_definition and confirm it
-- is EXCLUDE USING gist on lease_id plus the inclusive daterange ('[]') and a
-- WHERE clause containing superseded_at IS NULL. ────────────────────────────
SELECT
  expected.conname,
  con.oid IS NOT NULL AS present,
  pg_get_constraintdef(con.oid) AS actual_definition
FROM (VALUES
  ('lease_rent_schedule_no_overlap'),
  ('lease_concessions_no_overlap'),
  ('lease_recurring_charges_no_overlap'),
  ('lease_recurring_charges_other_no_overlap'),
  ('lease_escalation_rules_no_overlap')
) AS expected(conname)
LEFT JOIN pg_constraint con
  ON con.conname = expected.conname
 AND con.contype = 'x'
ORDER BY expected.conname;
