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
  isRealIsoDate,
  isUuid,
  ledgerToday,
  trialBalance,
  validateEntryLines,
  type TbAccount,
  type TbLine,
} from '../lib/gl'
import { MAX_IIF_CHARS, parseIifAccounts, planAccountImport, type ExistingAccount } from '../lib/qb-iif-accounts'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string; GL_PERIOD_LOCK_EMAILS?: string }
type Ctx = Context<{ Bindings: Env }>

export const glRouter = new Hono<{ Bindings: Env }>()


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

/**
 * B8 slice 1: an LLC's QuickBooks Desktop chart from an IIF export (Lists → Chart of Accounts).
 * Body: { iif: <file text>, apply?: boolean, expected_new?: number }. Without apply (the default) nothing is written and
 * the response is the plan: new / unchanged / conflicts / warnings / ledger_only / skipped.
 * With apply: refuses (409) on any conflict, or when expected_new (the preview's count) no longer
 * matches; otherwise inserts every new account in ONE statement
 * (all-or-nothing). Existing accounts are never changed or deleted by an import.
 */
glRouter.post('/entities/:id/accounts/qb-iif', async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'id must be a uuid' }, 422)
  // Refuse an oversized body before reading it (JSON escaping can at most ~6x the text).
  const declared = Number(c.req.header('content-length') ?? '0')
  if (declared > MAX_IIF_CHARS * 6 + 1024) return c.json({ error: 'The IIF file is too large' }, 413)
  const raw = await body(c)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return c.json({ error: 'Body must be { iif, apply?, expected_new? }' }, 422)
  const { iif, apply, expected_new: expectedNew, ...extra } = raw as Record<string, unknown>
  if (Object.keys(extra).length) return c.json({ error: `Unknown field(s): ${Object.keys(extra).join(', ')}` }, 422)
  if (typeof iif !== 'string' || iif.length === 0) return c.json({ error: 'iif must be the text of the IIF file' }, 422)
  if (iif.length > MAX_IIF_CHARS) return c.json({ error: 'The IIF file is too large' }, 422)
  if (apply !== undefined && typeof apply !== 'boolean') return c.json({ error: 'apply must be true or false' }, 422)
  if (expectedNew !== undefined && !(Number.isInteger(expectedNew) && (expectedNew as number) >= 0)) return c.json({ error: 'expected_new must be a whole number' }, 422)

  const db = getDb(c.env)
  const entity = await db.from('gl_entities').select('id').eq('id', id).maybeSingle()
  if (entity.error) return dbError(c, entity.error, 'Failed to load entity')
  if (!entity.data) return c.json({ error: 'Entity not found' }, 404)

  const parsed = parseIifAccounts(iif)
  if (parsed.errors.length) return c.json({ error: 'The IIF file could not be imported', data: { errors: parsed.errors, skipped: parsed.skipped } }, 422)

  const existing = await fetchAllPages<ExistingAccount>((after) => {
    let q = db.from('gl_accounts').select('id, qb_name, number, account_type, qb_account_type, is_active').eq('entity_id', id)
    if (after !== null) q = q.gt('id', after)
    return q.order('id').limit(POSTGREST_MAX_ROWS)
  }, (r) => r.id)
  if (existing.error) return dbError(c, existing.error, 'Failed to load accounts')

  const plan = { ...planAccountImport(parsed.accounts, existing.data), skipped: parsed.skipped }
  if (apply !== true) return c.json({ data: { ...plan, applied: false, inserted: 0 } })
  if (plan.conflicts.length) return c.json({ error: 'The file conflicts with the ledger; nothing was imported', data: { ...plan, applied: false, inserted: 0 } }, 409)
  // The preview the user approved must still be the plan: if the ledger changed in between, stop.
  if (expectedNew !== undefined && expectedNew !== plan.new.length) {
    return c.json({ error: `The ledger changed since the preview (${String(expectedNew)} new then, ${plan.new.length} now); nothing was imported. Preview again.`, data: { ...plan, applied: false, inserted: 0 } }, 409)
  }
  if (!plan.new.length) return c.json({ data: { ...plan, applied: true, inserted: 0 } })

  const rows = plan.new.map((a) => ({
    entity_id: id, qb_name: a.qb_name, number: a.number, account_type: a.account_type, qb_account_type: a.qb_account_type, is_active: a.is_active,
  }))
  const { data, error } = await db.from('gl_accounts').insert(rows).select('id')
  if (error) {
    if (error.code === '23505') return c.json({ error: 'An account in the file was added to the ledger meanwhile; re-run the preview' }, 409)
    return writeError(c, error, 'Failed to import accounts')
  }
  return c.json({ data: { ...plan, applied: true, inserted: data?.length ?? 0 } }, 201)
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
  if ((from && !isRealIsoDate(from)) || (to && !isRealIsoDate(to))) return c.json({ error: 'from/to must be real YYYY-MM-DD dates' }, 422)
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
  const asOf = c.req.query('as_of') ?? ledgerToday()
  if (!isUuid(entityId)) return c.json({ error: 'entity_id must be a uuid' }, 422)
  if (!isRealIsoDate(asOf)) return c.json({ error: 'as_of must be a real YYYY-MM-DD date' }, 422)
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
