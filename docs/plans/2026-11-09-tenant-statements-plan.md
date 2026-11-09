# Tenant account statements — plan (2026-11-09)

Lane L3 /build. Scope agreed with Gabriel 2026-11-09 (all four recommended options):

| Decision | Ruling |
|---|---|
| Delivery | Stage Outlook **drafts** from a downloaded packet via a local COM script. Never `.Send()`. Sending happens only through `~/.claude/scheduled-tasks/_shared/send-parked-drafts.ps1 -EntryId … -Confirm SEND` after Gabriel's in-turn yes. |
| Grain | One statement per **lease** (one signing LLC, one `ar_ledger` row). |
| Credits / voids / ACH | Match `ar_ledger` exactly: no credits line, voided charges omitted, `pending`/`processing` ACH shown as a memo line that does not reduce the balance. |
| Portal | Not in this PR. |

## Capability audit (code, not docs)

| Need | Owner today |
|---|---|
| Counted-payment rule | `ar_ledger` view, `supabase/migrations/0016_charges_void.sql` (`check/wire/other` always; `ach_stripe` only when `stripe_status='succeeded'`) |
| Voided-charge exclusion | `charges.voided_at IS NULL` (0016) |
| Aging buckets | `allocateOldestFirst` in `server/lib/ar-aging.ts` (OI-234 oldest-first) |
| Snapshot cross-check | `findChargeTotalMismatch` pattern, `server/routes/reports.ts` |
| Paged reads | `fetchAllPages` / `fetchChunked`, `server/lib/postgrest-paging.ts` |
| Signing entity | `properties.entity_llc` (0001) |
| Recipient | `tenants.contact_email` / `contact_name` (0001) |
| Statement / opening balance / period activity | verified absent: `grep -rniE "statement" server src` → only unrelated hits |
| Credits | verified absent: `charges.amount CHECK (>= 0)`, no credit table |
| Draft staging | absent in ora-pm; `send-via-outlook.ps1` refuses attachment + external recipient (exit 5) and always sends, so it is NOT used here |

No migration: nothing new is persisted.

## Design

- `server/lib/statement.ts` (pure, integer cents): `classifyPayment`, `buildStatement`.
  - opening = Σ charges with `charge_date < start` − Σ counted payments with `payment_date < start`
  - period activity = charges with `charge_date ∈ [start, end]`, counted payments with `payment_date ∈ [start, end]`, merged by date (charges before payments on the same day), running balance
  - closing = opening + period charges − period payments (= balance as of `end`)
  - pending memo = `ach_stripe` with `stripe_status ∈ {pending, processing}` and `payment_date ≤ end`
  - aging = `allocateOldestFirst(closing, charges with charge_date ≤ end, asOf = end)`
  - payment status is today's status (no status history exists), stated on the statement
- `server/lib/statement-render.ts`: HTML email body + subject. Every interpolated string escaped. Signed with the property LLC; never the firm name.
- `server/routes/statements.ts` (admin-gated under `/api/*`):
  - `GET /api/statements/lease/:leaseId?start&end`
  - `GET /api/statements/batch?start&end`: every lease with closing > 0, each with `blockers` (`missing_entity_llc`, `missing_contact_email`, `invalid_contact_email`)
  - `GET /api/statements/packet?start&end`: drafts for unblocked statements + `skipped` (lease id + reason only)
  - Fail closed: Σ fetched non-voided charges must equal `ar_ledger.total_charged` and Σ counted payments must equal `total_paid` per lease; retry once, then 500.
- UI: `/statements` batch page (run + download packet); `/statements/lease/:leaseId` printable statement (browser print → PDF); "Statement" link per lease on TenantDetail.
- `scripts/stage-statement-drafts.ps1 -Packet <file> [-DryRun]`: validates, creates drafts with `MailItem.Save()`, skips an existing draft with the same To + Subject. Output carries lease ids and EntryIDs only (no names, emails, amounts).
- REFUTE gate: add `server/lib/statement.ts`, `server/lib/statement-render.ts`, `server/routes/statements.ts` to `FINANCIAL_SOURCE_PATHS`.

## Load / bottleneck

~140 tenants, ~200 leases, admin-triggered roughly monthly → peak ≈ 0.01 RPS; nothing bottlenecks on rate. Batch reads: 1–2 `ar_ledger` pages, properties (1), tenants (2 chunks), charges and payments keyset-paged per 100-lease chunk. At ~200 leases × ~24 charges + ~24 payments/yr ≈ 9.6k rows/yr ≈ 10 pages/yr each side. First limit: the Workers subrequest cap (50 free / 1000 paid) at ~(50 − 6)/2 ≈ 22 pages per side ≈ 2+ years of history on the free plan, ~50 years on paid. Mitigation if needed: bound reads by `charge_date ≤ end` (already) and add a `lease_id`-filtered batch.

## Pre-mortem

1. Ledger/charges/payments drift between reads → mis-stated balance. Detected by the per-lease total_charged/total_paid cross-check (retry once, then 500).
2. Wrong or missing signing entity / recipient → statement sent under the wrong name. Blocked: `missing_entity_llc` / missing or malformed email never reaches the packet; render test asserts the firm name never appears.
3. Re-running the stager duplicates drafts → tenant gets two statements. Script skips a draft with identical To + Subject; sending is a separate, confirmed step.

## Tasks (TDD)

1. `statement.ts` engine + `tests/lib/statement.test.ts`
2. `statement-render.ts` + `tests/lib/statement-render.test.ts`
3. `statements.ts` route + `tests/routes/statements.test.ts`; mount in `server/index.ts`
4. Refute-gate path set + pinned count
5. UI pages + nav + TenantDetail link + render tests
6. Stager script + `tests/scripts/stage-statement-drafts.test.ts` (dry-run, skipped where no PowerShell)
7. typecheck, lint, full test run, REFUTE pass, PR
