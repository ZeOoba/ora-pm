-- OI-078: 17 of 23 public-schema tables had no ENABLE ROW LEVEL SECURITY
-- anywhere in supabase/migrations/** — under stock Supabase grants, an
-- RLS-disabled table is readable AND writable via PostgREST using the
-- anon key, which ships in the client bundle by design
-- (VITE_SUPABASE_ANON_KEY). Every table below is now covered.
--
-- No CREATE POLICY statements are added here, deliberately — this is a
-- default-deny fix, not a scoped-access one. Two facts, both verified by
-- direct grep against this repo (see server/db/client.ts's OI-048 comment
-- block for the same conclusion reached independently for the original 6
-- tables), make default-deny both correct and safe:
--
--   1. server/db/client.ts's getDb()/getServiceDb() is the ONLY database
--      client the backend uses, and it is constructed with
--      SUPABASE_SERVICE_ROLE_KEY — every server/routes/** query bypasses
--      RLS entirely, unaffected by anything in this migration.
--   2. `grep -rEn "\.from\(['\"][a-z_]+['\"]\)" src/` returns ZERO matches —
--      no frontend code (admin or portal) ever queries a table directly via
--      supabase-js with the anon/authenticated key. The frontend clients
--      (src/lib/supabase.ts, src/portal/lib/supabase-portal.ts) are used
--      only for auth and, in one documented case, storage.
--
-- So there is no legitimate anon/authenticated caller to write a policy
-- for on any of these 17 tables today — enabling RLS with no policy blocks
-- the anon-key-via-PostgREST exposure completely, with no code path that
-- can regress. If a future feature needs direct client-side access to one
-- of these tables, that access should be added as its own new, reviewable
-- migration, not a reason to leave the other 16 unprotected in the meantime.
ALTER TABLE properties            ENABLE ROW LEVEL SECURITY;
ALTER TABLE units                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants               ENABLE ROW LEVEL SECURITY;
ALTER TABLE leases                ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses              ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets               ENABLE ROW LEVEL SECURITY;
ALTER TABLE renewals              ENABLE ROW LEVEL SECURITY;
ALTER TABLE broker_commissions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE cam_reconciliations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE correspondence_log    ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entry_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE lease_move_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sent_notifications    ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_sales_reports  ENABLE ROW LEVEL SECURITY;
ALTER TABLE utility_meters        ENABLE ROW LEVEL SECURITY;
ALTER TABLE utility_readings      ENABLE ROW LEVEL SECURITY;
