import { Hono } from 'hono'
import { getDb } from '../db/client'
import { ChargeInsertSchema } from '../lib/schemas'
import { dbError } from '../lib/api-error'
import { parseListQuery, listErrorResponse } from '../lib/list-query'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const chargesRouter = new Hono<{ Bindings: Env }>()

// Admin list: returns voided rows too (OI-278 / migration 0016 — they are the audit trail;
// `select('*')` carries voided_at/void_reason and BillingDashboard.tsx marks them). Every money
// path (ar_ledger, cron sums, portal, exports, reports, cam) filters `voided_at IS NULL` itself.
chargesRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const leaseId = c.req.query('lease_id')
  const lq = parseListQuery(c, {
    sortable: ['charge_date', 'amount', 'type'],
    defaultSort: 'charge_date',
    defaultDir: 'desc',
  })
  const base = db.from('charges').select('*, leases(tenant_id, tenants(name))', { count: 'exact' })
  const { data, error, count } = await (leaseId ? base.eq('lease_id', leaseId) : base)
    .order(lq.sort, { ascending: lq.ascending })
    .order('id')
    .range(...lq.range!)
  if (error) {
    return listErrorResponse(c, error, 'Failed to load charges', () => {
      const head = db.from('charges').select('id', { count: 'exact', head: true })
      return leaseId ? head.eq('lease_id', leaseId) : head
    })
  }
  return c.json({ data, total: count ?? 0 })
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
  // CAM true-ups are posted ONLY by POST /cam/:id/approve, through approve_cam_reconciliation()
  // (migration 0024), which keys them cam_true_up:<lease>:<year> and bills the reconciliation in the
  // same transaction. A hand-posted cam_true_up (any key) is invisible to that check, so approving the
  // draft would post a second true-up (a double charge) or bill a credit while it is live; a charge
  // holding a reserved cam_true_up: key blocks the real one. Refuse both (REFUTE 0024, C1b).
  if (parsed.data.type === 'cam_true_up' || parsed.data.idempotency_key?.startsWith('cam_true_up:')) {
    return c.json({
      error: 'CAM true-up charges are posted only by approving the CAM reconciliation (CAM page, Approve & Bill). '
        + 'Post an adjustment as type "other" instead.',
    }, 422)
  }
  const idempotencyKey = parsed.data.idempotency_key ?? `manual:${crypto.randomUUID()}`
  const { data, error } = await db
    .from('charges')
    .insert({ ...parsed.data, idempotency_key: idempotencyKey })
    .select()
    .single()
  if (error) return dbError(c, error, 'Failed to create charge')
  return c.json({ data }, 201)
})

// DELETE is NOT the void path. Voiding (voided_at + void_reason, migration 0016) keeps the row as
// an audit record and is reversible; deletion is neither. Auto charges stay undeletable — the
// OI-278 population was retired via migration 0017's guarded UPDATE, and any future void action
// should set the two columns, never call this route. Already-voided charges are undeletable too
// (OI-310), so the audit record a void creates cannot be erased through this door.
chargesRouter.delete('/:id', async (c) => {
  const db = getDb(c.env)
  // Fail closed (PR #42 refute): a failed pre-read used to fall through as "not found". PGRST116
  // (no row) is the genuine 404; any other error is a DB failure and must not be reported as 404.
  const { data: charge, error: readErr } = await db
    .from('charges')
    .select('source, voided_at')
    .eq('id', c.req.param('id'))
    .single()
  if (readErr && readErr.code !== 'PGRST116') return dbError(c, readErr, 'Failed to load charge')
  if (!charge) return c.json({ error: 'Charge not found' }, 404)
  if ((charge as { source: string }).source === 'auto') {
    return c.json({ error: 'Auto-generated charges cannot be deleted' }, 400)
  }
  // OI-310: a voided charge IS the audit record — deleting one destroys exactly what the void
  // mechanism exists to preserve. Today this cannot be reached (0017 only voids `source='auto'`
  // rows, which the check above already refuses), so this guard is deliberately landed BEFORE the
  // manual-void action that would make it reachable, not after. Do not drop it as "dead code":
  // the day a manual void can stamp `voided_at` on a `source='manual'` charge, this is the only
  // thing standing between a DELETE request and a hard-deleted audit trail.
  if ((charge as { voided_at: string | null }).voided_at !== null) {
    return c.json({ error: 'Voided charges cannot be deleted' }, 400)
  }
  const { error } = await db.from('charges').delete().eq('id', c.req.param('id'))
  if (error) return dbError(c, error, 'Failed to delete charge')
  return c.json({ success: true })
})
