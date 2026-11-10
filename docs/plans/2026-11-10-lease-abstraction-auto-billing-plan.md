# Lease upload → full abstraction → automatic billing — plan (2026-11-10)

Lane **L3 /build** (multi-phase; financial-code phases carry the mandatory REFUTE pass). Pulls the roadmap's
P7 items "rent-step engine" and "lease abstraction v2" forward, ahead of the P3 GL — neither depends on it.

**Goal.** Gabriel uploads a lease (and later its amendments). The app abstracts every economically or
operationally material term, he reviews and approves it once, and from then on: the tenant/lease record is
correct, monthly charges follow the lease's own rent schedule (steps, abatements, waivers, CAM changes),
statements reflect it, and tenant-specific rights/rules sit in one structured notes section with critical-date alerts.

---

## 1. Where ora-pm stands (verified in code at `cb32cc8`)

| Capability | Today | Gap |
|---|---|---|
| Upload + extract | `POST /api/intake/lease` (`server/routes/intake.ts`) → `extractLease` (`server/lib/lease-extract.ts`). Confidentiality scan pre-egress, per-page text-layer gate, rate limit 10/day, text-only egress. | Extracts **9 fields** only. Tenant + unit must be pre-selected (no tenant auto-create). Scanned/image PDFs are rejected. `max_tokens: 1024`. PDF is not stored. |
| Review | `LeaseIntake.tsx` → `LeaseForm` with confidence shading | No source citations (page/quote), no review of schedules/clauses, no "approve" record. |
| Lease record | `leases`: one flat `base_rent_monthly`, `cam_estimate_monthly`, `options JSONB`, `percentage_rent_terms JSONB`, free-text `notes` | No rent schedule, no abatements/waivers, no structured provisions, no critical dates beyond `end_date`. |
| Billing | `buildMonthlyCharges` (`server/lib/billing.ts`) bills `base_rent_monthly` + `cam_estimate_monthly`, prorates, idempotency key `auto:<lease>:<period>:<type>`. `POST /api/cron/monthly-billing` also creates **autopay ACH debits**. | Rent never steps; a waiver has to be a manual void. **monthly-billing is not wired to any trigger** (`wrangler.toml`; `ping-crons.ps1` doesn't call it). |
| Statements | `server/lib/statement.ts` from `ar_ledger`; batch + Outlook draft staging (PR #59) | Admin-triggered. No credit lines (`charges.amount >= 0`; no credit table). |
| Amendments | `lease_amendments(changes JSONB)` exists, never applied to billing | No chaining. |
| Critical dates | `/api/cron/critical-dates-alerts` | Keyed to lease end only. |

## 2. Target data model (migration `0020_lease_abstraction.sql`)

All new tables: RLS enabled with **no policies** (default-deny, service role only — the 0013/0018 posture). Child rows `ON DELETE CASCADE` from `leases`; `lease_abstracts` is `RESTRICT` (audit trail). **As built in 0020 (after the adversarial pass):** every rule row cites its abstract through a composite FK `(abstract_id, lease_id)` so it can only cite its own lease's abstract; rule tables carry `superseded_at` and all five gist no-overlap guards cover active rows only; escalation rules have `anniversary_basis` and their own overlap guard; CPI floor/cap are fractions < 1. The approve RPC (Phase 4) owns what a CHECK cannot: only approved abstracts cited, amendment rows cite amendment abstracts, active schedule rows cover the term without gaps. **CAM single source (Phase 2 decision):** once a lease has an active `cam_estimate` recurring row, billing reads that and ignores `leases.cam_estimate_monthly`; never both.

| Table | Purpose | Key columns |
|---|---|---|
| `lease_abstracts` | One immutable snapshot per extraction run (audit trail) | `lease_id NULL` (null until approved), `document_id`, `model`, `raw_fields JSONB`, `citations JSONB` (field → page + quote), `confidence JSONB`, `status` (`draft`/`approved`/`superseded`), `approved_by`, `approved_at` |
| `lease_rent_schedule` | The billing source of truth | `lease_id`, `effective_start`, `effective_end`, `base_rent_monthly`, `rent_psf_annual NULL`, `source` (`abstract`/`amendment`/`manual`), `abstract_id`, `EXCLUDE USING gist (lease_id WITH =, daterange(effective_start, effective_end, '[]') WITH &&)` — no overlapping steps |
| `lease_escalation_rules` | Formula escalations that generate schedule rows | `kind` (`fixed_pct`/`fixed_amount`/`cpi`), `value`, `cadence_months`, `anniversary_basis` (`commencement`/`calendar`), `cpi_floor/cap` — **CPI rows never auto-post; they create a review task** (no index source of record wired yet) |
| `lease_concessions` | Abatements / waivers / free rent / discounts | `charge_type` (`rent`/`cam_estimate`/`all`), `period_start`, `period_end`, `kind` (`full_waiver`/`pct`/`fixed_amount`), `value`, `reason`, `clawback_on_default BOOL` |
| `lease_recurring_charges` | CAM estimate, tax/insurance escrow, utilities, parking, storage — each with its own effective dates | `type` (existing `charges.type` enum), `amount_monthly`, `effective_start/end` |
| `lease_provisions` | The "clear notes section": structured tenant rights/rules | `category` (`renewal_option`/`expansion`/`rofr_rofo`/`termination`/`exclusive_use`/`permitted_use`/`signage`/`parking`/`assignment_sublet`/`insurance_req`/`maintenance_split`/`hvac`/`holdover`/`late_fee`/`guaranty`/`relocation`/`other`), `summary`, `verbatim_excerpt`, `page_ref`, `notice_deadline DATE NULL`, `exercise_window JSONB NULL` |
| `lease_critical_dates` | Everything that should alert | `date`, `kind` (option notice, rent step, abatement end, insurance cert, CAM recon due, expiration), `provision_id NULL`, `alert_tiers` |
| `tenants` (alter) | Auto-populated from lease | add `legal_name`, `dba`, `notice_address`, `billing_address`, `guarantor_name`, `entity_type`, `state_of_formation` |

`leases.base_rent_monthly` / `cam_estimate_monthly` stay (UI and portal read them) but become **derived**: a
nightly-safe function `current_rent(lease_id, as_of)` + a trigger/RPC keeps them equal to the active schedule row,
so nothing that reads them today breaks. Charges get a nullable `schedule_id` / `concession_id` for traceability.

**Waivers on statements.** Two options; recommendation is **(A)**:
- (A) Bill the net amount and add a `memo` line on the charge (`Rent – March 2027 (abated 50%, Lease §4.3)`). No schema change to `charges`/`ar_ledger`, statement shows the waiver explicitly. 
- (B) Add a `credits` table + `ar_ledger` change. Cleaner GAAP, but touches the ledger view, statements and Stripe outstanding-balance cap — defer to the P3 GL.

## 3. Extraction v2 (`server/lib/lease-extract.ts` → `lease-abstract.ts`)

- **Field set** aligned with the ORA 33-field abstract used by `lease-abstraction-pipeline` (so rent-roll, estoppel and
  the `lease-abstract-verifier` agent share one vocabulary): parties (legal name, DBA, guarantor, notice addresses),
  premises (suite, RSF, pro-rata share), dates (execution, commencement, rent commencement, expiration),
  rent schedule (array of `{start, end, monthly, psf}`), escalation rule, concessions array, recurring charges array,
  CAM/tax/insurance structure (NNN / base year / expense stop / caps / gross-up / admin fee), security deposit + LOC,
  late fee + grace, holdover %, options array, provisions array, insurance requirements.
- **Citations required**: every field returns `{value, page, quote}`; server verifies `quote` actually occurs in the
  scanned text of that page (normalized whitespace) and drops confidence to 0 + flags if it doesn't — hallucination guard.
- **Deterministic cross-checks** (pure, unit-tested, no LLM): schedule rows contiguous and inside the term;
  step % matches the stated escalation rule within $1; `monthly × 12 / RSF` ≈ stated $/SF; abatement windows inside term;
  option notice dates computed from expiration − notice period. Failures → blocking review flags, never silent fixes.
- **Long leases**: two-pass — pass 1 locates sections (rent, CAM, options, …) by page; pass 2 extracts with only those
  pages. `max_tokens` raised to 8k. Model from `server/lib/models.ts` (bump `ANTHROPIC_MODEL` to `claude-opus-5-5` +
  allowlist; run `npm run eval:lease-intake-model` before/after).
- **Eval set**: extend `evals/lease-intake-model-eval/fixtures.ts` with 6–8 real-shaped synthetic leases (NNN with
  3% bumps, MG with base-year, free-rent + 50% abatement, CPI with floor/cap, renewal + ROFR, amendment changing rent).
  Gate: ≥ 98% exact on money/date fields, 100% on schedule row count.

**Scanned PDFs (open decision — see §7).** Current gate rejects them by design (confidentiality scan needs text).
Many legacy leases are scans, so this caps coverage.

## 4. Flow (UI + API)

1. **Upload** `/leases/intake`: drop PDF; tenant/unit selection becomes *optional* — extraction proposes a match
   (fuzzy on legal name/DBA + suite) or "create new tenant". PDF stored in Supabase Storage (`lease_documents`,
   existing bucket + 0008 RLS) **before** extraction so the abstract links to the exact file hash.
2. **Extract** → `lease_abstracts` row (`draft`). Async-safe: the route returns the abstract id; UI polls (Workers
   30 s CPU limit is wall-time-safe because the work is a fetch, but two-pass + 8k tokens can exceed the client's patience).
3. **Review screen** (new `AbstractReview.tsx`): three columns — field / value (editable) / source quote with page jump in
   an embedded PDF viewer. Sections: Tenant · Premises · Term · **Rent schedule (editable grid, preview of the next 24
   charges)** · Concessions · Recurring charges · Recoveries · Provisions · Critical dates. Low-confidence and
   cross-check-failed fields block **Approve** until touched.
4. **Approve** (single transaction RPC `approve_lease_abstract`): upsert tenant → insert/update lease → write schedule,
   concessions, recurring charges, provisions, critical dates → mark abstract `approved`, prior one `superseded`.
   Idempotent on `abstract_id`.
5. **Amendment upload**: same pipeline with `type=amendment` and a target lease; extractor returns a **diff**
   (changed rows only); approval end-dates superseded schedule rows and inserts new ones; never mutates history
   already billed (`period_start < today` rows are locked; changes there produce an explicit adjustment charge for review).

## 5. Billing engine changes (`server/lib/billing.ts`, `server/routes/cron.ts`) — REFUTE-gated

- `buildMonthlyCharges` takes `schedule[]`, `recurring[]`, `concessions[]` instead of two scalars. Per period:
  rent = Σ over schedule rows intersecting the month, prorated by **days of that row in the month** (handles a mid-month
  step and mid-month start/end with the same math already used); then apply concessions; then recurring charges the same way.
- Idempotency key unchanged in shape (`auto:<lease>:<period>:<type>`) so re-runs and the existing void guard still work;
  multiple recurring lines of the same `type` get a `:<recurring_id>` suffix.
- Fallback: a lease with **no schedule rows** bills exactly as today (flat fields) — zero behaviour change for the
  ~200 existing leases until each is re-abstracted or back-filled (one-off script: one schedule row = current rent, start→end).
- **Autopay**: the cron's debit amount follows the new charges automatically. Add a guard: if a lease's rent
  changed vs. the prior month by > 15% (not explained by an approved step/concession), skip autopay for that lease and
  surface it — never debit a surprise amount.
- **Wire the trigger**: add `monthly-billing` to `ping-crons.ps1` (1st, 06:00 ET), then statements batch on the 2nd
  stages Outlook drafts as today. Sending stays a confirmed step (Invariant 1 — tenant mail is external).
- Add `server/lib/billing.ts`, `server/lib/lease-abstract.ts` (money fields), `server/lib/rent-schedule.ts` and the
  approve RPC migration to `FINANCIAL_SOURCE_PATHS`.

### 5a. Phase 7 hard requirements (from the Phase 2 REFUTE pass, 2026-11-10)

Phase 2 ships the engine with `cron.ts` unchanged. Before `cron.ts` passes `schedule`:
1. **Surface `BillingOutput.exception`** into `leaseExceptions` / `errorMessages`; a schedule exception means no charges AND no autopay debit for that lease, reported, never silent.
2. **Lease edits route through the schedule.** Once a lease has rows, `leases.base_rent_monthly` no longer bills. The lease form must edit schedule rows (or be read-only for scheduled leases), and a renewal that extends `end_date` must add schedule rows in the same transaction, or billing stops with `schedule_gap`. Keep `leases.base_rent_monthly` in sync for the 0004 views (or move the views to the schedule).
3. **Superseded-only schedules fail closed** (`schedule_missing_rent`), already built in Phase 2 — the approve RPC must never leave a lease in that state.
4. **'other' line keys change on supersede** (`other:<row id>`): re-abstracting mid-month then re-running cron would post a second escrow. Key 'other' lines on a stable discriminator (e.g. normalized description) or block re-billing a period that already has an 'other' charge for that lease.
5. **NUMERIC as string/null:** coerce the cron select's numerics the same way legacy does before calling the engine, or a stray null blocks rent with `invalid_row`.
6. **`'all'` + `fixed_amount` is rejected by the engine** (`invalid_row`): it has no defined rent/CAM split. Extraction/approval (Phases 3–4) must split such a waiver into one fixed concession per charge class; consider a matching 0020-follow-up CHECK.
7. Confirm the hosted PostgREST `max_rows` ≥ 1000 (`fetchAllPages` assumption) before the backfill runs.

## 6. Phases (each a PR; TDD; done bar per Engineering OS)

| # | PR | Contents | Size | Gate |
|---|---|---|---|---|
| 1 | Schema | `0020` tables + RLS + gist exclusion + `current_rent()`; pg-migration tests (`tests/db/`) | S | migration tests, RLS inventory test updated |
| 2 | Rent-schedule engine | `rent-schedule.ts` (expand escalation rules → rows, apply concessions, per-day proration) + `billing.ts` refactor + backfill script; property-based tests (sum of prorated months over a year = Σ schedule) | M | **REFUTE (Opus 5.5)**, `check:refute --strict` |
| 3 | Extraction v2 | new tool schema, citations + quote verification, cross-checks, two-pass, eval fixtures | M | eval ≥ thresholds; confidentiality tests still green |
| 4 | Review + approve UI | `AbstractReview.tsx`, PDF viewer, schedule grid w/ 24-month charge preview, approve RPC, tenant auto-match/create | M | Playwright-less: vitest component tests + manual run on 3 real leases |
| 5 | Provisions & critical dates | Lease Detail "Rights & Rules" tab (grouped by category, verbatim excerpt + page link), critical-dates cron extended to `lease_critical_dates` | S | |
| 6 | Amendments | diff extraction, supersede logic, locked-history adjustment charges | M | **REFUTE** |
| 7 | Automation | wire monthly-billing trigger, autopay variance guard, statement memo lines for concessions, portal "My Lease" shows schedule + provisions | S | **REFUTE** on cron change; one dry-run month (`?dryRun=1` returning charges without insert) compared to hand calc for all leases before first live run |

Phases 2 and 3 are independent and can run in parallel sessions; 4 needs both.

## 7. Open decisions

1. **Scanned leases.** (Rec.) OCR in-browser/Worker before the confidentiality scan (e.g. tesseract.js WASM client-side),
   so the scan still sees the text and what leaves is still only scanned text — keeps the REFUTE C1b property.
   Alternative: send page images to Claude vision — better accuracy on tables, but breaks "what leaves = what was scanned";
   acceptable only if Gabriel accepts that tradeoff given no confidential deals are active.
2. **Waiver representation**: (A) net billing + memo line (rec.) vs (B) credits table now.
3. **CPI escalations**: review task each anniversary (rec.) vs wiring a BLS CPI-U fetch.
4. **Backfill existing ~200 leases**: re-abstract from SharePoint lease PDFs in batches of 10/day under the current rate
   limit (rec., ~4 weeks), or raise the limit temporarily for a supervised backfill.

## 8. Pre-mortem

1. **Model misreads a rent step → tenant over/under-billed for years.** Mitigation: quote verification, deterministic
   step/PSF cross-checks, mandatory human approve, 24-month charge preview at approval, `lease-abstract-verifier`
   agent pass on the first 20 leases, autopay variance guard.
2. **Re-abstraction or amendment rewrites already-billed periods.** Mitigation: history lock on `period_start < current
   month`; changes there only create reviewable adjustment charges; gist exclusion stops overlapping schedule rows.
3. **Billing refactor silently changes amounts for existing leases.** Mitigation: no-schedule fallback is the current
   code path verbatim; dry-run diff of every active lease for next month must be $0 before merge.
4. **Confidential document egress widened by bigger prompts / OCR.** Mitigation: OCR happens before the scan; scan logic
   untouched; existing intake confidentiality tests run in CI unchanged.

## 9. Load

~200 leases, ~1 upload/day, billing monthly → negligible RPS. Extraction: ~40–80k input tokens per long lease × 2 passes;
cost dominated by the backfill (≈200 leases once). Billing cron reads schedule/concession/recurring rows keyset-paged
alongside leases (≈ +3 queries per 100-lease chunk) — well under the Workers subrequest cap.
