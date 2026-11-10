# ORA PM redesign: implementation plan

**Status:** IN PROGRESS · 2026-11-10 · baseline `origin/main` @ `cb32cc8`
**Source:** Claude Design handoff "Property management software audit". The primary file is `ORA PM.dc.html`, a single clickable prototype that combines Today, Overview, Property, Tenant, Lease, Rent roll, Renewals, Collections, Books, Tenant portal and Mobile. Everything in the prototype is sample data.
**Owner:** Gabriel Goldberg

## Scoping decisions (2026-11-10)

| # | Decision | Ruling |
|---|---|---|
| R1 | Scope | Every prototype screen gets built, **including the backend it needs**. UI PRs ship first on live data. Backend epics follow as separate PRs. |
| R2 | Navigation | Use the prototype's IA (Today · Portfolio · Leasing · Money · Books). Every pre-redesign page is nested under the closest group, so each route stays one click away. |
| R3 | Home | Today replaces the old Dashboard at `/`. The old Dashboard's portfolio charts move to Portfolio Overview (PR 2). |
| R4 | Delivery | Stacked draft PRs, never merged by the agent. A merge to `main` is a production deploy. |

Rules that apply to every PR: no fabricated figures. A panel whose data does not exist yet is either left out or shown with a "Preview" label. Its backend epic is listed below. Financial-decision code (posting, payment application, GL, Stripe, late fees, CAM) is behind `check:refute` and needs an adversarial REFUTE pass.

## UI PRs (live data, no schema change)

| PR | Branch | Screens | Data sources | Panels deferred to backend epics |
|---|---|---|---|---|
| 1 | `feat/redesign-1-shell-today` | Shell brand, regrouped nav, **Today** at `/` (work queue ranked by what's at stake, vitals strip, AR aging, coming-up dates) | `/reports/ar-aging`, `/reports/rent-roll`, `/reports/critical-dates`, `/reports/financials` | Approve / Close queue kinds (B2, B7, B8), sparklines (B12), close checklist (B7), cash on hand (B8), entity switcher (B4), shared snooze (B2) |
| 2 | `feat/redesign-2-records` | **Portfolio Overview** at `/portfolio` (broadsheet table plus rent-at-risk by quarter), **Property** (stacking plan by SF and status, unit table, T12 from financials), **Tenant** (ledger first, contacts, lease card, activity from `correspondence_log`), **Lease** (term timeline, rent schedule, clause cards) | properties/units/leases/tenants routes, rent-roll, ar-aging, `income-statement-12mo`, correspondence | Debt & cover (B5), Watch standing (B3), promise-to-pay (B1), clause→PDF page citations (B6), WALT/NOI vs budget per property (B12) |
| 3 | `feat/redesign-3-money` | **Rent roll** grouped by property with subtotals, share bar and term bar; **Renewals** 18-month timeline (notice band) plus stage board; **Collections** work queue (aging bars, tabs, multi-select batch bar) | rent-roll, renewals (`PUT` for stage), ar-aging, statements batch | Promise/dispute status (B1), batch reminders and late fee actions (B1, B9; late fees go through refute), demand letters (B11) |
| 4 | `feat/redesign-4-portal-mobile` | **Tenant portal** home (balance first, "what makes up your balance", pay panel), admin "View as tenant" preview, **mobile-responsive** Today, plus a site-walk checklist shell | portal routes, Stripe ACH (existing) | Card payments with fee (B9), site walks (B10), record-a-check (B10), requests (P4 maintenance) |

## Backend epics (each epic is its own PR; ⚠ = refute gate)

| # | Epic | Schema / routes (sketch) | Roadmap phase | Feeds |
|---|---|---|---|---|
| B1 | Collections workflow | `promises_to_pay(lease_id, amount, promised_date, status open/kept/lapsed, created_by)`, `ar_disputes`; lapse detection in cron; reuses `correspondence_log` for calls/notes | P2 | Today Collect context, Collections status/next step, Tenant activity |
| B2 | Shared work queue state | `queue_item_state(item_key, snoozed_until, assignee_email)`; `GET /api/today` server-side queue (moves the PR 1 derivation server-side) | P2 | Today snooze/assign, Approve kind |
| B3 | Tenant standing | Read-only `server/lib/tenant-standing.ts`: days-to-pay trend, short-pays, lapsed promises, deposit cover → Good / Watch with reasons | P2 | Tenant header, Collections risk sort |
| B4 | Entities & property attributes | `entities` (LLC, EIN last 4), `properties.entity_id`, acquired date, clear height, docks; entity switcher scoping | P3 prerequisite | Shell entity switcher, Property facts, Books entity |
| B5 | Debt | `loans(property_id, lender, balance, rate, maturity, covenant_dscr)`. Display only, no governor constants | P5 | Property "Debt & cover" |
| B6 | Lease abstract citations | `lease_clauses(lease_id, key, value, note, page, section, excerpt)`; PDF page viewer over `lease_documents`; extend intake extraction to emit page cites | P7 | Lease clause cards → PDF page |
| B7 | Period close | `close_periods`, `close_tasks` (auto/manual, assignee, done_at); period lock | P3 | Today close checklist, Books |
| B8 | ⚠ Native GL & Books | Per roadmap P3: CoA, journal, bank import + matching rules, AP bills + approval limits, reconciliation, cash by account, 13-week forecast (P5) | P3/P5 | Books screen, Today cash panel, Approve kind |
| B9 | ⚠ Payments depth | Card payments (decide whether to add a surcharge; check state law), late-fee batch assess from Collections | P3+ | Portal pay panel, Collections batch |
| B10 | Field ops | Site walks (`inspections`, items, photos via Storage, offline queue); ⚠ record-a-check (Claude OCR → payment draft, posted through `payments.ts`) | P4 | Mobile screens |
| B11 | Documents | Demand letter and owner report generation (template → PDF), Outlook draft staging (existing statements pattern) | P2/P5 | Collections batch, Property "Owner report" |
| B12 | Portfolio metrics history | Monthly snapshot table (collected %, occupancy, AR>30, ABR expiring) for sparklines and trend; WALT; NOI vs budget per property | P2 | Today sparklines, Overview |

## Prototype → repo mapping

| Prototype screen | Route | File(s) |
|---|---|---|
| Today | `/` | `src/pages/today/TodayPage.tsx`, `today-queue.ts` |
| Portfolio Overview | `/portfolio` (PR 2) | `src/pages/portfolio/*` |
| Property / Tenant / Lease | `/properties/:id`, `/tenants/:id`, `/leases/:id` | detail pages + `EntityPage.tsx` |
| Rent roll | `/rent-roll` | `src/pages/reports/RentRoll.tsx` |
| Renewals | `/renewals` | `src/pages/renewals/*` |
| Collections | `/ar` | `src/pages/ar/*` |
| Books | `/books` (B8) | — |
| Tenant portal | `/portal` | `src/portal/**` |
| Mobile | responsive breakpoints of the routes above | — |
