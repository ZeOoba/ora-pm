// B1 collections workflow: promises to pay and AR disputes (admin-only; mounted under /api, so
// adminAuthMiddleware gates every route here — see server/index.ts ADMIN_EXEMPT).
//
// Work-log records only: nothing here posts, voids or applies money, and no billing, late-fee,
// autopay or balance code reads these tables. See supabase/migrations/0022_collections_workflow.sql.
import { Hono, type Context } from 'hono'
import { getDb } from '../db/client'
import { dbError } from '../lib/api-error'
import {
  CollectionsListQuerySchema,
  DisputeInsertSchema,
  DisputeResolveSchema,
  PromiseInsertSchema,
  PromiseResolveSchema,
  isUuid,
  todayUtc,
  withLapsed,
} from '../lib/collections'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const collectionsRouter = new Hono<{ Bindings: Env }>()
type Ctx = Context<{ Bindings: Env }>

// Joined context so the UI can label a row without a second read.
const LEASE_JOIN = 'leases!inner(id, tenant_id, tenants(name), units(suite, properties(name)))'

type Kind = 'promises' | 'disputes'
const TABLE: Record<Kind, 'promises_to_pay' | 'ar_disputes'> = { promises: 'promises_to_pay', disputes: 'ar_disputes' }
const ORDER: Record<Kind, string> = { promises: 'promised_date', disputes: 'created_at' }

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return undefined
  }
}

function list(kind: Kind) {
  return async (c: Ctx) => {
    const parsed = CollectionsListQuerySchema.safeParse(c.req.query())
    if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
    const { status, lease_id, tenant_id } = parsed.data
    const db = getDb(c.env)
    let q = db.from(TABLE[kind]).select(`*, ${LEASE_JOIN}`).order(ORDER[kind], { ascending: true }).order('id')
    if (status === 'open') q = q.eq('status', 'open')
    if (lease_id) q = q.eq('lease_id', lease_id)
    if (tenant_id) q = q.eq('leases.tenant_id', tenant_id)
    const { data, error } = await q
    if (error) return dbError(c, error, `Failed to load ${kind}`)
    const rows = (data ?? []) as Record<string, unknown>[]
    if (kind === 'promises') return c.json({ data: withLapsed(rows as (Record<string, unknown> & { status: string; promised_date: string })[], todayUtc()) })
    return c.json({ data: rows })
  }
}

async function leaseExists(db: ReturnType<typeof getDb>, leaseId: string): Promise<{ ok: boolean; error?: { message: string } }> {
  const { data, error } = await db.from('leases').select('id').eq('id', leaseId).maybeSingle()
  if (error) return { ok: false, error }
  return { ok: !!data }
}

collectionsRouter.get('/promises', list('promises'))
collectionsRouter.get('/disputes', list('disputes'))

collectionsRouter.post('/promises', async (c) => {
  const parsed = PromiseInsertSchema.safeParse(await readJson(c))
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const db = getDb(c.env)
  const lease = await leaseExists(db, parsed.data.lease_id)
  if (lease.error) return dbError(c, lease.error, 'Failed to record promise')
  if (!lease.ok) return c.json({ error: 'Lease not found' }, 404)
  const { data, error } = await db
    .from('promises_to_pay')
    .insert({ ...parsed.data, notes: parsed.data.notes || null, status: 'open', created_by: c.get('adminEmail') ?? null })
    .select()
    .single()
  if (error) return dbError(c, error, 'Failed to record promise')
  return c.json({ data: withLapsed([data as { status: string; promised_date: string }], todayUtc())[0] }, 201)
})

collectionsRouter.post('/disputes', async (c) => {
  const parsed = DisputeInsertSchema.safeParse(await readJson(c))
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const db = getDb(c.env)
  const lease = await leaseExists(db, parsed.data.lease_id)
  if (lease.error) return dbError(c, lease.error, 'Failed to record dispute')
  if (!lease.ok) return c.json({ error: 'Lease not found' }, 404)
  const { data, error } = await db
    .from('ar_disputes')
    .insert({ ...parsed.data, amount: parsed.data.amount ?? null, status: 'open', created_by: c.get('adminEmail') ?? null })
    .select()
    .single()
  if (error) return dbError(c, error, 'Failed to record dispute')
  return c.json({ data }, 201)
})

/**
 * Resolve an OPEN record. The update is conditioned on status = 'open', so two admins resolving
 * the same record cannot both win, and a resolved record is never reopened or re-resolved.
 */
function resolve(kind: Kind) {
  return async (c: Ctx) => {
    const id = c.req.param('id') as string
    if (!isUuid(id)) return c.json({ error: 'id must be a uuid' }, 422)
    const raw = await readJson(c)
    const parsed = kind === 'promises' ? PromiseResolveSchema.safeParse(raw) : DisputeResolveSchema.safeParse(raw)
    if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
    const db = getDb(c.env)
    const patch: Record<string, unknown> = {
      ...parsed.data,
      resolved_at: new Date().toISOString(),
      resolved_by: c.get('adminEmail') ?? null,
    }
    if ('resolution' in patch) patch.resolution = patch.resolution || null
    const { data, error } = await db.from(TABLE[kind]).update(patch).eq('id', id).eq('status', 'open').select()
    if (error) return dbError(c, error, `Failed to update ${kind === 'promises' ? 'promise' : 'dispute'}`)
    if (data && data.length === 1) return c.json({ data: data[0] })
    const { data: existing, error: readErr } = await db.from(TABLE[kind]).select('id, status').eq('id', id).maybeSingle()
    if (readErr) return dbError(c, readErr, `Failed to update ${kind === 'promises' ? 'promise' : 'dispute'}`)
    if (!existing) return c.json({ error: 'Not found' }, 404)
    return c.json({ error: `Already ${(existing as { status: string }).status}; only an open record can be resolved` }, 409)
  }
}

collectionsRouter.put('/promises/:id', resolve('promises'))
collectionsRouter.put('/disputes/:id', resolve('disputes'))
