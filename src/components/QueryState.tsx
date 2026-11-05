import type { ReactNode } from 'react'
import { Button } from './ui/Button'
import { Skeleton } from './ui/skeleton'
import { queryStateOf, type QueryLike } from './query-state'

export type { QueryLike } from './query-state'

function errorMessage(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'Failed to load data.'
}

export function QueryState({
  query,
  empty,
  isEmpty,
  skeleton,
  children,
}: {
  query: QueryLike | QueryLike[]
  /** Rendered instead of children when a single query resolves to an empty result. */
  empty?: ReactNode
  isEmpty?: (data: unknown) => boolean
  /** Custom loading placeholder; defaults to three skeleton bars. */
  skeleton?: ReactNode
  children: ReactNode
}) {
  const qs = Array.isArray(query) ? query : [query]
  const state = queryStateOf(query, isEmpty)

  if (state === 'error') {
    const failed = qs.filter((q) => q.isError)
    const messages = [...new Set(failed.map((q) => errorMessage(q.error)))]
    return (
      <div
        role="alert"
        className="mb-4 flex items-center justify-between gap-3 rounded-md border border-status-danger/30 bg-status-danger/5 px-4 py-3 text-sm text-status-danger"
      >
        <div>
          {messages.map((m) => (
            <p key={m}>{m}</p>
          ))}
        </div>
        <Button
          variant="ghost"
          className="border border-status-danger/40 px-3 py-1"
          onClick={() => { for (const q of failed) void q.refetch() }}
        >
          Retry
        </Button>
      </div>
    )
  }
  if (state === 'loading') {
    return (
      <>
        {skeleton ?? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        )}
      </>
    )
  }
  if (state === 'empty' && empty !== undefined) return <>{empty}</>
  return <>{children}</>
}
