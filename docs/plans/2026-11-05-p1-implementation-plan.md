# Phase 1 Implementation Plan — Design System & UX Foundation

Source spec: `docs/plans/2026-11-05-ora-pm-upgrade-roadmap.md` §3 and §5 (T1–T14). This plan regroups T1–T14 into 9 executable tasks.
Branch: `feat/p1-design-foundation` (worktree `C:\Users\Owner\ora-pm-worktrees\p1-design-foundation`).

## Global Constraints (bind every task)

- **No financial-logic change.** Do not modify billing, payments, Stripe, CAM calculation, late-fee, IIF export, or cron money paths. If a task seems to need it, STOP and report BLOCKED.
- **No new runtime CDN.** Everything bundled; CSP is self-hosted.
- **Brand tokens (exact):** navy `#1B2A4A`, navy-700 `#243660`, gold `#C9A96E`, gold-600 `#B8975A`, parchment `#F5F3EF` (was `#F5F0E8` — wrong), ivory `#FBF9F4`; status colors unchanged (`#15803D` active, `#B45309` warning, `#B91C1C` danger, `#4338CA` pending, `#475569` neutral). Fonts: EB Garamond display, DM Sans body, IBM Plex Mono data (already self-hosted via @fontsource). No dark mode in P1.
- **Component kit:** shadcn/ui pattern — Radix primitives (`@radix-ui/react-*`) + `class-variance-authority` + `clsx` + `tailwind-merge`, components copied into `src/components/ui/`. Plus `lucide-react`, `@tanstack/react-table`, `recharts`, `sonner`, `cmdk`. Use `^` ranges like the rest of `package.json`; commit the lockfile.
- **Keep existing import paths stable** for `src/components/ui/{Button,Card,Badge,KpiStat,EmptyState,FileDropZone}.tsx` and their `*-variants.ts`/`badge-tone.ts` helpers; existing tests under `tests/components/` must stay green.
- **List API contract:** every paged list endpoint returns `{ data, total }` where `total` is the full filtered row count. `data` shape is unchanged. Pagination stays `limit` (1–200, default 50) / `offset` (≥0).
- **Tests:** Vitest, `environment: node`. UI behavior is tested through pure functions (state→query mapping, CSV building, nav config) and `react-dom/server` `renderToStaticMarkup` render tests (see `tests/portal/portal-router.test.tsx` for the pattern). Do not add jsdom or a browser runner in P1.
- **Gates before every commit:** `npm run typecheck`, `npm run lint`, `npm test`. Known pre-existing Windows-only failure: `tests/scripts/check-migrations-applied.test.ts` (CRLF shebang in `scripts/check-migrations-applied.mjs`) — ignore it, do not fix it, everything else must pass.
- **Git:** stage explicit paths only (never `git add -A`/`.`), commit with message ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push.
- **No tenant PII or confidential deal data** in fixtures; use obviously fake names (e.g. "Acme Test LLC").

---

## Task 1: Theme tokens and component kit

Covers roadmap T1 + T2.

1. Install deps: `@radix-ui/react-dialog @radix-ui/react-dropdown-menu @radix-ui/react-tabs @radix-ui/react-tooltip @radix-ui/react-popover @radix-ui/react-select @radix-ui/react-slot class-variance-authority clsx tailwind-merge lucide-react @tanstack/react-table recharts sonner cmdk`. If `npm install` refuses a package because of the `allowScripts` field in `package.json`, report NEEDS_CONTEXT rather than editing `allowScripts`.
2. `src/lib/utils.ts`: `export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)) }`.
3. `src/index.css`: fix `--color-parchment` to `#F5F3EF`. Add shadcn semantic tokens inside the existing `@theme` mapped to ORA values: `--color-background` (ivory), `--color-foreground` (navy), `--color-card` (#FFFFFF), `--color-card-foreground` (navy), `--color-popover`/`-foreground` (same as card), `--color-primary` (navy), `--color-primary-foreground` (#FFFFFF), `--color-secondary` (parchment), `--color-secondary-foreground` (navy), `--color-muted` (parchment), `--color-muted-foreground` (#5B6578), `--color-accent` (gold), `--color-accent-foreground` (navy), `--color-destructive` (status-danger), `--color-border` (#E4DFD5), `--color-input` (#E4DFD5), `--color-ring` (gold), `--color-chart-1`…`--color-chart-5` = `#1B2A4A`, `#C9A96E`, `#4F6A93`, `#8FA3C2`, `#B8975A`, `--radius` 0.625rem with `--radius-sm/md/lg`. Add base layer `* { @apply border-border; }`.
4. `components.json` at repo root (style `new-york`, `rsc: false`, `tsx: true`, css `src/index.css`, aliases `@/components`, `@/components/ui`, `@/lib/utils`, iconLibrary `lucide`). Add `resolve.alias { '@': path.resolve(__dirname, 'src') }` to `vite.config.ts` and the same alias to `vitest.config.ts` (tsconfig already maps `@/*`).
5. Add shadcn primitives as new files in `src/components/ui/` (lowercase shadcn filenames to avoid clashing with the existing PascalCase files): `dialog.tsx`, `sheet.tsx` (Radix dialog side variant), `dropdown-menu.tsx`, `tabs.tsx`, `tooltip.tsx`, `popover.tsx`, `select.tsx`, `command.tsx` (cmdk), `table.tsx`, `skeleton.tsx`, `input.tsx`, `sonner.tsx` (Toaster wrapper themed navy/gold), `chart.tsx` (shadcn ChartContainer/ChartTooltip over Recharts using `--color-chart-*`).
6. Re-point existing `Button.tsx`, `Card.tsx`, `Badge.tsx` internals to use `cn()` and keep their current props/variants and exported helpers exactly (navy, gold, ghost, danger; flat/default/raised). Add `asChild` support to Button via `@radix-ui/react-slot`.
7. Mount `<Toaster />` once in `src/App.tsx` and once in `src/portal/PortalApp.tsx`.

Tests (write first): `tests/components/theme-tokens.test.ts` reads `src/index.css` and asserts parchment `#F5F3EF`, absence of `#F5F0E8`, and presence of each semantic token name above; `tests/components/cn.test.ts` asserts `cn('p-2','p-4') === 'p-4'` and falsy filtering; render test that `Button` with `asChild` renders an `<a>`.
Done when: `npm run build` succeeds, all gates pass.

## Task 2: List endpoints return totals, sort and search

Covers roadmap T5. Server only.

1. In `server/lib/schemas.ts` add `ListQuerySchema = PaginationSchema.extend({ sort: z.string().optional(), dir: z.enum(['asc','desc']).default('asc'), q: z.string().trim().max(100).optional() })` and a helper `server/lib/list-query.ts` exporting `parseListQuery(c, { sortable: readonly string[], defaultSort: string, searchColumns?: readonly string[] })` that returns `{ limit, offset, sort, ascending, q }` and rejects a `sort` not in `sortable` with a 422 (`{ error: 'Invalid sort field' }`). `q` is escaped for PostgREST `ilike` (escape `%`, `_`, `,`, `(`, `)`) and applied as `.or('col.ilike.%q%,...')` across `searchColumns`.
2. Apply to the six paged routes — `properties` (sortable: name, city, state, created_at; search: name, city, entity_llc), `tenants` (name, created_at; search: name, contact_name, email), `leases` (start_date, end_date, base_rent_monthly, status; keep existing `status` filter; `status` absent = all statuses), `charges` (charge_date, amount, type), `payments` (payment_date, amount), `expenses` (expense_date, amount, category). Use `.select(<existing select>, { count: 'exact' })` and return `{ data, total: count ?? 0 }`.
3. Add the same paging + `{ data, total }` to `units`, `insurance`, `renewals` GET list routes (sortable: units suite/sf/status; insurance expiration_date/status; renewals target/decision date columns that exist — read the migration to pick real column names).
4. Do not change any non-list route, any money path, or the portal routes.
5. Confirm with grep that every frontend caller of these endpoints only reads `.data` (so `total` is additive). List callers in the report.

Tests (write first, in `tests/routes/list-query.test.ts` + per-route additions following existing route-test mocking patterns, e.g. `tests/routes/payments.test.ts`): `parseListQuery` defaults, invalid sort → 422, `q` escaping of `%_,()`, limit >200 rejected; one route test per endpoint group asserting `total` is returned and `range(offset, offset+limit-1)` is applied.
This task touches the shared API contract: it will get an adversarial review.

## Task 3: DataTable component

Covers roadmap T4.

1. `src/lib/api.ts`: add `api.list<T>(path, params)` returning `{ data: T[]; total: number }`, building the query string from `{ limit, offset, sort, dir, q, ...filters }` and omitting undefined/empty values.
2. `src/components/data-table/` with:
   - `table-state.ts` (pure): `type TableState = { pageIndex; pageSize; sort?: { id; desc }; q?; filters: Record<string,string> }`; `toListParams(state)` → `{ limit, offset, sort, dir, q, ...filters }`; `pageCount(total, pageSize)`.
   - `csv.ts` (pure): `toCsv(rows, columns: { header; accessor(row): unknown }[])` — RFC 4180 quoting (quotes, commas, newlines), CRLF line endings, numbers unformatted, null → empty; plus `downloadCsv(filename, csv)` (Blob + object URL, browser-only).
   - `DataTable.tsx`: built on `@tanstack/react-table` in manual pagination/sorting mode; props `{ columns, queryKey, fetchPage(params) => Promise<{data,total}>, searchPlaceholder?, filters?: FilterDef[], rowHref?(row), bulkActions?, csvFilename? }`; uses TanStack Query; toolbar with debounced (300 ms) search, filter chips (Select-based), column visibility dropdown, CSV export of the current page set (export fetches all pages up to 2,000 rows at limit 200 and warns via toast if truncated); sortable headers with lucide arrows; footer pager showing "Showing 51–100 of 140" and page-size select (25/50/100); skeleton rows while loading; `EmptyState` when 0 rows; error banner with Retry when the query fails; optional row selection checkbox column when `bulkActions` given; table scrolls horizontally inside its own `overflow-x-auto` container on narrow screens.
   - Numbers right-aligned in `font-mono tabular-nums`.

Tests (first): `tests/components/table-state.test.ts` (page 3 of size 50 → offset 100; sort desc → dir 'desc'; empty q omitted; pageCount(140,50)=3, pageCount(0,50)=1); `tests/components/csv.test.ts` (quotes/commas/newlines escaped, CRLF, null empty); `tests/lib/api-list.test.ts` (query string building, undefined omitted). Render test: `renderToStaticMarkup` of DataTable in loading state shows skeleton rows (wrap in QueryClientProvider).

## Task 4: Migrate list pages to DataTable

Covers roadmap T6. Depends on Tasks 2–3.

Migrate: `PropertiesList`, `UnitsPage`/`UnitMatrix` (whichever renders the list), `TenantsList`, `LeasesList` (all statuses; status filter chip: All/Active/Pending/Expired/Terminated using the real enum values from migrations), `BillingDashboard` (keep voided strike-through marker that `tests/components/billing-dashboard-voided-marker.test.ts` asserts — update that test only if its source-grep target moves, keeping its intent), `PaymentsList` (keep the inline Record Payment form as a Sheet opened from a toolbar button), `ExpensesList` (add form → Sheet), `InsuranceList`, `RenewalsPipeline`, `RentRoll` (report endpoint is unpaged: use DataTable in client mode — add a `mode: 'client'` prop that takes `rows` and sorts/filters/paginates in memory; keep the property-name filter as search).
Each page: `PageHeader` + DataTable, row click → detail where a detail page exists, CSV filename `ora-<page>-YYYY-MM-DD.csv`. Replace raw `bg-gray-*`/`bg-blue-*`/`text-gray-*` classes on these pages with tokens.

Tests: `tests/components/no-handrolled-tables.test.ts` — source grep asserting none of the migrated page files contain `min-w-full divide-y`; existing component tests stay green.

## Task 5: Responsive AppShell, new navigation, command palette

Covers roadmap T3 + T9.

1. `src/components/nav-config.ts` (pure, exported): groups per roadmap §3 adapted to existing routes only — Home (`/`), Portfolio (Properties, Units, Tenants, Leases, Insurance), Leasing (Renewals, Critical Dates), Accounting (Billing, Payments, AR / Collections, CAM, Expenses, Budgets), Reports (Rent Roll, QB Export). Each item has a lucide icon. No links to routes that do not exist.
2. `AppShell.tsx`: ≥ `md` a collapsible left rail (expanded 240 px / collapsed 64 px icons-only, state in localStorage wrapped in try/catch); < `md` a top bar with menu button opening the nav in a `Sheet`; header area with breadcrumb (derived from nav-config + pathname), a search button showing ⌘K / Ctrl K, and a user menu (email + Sign out via existing supabase signOut). Main content padding `p-4 md:p-8`, max width none.
3. `server/routes/search.ts` mounted at `/api/search` (admin-authenticated like other admin routes — confirm it is NOT in the auth-exempt list in `server/index.ts`): `GET ?q=` (trimmed, 2–100 chars else 422), ILIKE (escaped as in Task 2) across properties.name, tenants.name, units.suite (with property name), leases (via tenant name); returns `{ data: { type, id, label, sublabel, href }[] }` max 20 total.
4. `src/components/CommandMenu.tsx`: cmdk dialog opened by ⌘K/Ctrl+K and the header button; debounced 250 ms query to `/api/search`; groups results by type; Enter navigates; also lists nav-config pages for quick jump.

Tests (first): `tests/components/nav-config.test.ts` (every nav `to` exists in `src/router.tsx` route paths — parse router source or export the path list; no duplicates); `tests/routes/search.test.ts` (401 without admin auth, 422 on 1-char q, escaping, cap at 20); render test of AppShell markup contains nav labels and the `md:` responsive classes.

## Task 6: Feedback primitives and quick wins

Covers roadmap T7 + T8.

1. `src/components/ConfirmDialog.tsx` (controlled Radix dialog: title, description, confirm label, destructive variant, pending state) and `src/components/QueryState.tsx` (`{ query, empty?, children }` → skeleton / error banner with Retry / empty / children).
2. Replace every `alert(` and `confirm(` in `src/` (currently in `pages/admin/TenantPortalAdmin.tsx`, `pages/cam/CAMList.tsx`, `pages/expenses/ExpensesList.tsx` — grep for others) with ConfirmDialog + `sonner` toasts. CAM "Approve & Bill" keeps calling the same endpoint with the same payload — only the confirmation UI changes.
3. AR (`src/pages/ar/ARDashboard.tsx`): add aging buckets using existing `server/lib/ar-aging.ts`. Expose them through `GET /api/reports/ar-aging` by adding a `buckets` field (current, 1–30, 31–60, 61–90, 90+) per tenant and a portfolio total, without changing existing fields. Read `ar-aging.ts` first and use its functions as-is; if its semantics are unclear or it would require changing charge/payment logic, report NEEDS_CONTEXT. Show a stacked bar (Recharts via `chart.tsx`) of portfolio buckets plus bucket columns in the table.
4. Renewals: inline status/decision editing via existing `PUT /api/renewals/:id` (Select in row + toast); invalidate query on success.
5. Dashboard: show an error banner (QueryState) when any of its three queries fail instead of zeros.

Tests (first): grep test — zero `alert(` / `confirm(` / `window.confirm` in `src/`; `tests/routes/reports-ar-aging-buckets.test.ts` — bucket sum equals balance for a fixture with charges at 0/15/45/75/120 days; render test of Dashboard error state (mock query results) shows the banner text.
This task touches the AR report route: it will get an adversarial review focused on the bucket math.

## Task 7: Entity pages, Home visuals, portal polish

Covers roadmap T10 + T13 + T11.

1. `src/components/EntityPage.tsx`: header (title, subtitle, status badge, actions slot), KPI strip (KpiStat), Radix Tabs, optional activity timeline component (`{ date, label, detail }[]`, newest first). Apply to `PropertyDetail` (tabs: Overview, Units, Leases), `TenantDetail` (Overview, Leases, Insurance, Correspondence, Portal), `LeaseDetail` (Terms, Amendments, Notices, Documents, Commissions). Existing forms on those pages keep working; move inline forms into Sheets where they clutter.
2. Home (`Dashboard.tsx`): keep the four KPIs; add three charts from existing endpoints (no new API): occupancy donut (occupied vs vacant SF from rent-roll), AR aging stacked bar (Task 6 buckets), lease-expiry ladder (bar of SF expiring by year, next 6 years, from rent-roll lease end dates). Every chart has an `aria-label` and a visually hidden table fallback. Layout `grid-cols-1 md:grid-cols-2 xl:grid-cols-4` for KPIs.
3. Portal: replace inline `style={{color:'#1B2A4A'}}` and `font-serif` with tokens/classes, use the shared `Card`/`Button`/`Skeleton`/`QueryState`, ensure every portal page has loading skeletons and error states. Do not change any portal data call, Stripe flow, or MFA logic.
4. Pure helpers for charts in `src/components/charts/derive.ts`: `occupancySplit(rentRollRows)`, `expiryLadder(rentRollRows, fromYear, years=6)`; test them.

Tests (first): `tests/components/chart-derive.test.ts` (ladder buckets by year, ignores null end dates, SF-weighted; occupancy split sums to total SF); grep test that `src/portal/**` contains no `style={{` color literals; existing portal tests green.

## Task 8: Admin roles data model

Covers roadmap T12. Auth-sensitive.

1. Migration `supabase/migrations/0018_admin_roles.sql`: table `admin_users (id uuid pk default gen_random_uuid(), email text not null unique (store lower-cased; add check `email = lower(email)`), role text not null check in ('owner','manager','bookkeeper','viewer'), entity_scope uuid[] null, created_at timestamptz default now())`; RLS enabled with no policies (service-role only, matching migration 0013's pattern). Follow `supabase/migrations/README.md` conventions and the migrations-applied CI gate requirements.
2. `server/middleware/admin-auth.ts`: after the existing allowlist + tenant-row checks pass (unchanged, still authoritative), look up `admin_users` by email; set `c.set('adminRole', row?.role ?? 'owner')` and `c.set('adminEntityScope', row?.entity_scope ?? null)`. A lookup error must NOT grant or deny access — log and default to `'owner'` (documented in a comment: roles are not enforced in P1). No route reads the role yet.
3. Export the role type from `server/lib/` for later phases.

Tests (first): pg-mem migration test (table created, role check rejects 'admin', email lower-case check); middleware tests: allowlisted admin with no row → role 'owner'; with row 'viewer' → role 'viewer'; non-allowlisted email with an `admin_users` row → still rejected (allowlist stays authoritative); tenant-row email → still 403; lookup error → access unchanged. All existing `tests/middleware/*` green.
This task will get an adversarial review.

## Task 9: Quality gate and style guide

Covers roadmap T14.

1. ESLint rule (via `no-restricted-syntax` on JSX `className` string literals, or a small local rule) in `eslint.config.js` that errors on `bg-gray-`, `text-gray-`, `bg-blue-`, `text-blue-`, `border-gray-` inside `src/`. Fix every remaining occurrence across `src/` by mapping to tokens (`bg-muted`, `text-muted-foreground`, `bg-primary`, `border-border`, etc.).
2. Update `src/pages/StyleGuide.tsx` to show the new primitives (Dialog, Sheet, Tabs, DataTable sample with fake rows, charts with fake data, toasts) and the corrected parchment swatch; label it "P1 design system".
3. Add `docs/design-system.md` (short): tokens, components, when to use which, DataTable usage, chart rules.

Tests: `npm run lint` clean with the new rule (and a fixture-free check that the rule triggers: a small test running ESLint's `Linter` on a snippet with `className="bg-gray-100"` expects an error).
Done when all gates pass and `npm run build` succeeds.
