import { Hono } from 'hono'
import { getDb } from '../db/client'
import { InsuranceInsertSchema, InsuranceUpdateSchema } from '../lib/schemas'
import { dbError } from '../lib/api-error'
import { parseListQuery } from '../lib/list-query'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const insuranceRouter = new Hono<{ Bindings: Env }>()

insuranceRouter.get('/', async (c) => {
  const db = getDb(c.env)
  // Historically unpaged: paging only applies when the caller passes limit/offset.
  const lq = parseListQuery(c, {
    sortable: ['expiration_date', 'status'],
    defaultSort: 'expiration_date',
    unpagedByDefault: true,
  })
  let q = db
    .from('insurance_certificates')
    .select('*, tenants(name)', { count: 'exact' })
    .order(lq.sort, { ascending: lq.ascending })
    .order('id')
  if (lq.range) q = q.range(...lq.range)
  const { data, error, count } = await q
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

  return c.json({ data: enriched, total: count ?? 0 })
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
