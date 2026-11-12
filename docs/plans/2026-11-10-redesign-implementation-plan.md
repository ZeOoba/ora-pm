# ORA PM redesign: implementation plan

**Status:** IN PROGRESS · 2026-11-10 · baseline `origin/main` @ `cb32cc8`
**Source:** Claude Design handoff "Property management software audit". The primary file is `ORA PM.dc.html`, a single clickable prototype that combines Today, Overview, Property, Tenant, Lease, Rent roll, Renewals, Collections, Books, Tenant portal and Mobile. Everything in the prototype is sample data.
**Owner:** ORA principal

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
| 2 | `feat/redesign-2-records` | **Portfolio Overview** at `/portfolio` (broadsheet table plus rent-at-risk by quarter), **Property** (stacking plan by SF and status, unit table, T12 from financials), **Tenant** (ledger first, contacts, lease card, activity from `correspondence_log`), **Lease** (term timeline with option-notice deadlines, option cards). Shared detail header restyled (Garamond title, facts strip). | properties/units/leases/tenants routes, rent-roll, ar-aging, `income-statement-12mo` (billed basis), `statements/lease/:id`, correspondence | Debt & cover (B5), Watch standing (B3), promise-to-pay (B1), clause→PDF page citations (B6), rent-step schedule chart (P7 rent-step engine), collected-MTD and NOI vs budget per property (B12), site photo |
| 3 | `feat/redesign-3-money` | **Rent roll** grouped by property (default) with subtotals, share bar and 10-year term bar; DataTable kept as "Table & export". **Renewals** 18-month timeline (default; band = decision-by date → expiry) and stage board (status select per card, "Not tracked" column for expiring leases with no renewal record); DataTable kept as "List". **Collections** headline + aging bar, work queue (tabs, over-30-first order, multi-select batch bar: CSV of selection, statements), existing aging table kept as "Aging detail". Views via `?view=`. | rent-roll, renewals (`PUT` for stage), ar-aging, statements batch | Promise/dispute status (B1), batch reminders and late fee actions (B1, B9; late fees go through refute), demand letters (B11), owner per row (B2), lease-option notice windows on the timeline (needs `options` in the rent_roll view) |
| 4 | `feat/redesign-4-portal-mobile` | **Tenant portal** home (balance first, recent charges, "Make a payment" card that hands off to the existing Pay Now flow, autopay state, lease/COI tiles) and restyled portal shell (white header, scrolling tab row). **Admin mobile**: bottom tab bar < md (Today, Collections, Rent roll, Search). | portal `/me`, `/charges`, `/payments`, `/lease` (existing) | "What makes up your balance" with past-due split (needs a tenant-scoped aging endpoint; B13), admin "View as tenant" (B13), card payments with fee (B9), site walks and record-a-check (B10), requests (P4 maintenance). The site-walk shell was dropped: a checklist that saves nothing would be fake. |

## Backend epics (each epic is its own PR; ⚠ = refute gate)

| # | Epic | Schema / routes (sketch) | Roadmap phase | Feeds |
|---|---|---|---|---|
| B1 | Collections workflow (**built**, `feat/b1-collections-workflow`) | Migration 0022: `promises_to_pay` (open / kept / broken / cancelled) and `ar_disputes` (open / resolved / withdrawn), resolved_at pair CHECKs, RLS default-deny. `/api/collections/{promises,disputes}` GET (open or all, by lease or tenant), POST, PUT resolve (conditional on status = open; 409 otherwise). "Lapsed" = open and past its date, derived at read, so no cron change. Work log only: no billing, late-fee, autopay or balance code reads it. Calls/notes stay in `correspondence_log`. | P2 | Today Collect context + urgency, Collections status / Promised / Disputed tabs / Log…, Tenant Collections card |
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
| B13 | Tenant-view parity (**built**, `feat/b13-tenant-view-parity`) | AR-aging read extracted verbatim from `reports.ts` to `server/lib/ar-aging-report.ts` (+ tenant filter); portal per-tenant reads extracted to `server/lib/portal-data.ts` and used by both the portal routes (each still guards on `auth_user_id` inline) and admin-only `GET /api/tenants/:id/portal-preview`. New `GET /api/portal/aging` (tenant-safe projection). `/me` now sums in cents and fails closed on an `ar_ledger` read error (it used to report $0). Shared `PortalHomeView` renders the portal home and the preview; "what makes up your balance" shows aged buckets plus an explicit credit-on-account line. | P2 | Portal home, Tenant "View as tenant" |
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
