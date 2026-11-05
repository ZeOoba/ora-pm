// Pure state mapping for <QueryState> (separate file so QueryState.tsx exports only components).

// The slice of a TanStack Query result QueryState reads — any useQuery() result satisfies it.
export interface QueryLike {
  isPending: boolean
  isError: boolean
  error: unknown
  data: unknown
  refetch: () => unknown
}

export type QueryStateKind = 'loading' | 'error' | 'empty' | 'ready'

const defaultIsEmpty = (data: unknown) => Array.isArray(data) && data.length === 0

// A query "blocks" with the error banner only on a first-load failure (errored AND no data). A failed
// background refetch that kept its data is non-blocking: see staleErrors().
const failedFirstLoad = (q: QueryLike) => q.isError && q.data === undefined

/** Queries whose latest refetch failed but which still hold last-loaded data. */
export function staleErrors(query: QueryLike | QueryLike[]): QueryLike[] {
  const qs = Array.isArray(query) ? query : [query]
  return qs.filter((q) => q.isError && q.data !== undefined)
}

/** The queries that block rendering with the error banner (first-load failures). */
export function blockingErrors(query: QueryLike | QueryLike[]): QueryLike[] {
  const qs = Array.isArray(query) ? query : [query]
  return qs.filter(failedFirstLoad)
}

// First-load error wins over loading: one failed query must show the banner even while a sibling is
// still loading — a page must never render a failed read as zeros. Pending shows the skeleton only
// when there is no data. "Empty" applies to a single query only.
export function queryStateOf(query: QueryLike | QueryLike[], isEmpty: (data: unknown) => boolean = defaultIsEmpty): QueryStateKind {
  const qs = Array.isArray(query) ? query : [query]
  if (qs.some(failedFirstLoad)) return 'error'
  if (qs.some((q) => q.isPending && q.data === undefined)) return 'loading'
  if (!Array.isArray(query) && isEmpty(query.data)) return 'empty'
  return 'ready'
}
