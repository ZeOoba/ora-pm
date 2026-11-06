import { supabase } from './supabase'
import { apiErrorMessage, ApiError } from './api-error'

const BASE = '/api'

async function getAdminJwt(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token ?? null
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const jwt = await getAdminJwt()
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
      ...init?.headers,
    },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => null)
    throw new ApiError(apiErrorMessage(err, res.statusText), res.status, err)
  }
  return res.json() as Promise<T>
}

// Authenticated file download — attaches the same Bearer JWT as request(), but
// returns the response body as a Blob (plus the server-supplied filename) rather
// than parsed JSON. Use for endpoints that stream a file attachment.
async function download(
  path: string,
  fallbackFilename = 'download',
): Promise<{ blob: Blob; filename: string }> {
  const jwt = await getAdminJwt()
  const res = await fetch(`${BASE}${path}`, {
    headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
  })
  if (!res.ok) {
    const err = await res.json().catch(() => null)
    throw new Error(apiErrorMessage(err, res.statusText))
  }
  const blob = await res.blob()
  const filename =
    res.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] ??
    fallbackFilename
  return { blob, filename }
}

export type ListQueryParams = Record<string, string | number | boolean | null | undefined>

// Builds `?a=1&b=2` (or '' when empty), omitting undefined / null / '' values.
function buildQuery(params: ListQueryParams): string {
  const sp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    sp.set(key, String(value))
  }
  return sp.toString()
}

const LIST_ALL_PAGE = 200
const LIST_ALL_MAX_ROWS = 5000

function listRowId(row: unknown): string | undefined {
  const id = (row as { id?: unknown } | null)?.id
  return id === undefined || id === null ? undefined : String(id)
}

// One offset-paged pass for api.listAll. `offset` advances by rows FETCHED; returned rows are
// de-duplicated by `id` (rows without one are kept as-is). `totalChanged` reports whether any
// page's total differed from the first page's (a concurrent insert/delete shifted the pages).
async function listAllOnce<T>(path: string, params: ListQueryParams): Promise<{ rows: T[]; totalChanged: boolean }> {
  const rows: T[] = []
  const seen = new Set<string>()
  let fetched = 0
  let firstTotal: number | undefined
  let totalChanged = false
  for (;;) {
    const res = await api.list<T>(path, { ...params, limit: LIST_ALL_PAGE, offset: fetched })
    const total = typeof res.total === 'number' ? res.total : 0
    if (firstTotal === undefined) firstTotal = total
    else if (total !== firstTotal) totalChanged = true
    if (res.data.length === 0) break
    for (const row of res.data) {
      fetched++
      const id = listRowId(row)
      if (id !== undefined) {
        if (seen.has(id)) continue
        seen.add(id)
      }
      rows.push(row)
    }
    if (total > 0) {
      if (fetched >= total) break
    } else if (res.data.length < LIST_ALL_PAGE) {
      break
    }
    if (rows.length >= LIST_ALL_MAX_ROWS) {
      console.warn(`api.listAll(${path}) hit the ${LIST_ALL_MAX_ROWS}-row cap; results truncated`)
      break
    }
  }
  return { rows: rows.slice(0, LIST_ALL_MAX_ROWS), totalChanged }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  // Paged list endpoints return { data, total } (total = full filtered row count).
  list: <T>(path: string, params: ListQueryParams = {}) => {
    const qs = buildQuery(params)
    const sep = path.includes('?') ? '&' : '?'
    return request<{ data: T[]; total: number }>(qs ? `${path}${sep}${qs}` : path)
  },
  // Fetches EVERY row of a paged list endpoint for pickers/selectors (pages of 200). Always stops
  // on an empty page. When total > 0 it pages until rows.length >= total, so a server max_rows
  // below 200 (short but non-final pages) does not truncate. Only when total is 0/absent (a null
  // count falls back to 0) does a short page (< 200) end the loop. Hard cap 5,000 rows (warns).
  // Caller limit/offset are ignored. Rows are de-duplicated by `id`; a total that changes between
  // pages (concurrent insert/delete) triggers one re-fetch from the start.
  listAll: async <T>(path: string, params: ListQueryParams = {}): Promise<T[]> => {
    // F-003: offset paging is not snapshot-isolated. If the total moved between pages, re-fetch
    // once from the start (rows are always de-duplicated by id); a second moving pass is returned
    // as-is (de-duplicated) rather than looping.
    const first = await listAllOnce<T>(path, params)
    if (!first.totalChanged) return first.rows
    return (await listAllOnce<T>(path, params)).rows
  },
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  download: (path: string, fallbackFilename?: string) => download(path, fallbackFilename),
}
