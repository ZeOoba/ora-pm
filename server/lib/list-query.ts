import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { ListQuerySchema } from './schemas'
import { dbError } from './api-error'

export type ListQueryOptions = {
  /** Columns the client may sort by (allow-list; anything else is a 422). */
  sortable: readonly string[]
  /** Sort column used when `sort` is absent (preserves each route's prior order). */
  defaultSort: string
  /** Direction used when `dir` is absent. Defaults to 'asc'. */
  defaultDir?: 'asc' | 'desc'
  /** Columns searched (ilike, OR-ed) by `q`. Omit for routes with no search. */
  searchColumns?: readonly string[]
  /**
   * For routes that historically returned every row (units, insurance,
   * renewals): when neither `limit` nor `offset` is supplied, `range` is null
   * and the route must not page. Paging applies as soon as either is given.
   */
  unpagedByDefault?: boolean
}

export type ListQuery = {
  limit: number
  offset: number
  /** Inclusive PostgREST range bounds, or null when the route is unpaged. */
  range: [number, number] | null
  sort: string
  ascending: boolean
  q?: string
  /** Ready-to-use argument for `.or(...)`, or null when there is nothing to search. */
  searchFilter: string | null
}

function reject(c: Context, status: 422, body: unknown): never {
  throw new HTTPException(status, { res: c.json(body as Record<string, unknown>, status) })
}

/**
 * Build a PostgREST `.or()` filter doing a case-insensitive substring match of
 * `q` across `columns`.
 *
 * `q` is user input spliced into a filter *string*, so it is neutralised twice:
 *  1. LIKE-escape `\`, `%`, `_` so they match literally (not as wildcards);
 *     `*` (PostgREST's `%` alias) is dropped since it cannot be escaped.
 *  2. Wrap the pattern in a PostgREST double-quoted value, escaping `\` and
 *     `"`. Inside quotes `, ( ) :` are literal, so a hostile `q` cannot end
 *     the clause or add new filters.
 */
export function buildSearchFilter(q: string | undefined, columns: readonly string[] | undefined): string | null {
  if (!q || !columns || columns.length === 0) return null
  const cleaned = q.replace(/\*/g, '')
  if (cleaned.length === 0) return null
  const likeEscaped = cleaned.replace(/[\\%_]/g, (ch) => `\\${ch}`)
  const pattern = `%${likeEscaped}%`
  const quoted = `"${pattern.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`
  return columns.map((col) => `${col}.ilike.${quoted}`).join(',')
}

/**
 * Parse limit/offset/sort/dir/q for a paged list endpoint. Invalid input
 * (limit outside 1-200, negative offset, bad dir, over-long q, sort not in
 * the allow-list) is a 422, never a 500.
 */
export function parseListQuery(c: Context, opts: ListQueryOptions): ListQuery {
  const parsed = ListQuerySchema.safeParse({
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
    sort: c.req.query('sort') || undefined,
    dir: c.req.query('dir') || undefined,
    q: c.req.query('q'),
  })
  if (!parsed.success) return reject(c, 422, { error: parsed.error.flatten().fieldErrors })

  const { limit, offset } = parsed.data
  const sort = parsed.data.sort ?? opts.defaultSort
  if (!opts.sortable.includes(sort)) return reject(c, 422, { error: 'Invalid sort field' })

  const dirGiven = Boolean(c.req.query('dir'))
  const dir = dirGiven ? parsed.data.dir : (opts.defaultDir ?? 'asc')
  const q = parsed.data.q || undefined

  const paged = !opts.unpagedByDefault || c.req.query('limit') !== undefined || c.req.query('offset') !== undefined

  return {
    limit,
    offset,
    range: paged ? [offset, offset + limit - 1] : null,
    sort,
    ascending: dir === 'asc',
    q,
    searchFilter: buildSearchFilter(q, opts.searchColumns),
  }
}

type HeadCountResult = { count: number | null; error: { message: string; code?: string } | null }

/**
 * Error path shared by every paged list route. With `count: 'exact'`, PostgREST
 * answers 416 / PGRST103 ("Requested range not satisfiable") when `offset` is
 * past the filtered total; that is an empty page, not a failure. Re-run the
 * same filtered query as a head-only count (no range) for the real total and
 * return `{ data: [], total }`. Every other error (and a failed head count)
 * goes to dbError unchanged.
 *
 * `headCount` must build the query with the route's own filters (via its
 * `applyFilters`) on `.select('id', { count: 'exact', head: true })`.
 */
export async function listErrorResponse(
  c: Context,
  error: { message: string; code?: string },
  publicMsg: string,
  headCount: () => PromiseLike<HeadCountResult>,
) {
  if (error.code !== 'PGRST103') return dbError(c, error, publicMsg)
  const head = await headCount()
  if (head.error) return dbError(c, head.error, publicMsg)
  return c.json({ data: [], total: head.count ?? 0 })
}
