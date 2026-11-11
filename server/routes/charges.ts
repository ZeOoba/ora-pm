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
    .select('source, voided_at, type, lease_id, period_start, idempotency_key')
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
  const camGuard = await billedCamTrueUpGuard(db, charge as ChargeGuardRow)
  if (camGuard.kind === 'db_error') return dbError(c, camGuard.error, 'Failed to load CAM reconciliation')
  if (camGuard.kind === 'refuse') return c.json({ error: camGuard.reason }, camGuard.status)
  const { error } = await db.from('charges').delete().eq('id', c.req.param('id'))
  if (error) return dbError(c, error, 'Failed to delete charge')
  return c.json({ success: true })
})

type ChargeGuardRow = {
  type?: string | null
  lease_id?: string | null
  period_start?: string | null
  idempotency_key?: string | null
}

type CamGuard =
  | { kind: 'allow' }
  | { kind: 'refuse'; status: 409 | 500; reason: string }
  | { kind: 'db_error'; error: { code?: string; message: string } }

// Only a UUID-shaped lease part: 0024 builds the key from lease_id::text, and a malformed legacy key
// would otherwise reach the uuid column filter and 500 (22P02) on every delete attempt (REFUTE D2).
const CAM_KEY = /^cam_true_up:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}):(\d{4})$/

// There is no in-app void action yet (no route or UI writes voided_at); a void is a manual DB
// operation, so the refusals say so instead of pointing at a button that does not exist (REFUTE D1).
const VOID_HOW = 'Void the charge instead: an administrator sets voided_at and void_reason on it in the '
  + 'database (migration 0016). The charge stays on record as an audit row.'

// A billed CAM reconciliation's true-up must not be hard-deleted. approve_cam_reconciliation()
// (migration 0024) posts it under cam_true_up:<lease>:<year> and marks the reconciliation billed in
// one transaction; approve then refuses any non-draft row (not_draft). Deleting the charge afterwards
// left the row billed with nothing on the ledger and no way to re-post — the true-up was lost.
//
// Refuse (409) while the reconciliation the charge belongs to is billed or collected; void is the
// correction path (voided_at/void_reason, migration 0016: audit row kept, reversible). Deletion stays
// allowed while that reconciliation is a draft (or absent): approve's live_mismatch answer tells the
// user to delete a stale true-up, and the next approve re-posts the right figure.
//
// Which reconciliation: the one the reserved key names (that is the row approve keys on), and also
// the charge's own lease + period_start year (a legacy true-up posted before the reserved key). Any
// charge holding a cam_true_up: key is checked, whatever its type — it occupies the key all the same.
//
// Fail closed: a missing `type` (column dropped from the select) or an undeterminable year on a
// cam_true_up refuses; any read error on cam_reconciliations is a 500, never a delete.
//
// Concurrency: no gap for rows 0024 posts — the charge becomes visible only in the same commit that
// bills the reconciliation, so a delete that can see the charge also sees `billed`. The residual
// window is a PRE-0024 row left mid-approve (live keyed charge, draft reconciliation): an approve
// committing between this read and the DELETE bills it, then the delete removes it. Closing that
// fully needs the delete inside a function holding the reconciliation lock (see PR body).
async function billedCamTrueUpGuard(db: ReturnType<typeof getDb>, row: ChargeGuardRow): Promise<CamGuard> {
  if (row.type === undefined) {
    return { kind: 'refuse', status: 500, reason: 'Charge type could not be read; refusing to delete.' }
  }
  const targets = new Map<string, { leaseId: string; year: number }>()
  const keyMatch = typeof row.idempotency_key === 'string' ? CAM_KEY.exec(row.idempotency_key) : null
  if (keyMatch) {
    const year = Number(keyMatch[2])
    targets.set(`${keyMatch[1]}:${year}`, { leaseId: keyMatch[1], year })
  }
  if (row.type === 'cam_true_up') {
    const year = typeof row.period_start === 'string' ? Number(row.period_start.slice(0, 4)) : NaN
    if (row.lease_id && Number.isInteger(year) && year > 0) {
      targets.set(`${row.lease_id}:${year}`, { leaseId: row.lease_id, year })
    } else if (targets.size === 0) {
      return {
        kind: 'refuse',
        status: 409,
        reason: 'This CAM true-up charge cannot be matched to a reconciliation year, so it cannot be '
          + `deleted safely. ${VOID_HOW}`,
      }
    }
  }
  for (const { leaseId, year } of targets.values()) {
    const { data, error } = await db
      .from('cam_reconciliations')
      .select('status')
      .eq('lease_id', leaseId)
      .eq('reconciliation_year', year)
      .maybeSingle()
    if (error) return { kind: 'db_error', error }
    const status = (data as { status?: string } | null)?.status
    if (data && status !== 'draft') {
      return {
        kind: 'refuse',
        status: 409,
        reason: `This is the ${year} CAM true-up for a reconciliation that is already ${status ?? 'billed'}. `
          + `Deleting it would leave the reconciliation ${status ?? 'billed'} with nothing posted, and it `
          + `cannot be re-approved. ${VOID_HOW}`,
      }
    }
  }
  return { kind: 'allow' }
}
