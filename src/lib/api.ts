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

export const api = {
  get: <T>(path: string) => request<T>(path),
  // Paged list endpoints return { data, total } (total = full filtered row count).
  list: <T>(path: string, params: ListQueryParams = {}) => {
    const qs = buildQuery(params)
    const sep = path.includes('?') ? '&' : '?'
    return request<{ data: T[]; total: number }>(qs ? `${path}${sep}${qs}` : path)
  },
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  download: (path: string, fallbackFilename?: string) => download(path, fallbackFilename),
}
