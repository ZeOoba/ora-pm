// Pure helpers for RouteError: detect stale-chunk failures (a React.lazy import that 404s after a
// deploy replaced the hashed assets) and reload at most once per session window.
export const CHUNK_RELOAD_KEY = 'ora-pm:chunk-reload'

const CHUNK_RE = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i

export interface ReloadStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function isChunkLoadError(err: unknown): boolean {
  if (typeof err === 'string') return CHUNK_RE.test(err)
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message
    return typeof m === 'string' && CHUNK_RE.test(m)
  }
  return false
}

/** Reloads once for a chunk-load error. Returns true if a reload was triggered. Fails closed (no reload) if storage is unusable, so it can never loop. */
export function tryAutoReload(err: unknown, storage: ReloadStorage, reload: () => void): boolean {
  if (!isChunkLoadError(err)) return false
  try {
    if (storage.getItem(CHUNK_RELOAD_KEY)) return false
    storage.setItem(CHUNK_RELOAD_KEY, '1')
  } catch {
    return false
  }
  reload()
  return true
}

export function clearChunkReloadFlag(storage: ReloadStorage): void {
  try {
    storage.removeItem(CHUNK_RELOAD_KEY)
  } catch {
    /* storage unavailable: nothing to clear */
  }
}
