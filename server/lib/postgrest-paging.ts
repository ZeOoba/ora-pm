// PostgREST read helpers shared by every route that can read more than one page of rows.
// Moved verbatim from server/routes/cron.ts; see each function's comment for its contract.

// Runs `fetchChunk` once per chunkSize-sized slice of `ids`, concatenating results — used to keep
// every `.in('lease_id', ids)` bulk query under a proxy URL-length limit regardless of how many
// ids are involved, instead of either one unbounded query (risks the URL-length wall) or one
// query per id (the O(leases) subrequest bug this whole file exists to avoid). Stops and surfaces
// the error on the first failing chunk — never returns partial data silently, since a caller here
// must be able to tell "some ids' state is unknown" from "confirmed empty."
//
// Row cap: PostgREST returns at most `max_rows` rows per request and truncates SILENTLY — no
// error, no marker. A chunk that comes back with >= `maxRows` rows cannot be told apart from a
// truncated one, so it is returned as an error (same fail-closed path as a query error) rather
// than as data. `maxRows` is required, not defaulted: every caller must decide it, and a chunk
// size small enough that real results stay well under the cap is what keeps this from tripping.
export async function fetchChunked<T>(
  ids: string[],
  chunkSize: number,
  // PromiseLike, not Promise: Supabase's un-awaited query builder is thenable (awaitable at
  // runtime) but doesn't structurally satisfy the full Promise interface (catch/finally/
  // Symbol.toStringTag) that TS requires for a bare Promise<...> parameter type.
  fetchChunk: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  { maxRows }: { maxRows: number }
): Promise<{ data: T[]; error: { message: string } | null }> {
  const all: T[] = []
  for (let i = 0; i < ids.length; i += chunkSize) {
    const { data, error } = await fetchChunk(ids.slice(i, i + chunkSize))
    if (error) return { data: all, error }
    if ((data?.length ?? 0) >= maxRows) {
      return { data: all, error: { message: `chunk of ${Math.min(chunkSize, ids.length - i)} ids returned ${data!.length} rows: at the PostgREST row cap (${maxRows}), result may be truncated` } }
    }
    all.push(...(data ?? []))
  }
  return { data: all, error: null }
}

// PostgREST `max_rows` (supabase/config.toml; the hosted default is the same). The guards below
// assume the SERVER cap is >= this value: if it were lower, a truncated response would be shorter
// than this and read as complete. tests/routes/cron-postgrest-max-rows-config.test.ts pins it to
// the local config; the hosted project's setting is not visible from this repo.
export const POSTGREST_MAX_ROWS = 1000

// Keyset pagination for a query whose result set is NOT bounded by a chunk of ids (a whole-table
// select). `fetchPage(after)` must filter `key > after` (when `after` is non-null), order by the
// same unique key ascending, and `.limit(POSTGREST_MAX_ROWS)`. A page shorter than the limit is
// the last one. Keyset rather than `.range()` offsets: a row whose filter state changes between
// pages (e.g. a balance crossing 0) shifts every later offset and silently skips or repeats a row;
// a key cursor cannot. Every page is checked to be strictly ascending and past the cursor — a page
// that isn't (cursor ignored, wrong sort) would loop forever or double-count, so it fails closed.
// Keys must be UUIDs: Postgres orders uuid bytewise, which for PostgREST's lowercase canonical
// text form is the same order as JS string comparison. (A text key under a non-C collation is not.)
export async function fetchAllPages<T>(
  fetchPage: (after: string | null) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  keyOf: (row: T) => string
): Promise<{ data: T[]; error: { message: string } | null }> {
  const all: T[] = []
  let after: string | null = null
  for (;;) {
    const { data, error } = await fetchPage(after)
    if (error) return { data: all, error }
    const page = data ?? []
    let prev: string | null = after
    for (const row of page) {
      const key = keyOf(row)
      if (prev !== null && !(key > prev)) {
        return { data: all, error: { message: `keyset page not strictly ascending past cursor ${after} (at ${key}): pagination unreliable, result may be incomplete` } }
      }
      prev = key
    }
    all.push(...page)
    if (page.length < POSTGREST_MAX_ROWS) return { data: all, error: null }
    after = prev
  }
}
