import { Hono } from 'hono'
import { getDb } from '../db/client'
import { RenewalUpdateSchema } from '../lib/schemas'
import { dbError } from '../lib/api-error'
import { parseListQuery, listErrorResponse } from '../lib/list-query'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const renewalsRouter = new Hono<{ Bindings: Env }>()

renewalsRouter.get('/', async (c) => {
  const db = getDb(c.env)
  // Historically unpaged: paging only applies when the caller passes limit/offset.
  const lq = parseListQuery(c, {
    sortable: ['expiration_date', 'target_decision_date', 'status'],
    defaultSort: 'expiration_date',
    unpagedByDefault: true,
  })
  let q = db
    .from('renewals')
    .select('*, leases(tenant_id, tenants(name), units(suite, properties(name)))', { count: 'exact' })
    .order(lq.sort, { ascending: lq.ascending })
    .order('id')
  if (lq.range) q = q.range(...lq.range)
  const { data, error, count } = await q
  if (error) {
    return listErrorResponse(c, error, 'Failed to load renewals', () =>
      db.from('renewals').select('id', { count: 'exact', head: true }))
  }
  return c.json({ data, total: count ?? 0 })
})

renewalsRouter.put('/:id', async (c) => {
  const db = getDb(c.env)
  const raw = await c.req.json()
  const parsed = RenewalUpdateSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const { data, error } = await db
    .from('renewals')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('id', c.req.param('id'))
    .select()
    .single()
  if (error) return dbError(c, error, 'Failed to update renewal')
  return c.json({ data })
})
