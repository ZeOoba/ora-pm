import { Hono } from 'hono'
import { getDb } from '../db/client'
import { TenantInsertSchema, TenantUpdateSchema, PaginationSchema, TenantCorrespondenceInsertSchema } from '../lib/schemas'
import { dbError } from '../lib/api-error'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const tenantsRouter = new Hono<{ Bindings: Env }>()

tenantsRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const { limit, offset } = PaginationSchema.parse({
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
  })
  const { data, error } = await db
    .from('tenants')
    .select('*')
    .order('name')
    .range(offset, offset + limit - 1)
  if (error) return dbError(c, error, 'Failed to load tenants')
  return c.json({ data })
})

tenantsRouter.get('/:id', async (c) => {
  const db = getDb(c.env)
  const { data, error } = await db
    .from('tenants')
    .select('*, leases(*, units(*, properties(name))), insurance_certificates(*), correspondence_log(*)')
    .eq('id', c.req.param('id'))
    .single()
  // Not-found is a 404, not a 500 — dbError always returns 500, so this
  // stays a plain generic response rather than routing through it.
  if (error) return c.json({ error: 'Tenant not found' }, 404)
  return c.json({ data })
})

tenantsRouter.post('/', async (c) => {
  const db = getDb(c.env)
  const raw = await c.req.json()
  const parsed = TenantInsertSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const { data, error } = await db.from('tenants').insert(parsed.data).select().single()
  if (error) return dbError(c, error, 'Failed to create tenant')
  return c.json({ data }, 201)
})

tenantsRouter.put('/:id', async (c) => {
  const db = getDb(c.env)
  const raw = await c.req.json()
  const parsed = TenantUpdateSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const { data, error } = await db
    .from('tenants')
    .update(parsed.data)
    .eq('id', c.req.param('id'))
    .select()
    .single()
  if (error) return dbError(c, error, 'Failed to update tenant')
  return c.json({ data })
})

// POST /api/tenants/:id/correspondence
tenantsRouter.post('/:id/correspondence', async (c) => {
  const raw = await c.req.json()
  const parsed = TenantCorrespondenceInsertSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const db = getDb(c.env)
  const { data, error } = await db
    .from('correspondence_log')
    .insert({ ...parsed.data, tenant_id: c.req.param('id') })
    .select()
    .single()
  if (error) return dbError(c, error, 'Failed to create correspondence entry')
  return c.json({ data }, 201)
})
