import { Hono } from 'hono'
import { getDb } from '../db/client'
import {
  LeaseInsertSchema, LeaseUpdateSchema, LeaseAmendmentInsertSchema, LeaseNoticeInsertSchema,
} from '../lib/schemas'
import { dbError } from '../lib/api-error'
import { scheduledLeaseEditProblem, type LeaseMoneyFields, type LeaseScheduleShape } from '../lib/lease-edit-guard'
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
    // 0020 abstract rows (provisions, active rent schedule, critical dates) back the "Rights & Rules" tab.
    .select('*, tenants(*), units(*, properties(*)), lease_amendments(*), lease_documents(*), broker_commissions(*), tenant_notices(*), lease_provisions(*), lease_rent_schedule(*), lease_critical_dates(*)')
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
  const id = c.req.param('id')
  // Plan §5a item 2: a lease billed from its schedule ignores these fields; refuse edits that would look
  // like they change billing, or that move the term outside the schedule (billing would stop).
  const p = parsed.data as LeaseMoneyFields
  if (['base_rent_monthly', 'cam_estimate_monthly', 'start_date', 'end_date'].some((k) => k in p)) {
    const [cur, rent, cam] = await Promise.all([
      db.from('leases').select('base_rent_monthly, cam_estimate_monthly, start_date, end_date').eq('id', id).maybeSingle(),
      db.from('lease_rent_schedule').select('effective_start, effective_end, superseded_at').eq('lease_id', id),
      db.from('lease_recurring_charges').select('id').eq('lease_id', id).eq('type', 'cam_estimate').is('superseded_at', null).limit(1),
    ])
    const readErr = cur.error ?? rent.error ?? cam.error
    if (readErr) return dbError(c, readErr, 'Failed to update lease')
    if (cur.data) {
      const problem = scheduledLeaseEditProblem(cur.data as LeaseMoneyFields, p, {
        rent: (rent.data ?? []) as LeaseScheduleShape['rent'],
        hasActiveCam: (cam.data ?? []).length > 0,
      })
      if (problem) return c.json({ error: problem }, 409)
    }
  }
  const { data, error } = await db
    .from('leases')
    .update(parsed.data)
    .eq('id', id)
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
