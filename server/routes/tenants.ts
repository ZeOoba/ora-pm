import { Hono } from 'hono'
import { getDb } from '../db/client'
import { TenantInsertSchema, TenantUpdateSchema, TenantCorrespondenceInsertSchema } from '../lib/schemas'
import { dbError } from '../lib/api-error'
import { parseListQuery, listErrorResponse } from '../lib/list-query'
import { PORTAL_TENANT_SELECT, portalAging, portalBalance, portalCharges, portalLeases, portalPayments } from '../lib/portal-data'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const tenantsRouter = new Hono<{ Bindings: Env }>()

tenantsRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const lq = parseListQuery(c, {
    sortable: ['name', 'created_at'],
    defaultSort: 'name',
    searchColumns: ['name', 'contact_name', 'contact_email'],
  })
  const applyFilters = <Q extends { or(f: string): Q }>(q: Q): Q => (lq.searchFilter ? q.or(lq.searchFilter) : q)
  const { data, error, count } = await applyFilters(db.from('tenants').select('*', { count: 'exact' }))
    .order(lq.sort, { ascending: lq.ascending })
    .order('id')
    .range(...lq.range!)
  if (error) {
    return listErrorResponse(c, error, 'Failed to load tenants', () =>
      applyFilters(db.from('tenants').select('id', { count: 'exact', head: true })))
  }
  return c.json({ data, total: count ?? 0 })
})

tenantsRouter.get('/:id', async (c) => {
  const db = getDb(c.env)
  const { data, error } = await db
    .from('tenants')
    .select('*, leases(*, units(*, properties(name))), insurance_certificates(*), correspondence_log(*)')
    .eq('id', c.req.param('id'))
    .single()
  // Not-found is a 404, not a 500 — dbError always returns 500, so this
  // stays a plain generic response rather than routing through it.
  if (error) return c.json({ error: 'Tenant not found' }, 404)
  return c.json({ data })
})

tenantsRouter.post('/', async (c) => {
  const db = getDb(c.env)
  const raw = await c.req.json()
  const parsed = TenantInsertSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const { data, error } = await db.from('tenants').insert(parsed.data).select().single()
  if (error) return dbError(c, error, 'Failed to create tenant')
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
  if (error) return dbError(c, error, 'Failed to update tenant')
  return c.json({ data })
})

// POST /api/tenants/:id/correspondence
tenantsRouter.post('/:id/correspondence', async (c) => {
  const raw = await c.req.json()
  const parsed = TenantCorrespondenceInsertSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const db = getDb(c.env)
  const { data, error } = await db
    .from('correspondence_log')
    .insert({ ...parsed.data, tenant_id: c.req.param('id') })
    .select()
    .single()
  if (error) return dbError(c, error, 'Failed to create correspondence entry')
  return c.json({ data }, 201)
})

// GET /api/tenants/:id/portal-preview — B13 "View as tenant". Admin-only (this router sits behind
// adminAuthMiddleware). Returns the exact payloads the tenant's own portal endpoints return, built
// by the same functions (server/lib/portal-data.ts), so the preview can never show a different
// balance or a field the tenant cannot see. Read-only. Fails as a whole: a partial preview would
// misrepresent what the tenant sees.
const PREVIEW_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

tenantsRouter.get('/:id/portal-preview', async (c) => {
  const id = c.req.param('id')
  if (!PREVIEW_UUID_RE.test(id)) return c.json({ error: 'id must be a uuid' }, 422)
  const db = getDb(c.env)
  const { data: tenant, error } = await db.from('tenants').select(PORTAL_TENANT_SELECT).eq('id', id).maybeSingle()
  if (error) return dbError(c, error, 'Failed to load tenant')
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404)

  const [balance, charges, payments, leases, aging] = await Promise.all([
    portalBalance(db, id), portalCharges(db, id), portalPayments(db, id), portalLeases(db, id), portalAging(db, id),
  ])
  for (const r of [balance, charges, payments, leases, aging]) {
    if (!r.ok) {
      return r.kind === 'raw'
        ? dbError(c, { message: r.text }, 'Failed to load tenant portal preview')
        : dbError(c, r.error, 'Failed to load tenant portal preview')
    }
  }
  if (!balance.ok || !charges.ok || !payments.ok || !leases.ok || !aging.ok) return c.json({ error: 'unreachable' }, 500)
  return c.json({
    me: { tenant, total_balance: balance.data },
    charges: { data: charges.data },
    payments: { data: payments.data },
    lease: { data: leases.data },
    aging: aging.data,
  })
})
