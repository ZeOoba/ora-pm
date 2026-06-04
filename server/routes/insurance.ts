import { Hono } from 'hono'
import { getDb } from '../db/client'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const insuranceRouter = new Hono<{ Bindings: Env }>()

insuranceRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const { data, error } = await db
    .from('insurance_certificates')
    .select('*, tenants(name)')
    .order('expiration_date')
  if (error) return c.json({ error: error.message }, 500)

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
  const { data, error } = await db
    .from('insurance_certificates')
    .insert(await c.req.json())
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ data }, 201)
})

insuranceRouter.put('/:id', async (c) => {
  const db = getDb(c.env)
  const { data, error } = await db
    .from('insurance_certificates')
    .update(await c.req.json())
    .eq('id', c.req.param('id'))
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ data })
})
