# ora-pm Upgrade Roadmap — Yardi/AppFolio gap analysis → phased plan

**Status:** PROPOSED · 2026-11-05 · baseline `origin/main` @ `0a2401d`
**Owner:** Gabriel Goldberg · **Lane:** L5 research → plan (no code in this change)

## 0. Ratified decisions (2026-11-05)

| # | Decision | Ruling |
|---|---|---|
| D1 | Capability scope | Maintenance/work orders · Reporting & dashboards · Leasing & vacancy pipeline · Owner/LLC financials |
| D2 | Accounting | **Native double-entry GL** (Yardi-style); QuickBooks Desktop retires after cutover |
| D3 | QB transition | **Parallel run, then cutover** — ora-pm GL beside QB for ≥1–2 closes per LLC, reconciled monthly |
| D4 | Users | **All portals** — admin console, tenant portal, new vendor portal |
| D5 | Design | **ORA Style Guide + shadcn/ui** (+ chart library) on existing Tailwind 4 |
| D6 | Leasing data | **ora-pm owns prospects** (unit-level truth), one-way sync to HubSpot for comms |
| D7 | Deliverable | This repo doc + private visual-summary artifact |
| D8 | Granularity | Phased roadmap at epic level + implementation-ready Phase 1 |

Guardrails that bind every phase: GL, billing, payment-application, CAM, distribution and late-fee code are **financial-decision code** → `check:refute` gate + adversarial REFUTE pass (reviewer ≥ Opus 5.5). No governor constants (DSCR 1.25 / LTV 40 / 65) are introduced or touched by this software. No confidential deal data in fixtures or seeds.

---

## 1. Where ora-pm stands today (survey of `0a2401d`)

**Strong foundation.** 17 migrations, RLS on every table, Stripe ACH + autopay with AAL2 step-up and idempotent payment intents, signature-verified webhooks, Claude lease intake with per-field confidence and a confidentiality denylist, CAM calculation + approve-and-bill, budgets vs actuals, critical-dates view and digest, QB IIF export, 82 test files, REFUTE CI gate.

**Material gaps found in the code (not just missing features):**

| # | Finding | Evidence | Impact |
|---|---|---|---|
| G1 | **Silent 50-row cap** on every paged list; no page passes `limit`/`offset`, no pager | `server/lib/schemas.ts:240–243` | Properties/tenants/leases/charges/payments/expenses lists truncate silently at 50 — 140 tenants already exceeds it |
| G2 | **No payment→charge application**; portal treats every charge as open | `PortalDashboard.tsx:12`, `PortalPayNow.tsx:44` | Tenant-facing "open charges" is wrong once anything is paid; blocks a real subledger |
| G3 | AR aging buckets implemented but unused; AR page shows balances only | `server/lib/ar-aging.ts` (no importer) | Collections has no 0–30/31–60/61–90/90+ view |
| G4 | Renewals page read-only though `PUT /renewals/:id` exists | `server/routes/renewals.ts` | Renewal pipeline can't be worked in-app |
| G5 | Leases list filters to `status=active` only | `src/pages/leases/*` | Pending/expired leases not browsable |
| G6 | Dashboard ignores query errors (shows zeros) | `src/pages/Dashboard.tsx` | False "healthy" signal on API failure |
| G7 | Design system built but adopted on 3 pages; 38 files use raw gray/blue | `src/components/ui/*` vs pages | Inconsistent, unbranded look |
| G8 | Admin shell not responsive (fixed `w-60`, fixed `grid-cols-4`) | `AppShell.tsx` | Unusable on phone/tablet (site walks, vendor meetings) |
| G9 | **Parchment token wrong**: `#F5F0E8` vs canonical `#F5F3EF` | `src/index.css:9`; ORA Style Guide (rules.md §7, corrected 2026-06-11) | Off-brand base color |
| G10 | Single admin role; no per-entity permissions | `server/middleware/admin-auth.ts` | Blocks bookkeeper/PM/vendor roles needed by GL + vendor portal |
| G11 | Dead schema: `lease_move_events`, `tenant_sales_reports`, `journal_entry_exports`, `utility_meters/readings` never referenced | grep `server/` `src/` | Either wire up or deprecate |
| G12 | No admin upload path for `lease_documents`; no generic documents model | `server/routes/` | Documents only via portal COI flow |
| G13 | `properties.entity_llc` is free text; IIF account names hardcoded | `0001:12`, `exports.ts:100–104` | No entity model for multi-LLC GL |
| G14 | 5 `alert()`/`confirm()` calls; bare "Loading…" text; no search/sort/bulk/CSV | pages | Basic usability |

Operational note: the main checkout `C:\Users\Owner\ora-pm` is 38 commits behind with an uncommitted `package.json`/lockfile diff that only re-adds eslint deps already on `origin/main` — stale, safe to discard by its owner; not touched here.

---

## 2. Yardi / AppFolio capability benchmark → ora-pm gap matrix

Legend: ✅ have · 🟡 partial · ❌ missing · Y = Yardi (Voyager/Breeze/add-ons) · A = AppFolio. Sources in §8. Yardi Voyager claims are from vendor search excerpts (yardi.com blocked fetches) — marked ᵉ.

| Domain | Capability | Y | A | ora-pm | Phase |
|---|---|---|---|---|---|
| **Accounting** | Double-entry GL, chart of accounts | ✔ | ✔ | ❌ | P3 |
| | Multi-entity / corporate GL, intercompany | ✔ | ✔ (Portfolio Distributions) | ❌ (free-text LLC) | P3/P5 |
| | AP workflow: bills, approval limits, payment | ✔ (P2P, Payscan ᵉ) | ✔ | ❌ | P3 |
| | Invoice OCR / AI coding | ✔ (Smart AP) | ✔ (Accounting Performer) | ❌ (have Claude intake infra) | P3 |
| | Bank accounts + reconciliation | 🟡 | 🟡 (Column; rec "coming") | ❌ | P3 |
| | Period close / lock, audit trail | ✔ | ✔ (continuous close) | ❌ | P3 |
| | Owner/LLC statements & packets | ✔ | ✔ | ❌ | P5 |
| | Budgets & variance | ✔ | ✔ | 🟡 (expense-based) | P2→P5 |
| | 1099 / year-end | ✔ | ✔ | ❌ | P5 |
| **Lease admin** | AI lease abstraction w/ confidence review | ✔ (Smart Lease ᵉ) | ❓ | ✅ (Claude intake) | P7 depth |
| | Rent steps / escalations auto-post | ✔ | ❓ | 🟡 (JSONB terms, no step engine) | P7 |
| | Recoveries: pools, caps, base-year, gross-up | ✔ | 🟡 | 🟡 (CAM calc, no caps/pools) | P7 |
| | Critical dates / options alerts | ✔ | ❓ | ✅ (view + digest) | P2 visual |
| | Security-deposit ledger | ❓ | ❓ | 🟡 (field only) | P3 |
| | COI tracking + expiry | ❓ | ❓ | ✅ (portal upload, status) | P4 vendor COIs |
| **Maintenance** | Work orders, tenant requests w/ photos | ✔ | ✔ | ❌ | P4 |
| | Vendor dispatch + vendor portal | ✔ | ✔ | ❌ | P4 |
| | Preventive maintenance schedules | ❓ | ✔ (Plus) | ❌ | P4 |
| | Chargeback to tenant from WO | ✔ | ✔ | ❌ | P4 |
| | Maintenance KPI dashboard / SLA thresholds | ❓ | ✔ (Smart Thresholds, soon) | ❌ | P4 |
| **Leasing** | Vacancy listings / syndication | ✔ | ✔ | ❌ (agents exist off-app) | P6 |
| | Prospect CRM / showings | ✔ | ✔ (Max) | ❌ | P6 |
| | Commercial deal pipeline w/ milestones | ✔ (Deal Manager ᵉ) | ❌ | ❌ | P6 |
| **Portals** | Tenant: pay, autopay, ledger, docs | ✔ | ✔ | ✅ (ACH only) | P1 polish |
| | Tenant: service requests | ✔ | ✔ | ❌ | P4 |
| | Owner/investor portal | ✔ | ✔ | ❌ (internal owners — read-only LLC view) | P5 |
| | Vendor portal | ✔ | ✔ | ❌ | P4 |
| **Reporting** | Report library + builder, drill-down, export | ✔ | ✔ | 🟡 (4 reports, no export) | P2 |
| | Role-based KPI dashboards, charts | ✔ ᵉ | 🟡 | ❌ (4 tiles) | P2 |
| | Scheduled reports | ❓ | ❓ | ❌ (Outlook COM path exists) | P2 |
| **AI** | Assistant over portfolio data | ✔ (Virtuoso) | ✔ (Realm-X) | ❌ | P7 |
| | If/then workflow automations | ✔ (Agents) | ✔ (Flows) | 🟡 (3 crons) | P7 |
| **Platform** | Roles & permissions | ✔ | ✔ | ❌ (single admin) | P1 (model) / P3 |
| | API / MCP connector | ✔ (MCP ᵉ) | ✔ (Max, Claude connector) | 🟡 (internal REST) | P7 |

**Where ora-pm can lead, not follow:** neither vendor documents (publicly) COI tracking, a security-deposit ledger, maintenance SLA tracking, heatmaps or scheduled reports — ora-pm already has COI and critical-dates primitives and the Outlook COM delivery path. AppFolio's "cash follows the owner" distribution model maps directly onto ~20 single-property LLCs (P5).

**UX lessons from reviews:** Yardi (G2 ≈3.9/5) loses on clutter, deep menus, learning curve; AppFolio (G2 ≈4.6/5) wins on ease of use but loses on customization, reporting gaps and a shallow mobile app. Target: AppFolio-grade simplicity, Yardi-grade commercial depth, a mobile-first field experience neither does well.

---

## 3. Target experience (design direction)

- **Stack additions:** shadcn/ui (Radix primitives, copied into `src/components/ui/`, themed to ORA tokens), `lucide-react` icons, `@tanstack/react-table` (DataTable), Recharts (via shadcn Chart), `sonner` toasts, `cmdk` command palette. All MIT; no runtime CDN (CSP stays self-hosted).
- **Brand:** EB Garamond display / DM Sans body / IBM Plex Mono figures; navy `#1B2A4A`, gold `#C9A96E` accent, parchment `#F5F3EF` (fix G9), ivory surface. Chart palette: navy-sequential for magnitude, gold for highlight, status colors only for status. Dark mode deferred (internal tool; not worth the cost now).
- **Information architecture** (task-first, ≤7 top-level groups, replaces 15 flat links):
  `Home` · `Portfolio` (Properties, Units/stacking plan, Tenants, Leases) · `Leasing` (Vacancies, Prospects, Renewals) · `Maintenance` (Work orders, Vendors, PM schedules) · `Accounting` (Receivables, Payables, GL, Banking, CAM, Budgets, Close) · `Reports` · `Admin`.
- **Global patterns:** ⌘K search across properties/tenants/leases/units; one DataTable everywhere (server pagination, sort, filter chips, column picker, saved views, CSV export, bulk select); entity pages as header + KPI strip + tabs + activity timeline; side-sheet quick edit; toasts + confirm dialogs (kill `alert/confirm`); skeletons, real empty states, error banners with retry; responsive shell (collapsible rail ≥ md, bottom sheet nav < md).
- **Visual inventory (what "more visuals" means concretely):**
  1. Home: occupancy gauge, rent-roll trend (12-mo), AR aging stacked bar, lease-expiry ladder (by year, SF-weighted), critical-dates timeline, collections % MTD.
  2. Property page: site/stacking plan grid colored by status/expiry, NOI vs budget sparkline, open WOs.
  3. Tenant page: ledger with running balance chart, payment-timeliness heat strip (12 months), COI status.
  4. Portfolio map (Leaflet/OSM, self-hosted tiles or static) colored by occupancy — P2 stretch.
  5. Maintenance: WO aging, SLA breach, spend by category/vendor.
  6. Accounting: cash by LLC, budget variance waterfall, close checklist progress.

---

## 4. Phased roadmap

Sizing is relative (S ≈ ≤1 wk, M ≈ 2–3 wk, L ≈ 4–6 wk of focused Claude Code build + review). Order is dependency-driven: UX foundation → visibility → ledger → operations on the ledger → owner outputs → growth → depth/AI.

| Phase | Theme | Key epics | Depends on | Size | Exit criteria |
|---|---|---|---|---|---|
| **P1** | Design system & UX foundation | shadcn+ORA theme, responsive shell + new IA, DataTable w/ server pagination (fix G1), ⌘K search, toasts/dialogs, loading/empty/error states, migrate all pages, quick wins G3–G6, G9, G14, roles data model (G10, not yet enforced beyond admin) | — | L | Every list paginates; no raw gray/blue classes; Lighthouse a11y ≥ 95; works at 375 px |
| **P2** | Reporting & dashboards | Chart kit; Home v2; property/tenant visual pages; report library (rent roll, AR aging, expiry, occupancy, budget variance, delinquency) with CSV/PDF export; saved views; **scheduled reports** via existing cron → Outlook COM path (routing: ggoldberg@ only) | P1 | M | 6 standard reports exportable; Home renders from live data with error states |
| **P3** | Native GL foundation | `entities` (LLC) + `bank_accounts`; chart of accounts (template per LLC); `journal_entries`/`journal_lines` (balanced-entry constraint, immutable posted entries, reversal not edit); **payment application** to charges (fix G2) and AR subledger posting; AP: `vendors`, `bills`, approval limits, check/ACH payment records (no money movement from app); bank-statement import (CSV/OFX) + reconciliation; period close/lock; audit log; security-deposit liability ledger; roles enforced (bookkeeper/approver); Claude invoice capture reusing intake pattern | P1 | L+ | Trial balance per LLC ties to QB for a closed month; REFUTE pass on posting engine |
| **P4** | Maintenance, vendors & vendor portal | Work orders (status machine, priority, SLA targets), tenant request intake w/ photos (portal + mobile), vendor directory w/ COIs/W-9, vendor portal (assigned WOs, status/photos, invoice upload → P3 bill), PM schedules (recurring WO generator in cron), chargeback WO→charge, maintenance dashboard | P1, P3 (bills) | L | Tenant can submit a request with photo; vendor can close it and submit invoice that lands as a draft bill |
| **P5** | Owner/LLC financials + **QB parallel run** | Financial statements from GL (BS, IS, CF, T12) per LLC + consolidated; owner packet PDF; budgets on GL accounts (migrate P2 budgets); CAM recon sourced from GL; intercompany/distributions ("cash follows owner"); 1099 data; read-only owner view for Eric; **parallel-run harness**: QB CSV import → monthly variance report per LLC | P3 | L | Two consecutive closes per LLC reconcile to QB within $0 on BS, documented exceptions only; Gabriel ratifies cutover per LLC |
| **P6** | Leasing & vacancy pipeline | Vacancy board (days vacant, asking rent, listing status per channel), prospects/showings/proposals pipeline tied to units, deal milestones (LOI→lease), one-way HubSpot sync (contacts/deals; never brokers — rules.md §3b), listing-pack export for existing listing agents, renewal workflow on G4 | P1, P2 | M | Every vacant unit has a pipeline card; prospect → lease conversion creates lease draft |
| **P7** | Commercial lease depth & AI | Rent-step engine (auto-post escalations), recovery pools/caps/base-year/gross-up, options & critical-dates workflow, lease abstraction v2 (full clause set, confidence UI, amendment chaining), activate `tenant_sales_reports`/utility meters or deprecate (G11), in-app assistant (Claude, read-only Q&A over warehouse + drafting), automation rules (if/then on events), internal MCP/read API | P3, P5 | L | Escalations post without manual charges for 1 full quarter; assistant answers rent-roll questions with citations |
| **Cutover** | QB retirement per LLC | Freeze QB for LLC after ratified parallel run; opening balances locked; QB files archived (never deleted) | P5 | per LLC | Gabriel in-turn approval per LLC |

**Diminishing-returns flags.** (1) Native GL is the dominant cost and risk — it roughly equals P1+P2+P4 combined; the parallel run is what makes it safe, do not compress it. (2) Owner/investor *external* portal is excluded — owners are internal; a read-only LLC view suffices. (3) Full listing syndication duplicates existing listing agents; P6 exports packs rather than re-implementing posting. (4) Dark mode, native mobile apps, and percentage-rent depth are deferred (industrial/flex portfolio, little retail).

**Risks.** GL correctness (mitigate: balanced-entry DB constraint, immutable posting, REFUTE, parallel run) · scope creep in P1 page migration (mitigate: DataTable first, migrate pages mechanically) · Supabase row limits on reports (mitigate: SQL views/RPCs, server-side aggregation) · role model retrofitting (mitigate: data model lands in P1).

---

## 5. Phase 1 — implementation spec (ready to build)

**Goal:** one coherent, branded, responsive UI on a shared component kit, with every list correct at portfolio scale. No schema change except the roles table (T12). No financial-logic change.

**Branch/worktree:** `feat/p1-design-foundation` in `ora-pm-worktrees/`. Each task = 1 PR-sized commit set; TDD where behavior changes.

| # | Task | Files | Verify |
|---|---|---|---|
| T1 | **Tokens & theme.** Fix parchment → `#F5F3EF`; add shadcn CSS variables mapped to ORA tokens (`--background`, `--primary`=navy, `--accent`=gold, `--ring`, chart-1…5); add `components.json` | `src/index.css`, `components.json` | StyleGuide renders; token test asserts `#F5F3EF` |
| T2 | **Install kit.** shadcn primitives: button, input, select, dialog, sheet, dropdown-menu, tabs, tooltip, popover, command, table, badge, skeleton, card, chart; `lucide-react`, `@tanstack/react-table`, `recharts`, `sonner`, `cmdk`. Re-point existing `Button/Card/Badge/KpiStat/EmptyState` APIs onto shadcn internals (keep import paths stable) | `src/components/ui/*`, `package.json` | `npm run build` + existing component tests green |
| T3 | **Responsive AppShell + new IA.** Collapsible rail (≥ md), sheet nav (< md), grouped nav per §3, breadcrumb + page actions slot, user menu w/ sign-out | `src/components/AppShell.tsx`, `src/router.tsx` | Render test at 375/768/1280 widths; all 28 routes reachable |
| T4 | **DataTable.** Generic `<DataTable>`: server pagination (`limit/offset` + total via `Prefer: count=exact`), sort, filter chips, column visibility, CSV export of current filter, row selection, skeleton/empty/error states | `src/components/data-table/*`, `src/lib/api.ts` | Unit tests for state→query mapping; CSV escapes commas/quotes |
| T5 | **List endpoints return totals.** Add `{ data, total }` envelope (or `X-Total-Count`) to the six paged routes; add `sort`/`q` params validated by Zod; add paging to `units`, `insurance`, `renewals` | `server/routes/{properties,tenants,leases,charges,payments,expenses,units,insurance,renewals}.ts`, `server/lib/schemas.ts` | Route tests: 120-row fixture returns total=120, page 3 correct; invalid sort rejected |
| T6 | **Migrate list pages** to DataTable (Properties, Units, Tenants, Leases [all statuses + status filter, fixes G5], Billing, Payments, Expenses, Insurance, Renewals, Rent Roll) | `src/pages/**/**List.tsx` | No page has `min-w-full divide-y` hand-rolled table; grep test |
| T7 | **Feedback primitives.** Replace 5 `alert/confirm` with `<ConfirmDialog>` + `sonner` toasts; standard `<QueryState>` wrapper for loading/empty/error | pages using `alert(`/`confirm(` | Grep test: zero `alert(`/`confirm(` in `src/` |
| T8 | **Quick wins.** AR page uses `ar-aging.ts` buckets (G3); Renewals inline status/edit via existing `PUT` (G4); Dashboard surfaces query errors (G6) | `server/routes/reports.ts`, `src/pages/ar/*`, `src/pages/renewals/*`, `Dashboard.tsx` | Route test for bucket totals = balance; error-state render test |
| T9 | **Command palette.** ⌘K search across properties/tenants/leases/units via new `GET /api/search?q=` (ILIKE, 20 results, admin only) | `server/routes/search.ts`, `src/components/CommandMenu.tsx` | Route test (auth required, limit 20); keyboard open test |
| T10 | **Entity page template.** Header + KPI strip + tabs + activity timeline; apply to Property, Tenant, Lease detail | `src/components/EntityPage.tsx`, detail pages | Snapshot render tests |
| T11 | **Portal polish.** Portal pages onto same kit (drop inline `style` colors), skeletons everywhere, mobile check | `src/portal/**` | Portal render tests; 375 px manual check |
| T12 | **Roles data model (not yet enforced).** Migration `0018_admin_roles.sql`: `admin_users(email, role ∈ {owner, manager, bookkeeper, viewer}, entity_scope uuid[] null)`; middleware reads role into context, defaults allowlisted emails to `owner`; no route behavior change | `supabase/migrations/0018_*`, `server/middleware/admin-auth.ts` | pg-mem migration test; auth tests unchanged + role on context |
| T13 | **Home v1 visuals (seed of P2).** Occupancy, AR aging stacked bar, lease-expiry ladder from existing endpoints | `Dashboard.tsx`, `src/components/charts/*` | Renders with fixture; chart a11y (aria labels, table fallback) |
| T14 | **Quality gate.** Lint rule banning `bg-gray-*`/`bg-blue-*`/`text-gray-*` in `src/`; Lighthouse a11y ≥ 95 on Home/Tenants/Portal dashboard; update StyleGuide page | `eslint.config.js`, `src/pages/StyleGuide.tsx` | `npm run lint` clean; Lighthouse report attached to PR |

**Out of scope for P1:** any GL/billing/payment logic, new financial tables, HubSpot, vendor portal.
**Done bar:** typecheck, lint, full vitest green; reviewer pass per PR; T5 and T12 get an adversarial pass (shared API contract + auth middleware); preview deploy only — `main` merge deploys via CI, so each merge is treated as a deploy.

---

## 6. Phase 3 GL — design notes to settle before its spec

Not ratified yet; listed so P1/P2 don't paint into a corner.
1. Accounting basis per LLC (accrual vs cash) and whether both books are required for tax.
2. Chart-of-accounts template: mirror existing QB account names to make the parallel run line-for-line comparable (recommended).
3. Bank-feed source: statement import (CSV/OFX) first; live bank feeds (Plaid/Column-style) deferred.
4. Payments out of the app: record-only (checks/ACH initiated at the bank) — the app never moves money (Invariant 1).
5. Fiscal calendar, close cadence and who approves period lock.

## 7. Next steps

1. Ratify this roadmap (or amend phases/order).
2. Start P1 in `feat/p1-design-foundation` via `/build`, T1→T14.
3. Schedule the GL design session (§6) during P2 so P3 starts with a ratified spec.

## 8. Sources

Vendor pages retrieved 2026-11-05: Yardi Breeze [commercial features](https://www.yardibreeze.com/commercial-features/), [Breeze Premier](https://www.yardibreeze.com/breeze-premier/), [CAM reconciliation](https://www.yardibreeze.com/blog/2025/09/common-area-maintenance-reconciliation/), [11 highlights](https://www.yardibreeze.com/blog/2025/08/11-highlights-of-commercial-property-management-software/); Yardi (excerpt only, fetch blocked) [Voyager Commercial](https://www.yardi.com/product/voyager-commercial/), [Procure to Pay](https://www.yardi.com/products/procure-to-pay/), [Payscan](https://www.yardi.com/product/payscan/), [CommercialCafe](https://www.yardi.com/product/commercialcafe-tenant-portal/), [Smart Lease](https://www.yardi.com/blog/commercial-lease-abstraction-software/), [Virtuoso agents press release 2026-06-15](https://www.yardi.com/news/press-releases/yardi-delivers-ai-agents-for-every-multifamily-role-and-workflow/), [Spring 2026 commercial update](https://www.yardi.com/blog/en-gb/whats-new-in-the-yardi-commercial-suite-spring-2026-product-updates/); AppFolio [commercial](https://www.appfolio.com/commercial-property-management-software), [pricing](https://www.appfolio.com/pricing), [Fall 2026 product update](https://www.appfolio.com/blog/product-update-2026-q3), [Performers](https://www.appfolio.com/articles/performers), [owner help](https://www.appfolio.com/help/owner); reviews (secondary) [G2 Yardi Voyager](https://www.g2.com/products/yardi-voyager/reviews_and_filters), [G2 AppFolio](https://www.g2.com/products/appfolio), [Capterra AppFolio](https://www.capterra.com/p/92228/AppFolio-Property-Manager/reviews/).
