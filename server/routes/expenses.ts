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

expensesRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const propertyId = c.req.query('property_id')
  const lq = parseListQuery(c, {
    sortable: ['expense_date', 'amount', 'category'],
    defaultSort: 'expense_date',
    defaultDir: 'desc',
  })
  const { data, error, count } = await applyExpenseFilter(
    db.from('expenses').select('*, properties(name)', { count: 'exact' }),
    propertyId,
  )
    .order(lq.sort, { ascending: lq.ascending })
    .order('id')
    .range(...lq.range!)
  if (error) {
    return listErrorResponse(c, error, 'Failed to load expenses', () =>
      applyExpenseFilter(db.from('expenses').select('id', { count: 'exact', head: true }), propertyId),
    )
  }

  // Whole-filter total (not just this page), summed in integer cents to avoid float drift.
  // Keyset-paged on id (not offset/short-chunk): PostgREST max-rows may be below AMOUNT_CHUNK, so a
  // short chunk does not mean the end. Only an empty chunk stops the loop.
  let cents = 0
  let lastId: string | undefined
  let finished = false
  for (let i = 0; i < MAX_AMOUNT_CHUNKS; i++) {
    let q = applyExpenseFilter(db.from('expenses').select('id, amount'), propertyId).order('id')
    if (lastId !== undefined) q = q.gt('id', lastId)
    const { data: chunk, error: sumError } = await q.limit(AMOUNT_CHUNK)
    if (sumError) return dbError(c, sumError, 'Failed to load expenses')
    const amounts = (chunk ?? []) as Array<{ id: string; amount: number | string | null }>
    if (amounts.length === 0) {
      finished = true
      break
    }
    for (const row of amounts) {
      const n = Number(row.amount)
      if (row.amount === null || !Number.isFinite(n)) {
        return dbError(c, { message: `non-numeric expense amount (id ${row.id})` }, 'Failed to load expenses')
      }
      cents += Math.round(n * 100)
    }
    lastId = amounts[amounts.length - 1].id
  }
  if (!finished) {
    return dbError(c, { message: `expense total exceeded ${MAX_AMOUNT_CHUNKS} chunks` }, 'Failed to load expenses')
  }

  return c.json({ data, total: count ?? 0, total_amount: (cents / 100).toFixed(2) })
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
