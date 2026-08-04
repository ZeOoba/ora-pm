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
