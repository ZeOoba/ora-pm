// Pure table-state helpers: state -> list-API query params, paging math, and
// the sequential "fetch everything" loop used by CSV export. No React here.

export type TableState = {
  pageIndex: number
  pageSize: number
  sort?: { id: string; desc: boolean }
  q?: string
  filters: Record<string, string>
}

export type ListParams = {
  limit: number
  offset: number
  sort?: string
  dir?: 'asc' | 'desc'
  q?: string
  [filter: string]: string | number | undefined
}

export type PageResult<T> = { data: T[]; total: number }
export type FetchPage<T> = (params: ListParams) => Promise<PageResult<T>>

export const PAGE_SIZES = [25, 50, 100] as const
export const DEFAULT_PAGE_SIZE = 50
export const EXPORT_PAGE_LIMIT = 200
export const EXPORT_MAX_ROWS = 2000

const RESERVED_KEYS = new Set(['limit', 'offset', 'sort', 'dir', 'q'])

export function toListParams(state: TableState): ListParams {
  const params: ListParams = {
    limit: state.pageSize,
    offset: state.pageIndex * state.pageSize,
  }
  if (state.sort) {
    params.sort = state.sort.id
    params.dir = state.sort.desc ? 'desc' : 'asc'
  }
  const q = state.q?.trim()
  if (q) params.q = q
  for (const [key, value] of Object.entries(state.filters)) {
    if (RESERVED_KEYS.has(key)) {
      if (import.meta.env?.DEV) console.warn(`DataTable: filter id "${key}" is reserved and was ignored`)
      continue
    }
    if (value !== '' && value !== undefined) params[key] = value
  }
  return params
}

/** Page-size choices; includes a non-standard current size so the Select can show it. */
export function pageSizeOptions(pageSize: number): number[] {
  const base: number[] = [...PAGE_SIZES]
  return base.includes(pageSize) ? base : [...base, pageSize].sort((a, b) => a - b)
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize))
}

export function rangeLabel(pageIndex: number, pageSize: number, total: number): string {
  if (total <= 0) return 'Showing 0 of 0'
  const start = pageIndex * pageSize + 1
  const end = Math.min(total, (pageIndex + 1) * pageSize)
  return `Showing ${start}–${end} of ${total}`
}

export type CollectResult<T> = {
  rows: T[]
  total: number
  truncated: boolean
  /** Rows changed under the export on both passes; the caller should warn the user. */
  inconsistent: boolean
}

/** Row identity for export de-duplication; undefined = row cannot be de-duplicated. */
export type GetRowKey<T> = (row: T, index: number) => string | undefined

function defaultRowKey<T>(row: T): string | undefined {
  const id = (row as { id?: unknown } | null)?.id
  return id === undefined || id === null ? undefined : String(id)
}

// One pass over every page. `offset` advances by rows FETCHED (server offset), while the
// returned rows are de-duplicated by key. `consistent` is false when any page reported a
// different total than the first, or (when not capped) the unique count != the final total.
async function collectOnce<T>(
  fetchPage: FetchPage<T>,
  state: TableState,
  maxRows: number,
  getKey: GetRowKey<T>,
): Promise<CollectResult<T> & { consistent: boolean }> {
  const rows: T[] = []
  const seen = new Set<string>()
  let fetched = 0
  let firstTotal: number | undefined
  let total = 0
  let totalsVaried = false
  while (rows.length < maxRows) {
    const params = toListParams({ ...state, pageIndex: 0, pageSize: EXPORT_PAGE_LIMIT })
    params.offset = fetched
    const page = await fetchPage(params)
    total = page.total
    if (firstTotal === undefined) firstTotal = total
    else if (total !== firstTotal) totalsVaried = true
    if (page.data.length === 0) break
    for (const row of page.data) {
      const key = getKey(row, fetched)
      fetched++
      if (key !== undefined) {
        if (seen.has(key)) continue
        seen.add(key)
      }
      rows.push(row)
    }
    if (fetched >= total) break
  }
  const capped = rows.length >= maxRows
  const out = rows.slice(0, maxRows)
  const consistent = !totalsVaried && (capped || out.length === total)
  return { rows: out, total, truncated: total > out.length, inconsistent: !consistent, consistent }
}

// Fetch every page of the current query (sort / q / filters preserved, paging
// ignored) at EXPORT_PAGE_LIMIT, sequentially, until `total` is reached or
// `maxRows` collected. `truncated` is true when rows were left behind.
// Offset paging is not snapshot-isolated: a row inserted/deleted mid-export shifts later
// pages (F-001). Rows are de-duplicated by `getKey` (default: row.id), and if the pass was
// inconsistent (total changed between pages, or unique rows != total) the whole collection is
// re-run once; if the re-run is still inconsistent, `inconsistent: true` tells the caller to warn.
export async function collectPages<T>(
  fetchPage: FetchPage<T>,
  state: TableState,
  maxRows: number = EXPORT_MAX_ROWS,
  getKey: GetRowKey<T> = defaultRowKey,
): Promise<CollectResult<T>> {
  let pass = await collectOnce(fetchPage, state, maxRows, getKey)
  if (!pass.consistent) pass = await collectOnce(fetchPage, state, maxRows, getKey)
  const { rows, total, truncated, inconsistent } = pass
  return { rows, total, truncated, inconsistent }
}

// ── Client mode ────────────────────────────────────────────────────────────
// For endpoints that return the whole (unpaged) dataset: sort / search /
// filter / paginate in memory with the same TableState the server mode uses.

export type ClientOptions<T> = {
  /** Row matches the (trimmed, non-empty) search text. */
  searchFn?: (row: T, q: string) => boolean
  /** Value to sort by for a column id. */
  getSortValue?: (row: T, columnId: string) => unknown
  /** Row passes the non-empty filter values. */
  filterFn?: (row: T, filters: Record<string, string>) => boolean
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true })
}

const isNil = (v: unknown) => v === null || v === undefined || v === ''

/** Filter + search + sort (no paging). Pure; never mutates `rows`. */
export function clientFilterSort<T>(rows: readonly T[], state: TableState, opts: ClientOptions<T>): T[] {
  let out = [...rows]
  const activeFilters = Object.fromEntries(
    Object.entries(state.filters).filter(([, v]) => v !== '' && v !== undefined),
  )
  if (opts.filterFn && Object.keys(activeFilters).length > 0) {
    out = out.filter((r) => opts.filterFn!(r, activeFilters))
  }
  const q = state.q?.trim()
  if (q && opts.searchFn) out = out.filter((r) => opts.searchFn!(r, q))
  const sort = state.sort
  if (sort && opts.getSortValue) {
    const dir = sort.desc ? -1 : 1
    const get = opts.getSortValue
    out.sort((ra, rb) => {
      const a = get(ra, sort.id)
      const b = get(rb, sort.id)
      if (isNil(a) && isNil(b)) return 0
      if (isNil(a)) return 1 // nulls last regardless of direction
      if (isNil(b)) return -1
      return dir * compareValues(a, b)
    })
  }
  return out
}

/** One page of the filtered/sorted rows plus the full filtered total. */
export function clientPage<T>(rows: readonly T[], state: TableState, opts: ClientOptions<T>): PageResult<T> {
  const all = clientFilterSort(rows, state, opts)
  const start = state.pageIndex * state.pageSize
  return { data: all.slice(start, start + state.pageSize), total: all.length }
}
