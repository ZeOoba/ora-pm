#!/usr/bin/env bash
# Runs supabase/tests/gl_core.test.sql against a REAL, EMPTY Postgres 16+ (CI and production: 17) (pg-mem cannot execute the
# plpgsql functions and triggers that carry the GL money rules). Never point this at production:
# it creates roles and tables.
#
# Usage: GL_TEST_DATABASE_URL=postgres://user@host:port/db scripts/verify-gl-sql.sh
# The database must be empty (a throwaway local cluster). Exits non-zero on the first failure.
set -euo pipefail
: "${GL_TEST_DATABASE_URL:?set GL_TEST_DATABASE_URL to an EMPTY throwaway Postgres database}"
cd "$(dirname "$0")/.."

if [ "$(psql "$GL_TEST_DATABASE_URL" -tAc "select count(*) from pg_tables where schemaname='public'")" != "0" ]; then
  echo "refusing: the target database is not empty" >&2
  exit 1
fi

psql "$GL_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
-- Supabase stubs this migration depends on: the three API roles and a minimal properties table
-- (0023 adds properties.gl_entity_id). Nothing else from earlier migrations is needed.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
CREATE TABLE properties (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT);
-- Minimal app tables 0028 (AR posting) reads: lease → unit → property, charges, payments, with the
-- columns and checks the ledger relies on (amounts in NUMERIC dollars, as in 0002/0016).
CREATE TABLE units (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), property_id UUID NOT NULL REFERENCES properties(id), suite TEXT);
-- tenants + leases.tenant_id + auth.uid(): 0030 (balance forwards) recreates ar_ledger and a tenant-own policy.
CREATE TABLE tenants (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL DEFAULT 'Tenant', auth_user_id UUID);
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE TABLE leases (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), unit_id UUID NOT NULL REFERENCES units(id), tenant_id UUID REFERENCES tenants(id));
CREATE TABLE charges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lease_id UUID NOT NULL REFERENCES leases(id),
  charge_date DATE NOT NULL, due_date DATE NOT NULL DEFAULT CURRENT_DATE,
  type TEXT NOT NULL CHECK (type IN ('rent','cam_estimate','cam_true_up','late_fee','security_deposit','utility_water','utility_gas','utility_electric','utility_other','percentage_rent','other')),
  amount NUMERIC NOT NULL CHECK (amount >= 0), description TEXT, voided_at TIMESTAMPTZ, void_reason TEXT);
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lease_id UUID NOT NULL REFERENCES leases(id),
  payment_date DATE NOT NULL, amount NUMERIC NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('ach_stripe','check','wire','other')), stripe_status TEXT);
-- Supabase's defaults: every new public table is GRANT ALL to the API roles, and service_role
-- bypasses RLS. The adversarial tests run as service_role against exactly those privileges.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER ROLE service_role BYPASSRLS;
SQL

# Apply twice: the migration must be re-runnable.
for m in supabase/migrations/0023_gl_core.sql supabase/migrations/0025_gl_qb_account_type.sql supabase/migrations/0027_gl_opening_balance.sql supabase/migrations/0028_gl_ar_posting.sql supabase/migrations/0029_gl_ar_cash_posting.sql supabase/migrations/0030_balance_forwards.sql; do
  psql "$GL_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$m"
  psql "$GL_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$m"
done
psql "$GL_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f supabase/tests/gl_core.test.sql
# A fresh session, so the triggers have no cached plans when the shadowing attack runs.
psql "$GL_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f supabase/tests/gl_service_role.test.sql
psql "$GL_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f supabase/tests/gl_shadow_functions.test.sql
psql "$GL_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f supabase/tests/gl_opening_balance.test.sql
psql "$GL_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f supabase/tests/gl_ar_posting.test.sql
psql "$GL_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f supabase/tests/gl_ar_cash_posting.test.sql
psql "$GL_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f supabase/tests/balance_forwards.test.sql
echo "verify-gl-sql: all GL SQL checks passed"
