# Migrations — read this before trusting the RLS policies you see here

## The RLS policies in `0004_views_and_rls.sql` and `0008_storage_rls.sql` do not protect this API

`0004_views_and_rls.sql` and `0008_storage_rls.sql` enable Row Level Security
and define `auth.uid()`-scoped policies on the tenant-facing tables and the
`storage.objects` bucket. Reading those files in isolation, it looks like
RLS is the tenant-isolation mechanism for this app. **It isn't, for any
request that goes through the API in `server/`.**

`server/db/client.ts` creates its Supabase client with the
**service-role key** (`SUPABASE_SERVICE_ROLE_KEY`), and the service role
bypasses RLS entirely by design — every table is fully readable/writable
through it, regardless of any policy defined here. Every route in
`server/routes/**` uses that client. So the `auth.uid() = t.auth_user_id`
checks in these policies never evaluate against a real session claim for API
traffic; there is no session claim to check against, because the API
connection isn't authenticated as any particular Supabase Auth user.

**What these policies ARE for:** defense-in-depth for *direct* client access
to Postgres/PostgREST/Storage that bypasses this API entirely.

- The **table policies** in `0004_views_and_rls.sql` currently protect a code
  path that doesn't exist yet: no `supabase-js` client in `src/**` calls
  `.from(<table>)` directly (verified by grep — the admin and portal
  frontends only use `supabase.auth.*`, plus one `supabase.storage.*` call,
  see below). Keep them anyway — they're what would stop cross-tenant reads
  the day a direct PostgREST client is added, and removing them would be a
  regression against that future, not a cleanup.
- The **storage policies** in `0008_storage_rls.sql` are NOT hypothetical:
  `src/portal/pages/PortalInsurance.tsx` uploads COI files with
  `portalSupabase.storage.from('insurance-certs').upload(...)` — a direct
  Supabase Storage call using the anon key + the tenant's own JWT, bypassing
  this API. RLS is the only thing that can scope that upload to the caller's
  own folder.
  **Open finding, not fixed by this task:** that upload path builds the
  storage folder from `session.user.id` (`auth.users.id`, i.e.
  `tenants.auth_user_id`), but `tenant_upload_insurance`'s `WITH CHECK`
  matches the folder against `t.id` — the `tenants` table's own primary key,
  a *different* UUID (`tenants.id` is its own `gen_random_uuid()`, not a copy
  of `auth_user_id` — see `0001_core_entities.sql`). Whether this means every
  real upload through that path currently fails RLS, or the policy was never
  applied to prod at all (see below) and so isn't being checked, can't be
  determined from the repo alone. This needs a human to check — either via
  `scripts/verify-rls.sql` (policy exists?) plus a real upload attempt
  (folder-check passes?), not by guessing from the SQL text.

**What actually enforces tenant isolation today:** the per-route guard
pattern in `server/routes/portal.ts` and `server/routes/stripe.ts`. Every
handler resolves the caller's own tenant row via
`.eq('auth_user_id', <jwt-derived userId>)` before issuing any other query,
and scopes every subsequent query off that resolved id — never off a
client-supplied `tenant_id`/`lease_id` without first checking it belongs to
the resolved tenant. That pattern is what a security review of this app
should look at; the RLS policies below it are not the control in effect.

Full explanation with code references: the comment block at the top of
`server/db/client.ts`.

## How migrations actually get applied to production

**Preferred: the "DB Migrate (manual)" GitHub Actions workflow**
(`.github/workflows/db-migrate.yml`), triggered by hand from the Actions tab.
It runs `supabase db push` for real, which is the only mechanism that writes
a row into `supabase_migrations.schema_migrations` as a side effect of
applying a migration — so using it is what keeps the tracker honest.
Requires two repo secrets (`SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`);
until both are set the workflow fails cleanly at the link step rather than
doing anything partial.

**Fallback: `scripts/prepare-migration-for-dashboard.mjs`.** The Code
sandbox this repo is normally worked from has no `SUPABASE_ACCESS_TOKEN`
configured, so the CLI can't run there — which is exactly why 0008-0010
(below) were applied by pasting raw SQL into the Supabase Dashboard SQL
editor and never got tracked. If the GitHub Actions workflow can't be used
for some reason, run:

    node scripts/prepare-migration-for-dashboard.mjs supabase/migrations/00NN_name.sql

and paste the ENTIRE output — not just the migration body — into the
Dashboard SQL editor as one execution. It wraps the migration and an
idempotent tracking `INSERT` in a single transaction, so applying and
recording happen atomically instead of as two steps a human can forget
between (which is how OI-048/OI-073 happened three times).

**Never** paste a bare migration file into the dashboard directly, and never
hand-write a row into `schema_migrations` except as a one-time backfill
(documented precedent: OI-073, 2026-08-04) — both defeat the point of having
a tracked history at all.

**History:** `0008_storage_rls.sql` (2026-06-05) and `0009`/`0010`
(discovered 2026-08-04, exact application date unknown) were all applied
out-of-band this way, with no tracking row. The gap was invisible until
0011's apply hit a `42P16` conflict against schema the tracker didn't know
about — see OI-048/OI-073/OI-074 in `~/.claude` memory
(`open-items-tracker.md`) for the full incident history and root-cause
writeup.

## Migration history (0011 onward — earlier files predate this log)

- `0011_appsec_idempotency_and_scale.sql` — appsec sweep 2026-08 (OI-034 /
  OI-035 / OI-039 / OI-046): `payments_stripe_pi_uniq` (one row per
  PaymentIntent), `payments.autopay_period` + `payments_autopay_period_uniq`,
  `charges.idempotency_key NOT NULL`, all money columns re-typed
  `NUMERIC(12,2)` with unit comments (ar_ledger dropped/recreated verbatim
  around the re-types). Its apply is what surfaced the untracked 0008-0010
  history above.
- `0012_view_security_invoker.sql` — OI-079: `ar_ledger`, `rent_roll`,
  `critical_dates` set `security_invoker = true` so a direct PostgREST caller
  is bound by the underlying tables' RLS. Additive; no logic change.
- `0013_enable_rls_remaining_tables.sql` — OI-078: `ENABLE ROW LEVEL SECURITY`
  on the 17 tables that had none, deliberately with no policies (default-deny
  for the anon key; the service-role API is unaffected).
- `0014_payment_intent_pending_row.sql` — OI-065 / OI-223 / OI-233 payment-
  intent hardening: `payments.client_request_id` +
  `payments_client_request_id_uniq`, and the `reserve_payment_intent()`
  plpgsql function that takes a per-lease `pg_advisory_xact_lock`, subtracts
  in-flight (`pending`/`processing`) ACH from `ar_ledger.balance`, and inserts
  the `'pending'` ledger row BEFORE `server/routes/stripe.ts` calls Stripe.
  `ar_ledger` itself is untouched. Executable by `service_role` only. Ships
  with a reconciliation query for reservations whose Stripe result was never
  written back. Apply BEFORE deploying the matching `server/` change — the
  new route fails closed (500, no Stripe call) if the function is missing.

## Keeping this claim honest as migrations change

- `tests/db/rls-inventory.test.ts` parses this directory's SQL and asserts
  the extracted `ENABLE ROW LEVEL SECURITY` table list and `CREATE POLICY`
  list match a checked-in manifest. If you add, rename, or drop a policy or
  an RLS-enabled table, update that manifest in the same PR — the test is a
  tripwire against a migration silently changing the claim set this README
  and `scripts/verify-rls.sql` are built on, not busywork to route around.
- `tests/routes/portal-scoping.test.ts` is the companion tripwire on the
  side that actually matters: it source-scans `portal.ts`/`stripe.ts` and
  fails if any handler is added that queries another table before resolving
  `auth_user_id`.
- `scripts/verify-rls.sql` is a manual, read-only script for a human to run
  against the live database (there is no prod DB in the test suite) to
  confirm the policies these migrations claim to create actually exist —
  this matters especially for `0008_storage_rls.sql`, which self-documents
  as applied out-of-band via a one-off Node script rather than the normal
  migration runner, so whether it ever actually ran against a given
  environment is not otherwise verifiable from the repo.
