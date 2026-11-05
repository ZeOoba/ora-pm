# ORA PM design system (P1)

Live reference: `/styleguide`. Everything is bundled (self-hosted fonts, no CDN). No dark mode in P1.

## Tokens

Defined once in `src/index.css` under `@theme`; use the utility classes, never raw hex or the Tailwind gray/blue palette.

| Group | Tokens |
|---|---|
| Brand | `navy #1B2A4A`, `navy-700 #243660`, `gold #C9A96E`, `gold-600 #B8975A`, `parchment #F5F3EF`, `ivory #FBF9F4` |
| Status | `status-active`, `status-warning`, `status-danger`, `status-pending`, `status-neutral` (use `/5`, `/30` alpha for tinted surfaces) |
| Semantic (shadcn) | `background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `muted-foreground`, `accent`, `destructive`, `border`, `input`, `ring` |
| Charts | `chart-1` … `chart-5` |
| Type | `font-display` (EB Garamond, headings), `font-sans` (DM Sans, body), `font-mono` (IBM Plex Mono, data) |

Common mappings: secondary text `text-muted-foreground`; body text `text-foreground`; panels and table stripes `bg-muted`; hairlines `border-border` / `divide-border`; primary action `bg-primary text-primary-foreground`; focus `ring-ring`.

**Lint guard:** `bg-/text-/border-/divide-/ring-` with `gray-` or `blue-` fails `npm run lint` anywhere in `src/` (string literals, template literals, `cn()`/`clsx()` args). Rule: `eslint.palette.js`, tested in `tests/config/lint-palette-rule.test.ts`.

## Components

| Need | Use |
|---|---|
| Button / card / badge | `ui/Button` (`navy`, `gold`, `ghost`, `danger`), `ui/Card` (`flat`, `default`, `raised`), `ui/Badge` + `StatusBadge` |
| Headline number | `ui/KpiStat` (`warn` for problems) |
| Nothing to show | `ui/EmptyState` (title, message, optional action) |
| File upload | `ui/FileDropZone` |
| Forms | `form/Field` + `form/inputs`, `form/FormActions` |
| Overlays | `ui/dialog` (modal), `ui/sheet` (side panel), `ui/popover`, `ui/tooltip`, `ui/dropdown-menu` |
| Confirming an action | `ConfirmDialog` (never `confirm()` / `alert()`; a test enforces this) |
| Notifications | `toast` from `sonner`; one `<Toaster />`, mounted in `App.tsx` only |
| Loading | `ui/skeleton`; route-level fallback is `PageSkeleton` |
| Detail pages | `EntityPage` (header, KPI strip, tabs, activity timeline) |
| Lists and tables | `data-table/DataTable` (never a hand-rolled `<table>` for data; a test enforces this) |
| Global search | `CommandMenu` (cmdk, opened from `AppShell`); navigation lives in `nav-config.ts` |

## DataTable

```tsx
const h = dataTableColumnHelper<Tenant>()
const columns = [
  h.accessor('name', { header: 'Company', enableSorting: true }),
  h.accessor('rent', { header: 'Rent', meta: { numeric: true } }),
]
<DataTable<Tenant>
  columns={columns}
  queryKey={['tenants', 'list']}
  fetchPage={(p) => api.list<Tenant>('/tenants', p)}
  rowHref={(t) => `/tenants/${t.id}`}
  csvFilename={csvFilename('tenants')}
  initialSort={{ id: 'name', desc: false }}
/>
```

- **Server mode (default):** supply `fetchPage`. Search, sort, filters and paging go to the endpoint as `q`, `sort`, `limit`, `offset`; the endpoint returns `{ data, total }` (`total` = full filtered count). The previous page stays visible while the next loads.
- **Client mode:** `mode="client"` plus `rows` (`undefined` = loading), optional `clientSearchFn` / `clientFilterFn`, `error` + `onRetry`. Use only when the page already holds the whole dataset.
- **Sorting is opt-in per column** (`enableSorting: true`). The column `id` (or accessor key) is sent as the `sort` param, so enable it only for columns the endpoint allowlists.
- **Rows:** `rowHref` makes rows clickable; `getRowId` is required for rows without an `id` (the index fallback is unstable across pages); `bulkActions` adds a checkbox column.
- **Export:** `csvFilename` enables CSV for the current filter (capped at `EXPORT_MAX_ROWS`). Display columns without an accessor or `meta.csv` are skipped.
- **Pickers and selectors:** do not use `api.list` for dropdown data (it returns one page). Use `api.listAll<T>('/properties')`, which pages through every row (200 per request, 5,000-row cap). `units`, `insurance` and `renewals` endpoints are unpaged unless `limit`/`offset` is passed; give `DataTable` an explicit `limit`/`offset` (server mode does) when pointing it at them.

## Loading and errors: QueryState

`<QueryState query={q}>` (or an array of queries) wraps content that depends on queries.

- **First-load failure** (errored and no data): blocking red banner with Retry. A failed read is never rendered as zeros, and the banner wins even while sibling queries are still loading.
- **Refetch failure** (errored but data present): non-blocking "Couldn't refresh - showing last loaded data" notice with Retry; children keep rendering the stale data.
- **Loading** (pending, no data): skeleton (or the `skeleton` prop).
- **Empty:** single query only; pass `empty` (and optionally `isEmpty`). Defaults to an empty array.
- Use `<StaleDataWarning query={q} />` directly when you manage the loading UI yourself.

## Charts

Recharts via `ui/chart` (`ChartContainer`, `ChartTooltip`, `ChartLegend`). Rules, as implemented in `components/charts/*`:

1. **Colors are tokens with a fallback:** `fill={`var(--color-${key}, var(--color-chart-1))`}`; series colors come from `chart-*` or `status-*`, never hex.
2. **Accessible name:** wrap the chart in `role="img"` with an `aria-label` that states the total and the series values; set `aria-hidden="true"` on the SVG container.
3. **Data table alternative:** include an `sr-only` `<table>` (caption, `scope` headers) carrying the same numbers.
4. Disable animation (`isAnimationActive={false}`); format values with `lib/format`. Charts render server-computed figures as-is and never re-derive buckets or money.

## Money-adjacent actions

Any click that moves or records money (payments, voids, CAM reconciliation, revoking access) must be guarded with `runExclusive` from `lib/run-exclusive.ts`:

```tsx
const inFlight = useRef(false)
await runExclusive(inFlight, () => api.post(path, body))
```

The ref flag is set synchronously, so a second click in the same tick is skipped (React state cannot guarantee that); it clears in `finally`, including on rejection. Pair it with a disabled button and a `ConfirmDialog` (`pending` blocks dismissal and double submit).

## Code splitting

Pages are `React.lazy` in `src/router.tsx`; only `AppShell`, the auth guard, `AdminLogin` and the `RouteError` boundary stay eager; every page (including Payments, CAM, Expenses, Budgets, Insurance) is lazy, and `Suspense` sits inside the shell with `PageSkeleton`. Add new pages with the same `lazy(() => import(...).then(m => ({ default: m.Name })))` pattern. Heavy vendors are split in `vite.config.ts` (`manualChunks`); keep every chunk under 500 kB. Every route has `errorElement: <RouteError />`: a stale-chunk failure after a deploy auto-reloads once (sessionStorage-guarded) and otherwise shows a branded "Couldn't load this page" notice with Reload/Home; the raw error is never shown.
