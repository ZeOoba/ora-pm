import { Hono } from 'hono'
import { getDb } from '../db/client'
import { TenantInsertSchema, TenantUpdateSchema, PaginationSchema } from '../lib/schemas'

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
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

tenantsRouter.get('/:id', async (c) => {
  const db = getDb(c.env)
  const { data, error } = await db
    .from('tenants')
    .select('*, leases(*, units(*, properties(name))), insurance_certificates(*), correspondence_log(*)')
    .eq('id', c.req.param('id'))
    .single()
  if (error) return c.json({ error: error.message }, 404)
  return c.json({ data })
})

tenantsRouter.post('/', async (c) => {
  const db = getDb(c.env)
  const raw = await c.req.json()
  const parsed = TenantInsertSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const { data, error } = await db.from('tenants').insert(parsed.data).select().single()
  if (error) return c.json({ error: 'Failed to create tenant' }, 400)
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
  if (error) return c.json({ error: 'Failed to update tenant' }, 400)
  return c.json({ data })
})

// POST /api/tenants/:id/correspondence
tenantsRouter.post('/:id/correspondence', async (c) => {
  const body = await c.req.json()
  if (!body.direction || !body.contact_date || !body.subject || !body.summary || !body.method) {
    return c.json({ error: 'direction, contact_date, subject, summary, method required' }, 400)
  }
  const { direction, contact_date, subject, summary, method } = body
  const db = getDb(c.env)
  const { data, error } = await db
    .from('correspondence_log')
    .insert({ direction, contact_date, subject, summary, method, tenant_id: c.req.param('id') })
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ data }, 201)
})
