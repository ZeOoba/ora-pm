import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

// ── OI-048: what actually enforces tenant isolation on this API ────────────
//
// This client is created with SUPABASE_SERVICE_ROLE_KEY, which bypasses
// Postgres Row Level Security entirely. Every query issued through it —
// from every route in server/routes/**, for every request this Worker ever
// handles — runs with superuser-equivalent table access. The `auth.uid()`
// RLS policies defined in supabase/migrations/0004_views_and_rls.sql and
// supabase/migrations/0008_storage_rls.sql have NO effect on any request
// that goes through this API. They cannot, because `auth.uid()` resolves
// from a Postgres session claim that a service-role connection never sets.
//
// Those RLS policies are not dead code and should not be removed: they are
// defense-in-depth for DIRECT client access to Postgres/PostgREST/Storage,
// bypassing this API entirely.
//
// The table-level policies (0004) currently have no known live caller: as of
// this task, no `supabase-js` client in src/** calls `.from(<table>)`
// directly (grep confirms it — admin and portal frontends only use
// `supabase.auth.*` and, in one case, `supabase.storage.*`). If a direct
// PostgREST client is added later, those policies are what stops it from
// reading another tenant's rows — until then they're inert-but-correct.
//
// The storage-level policies (0008) are NOT hypothetical: src/portal/pages/
// PortalInsurance.tsx uploads COI files with `portalSupabase.storage
// .from('insurance-certs').upload(...)` — a direct Supabase Storage call
// using the anon key + the tenant's own JWT, bypassing this API. RLS is the
// only thing that can scope that upload to the caller's own folder.
// FINDING (not fixed here — out of scope, report only): that upload path is
// built from `session.user.id` (the auth.users id, i.e. `tenants.auth_user_id`),
// but `tenant_upload_insurance`'s WITH CHECK matches the folder against
// `t.id` (the tenants table's own primary key) — see
// supabase/migrations/0008_storage_rls.sql:14. Those are different UUIDs
// (tenants.id is a separate gen_random_uuid(), not auth_user_id — see
// supabase/migrations/0001_core_entities.sql:31,36). Whether this means
// every real upload through this path currently fails RLS, or the policy
// was never actually applied to prod (see the note on 0008 below) and so
// isn't being checked at all, is unverified from the repo alone — resolve
// it as part of the manual scripts/verify-rls.sql check, not by guessing
// here.
//
// The PRIMARY, currently-load-bearing tenant-isolation control for
// everything that goes through this API (which is everything except that one
// direct storage upload above) is the
// per-route guard pattern in server/routes/portal.ts and
// server/routes/stripe.ts: every handler resolves the caller's own tenant
// row via `.eq('auth_user_id', <jwt-derived userId>)` BEFORE issuing any
// other query, and every subsequent query is scoped off that resolved
// tenant/lease id rather than trusting a client-supplied one. That pattern —
// not RLS — is what prevents one tenant from reading or writing another
// tenant's data through this API. It is verified by a source-scan tripwire
// in tests/routes/portal-scoping.test.ts, and the RLS policy/table claim set
// migrations 0004/0008 make is locked down by tests/db/rls-inventory.test.ts
// and independently checkable against a live database with
// scripts/verify-rls.sql.
//
// See supabase/migrations/README.md for the same explanation aimed at
// someone reading the migrations in isolation, without this file open.

// Module-level singleton (safe in Workers — each request gets a fresh isolate in production)
let _client: SupabaseClient | null = null

export function getDb(env: { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }): SupabaseClient {
  if (!_client) {
    _client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })
  }
  return _client
}

// Same client, more honest name: makes the service-role-bypasses-RLS fact
// legible at every call site without a 30-call-site rename in one task.
// `getDb` above keeps working — prefer `getServiceDb` in new code.
export const getServiceDb = getDb
