import { useEffect } from 'react'
import { useRouteError } from 'react-router'
import { isChunkLoadError, tryAutoReload } from './route-error'

/** Presentational notice. Never renders the raw error message (may contain internals). */
export function RouteErrorView({ error }: { error: unknown }) {
  const chunk = isChunkLoadError(error)

  useEffect(() => {
    try {
      tryAutoReload(error, window.sessionStorage, () => window.location.reload())
    } catch {
      /* sessionStorage blocked: show the manual notice only */
    }
  }, [error])

  return (
    <div role="alert" className="mx-auto mt-24 max-w-md rounded-lg border border-border bg-card p-6 text-center">
      <h1 className="text-2xl font-display text-navy">Couldn&apos;t load this page</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {chunk
          ? 'A newer version of the app is available. Reload to continue.'
          : 'Something went wrong while showing this page. Reload to try again, or go back to Home.'}
      </p>
      <div className="mt-4 flex items-center justify-center gap-4">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
        >
          Reload
        </button>
        {!chunk && (
          <a href="/" className="text-sm text-primary hover:underline">
            Home
          </a>
        )}
      </div>
    </div>
  )
}

export function RouteError() {
  return <RouteErrorView error={useRouteError()} />
}
