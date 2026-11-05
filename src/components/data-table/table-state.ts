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

// Fetch every page of the current query (sort / q / filters preserved, paging
// ignored) at EXPORT_PAGE_LIMIT, sequentially, until `total` is reached or
// `maxRows` collected. `truncated` is true when rows were left behind.
export async function collectPages<T>(
  fetchPage: FetchPage<T>,
  state: TableState,
  maxRows: number = EXPORT_MAX_ROWS,
): Promise<{ rows: T[]; total: number; truncated: boolean }> {
  const rows: T[] = []
  let total = 0
  while (rows.length < maxRows) {
    const params = toListParams({ ...state, pageIndex: 0, pageSize: EXPORT_PAGE_LIMIT })
    params.offset = rows.length
    const page = await fetchPage(params)
    total = page.total
    if (page.data.length === 0) break
    rows.push(...page.data)
    if (rows.length >= total) break
  }
  const capped = rows.slice(0, maxRows)
  return { rows: capped, total, truncated: total > capped.length }
}
