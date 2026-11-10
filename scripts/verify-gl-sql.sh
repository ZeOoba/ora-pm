#!/usr/bin/env bash
# Runs supabase/tests/gl_core.test.sql against a REAL, EMPTY Postgres 15+ (pg-mem cannot execute the
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
SQL

# Apply twice: the migration must be re-runnable.
psql "$GL_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f supabase/migrations/0023_gl_core.sql
psql "$GL_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f supabase/migrations/0023_gl_core.sql
psql "$GL_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f supabase/tests/gl_core.test.sql
echo "verify-gl-sql: all GL SQL checks passed"
