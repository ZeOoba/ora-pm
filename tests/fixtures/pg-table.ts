// Shared PostgREST stub for route tests (moved from tests/routes/cron-alerts.test.ts).
import { vi } from 'vitest'

export const PG_MAX_ROWS = 1000
export type Row = Record<string, unknown>
export type Call = { method: string; args: unknown[] }

// Minimal PostgREST evaluator: records the chain, applies every filter/order/limit at `await`
// against `rows`, then applies the server row cap. `ignoreGt` simulates a broken keyset (a
// server that ignores the cursor) so the handler's non-advancing-page guard is exercised. A
// filter on a column the row doesn't carry throws, so a wrong column name can't pass silently.
// `error` makes every select resolve with that error instead of data.
export function pgTable(rows: Row[], opts: { insert?: ReturnType<typeof vi.fn>; ignoreGt?: string; error?: { message: string } } = {}) {
  const pages: Call[][] = []
  const table = {
    pages,
    insert: opts.insert ?? vi.fn().mockResolvedValue({ error: null }),
    select() {
      const calls: Call[] = []
      pages.push(calls)
      // A handler whose keyset never advances must fail here, immediately and attributably —
      // the stub resolves synchronously, so an unbounded loop would starve vitest's timeout.
      if (pages.length > 50) throw new Error('pgTable stub: more than 50 selects on one table — pagination is not terminating')
      const b: Record<string, unknown> = {}
      for (const m of ['in', 'eq', 'gt', 'gte', 'lt', 'lte', 'is', 'order', 'limit']) {
        b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b }
      }
      // `.single()`: exactly one row, else PostgREST's PGRST116 error (as supabase-js surfaces it).
      let single = false
      b.single = () => { single = true; return b }
      b.then = (resolve: (v: unknown) => void) => {
        if (opts.error) return resolve({ data: null, error: opts.error })
        if (single) {
          const all = (b as { _rows: () => Row[] })._rows()
          return resolve(all.length === 1
            ? { data: all[0], error: null }
            : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } })
        }
        return resolve({ data: (b as { _rows: () => Row[] })._rows().slice(0, PG_MAX_ROWS), error: null })
      }
      b._rows = () => {
        const col = (r: Row, c: string) => {
          if (!(c in r)) throw new Error(`pgTable stub: filter on unknown column "${c}"`)
          return r[c]
        }
        // Numbers numerically; everything else bytewise (like Postgres uuid/date ordering).
        const cmp = (a: unknown, b2: unknown) => {
          if (typeof a === 'number' && typeof b2 === 'number') return a - b2
          const [x, y] = [String(a), String(b2)]
          return x < y ? -1 : x > y ? 1 : 0
        }
        let out = rows
        for (const { method, args } of calls) {
          const [c, v] = args as [string, unknown]
          if (method === 'in') out = out.filter(r => (v as unknown[]).includes(col(r, c)))
          if (method === 'eq') out = out.filter(r => String(col(r, c)) === String(v))
          // PostgREST `.is(col, null)` — IS NULL (the only form the routes use; `.is(col, true/false)`
          // is not modelled and throws rather than silently matching nothing).
          if (method === 'is') {
            if (v !== null) throw new Error(`pgTable stub: .is() only models IS NULL, got ${String(v)}`)
            out = out.filter(r => col(r, c) === null)
          }
          if (method === 'gt' && !(opts.ignoreGt === c)) out = out.filter(r => cmp(col(r, c), v) > 0)
          if (method === 'gte') out = out.filter(r => cmp(col(r, c), v) >= 0)
          if (method === 'lt') out = out.filter(r => cmp(col(r, c), v) < 0)
          if (method === 'lte') out = out.filter(r => cmp(col(r, c), v) <= 0)
        }
        const order = calls.find(x => x.method === 'order')
        if (order) out = [...out].sort((x, y) => cmp(col(x, order.args[0] as string), col(y, order.args[0] as string)))
        const limit = calls.find(x => x.method === 'limit')
        if (limit) out = out.slice(0, limit.args[0] as number)
        return out
      }
      return b
    },
  }
  return table
}
