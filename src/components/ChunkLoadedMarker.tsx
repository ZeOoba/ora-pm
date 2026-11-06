import { useEffect } from 'react'
import { clearChunkReloadFlag } from './route-error'

/** Rendered beside a lazy page inside Suspense: commits only once the chunk loaded, then re-arms the one-shot auto-reload. */
export function ChunkLoadedMarker() {
  useEffect(() => {
    try {
      clearChunkReloadFlag(window.sessionStorage)
    } catch {
      /* storage blocked */
    }
  }, [])
  return null
}
