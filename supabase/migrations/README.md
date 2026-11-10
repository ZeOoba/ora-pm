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

## Testing a migration on real Postgres before applying it

`tests/db/real-postgres-migrations.test.ts` replays every file here on real PostgreSQL 17 (PGlite,
in-process, runs in `npm test`) and re-applies every migration from 0020 on. It covers what the
pg-mem tests skip: DO blocks, extensions, EXCLUDE constraints, plpgsql, views. Supabase branching is
not available on this project's plan, so this test is the real-Postgres gate; keep new migrations
re-runnable (IF NOT EXISTS, conname-guarded DO blocks, DROP IF EXISTS + ADD for constraints).

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

## Migration history log

| File | Item | What it does | Pre-flight before applying to prod |
|------|------|--------------|-----------------------------------|
| `0011_appsec_idempotency_and_scale.sql` | OI-034/035/039/046 | `payments_stripe_pi_uniq` + `payments_autopay_period_uniq` partial unique indexes, `charges.idempotency_key` NOT NULL, money columns to `NUMERIC(12,2)` | Three checks in the file header — duplicate PaymentIntents, backfill collisions, sub-cent precision. Hit `42P16` on first apply (see History above). |
| `0012_view_security_invoker.sql` | OI-079 | `security_invoker = true` on the views so RLS applies through them | None. |
| `0013_enable_rls_remaining_tables.sql` | OI-078/081 | RLS on the remaining tables; `tests/db/rls-inventory-remaining-tables.test.ts` manifest | None; run `scripts/verify-rls.sql` after. |
| `0014_payment_intent_pending_row.sql` | OI-065/223/233 | `payments.client_request_id` + `payments_client_request_id_uniq`, and the `reserve_payment_intent()` plpgsql function: takes a per-lease `pg_advisory_xact_lock`, subtracts in-flight (`pending`/`processing`) ACH from `ar_ledger.balance`, inserts the `'pending'` ledger row BEFORE `server/routes/stripe.ts` calls Stripe. `ar_ledger` itself is untouched; executable by `service_role` only. Ships with a reconciliation query for reservations whose Stripe result was never written back. | None required to apply safely (additive column + function). **Apply BEFORE deploying the matching `server/` change** — the new route fails closed (500, no Stripe call) if the function is missing, the safe direction but still worth minimizing. Adversarially verified against a real PostgreSQL 16.2 instance (advisory-lock concurrency under genuine races), not just pg-mem — see `tests/db/payment-intent-migration-0014.test.ts`. |
| `0015_payments_idempotency_key.sql` | OI-082 | `payments.idempotency_key` TEXT NOT NULL, `legacy:<id>` backfill, `auto:<uuid>` DB default for the stripe.ts/cron.ts insert paths, `payments_idempotency_key_uniq` unique index. Closes the gap 0011 left: its two partial indexes never covered manual check/wire/other rows, so a double-submitted form inserted twice and `ar_ledger` summed both. | **Run the duplicate-manual-payment query in the file header against the LIVE database first** — `SELECT lease_id, payment_date, amount, method, count(*) FROM payments WHERE method IN ('check','wire','other') GROUP BY lease_id, payment_date, amount, method HAVING count(*) > 1;` — and adjudicate every group against deposit records before applying. The migration deliberately does NOT auto-dedupe: two same-day same-amount checks can be legitimate. `tests/db/payments-idempotency-migration-0015.test.ts` applies the real SQL under pg-mem. |
| `0016_charges_void.sql` | OI-278 | Charges become voidable: `charges.voided_at` and `charges.void_reason` (both set or both NULL, enforced by a CHECK) and an `ar_ledger` view that excludes voided charges, so rows are retired without deletion (`charges.amount` has `CHECK (amount >= 0)`, so an offsetting credit is impossible). Application code filters `voided_at IS NULL` wherever it sums or lists charges as money. | **Apply BEFORE deploying the matching app code:** `.is('voided_at', null)` raises `42703` against the old schema. `ci.yml` enforces this with `scripts/check-migrations-applied.mjs`, which blocks the deploy while any local migration is unapplied remotely. |
| `0017_void_oi278_pre_guard_late_fees.sql` | OI-278 | Data half of the above: voids the auto late fees posted before the payments-feed guard. Self-guarding: it RAISEs unless the population matches the ruled census exactly, and returns with a NOTICE when already applied or when there is nothing to void. | Requires 0016. Safe in a combined `supabase db push`; re-census by a human if it raises. |
| `0018_admin_roles.sql` | P1 T12 (G10) | `admin_users` (email kept lower-cased, trimmed and non-empty by two named CHECKs, plus UNIQUE; role CHECK ∈ owner/manager/bookkeeper/viewer; nullable `entity_scope uuid[]`), RLS enabled with NO policies (the 0013 default-deny posture; its RLS manifest pin lives in `tests/db/admin-roles-migration-0018.test.ts`, per 0013's per-migration precedent). Roles DATA MODEL only: `server/middleware/admin-auth.ts` records the role on the request context and nothing enforces it; `ADMIN_EMAILS` stays the sole authority for admin access. No seed rows, so an admin with no row has no role (`adminRole = null`); P3 must seed one row per `ADMIN_EMAILS` entry before enforcing roles. | None required (additive table, no data). The app is safe either side of the apply — a failed `admin_users` lookup (including the table not existing yet) records `adminRole = null` and leaves access unchanged — but `ci.yml`'s migrations-applied gate still blocks the deploy until 0018 is applied. After applying: `scripts/verify-rls.sql` Part 6 (rowsecurity `true`, 0 policies) and Part 6b (all three CHECKs present with the expected definitions — `CREATE TABLE IF NOT EXISTS` would silently skip over a pre-existing table). |
| `0019_sent_notifications_alert_tier.sql` | OI-321 | `sent_notifications.alert_tier` (CHECK ∈ overdue/urgent/warning/notice) + `alert_date`, tagged together or not at all. Replaces 0003's UNIQUE(type, reference, recipient) with a unique key per (tier, date), plus a partial unique index that keeps legacy untagged rows one per reference. Backfills each legacy `critical_date_alert` row still in `critical_dates` with its date and the tier that date had when the alert was SENT (from `sent_at`), so nothing delivered is re-sent and every escalation since fires once. | Apply BEFORE the Worker that writes alerts only on `/critical-dates-alerts/ack`. The old Worker keeps working against it unchanged. Install the ack-aware `ping-crons.ps1` before that Worker deploys; until then the new Worker records nothing and re-sends the same digest every week. The DROP fails loudly if 0003's constraint is not named as Postgres names it. |
| `0020_lease_abstraction.sql` | Lease abstraction plan, Phase 1 (`docs/plans/2026-11-10-lease-abstraction-auto-billing-plan.md`) | Schema only: `lease_abstracts` (immutable extraction snapshots, draft/approved/superseded/discarded, one approved original-lease abstract per lease), `lease_rent_schedule`, `lease_escalation_rules`, `lease_concessions`, `lease_recurring_charges`, `lease_provisions`, `lease_critical_dates`, plus nullable party/notice columns on `tenants`. Rule rows cite their abstract via composite FK `(abstract_id, lease_id)` (own lease only); rule tables carry `superseded_at`. Installs `btree_gist` for five `EXCLUDE USING gist` no-overlap guards on active rows (added in a conname-guarded DO block, which pg-mem cannot run). RLS on all seven, no policies (0013/0018 posture). Nothing reads these tables yet; billing is unchanged until Phase 2. | None required (additive, no data). **Apply the file twice to a Supabase branch/local stack first** (proves the gist guards build and re-run is clean; no test covers that). After applying: `scripts/verify-rls.sql` Part 7 (seven rows, `true`, 0 policies) and Part 7b (five exclusion constraints present, each with `superseded_at IS NULL`). |

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
