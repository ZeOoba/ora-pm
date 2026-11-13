// Books › Balance forward (migration 0030): bring each lease's balance over from QuickBooks as one
// opening-balance adjustment. Per LLC (properties.entity_llc) and cut-off date: preview from the
// QuickBooks A/R Aging Summary CSV (plus manual figures), then apply with the preview's plan hash.
// The planning rules are in server/lib/balance-forward-import.ts; the money rules in the migration.
import { Hono } from 'hono'
import { getDb } from '../db/client'
import { dbError } from '../lib/api-error'
import { fetchAllPages, fetchChunked, POSTGREST_MAX_ROWS } from '../lib/postgrest-paging'
import { toCents } from '../lib/ar-aging'
import { ledgerToday } from '../lib/gl'
import { MAX_AGING_CHARS, parseAgingSummary, planBalanceForwards, type BfLease, type BfPlan } from '../lib/balance-forward-import'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }
type Db = ReturnType<typeof getDb>

export const balanceForwardsRouter = new Hono<{ Bindings: Env }>()

const CHUNK = 100
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i


/** The LLC names on properties, with how many properties each has. */
balanceForwardsRouter.get('/llcs', async (c) => {
  const { data, error } = await fetchAllPages<{ id: string; entity_llc: string | null }>((after) => {
    let q = getDb(c.env).from('properties').select('id, entity_llc')
    if (after !== null) q = q.gt('id', after)
    return q.order('id').limit(POSTGREST_MAX_ROWS)
  }, (r) => r.id)
  if (error) return dbError(c, error, 'Failed to load LLCs')
  const counts = new Map<string, number>()
  for (const p of data) {
    const name = p.entity_llc?.trim()
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return c.json({ data: [...counts].map(([name, properties]) => ({ name, properties })).sort((a, b) => a.name.localeCompare(b.name)) })
})

type LedgerRow = { lease_id: string; tenant_name: string; suite: string | null; property_id: string; property_name: string; balance_forward: unknown; balance_forward_as_of: string | null }

type Loaded = { ok: true; leases: BfLease[] } | { ok: false; error: { message: string; code?: string }; publicMsg: string }

/** Every lease on the LLC's properties, with its app balance as of the cut-off (ar_ledger's rules). */
async function loadLeases(db: Db, llc: string, asOf: string): Promise<Loaded> {
  const props = await fetchAllPages<{ id: string }>((after) => {
    let q = db.from('properties').select('id').eq('entity_llc', llc)
    if (after !== null) q = q.gt('id', after)
    return q.order('id').limit(POSTGREST_MAX_ROWS)
  }, (r) => r.id)
  if (props.error) return { ok: false, error: props.error, publicMsg: 'Failed to load properties' }
  if (props.data.length === 0) return { ok: true, leases: [] }

  const ledger = await fetchChunked<LedgerRow>(props.data.map((p) => p.id), CHUNK, (chunk) =>
    fetchAllPages<LedgerRow>((after) => {
      let q = db.from('ar_ledger').select('lease_id, tenant_name, suite, property_id, property_name, balance_forward, balance_forward_as_of').in('property_id', chunk)
      if (after !== null) q = q.gt('lease_id', after)
      return q.order('lease_id').limit(POSTGREST_MAX_ROWS)
    }, (r) => r.lease_id), { maxRows: Infinity })
  if (ledger.error) return { ok: false, error: ledger.error, publicMsg: 'Failed to load leases' }
  const ids = ledger.data.map((r) => r.lease_id)
  if (ids.length === 0) return { ok: true, leases: [] }

  const [statuses, charges, payments] = await Promise.all([
    fetchChunked<{ id: string; status: string }>(ids, CHUNK, (chunk) => db.from('leases').select('id, status').in('id', chunk), { maxRows: POSTGREST_MAX_ROWS }),
    fetchChunked<{ id: string; lease_id: string; amount: unknown }>(ids, CHUNK, (chunk) =>
      fetchAllPages<{ id: string; lease_id: string; amount: unknown }>((after) => {
        let q = db.from('charges').select('id, lease_id, amount').in('lease_id', chunk).is('voided_at', null).lte('charge_date', asOf)
        if (after !== null) q = q.gt('id', after)
        return q.order('id').limit(POSTGREST_MAX_ROWS)
      }, (r) => r.id), { maxRows: Infinity }),
    fetchChunked<{ id: string; lease_id: string; amount: unknown; method: string; stripe_status: string | null }>(ids, CHUNK, (chunk) =>
      fetchAllPages<{ id: string; lease_id: string; amount: unknown; method: string; stripe_status: string | null }>((after) => {
        let q = db.from('payments').select('id, lease_id, amount, method, stripe_status').in('lease_id', chunk).lte('payment_date', asOf)
        if (after !== null) q = q.gt('id', after)
        return q.order('id').limit(POSTGREST_MAX_ROWS)
      }, (r) => r.id), { maxRows: Infinity }),
  ])
  if (statuses.error) return { ok: false, error: statuses.error, publicMsg: 'Failed to load leases' }
  if (charges.error) return { ok: false, error: charges.error, publicMsg: 'Failed to load charges' }
  if (payments.error) return { ok: false, error: payments.error, publicMsg: 'Failed to load payments' }

  const app = new Map<string, number>()
  const pending = new Set<string>()
  for (const ch of charges.data) {
    const cents = toCents(ch.amount)
    if (cents === null || cents < 0) return { ok: false, error: { message: `non-numeric or negative charges.amount on charge ${ch.id}` }, publicMsg: 'Failed to load charges' }
    app.set(ch.lease_id, (app.get(ch.lease_id) ?? 0) + cents)
  }
  for (const p of payments.data) {
    const cents = toCents(p.amount)
    if (cents === null || cents <= 0) return { ok: false, error: { message: `non-numeric or non-positive payments.amount on payment ${p.id}` }, publicMsg: 'Failed to load payments' }
    const counted = p.method === 'check' || p.method === 'wire' || p.method === 'other' || (p.method === 'ach_stripe' && p.stripe_status === 'succeeded')
    if (counted) app.set(p.lease_id, (app.get(p.lease_id) ?? 0) - cents)
    else if (p.method === 'ach_stripe' && (p.stripe_status === 'pending' || p.stripe_status === 'processing')) pending.add(p.lease_id)
  }
  const statusBy = new Map(statuses.data.map((l) => [l.id, l.status]))
  const leases: BfLease[] = []
  for (const r of ledger.data) {
    const bf = toCents(r.balance_forward ?? 0)
    if (bf === null) return { ok: false, error: { message: `non-numeric ar_ledger.balance_forward for lease ${r.lease_id}` }, publicMsg: 'Failed to load leases' }
    leases.push({
      lease_id: r.lease_id, tenant_name: r.tenant_name, suite: r.suite, property_name: r.property_name,
      status: statusBy.get(r.lease_id) ?? 'unknown', app_cents: app.get(r.lease_id) ?? 0, pending_ach: pending.has(r.lease_id),
      live_forward: bf !== 0 && r.balance_forward_as_of ? { amount_cents: bf, as_of: r.balance_forward_as_of } : null,
    })
  }
  return { ok: true, leases }
}

/** SHA-256 over exactly what would be written: LLC, cut-off and each adjusted lease's figures. */
async function planHash(llc: string, plan: BfPlan): Promise<string> {
  const rows = plan.rows.filter((r) => r.status === 'adjust').map((r) => [r.lease_id, r.qb_cents, r.app_cents])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([llc, plan.as_of, rows])))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function isStringMap(v: unknown): v is Record<string, string> {
  return v === undefined || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string'))
}
function isCentsMap(v: unknown): v is Record<string, number> {
  return v === undefined || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'number'))
}

/**
 * POST { llc, as_of, csv?, file_name?, assign?, manual?, apply?, expected_plan_hash? }
 * Without apply: the plan (200, or 422 when it has errors). With apply: writes the 'adjust' rows.
 */
balanceForwardsRouter.post('/plan', async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return c.json({ error: 'expected a JSON body' }, 400)
  const { llc, as_of: asOf, csv, file_name: fileName, assign, manual, apply, expected_plan_hash: expected } = body
  if (typeof llc !== 'string' || llc.trim() === '') return c.json({ error: 'llc is required' }, 422)
  if (typeof asOf !== 'string' || !ISO_DATE.test(asOf)) return c.json({ error: 'as_of must be YYYY-MM-DD' }, 422)
  if (csv !== undefined && csv !== null && (typeof csv !== 'string' || csv.length > MAX_AGING_CHARS)) return c.json({ error: 'csv must be text under the size limit' }, 422)
  if (fileName !== undefined && fileName !== null && typeof fileName !== 'string') return c.json({ error: 'file_name must be text' }, 422)
  if (!isStringMap(assign)) return c.json({ error: 'assign must map customer names to lease ids' }, 422)
  if (!isCentsMap(manual)) return c.json({ error: 'manual must map lease ids to cents' }, 422)

  const db = getDb(c.env)
  const loaded = await loadLeases(db, llc.trim(), asOf)
  if (!loaded.ok) return dbError(c, loaded.error, loaded.publicMsg)
  const plan = planBalanceForwards({
    as_of: asOf, today: ledgerToday(), leases: loaded.leases,
    aging: typeof csv === 'string' && csv.trim() !== '' ? parseAgingSummary(csv) : null,
    assign: assign as Record<string, string> | undefined, manual: manual as Record<string, number> | undefined,
  })
  const result = { ...plan, llc: llc.trim(), plan_hash: await planHash(llc.trim(), plan), applied: false, written: [] as unknown[] }
  if (apply !== true) return c.json({ data: result }, plan.errors.length ? 422 : 200)

  if (plan.errors.length) return c.json({ error: 'The balance forwards cannot be applied', data: result }, 422)
  if (plan.adjust_count === 0) return c.json({ error: 'Nothing to apply: every planned lease already matches QuickBooks', data: result }, 422)
  if (expected !== result.plan_hash) return c.json({ error: 'The figures changed since the preview; preview again', data: result }, 409)
  const by = c.get('adminEmail')
  if (!by) return c.json({ error: 'Applying requires an identified admin' }, 403)
  const rows = plan.rows.filter((r) => r.status === 'adjust').map((r) => ({
    lease_id: r.lease_id, qb_balance: r.qb_cents / 100, expected_app_balance: r.app_cents / 100,
    qb_customer: r.qb_customers.join('; ') || null,
  }))
  const { data, error } = await db.rpc('apply_balance_forwards', {
    p_as_of: asOf,
    p_source: typeof csv === 'string' && csv.trim() !== '' ? 'qb_ar_aging' : 'manual',
    p_source_ref: typeof fileName === 'string' ? fileName.slice(0, 200) : null,
    p_actor: by,
    p_rows: rows,
  })
  if (error) return dbError(c, error, 'Failed to apply the balance forwards') // 'bf: ' refusals reach the admin as written
  return c.json({ data: { ...result, applied: true, written: data ?? [] } }, 201)
})

/** Live and voided balance forwards for the LLC's leases (newest first). */
balanceForwardsRouter.get('/', async (c) => {
  const llc = c.req.query('llc')?.trim()
  if (!llc) return c.json({ error: 'llc is required' }, 422)
  const db = getDb(c.env)
  const loaded = await loadLeases(db, llc, ledgerToday())
  if (!loaded.ok) return dbError(c, loaded.error, loaded.publicMsg)
  const byLease = new Map(loaded.leases.map((l) => [l.lease_id, l]))
  const rows = await fetchChunked<Record<string, unknown> & { id: string; lease_id: string; created_at: string }>([...byLease.keys()], CHUNK, (chunk) =>
    db.from('balance_forwards').select('*').in('lease_id', chunk), { maxRows: POSTGREST_MAX_ROWS })
  if (rows.error) return dbError(c, rows.error, 'Failed to load balance forwards')
  const data = rows.data.map((r) => {
    const l = byLease.get(r.lease_id)
    return { ...r, tenant_name: l?.tenant_name ?? null, suite: l?.suite ?? null, property_name: l?.property_name ?? null }
  }).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  return c.json({ data })
})

balanceForwardsRouter.post('/:id/void', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ error: 'id must be a uuid' }, 422)
  const body = await c.req.json().catch(() => null) as { reason?: unknown } | null
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  if (!reason) return c.json({ error: 'a reason is required' }, 422)
  const by = c.get('adminEmail')
  if (!by) return c.json({ error: 'Voiding requires an identified admin' }, 403)
  const { data, error } = await getDb(c.env).rpc('void_balance_forward', { p_id: id, p_actor: by, p_reason: reason.slice(0, 500) })
  if (error) return dbError(c, error, 'Failed to void the balance forward')
  return c.json({ data })
})
