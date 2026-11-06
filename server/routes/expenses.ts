import { Hono } from 'hono'
import { getDb } from '../db/client'
import { ExpenseInsertSchema, ExpenseUpdateSchema } from '../lib/schemas'
import { dbError } from '../lib/api-error'
import { parseListQuery, listErrorResponse } from '../lib/list-query'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const expensesRouter = new Hono<{ Bindings: Env }>()

// PostgREST caps rows per request (max-rows, possibly < 1000), so a whole-filter sum
// keyset-pages through the amounts in chunks of this size until a chunk comes back empty.
const AMOUNT_CHUNK = 1000
// Safety cap (200 chunks): fail loudly rather than return a partial total.
const MAX_AMOUNT_CHUNKS = 200

// One filter function shared by the page query, the count fallback and every
// amount chunk so the Total always reflects exactly the rows the list is filtered to.
function applyExpenseFilter<Q>(q: Q, propertyId: string | undefined): Q {
  return propertyId ? (q as unknown as { eq(col: string, val: string): Q }).eq('property_id', propertyId) : q
}

type AmountSum = { cents: number; rows: number } | { error: { message: string; code?: string } }

// Whole-filter total (not just this page), summed in integer cents to avoid float drift.
// Keyset-paged on id (not offset/short-chunk): PostgREST max-rows may be below AMOUNT_CHUNK, so a
// short chunk does not mean the end. Only an empty chunk stops the loop. Also returns how many
// rows were summed, so the caller can pair total_amount with an exactly matching row count.
async function sumExpenseAmounts(db: ReturnType<typeof getDb>, propertyId: string | undefined): Promise<AmountSum> {
  let cents = 0
  let rows = 0
  let lastId: string | undefined
  for (let i = 0; i < MAX_AMOUNT_CHUNKS; i++) {
    let q = applyExpenseFilter(db.from('expenses').select('id, amount'), propertyId).order('id')
    if (lastId !== undefined) q = q.gt('id', lastId)
    const { data: chunk, error: sumError } = await q.limit(AMOUNT_CHUNK)
    if (sumError) return { error: sumError }
    const amounts = (chunk ?? []) as Array<{ id: string; amount: number | string | null }>
    if (amounts.length === 0) return { cents, rows }
    for (const row of amounts) {
      const n = Number(row.amount)
      if (row.amount === null || !Number.isFinite(n)) {
        return { error: { message: `non-numeric expense amount (id ${row.id})` } }
      }
      cents += Math.round(n * 100)
    }
    rows += amounts.length
    lastId = amounts[amounts.length - 1].id
  }
  return { error: { message: `expense total exceeded ${MAX_AMOUNT_CHUNKS} chunks` } }
}

expensesRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const propertyId = c.req.query('property_id')
  const lq = parseListQuery(c, {
    sortable: ['expense_date', 'amount', 'category'],
    defaultSort: 'expense_date',
    defaultDir: 'desc',
  })
  const readPage = () =>
    applyExpenseFilter(db.from('expenses').select('*, properties(name)', { count: 'exact' }), propertyId)
      .order(lq.sort, { ascending: lq.ascending })
      .order('id')
      .range(...lq.range!)

  // F-002: the page count and the amount sum are separate reads, so a concurrent insert/delete
  // between them could pair a total_amount with a count that excludes (or includes) a row. The
  // sum reports how many rows it covered; if that differs from the page count, re-run page+sum
  // once. If they still differ, return the second read's summed-row count as `total` so `total`
  // and `total_amount` always describe the same set of rows (no extra head-count query needed).
  for (let attempt = 0; ; attempt++) {
    const { data, error, count } = await readPage()
    if (error) {
      return listErrorResponse(c, error, 'Failed to load expenses', () =>
        applyExpenseFilter(db.from('expenses').select('id', { count: 'exact', head: true }), propertyId),
      )
    }
    const sum = await sumExpenseAmounts(db, propertyId)
    if ('error' in sum) return dbError(c, sum.error, 'Failed to load expenses')
    const total = count ?? 0
    if (total === sum.rows || attempt >= 1) {
      return c.json({ data, total: sum.rows, total_amount: (sum.cents / 100).toFixed(2) })
    }
  }
})

expensesRouter.post('/', async (c) => {
  const db = getDb(c.env)
  const raw = await c.req.json()
  const parsed = ExpenseInsertSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const { data, error } = await db.from('expenses').insert(parsed.data).select().single()
  if (error) return c.json({ error: 'Failed to create expense' }, 400)
  return c.json({ data }, 201)
})

expensesRouter.put('/:id', async (c) => {
  const db = getDb(c.env)
  const raw = await c.req.json()
  const parsed = ExpenseUpdateSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const { data, error } = await db
    .from('expenses')
    .update(parsed.data)
    .eq('id', c.req.param('id'))
    .select()
    .single()
  if (error) return c.json({ error: 'Failed to update expense' }, 400)
  return c.json({ data })
})

expensesRouter.delete('/:id', async (c) => {
  const db = getDb(c.env)
  const { error } = await db.from('expenses').delete().eq('id', c.req.param('id'))
  if (error) return dbError(c, error, 'Failed to delete expense')
  return c.json({ success: true })
})
