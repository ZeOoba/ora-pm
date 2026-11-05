import { Hono } from 'hono'
import { getDb } from '../db/client'
import { PaymentInsertSchema } from '../lib/schemas'
import { dbError } from '../lib/api-error'
import { parseListQuery, listErrorResponse } from '../lib/list-query'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const paymentsRouter = new Hono<{ Bindings: Env }>()

paymentsRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const leaseId = c.req.query('lease_id')
  const lq = parseListQuery(c, {
    sortable: ['payment_date', 'amount'],
    defaultSort: 'payment_date',
    defaultDir: 'desc',
  })
  const base = db.from('payments').select('*, leases(tenant_id, tenants(name))', { count: 'exact' })
  const { data, error, count } = await (leaseId ? base.eq('lease_id', leaseId) : base)
    .order(lq.sort, { ascending: lq.ascending })
    .order('id')
    .range(...lq.range!)
  if (error) {
    return listErrorResponse(c, error, 'Failed to load payments', () => {
      const head = db.from('payments').select('id', { count: 'exact', head: true })
      return leaseId ? head.eq('lease_id', leaseId) : head
    })
  }
  return c.json({ data, total: count ?? 0 })
})

// Record manual payment (check/wire/other only — ACH handled via Stripe in Phase 2)
//
// OI-082: migration 0015 made payments.idempotency_key NOT NULL + UNIQUE
// (payments_idempotency_key_uniq). Mirrors charges.ts's OI-046 pattern: a
// client-supplied key (PaymentsList.tsx sends one stable manual:<uuid> per
// form session, so a double-submit / retry after a network timeout resends
// the same value) passes through unchanged; otherwise default to a fresh
// manual:<uuid> so the insert still satisfies NOT NULL. `manual:` (not
// `legacy:`, which 0015's backfill reserved, nor `auto:`, the DB default for
// the stripe.ts/cron.ts paths) keeps this generation obviously distinct.
paymentsRouter.post('/', async (c) => {
  const db = getDb(c.env)
  const raw = await c.req.json()
  const parsed = PaymentInsertSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const idempotencyKey = parsed.data.idempotency_key ?? `manual:${crypto.randomUUID()}`
  const { data, error } = await db
    .from('payments')
    .insert({ ...parsed.data, idempotency_key: idempotencyKey })
    .select()
    .single()
  if (error) {
    // Scoped to payments_idempotency_key_uniq specifically, not any 23505 —
    // same constraint-name check as stripe.ts's payments_stripe_pi_uniq
    // branch. This insert never sets stripe_payment_intent_id or
    // autopay_period (the schema is .strict() and rejects both), so the two
    // 0011 partial indexes can't fire on it today; but a 23505 from either
    // would be an unrelated, uninvestigated collision that must surface as
    // a real failure, not be misreported as "already recorded".
    if (error.code === '23505' && error.message?.includes('payments_idempotency_key_uniq')) {
      // The same form session / retry already landed this payment. The row
      // is recorded exactly once — tell the client that plainly instead of
      // a generic failure, and insert nothing.
      return c.json({ error: 'Payment already recorded — this entry was submitted previously', deduped: true }, 409)
    }
    return dbError(c, error, 'Failed to create payment')
  }
  return c.json({ data }, 201)
})
