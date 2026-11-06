-- P1 T12 (roadmap gap G10): admin roles DATA MODEL — recorded, NOT enforced.
--
-- Today admin access is one flat tier: server/middleware/admin-auth.ts admits
-- an authenticated user whose email is on the ADMIN_EMAILS allowlist and who is
-- not a tenant (OI-036). Later phases need manager / bookkeeper / viewer tiers
-- and per-entity (LLC) scoping — roadmap P3, "roles enforced". This migration
-- lands only the table those phases will read, so the model is not retrofitted.
--
-- What this table does NOT do:
--   * It grants nothing. ADMIN_EMAILS stays the SOLE authority for admin
--     access. The middleware reads this table only AFTER the allowlist and
--     tenant-exclusion checks pass, so a row for a non-allowlisted email is
--     never even read.
--   * Nothing enforces a role in P1. The middleware only records it on the
--     request context (adminRole / adminEntityScope / adminRoleSource); no
--     route reads it yet.
--   * No seed rows. An allowlisted admin with NO row here is recorded as
--     adminRole = null (adminRoleSource = 'none'): no role at all. A FAILED
--     lookup (an error, including this table not existing yet; no answer
--     within the middleware's timeout; or a stored row that does not
--     validate) is recorded as adminRole = null (adminRoleSource = 'error').
--     Either way the request continues and access is unchanged in P1.
--     Before any role is enforced (P3), seed one row per ADMIN_EMAILS entry;
--     enforcement must treat a null or unset adminRole as deny.
--
-- Columns:
--   email         Stored lower-cased, trimmed and non-empty (CHECKs). The
--                 middleware looks rows up by the exact lower-cased auth
--                 email, so a mixed-case, padded or blank row could never
--                 match anyone. One row per email (UNIQUE).
--   role          owner | manager | bookkeeper | viewer (CHECK). Mirrored by
--                 ADMIN_ROLES in server/lib/admin-roles.ts — change both in
--                 the same PR (tests/lib/admin-roles.test.ts fails on drift).
--   entity_scope  uuid[] of the entities (LLCs) the admin is scoped to; NULL =
--                 no scope recorded. Meaning is defined when enforcement lands
--                 (P3). No foreign key: Postgres cannot reference array
--                 elements, and the entities table does not exist yet.
--
-- RLS: enabled with NO policies — default-deny for the anon and authenticated
-- roles (PostgREST via the public anon key, which ships in the client bundle),
-- exactly the 0013_enable_rls_remaining_tables.sql pattern. The API reads this
-- table only through the service-role client (server/db/client.ts header),
-- which bypasses RLS. A role table reachable with the anon key would let
-- anyone enumerate the admin roster or write themselves a row. If a client
-- ever needs direct access, add a scoped policy in its own reviewed
-- migration.
--
-- ORDERING: purely additive (one new table). The middleware tolerates this
-- table being absent — the failed lookup sets adminRole = null, logs a
-- warning, and leaves access unchanged — so the app is safe either side of
-- the apply. ci.yml's migrations-applied gate (scripts/check-migrations-
-- applied.mjs) still blocks the deploy until this is applied to production.
--
-- RE-RUNNABLE: CREATE TABLE IF NOT EXISTS; ENABLE ROW LEVEL SECURITY and
-- COMMENT ON are idempotent, so a Dashboard paste that failed midway can be
-- re-pasted whole.

CREATE TABLE IF NOT EXISTS admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE
    CONSTRAINT admin_users_email_lowercase CHECK (email = lower(email))
    CONSTRAINT admin_users_email_trimmed_nonempty CHECK (email = btrim(email) AND email <> ''),
  role TEXT NOT NULL
    CONSTRAINT admin_users_role_check CHECK (role IN ('owner', 'manager', 'bookkeeper', 'viewer')),
  entity_scope UUID[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE admin_users IS 'Admin role data model (P1 T12). Recorded on the request context by server/middleware/admin-auth.ts, NOT enforced. ADMIN_EMAILS remains the sole authority for admin access; a row here grants nothing.';
COMMENT ON COLUMN admin_users.email IS 'Lower-cased, trimmed, non-empty auth email (CHECKs); one row per admin.';
COMMENT ON COLUMN admin_users.role IS 'owner | manager | bookkeeper | viewer. Mirrors ADMIN_ROLES in server/lib/admin-roles.ts.';
COMMENT ON COLUMN admin_users.entity_scope IS 'Entity (LLC) ids the admin is scoped to; NULL = no scope recorded. Semantics defined when roles are enforced (P3).';

-- POST-APPLY CHECK (run against the live database; scripts/verify-rls.sql Part 6):
--   SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'admin_users';  -- expect true
--   SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'admin_users';   -- expect 0
--   Part 6b: all three CHECKs above present in pg_constraint with the expected
--   definitions. CREATE TABLE IF NOT EXISTS skips silently over a table that
--   already existed, so this is the only proof the constraints are there.

-- ---------------------------------------------------------------------------
-- Rollback (reference). Safe while no code enforces a role: the middleware
-- treats the missing table as a failed lookup (adminRole = null) and access
-- is unchanged. Rows added since the apply are lost — export them first.
--   DROP TABLE IF EXISTS admin_users;
