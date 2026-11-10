// B8 ledger core API (admin-only: /api/gl is not in ADMIN_EXEMPT). FINANCIAL-DECISION CODE
// (refute-gated). Every write goes through 0023's Postgres functions, which with the tables'
// constraints and triggers enforce balance, immutability, same-entity accounts and period lock.
// No route here edits or deletes a posted entry: corrections are reversals.
import { Hono, type Context } from 'hono'
import { getDb } from '../db/client'
import { dbError } from '../lib/api-error'
import { fetchAllPages, POSTGREST_MAX_ROWS } from '../lib/postgrest-paging'
import {
  AccountsImportSchema,
  EntityInsertSchema,
  JournalPostSchema,
  JournalReverseSchema,
  PeriodLockSchema,
  canLockPeriods,
  glRuleMessage,
  isUuid,
  trialBalance,
  validateEntryLines,
  type TbAccount,
  type TbLine,
} from '../lib/gl'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string; GL_PERIOD_LOCK_EMAILS?: string }
type Ctx = Context<{ Bindings: Env }>

export const glRouter = new Hono<{ Bindings: Env }>()

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

async function body(c: Ctx): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return undefined
  }
}

/** A ledger-rule rejection is the caller's to fix (422, with the rule); anything else is a 500. */
function writeError(c: Ctx, err: { message: string; code?: string }, publicMsg: string) {
  const rule = glRuleMessage(err)
  if (rule) return c.json({ error: rule }, 422)
  return dbError(c, err, publicMsg)
}

// ── Entities and chart of accounts ────────────────────────────────────────────────────────────
glRouter.get('/entities', async (c) => {
  const { data, error } = await getDb(c.env).from('gl_entities').select('*').order('name')
  if (error) return dbError(c, error, 'Failed to load entities')
  return c.json({ data })
})

glRouter.post('/entities', async (c) => {
  const parsed = EntityInsertSchema.safeParse(await body(c))
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const { data, error } = await getDb(c.env).from('gl_entities')
    .insert({ ...parsed.data, qb_file_name: parsed.data.qb_file_name || null }).select().single()
  if (error) return error.code === '23505' ? c.json({ error: 'An entity with that name already exists' }, 409) : writeError(c, error, 'Failed to create entity')
  return c.json({ data }, 201)
})

glRouter.get('/entities/:id/accounts', async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'id must be a uuid' }, 422)
  const { data, error } = await getDb(c.env).from('gl_accounts').select('*').eq('entity_id', id).order('number').order('qb_name')
  if (error) return dbError(c, error, 'Failed to load accounts')
  return c.json({ data })
})

/** Import (part of) an LLC's QuickBooks chart. All-or-nothing: one insert statement. */
glRouter.post('/entities/:id/accounts', async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'id must be a uuid' }, 422)
  const parsed = AccountsImportSchema.safeParse(await body(c))
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const names = parsed.data.accounts.map((a) => a.qb_name.toLowerCase())
  if (new Set(names).size !== names.length) return c.json({ error: 'Duplicate qb_name in the import' }, 422)
  const rows = parsed.data.accounts.map((a) => ({ ...a, number: a.number || null, entity_id: id }))
  const { data, error } = await getDb(c.env).from('gl_accounts').insert(rows).select()
  if (error) {
    if (error.code === '23505') return c.json({ error: 'An account with that QuickBooks name or number already exists for this entity' }, 409)
    if (error.code === '23503') return c.json({ error: 'Entity not found' }, 404)
    return writeError(c, error, 'Failed to import accounts')
  }
  return c.json({ data }, 201)
})

// ── Journal ───────────────────────────────────────────────────────────────────────────────────
glRouter.post('/journal', async (c) => {
  const parsed = JournalPostSchema.safeParse(await body(c))
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const v = validateEntryLines(parsed.data.lines)
  if (!v.ok) return c.json({ error: { lines: v.errors } }, 422)
  const postedBy = c.get('adminEmail')
  if (!postedBy) return c.json({ error: 'Posting requires an identified admin' }, 403)
  const { data, error } = await getDb(c.env).rpc('gl_post_entry', {
    p_entity_id: parsed.data.entity_id,
    p_entry_date: parsed.data.entry_date,
    p_memo: parsed.data.memo,
    p_source: parsed.data.source,
    p_posted_by: postedBy,
    p_lines: v.lines,
  })
  if (error) return writeError(c, error, 'Failed to post journal entry')
  return c.json({ data: { id: data, total_cents: v.totalCents } }, 201)
})

glRouter.post('/journal/:id/reverse', async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'id must be a uuid' }, 422)
  const parsed = JournalReverseSchema.safeParse(await body(c))
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const postedBy = c.get('adminEmail')
  if (!postedBy) return c.json({ error: 'Posting requires an identified admin' }, 403)
  const { data, error } = await getDb(c.env).rpc('gl_reverse_entry', {
    p_entry_id: id,
    p_entry_date: parsed.data.entry_date,
    p_memo: parsed.data.memo,
    p_posted_by: postedBy,
  })
  if (error) {
    if (error.code === 'P0002') return c.json({ error: 'Journal entry not found' }, 404)
    if (error.code === '23505') return c.json({ error: 'This entry has already been reversed' }, 409)
    return writeError(c, error, 'Failed to reverse journal entry')
  }
  return c.json({ data: { id: data } }, 201)
})

glRouter.get('/journal', async (c) => {
  const entityId = c.req.query('entity_id') ?? ''
  const from = c.req.query('from') ?? ''
  const to = c.req.query('to') ?? ''
  if (!isUuid(entityId)) return c.json({ error: 'entity_id must be a uuid' }, 422)
  if ((from && !ISO_DATE.test(from)) || (to && !ISO_DATE.test(to))) return c.json({ error: 'from/to must be YYYY-MM-DD' }, 422)
  let q = getDb(c.env).from('gl_journal_entries')
    .select('*, gl_journal_lines(line_no, account_id, debit_cents, credit_cents, memo)')
    .eq('entity_id', entityId)
  if (from) q = q.gte('entry_date', from)
  if (to) q = q.lte('entry_date', to)
  const { data, error } = await q.order('entry_date', { ascending: false }).order('posted_at', { ascending: false }).limit(200)
  if (error) return dbError(c, error, 'Failed to load journal')
  return c.json({ data })
})

// ── Trial balance ─────────────────────────────────────────────────────────────────────────────
// Every line through as_of (inclusive), keyset-paged so no silent truncation; every account of
// the entity listed. Fails closed on any read error or an unbalanced result (which the DB rules
// make impossible, so seeing one means a bad read).
glRouter.get('/trial-balance', async (c) => {
  const entityId = c.req.query('entity_id') ?? ''
  const asOf = c.req.query('as_of') ?? new Date().toISOString().slice(0, 10)
  if (!isUuid(entityId)) return c.json({ error: 'entity_id must be a uuid' }, 422)
  if (!ISO_DATE.test(asOf)) return c.json({ error: 'as_of must be YYYY-MM-DD' }, 422)
  const db = getDb(c.env)
  const accounts = await fetchAllPages<TbAccount>((after) => {
    let q = db.from('gl_accounts').select('id, number, qb_name, account_type, is_active').eq('entity_id', entityId)
    if (after !== null) q = q.gt('id', after)
    return q.order('id').limit(POSTGREST_MAX_ROWS)
  }, (r) => r.id)
  if (accounts.error) return dbError(c, accounts.error, 'Failed to load trial balance')
  const lines = await fetchAllPages<TbLine & { id: string }>((after) => {
    let q = db.from('gl_journal_lines')
      .select('id, account_id, debit_cents, credit_cents, gl_journal_entries!inner(entry_date)')
      .eq('entity_id', entityId)
      .lte('gl_journal_entries.entry_date', asOf)
    if (after !== null) q = q.gt('id', after)
    return q.order('id').limit(POSTGREST_MAX_ROWS)
  }, (r) => r.id)
  if (lines.error) return dbError(c, lines.error, 'Failed to load trial balance')
  let tb
  try {
    tb = trialBalance(accounts.data, lines.data)
  } catch (e) {
    return dbError(c, { message: (e as Error).message }, 'Failed to load trial balance')
  }
  if (!tb.balanced) return dbError(c, { message: `trial balance out of balance: ${tb.debit_cents} vs ${tb.credit_cents}` }, 'Failed to load trial balance')
  return c.json({ data: { entity_id: entityId, as_of: asOf, ...tb } })
})

// ── Periods ───────────────────────────────────────────────────────────────────────────────────
glRouter.get('/periods', async (c) => {
  const entityId = c.req.query('entity_id') ?? ''
  if (!isUuid(entityId)) return c.json({ error: 'entity_id must be a uuid' }, 422)
  const { data, error } = await getDb(c.env).from('gl_periods').select('*').eq('entity_id', entityId).order('period_start', { ascending: false })
  if (error) return dbError(c, error, 'Failed to load periods')
  return c.json({ data })
})

/** Lock a month. Permanent. Only admins on GL_PERIOD_LOCK_EMAILS (fail-closed when unset). */
glRouter.post('/periods/lock', async (c) => {
  const email = c.get('adminEmail')
  if (!canLockPeriods(email, c.env.GL_PERIOD_LOCK_EMAILS)) {
    return c.json({ error: 'Only the designated approver can lock a period' }, 403)
  }
  const parsed = PeriodLockSchema.safeParse(await body(c))
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const { error } = await getDb(c.env).rpc('gl_lock_period', {
    p_entity_id: parsed.data.entity_id,
    p_period_start: parsed.data.period_start,
    p_locked_by: email,
  })
  if (error) {
    if (error.code === '23505') return c.json({ error: 'That period is already locked' }, 409)
    if (error.code === '23503') return c.json({ error: 'Entity not found' }, 404)
    return writeError(c, error, 'Failed to lock period')
  }
  return c.json({ data: { entity_id: parsed.data.entity_id, period_start: parsed.data.period_start, status: 'locked' } })
})
