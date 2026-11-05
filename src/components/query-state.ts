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

// Error wins over loading: one failed query must show the banner even while a sibling is still
// loading — a page must never render a failed read as zeros. "Empty" applies to a single query only.
export function queryStateOf(query: QueryLike | QueryLike[], isEmpty: (data: unknown) => boolean = defaultIsEmpty): QueryStateKind {
  const qs = Array.isArray(query) ? query : [query]
  if (qs.some((q) => q.isError)) return 'error'
  if (qs.some((q) => q.isPending)) return 'loading'
  if (!Array.isArray(query) && isEmpty(query.data)) return 'empty'
  return 'ready'
}
