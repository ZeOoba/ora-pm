import { Hono } from 'hono'
import { getDb } from '../db/client'
import {
  LeaseInsertSchema, LeaseUpdateSchema, LeaseAmendmentInsertSchema, LeaseNoticeInsertSchema,
} from '../lib/schemas'
import { dbError } from '../lib/api-error'
import { parseListQuery, listErrorResponse } from '../lib/list-query'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const leasesRouter = new Hono<{ Bindings: Env }>()

leasesRouter.get('/', async (c) => {
  const db = getDb(c.env)
  // Absent/empty `status` = all statuses; callers wanting only active leases
  // pass ?status=active (every current frontend caller already does).
  const status = c.req.query('status')
  const lq = parseListQuery(c, {
    sortable: ['start_date', 'end_date', 'base_rent_monthly', 'status'],
    defaultSort: 'end_date',
  })
  const base = db
    .from('leases')
    .select('*, tenants(name), units(suite, sf, properties(name))', { count: 'exact' })
  const { data, error, count } = await (status ? base.eq('status', status) : base)
    .order(lq.sort, { ascending: lq.ascending })
    .order('id')
    .range(...lq.range!)
  if (error) {
    return listErrorResponse(c, error, 'Failed to load leases', () => {
      const head = db.from('leases').select('id', { count: 'exact', head: true })
      return status ? head.eq('status', status) : head
    })
  }
  return c.json({ data, total: count ?? 0 })
})

leasesRouter.get('/:id', async (c) => {
  const db = getDb(c.env)
  const { data, error } = await db
    .from('leases')
    .select('*, tenants(*), units(*, properties(*)), lease_amendments(*), lease_documents(*), broker_commissions(*), tenant_notices(*)')
    .eq('id', c.req.param('id'))
    .single()
  // Not-found is a 404, not a 500 — dbError always returns 500, so this
  // stays a plain generic response rather than routing through it.
  if (error) return c.json({ error: 'Lease not found' }, 404)
  return c.json({ data })
})

leasesRouter.post('/', async (c) => {
  const db = getDb(c.env)
  const raw = await c.req.json()
  const parsed = LeaseInsertSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const { data, error } = await db.from('leases').insert(parsed.data).select().single()
  if (error) return dbError(c, error, 'Failed to create lease')
  // Auto-create renewal tracking record — swallow error if renewals table not ready
  if (data) {
    const lease = data as { id: string; end_date: string }
    await db.from('renewals').insert({
      lease_id: lease.id,
      expiration_date: lease.end_date,
      status: 'tracking',
    })
  }
  return c.json({ data }, 201)
})

leasesRouter.put('/:id', async (c) => {
  const db = getDb(c.env)
  const raw = await c.req.json()
  const parsed = LeaseUpdateSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const { data, error } = await db
    .from('leases')
    .update(parsed.data)
    .eq('id', c.req.param('id'))
    .select()
    .single()
  if (error) return dbError(c, error, 'Failed to update lease')
  return c.json({ data })
})

// POST /api/leases/:id/amendments
leasesRouter.post('/:id/amendments', async (c) => {
  const db = getDb(c.env)
  const raw = await c.req.json()
  const parsed = LeaseAmendmentInsertSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const { data, error } = await db
    .from('lease_amendments')
    .insert({ ...parsed.data, lease_id: c.req.param('id') })
    .select()
    .single()
  if (error) return dbError(c, error, 'Failed to create amendment')
  return c.json({ data }, 201)
})

// GET /api/leases/:id/notices
leasesRouter.get('/:id/notices', async (c) => {
  const db = getDb(c.env)
  const { data, error } = await db
    .from('tenant_notices')
    .select('*')
    .eq('lease_id', c.req.param('id'))
    .order('sent_date', { ascending: false })
  if (error) return dbError(c, error, 'Failed to load notices')
  return c.json({ data })
})

// POST /api/leases/:id/notices
leasesRouter.post('/:id/notices', async (c) => {
  const raw = await c.req.json()
  const parsed = LeaseNoticeInsertSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const db = getDb(c.env)
  const { data, error } = await db
    .from('tenant_notices')
    .insert({ ...parsed.data, lease_id: c.req.param('id') })
    .select()
    .single()
  if (error) return dbError(c, error, 'Failed to create notice')
  return c.json({ data }, 201)
})
