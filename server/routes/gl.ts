// B8 ledger core API (admin-only: /api/gl is not in ADMIN_EXEMPT). FINANCIAL-DECISION CODE
// (refute-gated). Every write goes through 0023's Postgres functions, which with the tables'
// constraints and triggers enforce balance, immutability, same-entity accounts and period lock.
// No route here edits or deletes a posted entry: corrections are reversals.
import { Hono, type Context } from 'hono'
import { getDb } from '../db/client'
import { dbError } from '../lib/api-error'
import { toCents } from '../lib/ar-aging'
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
import { planCashArRun, type CashCharge, type CashKind } from '../lib/gl-ar-cash-posting'
import { AR_ROLES, planArRun, type ArKind, type ArPayment, type ArRole } from '../lib/gl-ar-posting'
import { MAX_TB_CHARS, planOpeningBalance, type ChartAccount } from '../lib/gl-opening-balance'
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

/** SHA-256 over exactly what would be posted: entity, start date and each line in order. */
async function planHash(entityId: string, startDate: string, lines: { account_id: string; debit_cents: number; credit_cents: number }[]): Promise<string> {
  const canonical = JSON.stringify([entityId, startDate, lines.map((l) => [l.account_id, l.debit_cents, l.credit_cents])])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The entity's live opening balance (not reversed), with its lines, or null. */
async function liveOpeningBalance(db: ReturnType<typeof getDb>, entityId: string) {
  const obs = await db.from('gl_journal_entries').select('id, entry_date, memo, posted_by, posted_at')
    .eq('entity_id', entityId).eq('source', 'opening_balance').order('posted_at', { ascending: false }).limit(50)
  if (obs.error) return { error: obs.error }
  if (!obs.data?.length) return { data: null }
  const ids = obs.data.map((o) => o.id)
  const revs = await db.from('gl_journal_entries').select('reverses_entry_id').in('reverses_entry_id', ids)
  if (revs.error) return { error: revs.error }
  const reversed = new Set((revs.data ?? []).map((r) => r.reverses_entry_id))
  const live = obs.data.find((o) => !reversed.has(o.id))
  if (!live) return { data: null }
  const lines = await db.from('gl_journal_lines').select('line_no, account_id, debit_cents, credit_cents').eq('entry_id', live.id).order('line_no').limit(POSTGREST_MAX_ROWS)
  if (lines.error) return { error: lines.error }
  return { data: { ...live, lines: lines.data ?? [] } }
}

async function loadChart(db: ReturnType<typeof getDb>, entityId: string) {
  return fetchAllPages<ChartAccount>((after) => {
    let q = db.from('gl_accounts').select('id, number, qb_name, account_type, is_active').eq('entity_id', entityId)
    if (after !== null) q = q.gt('id', after)
    return q.order('id').limit(POSTGREST_MAX_ROWS)
  }, (r) => r.id)
}

glRouter.get('/entities/:id/opening-balance', async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'id must be a uuid' }, 422)
  const db = getDb(c.env)
  const entity = await db.from('gl_entities').select('id, ledger_start_date').eq('id', id).maybeSingle()
  if (entity.error) return dbError(c, entity.error, 'Failed to load entity')
  if (!entity.data) return c.json({ error: 'Entity not found' }, 404)
  const ob = await liveOpeningBalance(db, id)
  if (ob.error) return dbError(c, ob.error, 'Failed to load opening balance')
  return c.json({ data: { ledger_start_date: entity.data.ledger_start_date, opening_balance: ob.data } })
})

/**
 * B8 slice 2: an LLC's opening balance from a CSV of QuickBooks' Trial Balance report.
 * Body: { csv, start_date (first of a month), apply?, expected_plan_hash? }. Without apply the
 * response is the plan (lines, totals, errors, warnings, plan_hash) and nothing is written. With
 * apply it posts through gl_post_opening_balance, dated start_date - 1, refusing on any plan
 * error, a live opening balance (reverse it first), or a plan_hash other than the previewed one
 * (the exact lines, not just the total, must be what the user saw).
 */
glRouter.post('/entities/:id/opening-balance', async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'id must be a uuid' }, 422)
  const declared = Number(c.req.header('content-length') ?? '0')
  if (declared > MAX_TB_CHARS * 6 + 1024) return c.json({ error: 'The trial balance file is too large' }, 413)
  const raw = await body(c)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return c.json({ error: 'Body must be { csv, start_date, apply?, expected_plan_hash? }' }, 422)
  const { csv, start_date: startDate, apply, expected_plan_hash: expected, ...extra } = raw as Record<string, unknown>
  if (Object.keys(extra).length) return c.json({ error: `Unknown field(s): ${Object.keys(extra).join(', ')}` }, 422)
  if (typeof csv !== 'string' || !csv.trim()) return c.json({ error: 'csv must be the text of the trial balance CSV' }, 422)
  if (csv.length > MAX_TB_CHARS) return c.json({ error: 'The trial balance file is too large' }, 422)
  if (typeof startDate !== 'string' || !isRealIsoDate(startDate) || !startDate.endsWith('-01')) return c.json({ error: 'start_date must be the first day of a month (YYYY-MM-01)' }, 422)
  if (apply !== undefined && typeof apply !== 'boolean') return c.json({ error: 'apply must be true or false' }, 422)
  if (expected !== undefined && (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected))) return c.json({ error: 'expected_plan_hash must be the plan_hash from the preview' }, 422)
  if (apply === true && expected === undefined) return c.json({ error: 'Posting requires expected_plan_hash from a preview' }, 422)

  const db = getDb(c.env)
  const entity = await db.from('gl_entities').select('id, ledger_start_date, accounting_basis').eq('id', id).maybeSingle()
  if (entity.error) return dbError(c, entity.error, 'Failed to load entity')
  if (!entity.data) return c.json({ error: 'Entity not found' }, 404)
  const chart = await loadChart(db, id)
  if (chart.error) return dbError(c, chart.error, 'Failed to load accounts')
  const live = await liveOpeningBalance(db, id)
  if (live.error) return dbError(c, live.error, 'Failed to load opening balance')

  const asOfDate = new Date(`${startDate}T00:00:00Z`)
  asOfDate.setUTCDate(asOfDate.getUTCDate() - 1)
  const asOf = asOfDate.toISOString().slice(0, 10)
  const plan = planOpeningBalance(csv, chart.data, { asOf, basis: entity.data.accounting_basis as 'accrual' | 'cash' })
  const result = {
    ...plan,
    plan_hash: await planHash(id, startDate, plan.lines),
    start_date: startDate,
    as_of: asOf,
    current_start_date: entity.data.ledger_start_date as string | null,
    live_opening_balance_id: live.data?.id ?? null,
    applied: false,
    entry_id: null as string | null,
  }
  if (entity.data.ledger_start_date && entity.data.ledger_start_date !== startDate) {
    result.warnings = [...result.warnings, `changes this LLC's ledger start date from ${entity.data.ledger_start_date as string} to ${startDate}`]
  }
  if (apply !== true) return c.json({ data: result }, plan.errors.length ? 422 : 200)
  if (plan.errors.length) return c.json({ error: 'The trial balance cannot be posted', data: result }, 422)
  if (live.data) return c.json({ error: 'This LLC already has an opening balance; reverse it before posting a new one', data: result }, 409)
  if (expected !== result.plan_hash) return c.json({ error: 'The plan changed since the preview (accounts or amounts); preview again', data: result }, 409)
  const postedBy = c.get('adminEmail')
  if (!postedBy) return c.json({ error: 'Posting requires an identified admin' }, 403)
  const { data, error } = await db.rpc('gl_post_opening_balance', {
    p_entity_id: id,
    p_start_date: startDate,
    p_lines: plan.lines.map((l) => ({ account_id: l.account_id, debit_cents: l.debit_cents, credit_cents: l.credit_cents })),
    p_posted_by: postedBy,
  })
  if (error) return writeError(c, error, 'Failed to post the opening balance')
  return c.json({ data: { ...result, applied: true, entry_id: data as string } }, 201)
})

// ── B8 slice 3: AR posting (accrual LLCs) ─────────────────────────────────────────────────────
type Db = ReturnType<typeof getDb>

/** `.in()` over many ids, in chunks (PostgREST puts them in the URL), every page of each chunk. */
async function selectIn<T extends { id: string }>(db: Db, table: string, columns: string, column: string, ids: string[]) {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const res = await fetchAllPages<T>((after) => {
      let q = db.from(table).select(columns).in(column, chunk)
      if (after !== null) q = q.gt('id', after)
      return q.order('id').limit(POSTGREST_MAX_ROWS) as unknown as PromiseLike<{ data: T[] | null; error: { message: string } | null }>
    }, (r) => r.id)
    if (res.error) return { error: res.error }
    out.push(...res.data)
  }
  return { data: out }
}

/** Everything a run needs for one entity: its leases' charges and payments, postings, snapshot, roles. */
/** The calendar day before a YYYY-MM-DD date. */
function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/** The entity's properties and lease ids (property → unit → lease). */
async function entityLeases(db: Db, entityId: string) {
  const props = await fetchAllPages<{ id: string }>((after) => {
    let q = db.from('properties').select('id').eq('gl_entity_id', entityId)
    if (after !== null) q = q.gt('id', after)
    return q.order('id').limit(POSTGREST_MAX_ROWS)
  }, (r) => r.id)
  if (props.error) return { error: props.error }
  const units = await selectIn<{ id: string }>(db, 'units', 'id', 'property_id', (props.data ?? []).map((p) => p.id))
  if (units.error) return { error: units.error }
  const leases = await selectIn<{ id: string }>(db, 'leases', 'id', 'unit_id', units.data.map((u) => u.id))
  if (leases.error) return { error: leases.error }
  return { data: { propertyIds: props.data.map((p) => p.id), leaseIds: leases.data.map((l) => l.id) } }
}

type BalanceForwardRow = { id: string; lease_id: string; as_of: string; amount: number | string; voided_at: string | null }

async function loadArState(db: Db, entityId: string) {
  const el = await entityLeases(db, entityId)
  if (el.error) return { error: el.error }
  const leaseIds = el.data.leaseIds
  const charges = await selectIn<CashCharge>(db, 'charges', 'id, lease_id, charge_date, due_date, type, amount, description, voided_at', 'lease_id', leaseIds)
  if (charges.error) return { error: charges.error }
  const payments = await selectIn<ArPayment>(db, 'payments', 'id, lease_id, payment_date, amount, method, stripe_status, status_changed_at', 'lease_id', leaseIds)
  if (payments.error) return { error: payments.error }
  const postings = await fetchAllPages<{ id: string; kind: ArKind; source_id: string }>((after) => {
    let q = db.from('gl_ar_postings').select('id, kind, source_id').eq('entity_id', entityId)
    if (after !== null) q = q.gt('id', after)
    return q.order('id').limit(POSTGREST_MAX_ROWS)
  }, (r) => r.id)
  if (postings.error) return { error: postings.error }
  const events = await fetchAllPages<{ id: string; kind: CashKind; source_id: string; lease_id: string; event_date: string; alloc_date: string }>((after) => {
    let q = db.from('gl_ar_cash_events').select('id, kind, source_id, lease_id, event_date, alloc_date').eq('entity_id', entityId)
    if (after !== null) q = q.gt('id', after)
    return q.order('id').limit(POSTGREST_MAX_ROWS)
  }, (r) => r.id)
  if (events.error) return { error: events.error }
  const items = await fetchAllPages<{ source_id: string; kind: 'charge' | 'payment' | 'balance_forward'; counted: boolean; cents: number | string }>((after) => {
    let q = db.from('gl_ar_tieout_items').select('source_id, kind, counted, cents').eq('entity_id', entityId)
    if (after !== null) q = q.gt('source_id', after)
    return q.order('source_id').limit(POSTGREST_MAX_ROWS)
  }, (r) => r.source_id)
  if (items.error) return { error: items.error }
  const roles = await db.from('gl_ar_accounts').select('role, account_id').eq('entity_id', entityId)
  if (roles.error) return { error: roles.error }
  const locks = await fetchAllPages<{ period_start: string }>((after) => {
    let q = db.from('gl_periods').select('period_start').eq('entity_id', entityId).eq('status', 'locked')
    if (after !== null) q = q.gt('period_start', after)
    return q.order('period_start').limit(POSTGREST_MAX_ROWS)
  }, (r) => r.period_start)
  if (locks.error) return { error: locks.error }
  // 0032: balance forwards from QuickBooks. Counted ones (in the snapshot) enter the cash replay with
  // the snapshot's signed cents; a live one the tie-out did not count goes to attention. A counted one
  // that reads voided or missing cannot happen (BF6); fail the plan closed if it does.
  const forwards = await selectIn<BalanceForwardRow>(db, 'balance_forwards', 'id, lease_id, as_of, amount, voided_at', 'lease_id', leaseIds)
  if (forwards.error) return { error: forwards.error }
  const bfById = new Map(forwards.data.map((b) => [b.id, b]))
  const counted = new Set<string>()
  const balanceForwards: { id: string; lease_id: string; as_of: string; cents: number }[] = []
  const bfProblems: string[] = []
  for (const i of items.data) {
    if (i.kind !== 'balance_forward') continue
    counted.add(i.source_id)
    const b = bfById.get(i.source_id)
    const cents = Number(i.cents)
    if (!b || b.voided_at || !Number.isSafeInteger(cents)) { bfProblems.push(`balance forward ${i.source_id} is in the AR tie-out but missing or voided in the app`); continue }
    if (i.counted) balanceForwards.push({ id: b.id, lease_id: b.lease_id, as_of: b.as_of, cents })
  }
  const liveBalanceForwards = forwards.data.filter((b) => !b.voided_at && !counted.has(b.id))
  return {
    data: {
      propertyIds: el.data.propertyIds,
      lockedMonths: locks.data.map((l) => l.period_start),
      charges: charges.data, payments: payments.data, postings: postings.data, events: events.data,
      tieoutItems: items.data.map((i) => ({ source_id: i.source_id, kind: i.kind, counted: i.counted, cents: Number(i.cents) })),
      roles: Object.fromEntries((roles.data ?? []).map((r) => [r.role, r.account_id])) as Partial<Record<ArRole, string>>,
      balanceForwards, liveBalanceForwards, bfProblems,
    },
  }
}

async function arPlanHash(entityId: string, through: string, items: { kind: string; source_id: string; date: string; cents: number; alloc_date?: string }[]): Promise<string> {
  const canonical = JSON.stringify([entityId, through, items.map((i) => [i.kind, i.source_id, i.date, i.alloc_date ?? null, i.cents])])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

glRouter.get('/entities/:id/ar', async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'id must be a uuid' }, 422)
  const db = getDb(c.env)
  const entity = await db.from('gl_entities').select('id, accounting_basis, ledger_start_date').eq('id', id).maybeSingle()
  if (entity.error) return dbError(c, entity.error, 'Failed to load entity')
  if (!entity.data) return c.json({ error: 'Entity not found' }, 404)
  const [roles, tieout, props] = await Promise.all([
    db.from('gl_ar_accounts').select('role, account_id').eq('entity_id', id),
    db.from('gl_ar_tieouts').select('as_of, app_ar_cents, gl_ar_cents, confirmed_by, confirmed_at').eq('entity_id', id).maybeSingle(),
    db.from('properties').select('id, name, gl_entity_id').order('name').limit(POSTGREST_MAX_ROWS),
  ])
  if (roles.error || tieout.error || props.error) return dbError(c, (roles.error ?? tieout.error ?? props.error)!, 'Failed to load AR setup')
  // 0032: the LLC's live balance forwards, for the tie-out card. after_cutoff ones refuse the tie-out.
  const el = await entityLeases(db, id)
  if (el.error) return dbError(c, el.error, 'Failed to load AR setup')
  const bfs = await selectIn<BalanceForwardRow>(db, 'balance_forwards', 'id, lease_id, as_of, amount, voided_at', 'lease_id', el.data.leaseIds)
  if (bfs.error) return dbError(c, bfs.error, 'Failed to load balance forwards')
  // Signed: a credit forward is negative (exactCents is for non-negative amounts only).
  const live: (BalanceForwardRow & { cents: number })[] = []
  for (const b of bfs.data) {
    if (b.voided_at) continue
    const cents = toCents(b.amount)
    if (cents === null) return dbError(c, { message: `non-numeric balance_forwards.amount on ${b.id}` }, 'Failed to load balance forwards')
    live.push({ ...b, cents })
  }
  const cutoff = entity.data.ledger_start_date ? dayBefore(entity.data.ledger_start_date as string) : null
  return c.json({ data: {
    accounting_basis: entity.data.accounting_basis, ledger_start_date: entity.data.ledger_start_date,
    roles: roles.data ?? [], tieout: tieout.data,
    properties: (props.data ?? []).filter((p) => p.gl_entity_id === id || p.gl_entity_id === null),
    balance_forwards: {
      count: live.length,
      net_cents: live.reduce((a, b) => a + b.cents, 0),
      positive_cents: live.filter((b) => b.cents > 0).reduce((a, b) => a + b.cents, 0),
      negative_cents: live.filter((b) => b.cents < 0).reduce((a, b) => a + b.cents, 0),
      after_cutoff: cutoff ? live.filter((b) => b.as_of > cutoff).map((b) => ({ lease_id: b.lease_id, as_of: b.as_of, amount_cents: b.cents })) : [],
    },
  } })
})

/** Map account roles: { roles: { ar: <account id>, rent: <account id>, late_fee: null, ... } }. */
glRouter.put('/entities/:id/ar/accounts', async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'id must be a uuid' }, 422)
  const raw = await body(c) as { roles?: Record<string, unknown> } | undefined
  const roles = raw?.roles
  if (!roles || typeof roles !== 'object' || Array.isArray(roles) || Object.keys(raw!).length !== 1) return c.json({ error: 'Body must be { roles: { <role>: <account id> | null } }' }, 422)
  const set: { entity_id: string; role: string; account_id: string; updated_by: string }[] = []
  const clear: string[] = []
  const by = c.get('adminEmail')
  if (!by) return c.json({ error: 'Changing account roles requires an identified admin' }, 403)
  for (const [role, acct] of Object.entries(roles)) {
    if (!(AR_ROLES as readonly string[]).includes(role)) return c.json({ error: `Unknown role ${role}` }, 422)
    if (acct === null) clear.push(role)
    else if (typeof acct === 'string' && isUuid(acct)) set.push({ entity_id: id, role, account_id: acct, updated_by: by })
    else return c.json({ error: `Role ${role} needs an account id or null` }, 422)
  }
  const db = getDb(c.env)
  if (set.length) {
    const { error } = await db.from('gl_ar_accounts').upsert(set, { onConflict: 'entity_id,role' })
    if (error) return writeError(c, error, 'Failed to save account roles')
  }
  if (clear.length) {
    const { error } = await db.from('gl_ar_accounts').delete().eq('entity_id', id).in('role', clear)
    if (error) return writeError(c, error, 'Failed to save account roles')
  }
  return c.json({ data: { saved: set.length, cleared: clear.length } })
})

/** Assign a property to this LLC (or release it): { property_id, assigned }. */
glRouter.put('/entities/:id/ar/properties', async (c) => {
  const id = c.req.param('id')
  const raw = await body(c) as { property_id?: unknown; assigned?: unknown } | undefined
  if (!isUuid(id) || !raw || typeof raw.property_id !== 'string' || !isUuid(raw.property_id) || typeof raw.assigned !== 'boolean' || Object.keys(raw).length !== 2) {
    return c.json({ error: 'Body must be { property_id, assigned }' }, 422)
  }
  const db = getDb(c.env)
  let q = db.from('properties').update({ gl_entity_id: raw.assigned ? id : null }).eq('id', raw.property_id)
  q = raw.assigned ? q.is('gl_entity_id', null) : q.eq('gl_entity_id', id)
  const { data, error } = await q.select('id')
  if (error) return writeError(c, error, 'Failed to update the property')
  if (!data?.length) return c.json({ error: raw.assigned ? 'That property already belongs to another LLC' : 'That property is not in this LLC' }, 409)
  return c.json({ data: { property_id: raw.property_id, assigned: raw.assigned } })
})

/** Confirm the AR tie-out (the database computes both sides and refuses unless they match). */
glRouter.post('/entities/:id/ar/tieout', async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'id must be a uuid' }, 422)
  const by = c.get('adminEmail')
  if (!by) return c.json({ error: 'Confirming the tie-out requires an identified admin' }, 403)
  const { data, error } = await getDb(c.env).rpc('gl_confirm_ar_tieout', { p_entity_id: id, p_confirmed_by: by })
  if (error) return writeError(c, error, 'Failed to confirm the AR tie-out')
  return c.json({ data: { app_ar_cents: data } }, 201)
})

/**
 * Plan (and with apply, post) an AR run through a date: { through, apply?, expected_plan_hash? }.
 * The response lists every item that would post, anything needing attention, and blocking errors.
 */
glRouter.post('/entities/:id/ar/run', async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'id must be a uuid' }, 422)
  const raw = await body(c)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return c.json({ error: 'Body must be { through, apply?, expected_plan_hash? }' }, 422)
  const { through, apply, expected_plan_hash: expected, ...extra } = raw as Record<string, unknown>
  if (Object.keys(extra).length) return c.json({ error: `Unknown field(s): ${Object.keys(extra).join(', ')}` }, 422)
  if (typeof through !== 'string' || !isRealIsoDate(through)) return c.json({ error: 'through must be a YYYY-MM-DD date' }, 422)
  if (apply !== undefined && typeof apply !== 'boolean') return c.json({ error: 'apply must be true or false' }, 422)
  if (expected !== undefined && (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected))) return c.json({ error: 'expected_plan_hash must be the plan_hash from the preview' }, 422)
  if (apply === true && expected === undefined) return c.json({ error: 'Posting requires expected_plan_hash from a preview' }, 422)

  const db = getDb(c.env)
  const entity = await db.from('gl_entities').select('id, accounting_basis, ledger_start_date').eq('id', id).maybeSingle()
  if (entity.error) return dbError(c, entity.error, 'Failed to load entity')
  if (!entity.data) return c.json({ error: 'Entity not found' }, 404)
  const cash = entity.data.accounting_basis === 'cash'
  const start = entity.data.ledger_start_date as string | null
  if (!start) return c.json({ error: 'Set the ledger start date and post the opening balance first' }, 422)
  if (through < start || through > ledgerToday()) return c.json({ error: `through must be between the ledger start date (${start}) and today` }, 422)
  const tie = await db.from('gl_ar_tieouts').select('entity_id').eq('entity_id', id).maybeSingle()
  if (tie.error) return dbError(c, tie.error, 'Failed to load the AR tie-out')
  if (!tie.data) return c.json({ error: 'Confirm the AR tie-out before posting' }, 409)

  const state = await loadArState(db, id)
  if (state.error) return dbError(c, state.error, 'Failed to load AR activity')
  const plan = cash
    ? planCashArRun({ startDate: start, through, charges: state.data.charges, payments: state.data.payments, events: state.data.events, tieoutItems: state.data.tieoutItems, roles: state.data.roles, lockedMonths: state.data.lockedMonths,
        balanceForwards: state.data.balanceForwards, liveBalanceForwards: state.data.liveBalanceForwards })
    : planArRun({ startDate: start, through, ...state.data })
  plan.errors.push(...state.data.bfProblems)
  const result = { ...plan, through, plan_hash: await arPlanHash(id, through, plan.items), applied: false, posted: 0 }
  if (apply !== true) return c.json({ data: result }, plan.errors.length ? 422 : 200)
  if (plan.errors.length) return c.json({ error: 'The run cannot be posted', data: result }, 422)
  if (expected !== result.plan_hash) return c.json({ error: 'AR activity changed since the preview; preview again', data: result }, 409)
  if (!plan.items.length) return c.json({ data: { ...result, applied: true } })
  const by = c.get('adminEmail')
  if (!by) return c.json({ error: 'Posting requires an identified admin' }, 403)
  const { data, error } = await db.rpc(cash ? 'gl_post_ar_cash_batch' : 'gl_post_ar_batch', {
    p_entity_id: id, p_through: through, p_posted_by: by,
    p_items: plan.items.map((i) => ({ kind: i.kind, source_id: i.source_id })),
  })
  if (error) {
    if (error.code === '23505') return c.json({ error: 'Some of this activity was posted meanwhile; preview again' }, 409)
    return writeError(c, error, 'Failed to post AR')
  }
  return c.json({ data: { ...result, applied: true, posted: data as number } }, 201)
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
