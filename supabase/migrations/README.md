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

## Numbering

Take the next number above the highest on `main` **when you open the PR**, and re-check before merging: parallel sessions can pick the same number (#75 and #76 both took 0024 on 2026-11-10). `npm run check:migrations -- --base=origin/main` (after `git fetch origin main`) fails on a duplicate number, on a new migration numbered at or below `main`'s highest, or on a deleted or renamed migration that `main` already had. CI runs it on every PR and, through `migration-numbers.yml`, on every branch push, because a PR that conflicts with `main` gets no pull-request CI at all. When renumbering, also rename the migration's test file, its README row and any verify script that applies it.

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
| `0021_cam_proportionate_share_base_year.sql` | CAM building-RSF ruling (2026-11-08) | `properties.cam_denominator_rsf` (building/project RSF the lease form names; never derived from summed unit SF), `leases.proportionate_share_pct` (stated share, fraction in (0,1]), `leases.base_year` + `leases.base_year_expense_amount`, and `cam_reconciliations.share_basis` / `recovery_basis` / `basis_warnings`. All NULLable, each with a named CHECK. | None (additive, no data). Apply BEFORE deploying the app: `/cam/calculate` and `/cam/pool` select the new columns and fail closed (500, nothing saved) against the old schema. After applying, enter `cam_denominator_rsf` per property and the stated share / base year per lease from the lease documents, or CAM calculation returns 422 for those leases. |
| `0022_collections_workflow.sql` | B1 collections workflow (#66) | `promises_to_pay` and `ar_disputes` per lease (amount, dates, open/kept/broken or open/resolved status, who and when). RLS on both, no policies. Disputes do not pause late fees (ratified 2026-11-10). | None (additive, no data). Applied to production 2026-11-10 via `db-migrate.yml` (dry run first). |
| `0023_gl_core.sql` | B8 native GL core (#71) | `gl_entities` (per-LLC accounting basis), `gl_accounts`, `gl_periods`, `gl_journal_entries`, `gl_journal_lines` (integer cents) with the ledger's money rules in the database: balanced at commit, immutable entries, exact-mirror reversals, permanent month locks (ended months only, US Central), same-transaction lines, reclassification frozen once used. Write functions `gl_post_entry` / `gl_reverse_entry` / `gl_lock_period` (EXECUTE: service_role only); every `gl_` function pins `search_path = public, pg_temp`; service_role has no TRIGGER/TRUNCATE/REFERENCES/MAINTAIN and cannot UPDATE/DELETE the journal. Five adversarial REFUTE passes; real-Postgres suite `npm run verify:gl-sql` (CI: postgres:17). | None (additive; nothing posts yet). Set `GL_PERIOD_LOCK_EMAILS` before the first month-end lock. Applied to production 2026-11-10 via `db-migrate.yml` (dry run first). |
| `0024_cam_approve_atomic.sql` | PR #72 REFUTE F4 follow-up (atomic CAM approve) | `approve_cam_reconciliation(uuid, numeric, text, date)` plpgsql function: locks the `cam_reconciliations` row `FOR UPDATE`, requires a draft with a `share_basis` and the true-up / basis the caller priced, classifies the charge holding `cam_true_up:<lease>:<year>` (locked; live+equal, absent, else refuse), inserts the charge only for a positive true-up and bills the row, all in one transaction. Returns a typed jsonb outcome. SECURITY INVOKER, `search_path = public`, EXECUTE for `service_role` only. Body runs on real Postgres in `tests/db/cam-approve-atomic-0024.test.ts` (pg-mem skips it). | No schema pre-flight (new function, no data); `SELECT proname FROM pg_proc WHERE proname = 'approve_cam_reconciliation'` returns zero rows on first apply. **Data check, must return zero rows:** `SELECT id, lease_id, period_start, amount FROM charges WHERE type = 'cam_true_up' AND voided_at IS NULL AND idempotency_key IS DISTINCT FROM 'cam_true_up:' || lease_id::text || ':' || extract(year FROM period_start)::int::text;` A row is a live true-up not under the exact key the function uses for its lease/year, so the function cannot see it: approving that lease/year would post a second true-up (or bill a credit while it is live). Resolve each row (void it, or confirm no draft for that lease/year will be approved) before approving CAM for that lease. Apply BEFORE deploying the app: POST `/cam/:id/approve` calls the function unconditionally and fails closed (500, nothing posted) without it. Deploy the app promptly after: until then the OLD route still bills through its two-call path, and POST `/charges` still accepts hand-posted `cam_true_up` charges. |
| `0025_gl_qb_account_type.sql` | B8 slice 1: QuickBooks chart import | `gl_accounts.qb_account_type` (QuickBooks Desktop ACCNTTYPE) with `gl_accounts_qb_type_check`: when set it must agree with `account_type` (BANK/AR/OCASSET/FIXASSET/OASSET = asset; AP/CCARD/OCLIAB/LTLIAB = liability; EQUITY; INC/EXINC = income; COGS/EXP/EXEXP = expense). NULL allowed. | None (additive). Apply BEFORE deploying: the import route writes `qb_account_type`. |
| `0026_cam_recoverable_categories.sql` | CAM rulings 2026-11-10 (lease extraction: partial recovery, annual cap, direct pay) | `leases.recoverable_categories TEXT[]` (subset of `expenses.category`; NULL = every recoverable expense), `leases.cam_annual_cap` + `cam_cap_through`, `leases.cam_reconciled` (NOT NULL DEFAULT true) + `cam_exclusion_reason` (required when false); `cam_reconciliations.recoverable_categories` + `cam_annual_cap_applied`. SQL function `cam_categories_valid(text[])` backs the two category CHECKs (added in a DO block pg-mem skips; tested on PGlite). | None (additive; every existing lease keeps today's behaviour). Apply BEFORE deploying the app: `/cam/calculate`, `/cam/pool` and `/approve`'s recompute select the new columns and fail closed against the old schema. Lease data (categories, the suite 507 cap, the not-reconciled leases) is entered afterwards from the approved staging workbook rows. |
| `0027_gl_opening_balance.sql` | B8 slice 2: opening balances | `gl_entities.ledger_start_date` (first of a month; parallel run 2027-01-01) and `gl_post_opening_balance` (service_role only). DB rules: an `opening_balance` entry is dated `ledger_start_date - 1`; one live opening balance per entity (reverse to correct; the reversal is dated the opening date); no other entry before the start date; the start date is fixed once there are manual entries or a live opening balance; opening-balance lines may use inactive (QB-hidden) accounts. Replaces 0023's `gl_assert_line_insert` only to add that exemption. Real-Postgres suite: `supabase/tests/gl_opening_balance.test.sql`. | None (additive). Apply BEFORE deploying: the opening-balance routes call `gl_post_opening_balance`. Do not lock December 2026 for an LLC until its opening balance ties to QuickBooks (a correction reverses on 2026-12-31). |
| `0028_gl_ar_posting.sql` | B8 slice 3: AR posting (accrual LLCs) | `gl_ar_accounts` (role → chart account per LLC), `gl_ar_tieouts` + `gl_ar_tieout_items` (one-time AR tie-out snapshot; app AR must equal the opening-balance AR to the cent), `gl_ar_postings` (each charge, void, payment and ACH return posts at most once), `payments.status_changed_at`, and `gl_confirm_ar_tieout` / `gl_post_ar_batch` (service_role only). The database builds every entry from the source row and a deferred check verifies it; posted or tied-out charges and payments cannot change amount, date, lease, type or method, or be deleted; a property's, unit's or lease's LLC is fixed once its AR is used. Once the tie-out is confirmed, its opening balance cannot be reversed and the start date, basis and AR/Undeposited Funds accounts are fixed (correct later differences with entries in an open month). Activity dated in a locked month posts on the first day of the next open month. Cash-basis LLCs are refused. Real-Postgres suite: `supabase/tests/gl_ar_posting.test.sql`. | None (additive; new triggers on `charges`, `payments`, `properties` only block changes to posted or tied-out rows). Apply BEFORE deploying: the AR posting routes call both functions. |
| `0029_gl_ar_cash_posting.sql` | B8 slice 4: AR posting (cash-basis LLCs) | `gl_ar_cash_events` (each lease replayed as charge / void / payment / return events, `seq` assigned by the database under the entity lock) and `gl_ar_cash_entries` (the entry an event posted), `gl_ar_cash_alloc` (oldest-first by due date; same date: deposit, rent, CAM, utilities, percentage rent, other, late fees last; the rest is a tenant credit in `prepaid_rent`), `gl_post_ar_cash_batch` (service_role only). Each event posts the change in the lease's allocation, account by account, and a deferred check verifies it; cash cannot enter ahead of a charge live on its date. Replay dates never go backwards within a lease (a backdated payment posts its cash on its own date into prepaid rent, and applies on the replay date); cash fills charges in billing order, so a late-billed charge never takes income already booked. Tie-outs (both bases) are re-verified at commit; for cash, paid pre-start deposits must also tie to the deposits account; every cash-basis role mapping is fixed from the tie-out on. Replaces `gl_confirm_ar_tieout` (cash: tenant credits must equal the prepaid rent opening balance), `gl_ar_held`, `gl_guard_ar_source_change` (a held cash-basis charge's due date is fixed), `gl_guard_ar_account` (`prepaid_rent` fixed from the tie-out), `gl_assert_ar_posting` and `gl_assert_ar_ready`. Real-Postgres suite: `supabase/tests/gl_ar_cash_posting.test.sql`. | None (additive). Apply BEFORE deploying: the AR posting routes call `gl_post_ar_cash_batch` for cash-basis LLCs. |
| `0030_balance_forwards.sql` | Balance forward from QuickBooks: one opening-balance adjustment per lease | `balance_forwards` (signed `amount` = QuickBooks balance − app balance as of `as_of`; at most one live per lease; insert-only, voidable once), `apply_balance_forwards` (recomputes each app balance under a lease lock and refuses one that moved since the preview, a pending ACH on or before the cut-off, a future date, or an LLC already tied out in the ledger) and `void_balance_forward` (service_role only). `ar_ledger` gains `balance_forward` and `balance_forward_as_of` (appended) and its `balance` includes the live balance forward; `total_charged`/`total_paid` are unchanged. While a lease has one, its charges and payments dated on or before `as_of` cannot be inserted, deleted, or change amount, date, lease, void state or method. The ledger's AR tie-out does not count balance forwards yet, so an LLC with one cannot be tied out (and vice versa). Refusals start `bf: ` and reach the admin as written. Real-Postgres suite: `supabase/tests/balance_forwards.test.sql`. | None (additive). Apply BEFORE deploying: Books › Balance forward calls both functions, and statements/aging read the new `ar_ledger` columns. |

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
