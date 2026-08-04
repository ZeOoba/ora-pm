import { Hono } from 'hono'
import { getDb } from '../db/client'
import { InsuranceInsertSchema, InsuranceUpdateSchema } from '../lib/schemas'
import { dbError } from '../lib/api-error'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const insuranceRouter = new Hono<{ Bindings: Env }>()

insuranceRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const { data, error } = await db
    .from('insurance_certificates')
    .select('*, tenants(name)')
    .order('expiration_date')
  if (error) return dbError(c, error, 'Failed to load insurance certificates')

  // Enrich status based on actual expiration date
  const today = Date.now()
  const enriched = (data ?? []).map((cert: Record<string, unknown>) => {
    const daysUntil = Math.floor(
      (new Date(cert.expiration_date as string).getTime() - today) / 86_400_000
    )
    const status =
      daysUntil < 0 ? 'expired' :
      daysUntil <= 30 ? 'expiring_soon' : 'active'
    return { ...cert, status }
  })

  return c.json({ data: enriched })
})

insuranceRouter.post('/', async (c) => {
  const db = getDb(c.env)
  const raw = await c.req.json()
  const parsed = InsuranceInsertSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const { data, error } = await db
    .from('insurance_certificates')
    .insert(parsed.data)
    .select()
    .single()
  if (error) return dbError(c, error, 'Failed to create insurance certificate')
  return c.json({ data }, 201)
})

insuranceRouter.put('/:id', async (c) => {
  const db = getDb(c.env)
  const raw = await c.req.json()
  const parsed = InsuranceUpdateSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const { data, error } = await db
    .from('insurance_certificates')
    .update(parsed.data)
    .eq('id', c.req.param('id'))
    .select()
    .single()
  if (error) return dbError(c, error, 'Failed to update insurance certificate')
  return c.json({ data })
})
