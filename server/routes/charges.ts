import { Hono } from 'hono'
import { getDb } from '../db/client'
import { ChargeInsertSchema, PaginationSchema } from '../lib/schemas'
import { dbError } from '../lib/api-error'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const chargesRouter = new Hono<{ Bindings: Env }>()

// Admin list: returns voided rows too (OI-278 / migration 0014 — they are the audit trail;
// `select('*')` carries voided_at/void_reason and BillingDashboard.tsx marks them). Every money
// path (ar_ledger, cron sums, portal, exports, reports, cam) filters `voided_at IS NULL` itself.
chargesRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const leaseId = c.req.query('lease_id')
  const { limit, offset } = PaginationSchema.parse({
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
  })
  let q = db.from('charges').select('*, leases(tenant_id, tenants(name))').order('charge_date', { ascending: false })
  if (leaseId) q = q.eq('lease_id', leaseId)
  const { data, error } = await q.range(offset, offset + limit - 1)
  if (error) return dbError(c, error, 'Failed to load charges')
  return c.json({ data })
})

// OI-046 gap closure: migration 0011 made charges.idempotency_key NOT NULL
// with no DB default. A client-supplied key (e.g. an admin UI dedupe-ing a
// double-click/retry by resending the same value) passes through unchanged;
// otherwise default to a fresh manual:<uuid> so the insert still satisfies
// the NOT NULL constraint. `manual:` (not `legacy:`, which 0011's backfill
// reserved) keeps this generation obviously distinct from that migration.
chargesRouter.post('/', async (c) => {
  const db = getDb(c.env)
  const raw = await c.req.json()
  const parsed = ChargeInsertSchema.safeParse({ ...raw, source: 'manual' })
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const idempotencyKey = parsed.data.idempotency_key ?? `manual:${crypto.randomUUID()}`
  const { data, error } = await db
    .from('charges')
    .insert({ ...parsed.data, idempotency_key: idempotencyKey })
    .select()
    .single()
  if (error) return dbError(c, error, 'Failed to create charge')
  return c.json({ data }, 201)
})

// DELETE is NOT the void path. Voiding (voided_at + void_reason, migration 0014) keeps the row as
// an audit record and is reversible; deletion is neither. Auto charges stay undeletable — the
// OI-278 population was retired via migration 0015's guarded UPDATE, and any future void action
// should set the two columns, never call this route.
chargesRouter.delete('/:id', async (c) => {
  const db = getDb(c.env)
  const { data: charge } = await db
    .from('charges')
    .select('source')
    .eq('id', c.req.param('id'))
    .single()
  if (!charge) return c.json({ error: 'Charge not found' }, 404)
  if ((charge as { source: string }).source === 'auto') {
    return c.json({ error: 'Auto-generated charges cannot be deleted' }, 400)
  }
  const { error } = await db.from('charges').delete().eq('id', c.req.param('id'))
  if (error) return dbError(c, error, 'Failed to delete charge')
  return c.json({ success: true })
})
