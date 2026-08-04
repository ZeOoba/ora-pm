import { Hono } from 'hono'
import { getDb } from '../db/client'
import { RenewalUpdateSchema } from '../lib/schemas'
import { dbError } from '../lib/api-error'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const renewalsRouter = new Hono<{ Bindings: Env }>()

renewalsRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const { data, error } = await db
    .from('renewals')
    .select('*, leases(tenant_id, tenants(name), units(suite, properties(name)))')
    .order('expiration_date')
  if (error) return dbError(c, error, 'Failed to load renewals')
  return c.json({ data })
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
