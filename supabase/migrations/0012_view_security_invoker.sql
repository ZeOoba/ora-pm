-- OI-079: ar_ledger, rent_roll, and critical_dates were created without
-- security_invoker, so each runs as its OWNER (the migration role) and
-- ignores the RLS policies on charges/payments/leases/tenants entirely
-- (0004_views_and_rls.sql) — a caller querying the view directly via
-- PostgREST with the anon/authenticated key sees every tenant's rows,
-- not just their own.
--
-- security_invoker (Postgres 15+) makes the view run with the QUERYING
-- role's privileges instead of the owner's, so the underlying tables'
-- RLS policies apply as if the caller had queried them directly. Additive
-- only — no column, join, or filter logic changes.
--
-- Same caveat as OI-078 (see its migration): these three views currently
-- have no direct caller (the app's own client code never queries them
-- through supabase-js — server/db/client.ts uses the service-role key,
-- which bypasses RLS regardless of security_invoker). This closes the
-- same direct-PostgREST-via-anon-key exposure class, defense-in-depth.
ALTER VIEW ar_ledger SET (security_invoker = true);
ALTER VIEW rent_roll SET (security_invoker = true);
ALTER VIEW critical_dates SET (security_invoker = true);
