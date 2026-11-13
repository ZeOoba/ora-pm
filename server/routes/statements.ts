import { Hono } from 'hono'
import { z } from 'zod'
import { getDb } from '../db/client'
import { dbError } from '../lib/api-error'
import { fetchChunked, fetchAllPages, POSTGREST_MAX_ROWS } from '../lib/postgrest-paging'
import { toCents, daysPastDue } from '../lib/ar-aging'
import { buildStatement, classifyPayment, type Statement, type StatementCharge, type StatementPayment } from '../lib/statement'
import { renderStatementEmail } from '../lib/statement-render'

// Tenant account statements (2026-11-09; scope ruled by Gabriel the same day). Admin-only: this
// router sits under the /api/* adminAuthMiddleware (not in ADMIN_EXEMPT). One statement per lease.
//
//   GET /lease/:leaseId?start&end  one statement
//   GET /batch?start&end           every lease whose closing balance (as of end) is > 0
//   GET /packet?start&end          Outlook draft packet for scripts/stage-statement-drafts.ps1
//
// NOTHING here sends mail. The packet is downloaded by an admin and turned into Outlook DRAFTS by a
// local script; sending is a separate, in-turn-confirmed step (Hard Invariant 1).
//
// Fail closed (500, no partial statement): any read error, a non-numeric amount, a malformed date,
// or a snapshot that does not tie — per lease, Σ fetched non-voided charges must equal
// ar_ledger.total_charged and Σ counted payments must equal ar_ledger.total_paid (the same
// cross-check reports.ts runs for aging, extended to payments because a statement lists them). A
// mismatch re-runs the whole read once (a concurrent write is transient), then 500s.
//
// PII: error messages and logs carry lease ids only — never names, emails or amounts.

const BULK_QUERY_CHUNK_SIZE = 100

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }
type Db = ReturnType<typeof getDb>

export const statementsRouter = new Hono<{ Bindings: Env }>()

type LedgerRow = { lease_id: string; tenant_id: string; tenant_name: string; property_id: string; property_name: string; suite: string; total_charged: unknown; total_paid: unknown; balance_forward: unknown; balance_forward_as_of: string | null }
type PropertyRow = { id: string; name: string; address: string | null; city: string | null; state: string | null; zip: string | null; entity_llc: string | null }
type TenantRow = { id: string; name: string; contact_name: string | null; contact_email: string | null }
type ChargeRow = { id: string; lease_id: string; charge_date: string; due_date: string; type: string; description: string | null; amount: unknown }
type PaymentRow = { id: string; lease_id: string; payment_date: string; amount: unknown; method: string; stripe_status: string | null; check_number: string | null }

export type StatementBlocker = 'missing_entity_llc' | 'missing_contact_email' | 'invalid_contact_email'

export interface LeaseStatement {
  lease_id: string
  tenant_id: string
  tenant_name: string
  contact_name: string | null
  contact_email: string | null
  property_id: string
  property_name: string
  property_address: string
  suite: string
  entity_llc: string | null
  blockers: StatementBlocker[]
  statement: Statement
}

type ReadFail = { ok: false; error: { message: string; code?: string }; publicMsg: string }
type ReadOk = { ok: true; rows: LeaseStatement[]; mismatch: string | null }

const LEDGER_COLS = 'lease_id, tenant_id, tenant_name, property_id, property_name, suite, total_charged, total_paid, balance_forward, balance_forward_as_of'
const fail = (message: string, publicMsg = 'Failed to build statement'): ReadFail => ({ ok: false, error: { message }, publicMsg })
const emailOk = (v: string) => z.string().email().safeParse(v).success

// Amount-free classification of a buildStatement error (see the throws in server/lib/statement.ts).
export function buildErrorKind(message: string): 'malformed date' | 'invalid range' | 'invalid amount' | 'does not foot' | 'other' {
  if (/malformed .*date/.test(message)) return 'malformed date'
  if (/invalid statement range/.test(message)) return 'invalid range'
  if (/integer cents/.test(message)) return 'invalid amount'
  if (/does not foot/.test(message)) return 'does not foot'
  return 'other'
}

function parseRange(start: string | undefined, end: string | undefined): { start: string; end: string } | string {
  if (!start || !end) return 'start and end are required (YYYY-MM-DD)'
  if (Number.isNaN(daysPastDue(start, start)) || Number.isNaN(daysPastDue(end, end))) return 'start and end must be valid YYYY-MM-DD dates'
  if (start > end) return 'start must be on or before end'
  return { start, end }
}

function addressOf(p: PropertyRow | undefined): string {
  if (!p) return ''
  const cityLine = [p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  return [p.address, cityLine].filter(Boolean).join(', ')
}

async function readStatements(db: Db, leaseId: string | null, start: string, end: string): Promise<ReadOk | ReadFail> {
  const { data: ledger, error: ledgerErr } = await fetchAllPages<LedgerRow>((after) => {
    let q = db.from('ar_ledger').select(LEDGER_COLS)
    if (leaseId !== null) q = q.eq('lease_id', leaseId)
    if (after !== null) q = q.gt('lease_id', after)
    return q.order('lease_id').limit(POSTGREST_MAX_ROWS)
  }, (r) => r.lease_id)
  if (ledgerErr) return { ok: false, error: ledgerErr, publicMsg: 'Failed to load statement ledger' }
  if (ledger.length === 0) return { ok: true, rows: [], mismatch: null }

  const leaseIds = ledger.map(r => r.lease_id)
  const propertyIds = [...new Set(ledger.map(r => r.property_id))]
  const tenantIds = [...new Set(ledger.map(r => r.tenant_id))]

  const props = await fetchChunked<PropertyRow>(propertyIds, BULK_QUERY_CHUNK_SIZE, (chunk) =>
    db.from('properties').select('id, name, address, city, state, zip, entity_llc').in('id', chunk), { maxRows: POSTGREST_MAX_ROWS })
  if (props.error) return { ok: false, error: props.error, publicMsg: 'Failed to load statement properties' }
  const tenants = await fetchChunked<TenantRow>(tenantIds, BULK_QUERY_CHUNK_SIZE, (chunk) =>
    db.from('tenants').select('id, name, contact_name, contact_email').in('id', chunk), { maxRows: POSTGREST_MAX_ROWS })
  if (tenants.error) return { ok: false, error: tenants.error, publicMsg: 'Failed to load statement tenants' }

  // Lifetime history per lease (paged inside each chunk — a lease's history can exceed one page):
  // the opening balance and the cross-check both need every row, not just the period.
  const charges = await fetchChunked<ChargeRow>(leaseIds, BULK_QUERY_CHUNK_SIZE, (chunk) =>
    fetchAllPages<ChargeRow>((after) => {
      let q = db.from('charges').select('id, lease_id, charge_date, due_date, type, description, amount')
        .in('lease_id', chunk)
        .is('voided_at', null)
      if (after !== null) q = q.gt('id', after)
      return q.order('id').limit(POSTGREST_MAX_ROWS)
    }, (r) => r.id), { maxRows: Infinity })
  if (charges.error) return { ok: false, error: charges.error, publicMsg: 'Failed to load statement charges' }
  const payments = await fetchChunked<PaymentRow>(leaseIds, BULK_QUERY_CHUNK_SIZE, (chunk) =>
    fetchAllPages<PaymentRow>((after) => {
      let q = db.from('payments').select('id, lease_id, payment_date, amount, method, stripe_status, check_number')
        .in('lease_id', chunk)
      if (after !== null) q = q.gt('id', after)
      return q.order('id').limit(POSTGREST_MAX_ROWS)
    }, (r) => r.id), { maxRows: Infinity })
  if (payments.error) return { ok: false, error: payments.error, publicMsg: 'Failed to load statement payments' }

  const chargesBy = new Map<string, StatementCharge[]>()
  for (const c of charges.data) {
    const amountCents = toCents(c.amount)
    if (amountCents === null || amountCents < 0) return fail(`non-numeric or negative charges.amount on charge ${c.id}`)
    const list = chargesBy.get(c.lease_id) ?? []
    list.push({ id: c.id, charge_date: c.charge_date, due_date: c.due_date, type: c.type, description: c.description, amountCents })
    chargesBy.set(c.lease_id, list)
  }
  const paymentsBy = new Map<string, StatementPayment[]>()
  for (const p of payments.data) {
    const amountCents = toCents(p.amount)
    if (amountCents === null || amountCents <= 0) return fail(`non-numeric or non-positive payments.amount on payment ${p.id}`)
    const list = paymentsBy.get(p.lease_id) ?? []
    list.push({ id: p.id, payment_date: p.payment_date, method: p.method, stripe_status: p.stripe_status, check_number: p.check_number, amountCents })
    paymentsBy.set(p.lease_id, list)
  }

  const propBy = new Map(props.data.map(p => [p.id, p]))
  const tenantBy = new Map(tenants.data.map(t => [t.id, t]))
  const rows: LeaseStatement[] = []
  for (const led of ledger) {
    const lc = chargesBy.get(led.lease_id) ?? []
    const lp = paymentsBy.get(led.lease_id) ?? []
    const ledgerCharged = toCents(led.total_charged)
    const ledgerPaid = toCents(led.total_paid)
    const fetchedCharged = lc.reduce((a, c) => a + c.amountCents, 0)
    const fetchedPaid = lp.filter(p => classifyPayment(p) === 'counted').reduce((a, p) => a + p.amountCents, 0)
    // Log text names the lease and which total failed — never the amounts (REFUTE C6b: tenant
    // balances must not reach Worker logs).
    const failed: string[] = []
    if (ledgerCharged === null || ledgerCharged !== fetchedCharged) failed.push('charges vs ar_ledger.total_charged')
    if (ledgerPaid === null || ledgerPaid !== fetchedPaid) failed.push('counted payments vs ar_ledger.total_paid')
    if (failed.length > 0) return { ok: true, rows: [], mismatch: `lease ${led.lease_id}: ${failed.join(', ')} do not tie` }

    // 0030: the live balance forward comes from the same ledger row (same snapshot).
    const bfCents = toCents(led.balance_forward ?? 0)
    if (bfCents === null) return fail(`non-numeric ar_ledger.balance_forward for lease ${led.lease_id}`)
    if (bfCents !== 0 && typeof led.balance_forward_as_of !== 'string') return fail(`balance forward without a date for lease ${led.lease_id}`)
    const balanceForward = bfCents === 0 ? null : { id: led.lease_id, as_of: led.balance_forward_as_of as string, amountCents: bfCents }

    let statement: Statement
    try {
      statement = buildStatement({ charges: lc, payments: lp, balanceForward, start, end })
    } catch (e) {
      // buildStatement's own message can carry amounts, so log only which check failed.
      return fail(`statement build failed for lease ${led.lease_id}: ${buildErrorKind((e as Error).message)}`)
    }

    const prop = propBy.get(led.property_id)
    const ten = tenantBy.get(led.tenant_id)
    const entity = prop?.entity_llc?.trim() || null
    const email = ten?.contact_email?.trim() || null
    const blockers: StatementBlocker[] = []
    if (!entity) blockers.push('missing_entity_llc')
    if (!email) blockers.push('missing_contact_email')
    else if (!emailOk(email)) blockers.push('invalid_contact_email')

    rows.push({
      lease_id: led.lease_id,
      tenant_id: led.tenant_id,
      tenant_name: ten?.name ?? led.tenant_name,
      contact_name: ten?.contact_name?.trim() || null,
      contact_email: email,
      property_id: led.property_id,
      property_name: prop?.name ?? led.property_name,
      property_address: addressOf(prop),
      suite: led.suite,
      entity_llc: entity,
      blockers,
      statement,
    })
  }
  return { ok: true, rows, mismatch: null }
}

async function readWithRetry(db: Db, leaseId: string | null, start: string, end: string): Promise<ReadOk | ReadFail> {
  let read = await readStatements(db, leaseId, start, end)
  if (read.ok && read.mismatch) read = await readStatements(db, leaseId, start, end)
  if (read.ok && read.mismatch) return fail(`statement snapshot mismatch persisted after retry: ${read.mismatch}`)
  return read
}

async function readBatch(db: Db, start: string, end: string) {
  const read = await readWithRetry(db, null, start, end)
  if (!read.ok) return read
  return { ...read, rows: read.rows.filter(r => r.statement.closingCents > 0) }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

statementsRouter.get('/lease/:leaseId', async (c) => {
  if (!UUID_RE.test(c.req.param('leaseId'))) return c.json({ error: 'lease id must be a uuid' }, 422)
  const range = parseRange(c.req.query('start'), c.req.query('end'))
  if (typeof range === 'string') return c.json({ error: range }, 422)
  const read = await readWithRetry(getDb(c.env), c.req.param('leaseId'), range.start, range.end)
  if (!read.ok) return dbError(c, read.error, read.publicMsg)
  if (read.rows.length === 0) return c.json({ error: 'Lease not found' }, 404)
  return c.json({ data: read.rows[0] })
})

statementsRouter.get('/batch', async (c) => {
  const range = parseRange(c.req.query('start'), c.req.query('end'))
  if (typeof range === 'string') return c.json({ error: range }, 422)
  const read = await readBatch(getDb(c.env), range.start, range.end)
  if (!read.ok) return dbError(c, read.error, read.publicMsg)
  return c.json({ data: read.rows, start: range.start, end: range.end })
})

statementsRouter.get('/packet', async (c) => {
  const range = parseRange(c.req.query('start'), c.req.query('end'))
  if (typeof range === 'string') return c.json({ error: range }, 422)
  const read = await readBatch(getDb(c.env), range.start, range.end)
  if (!read.ok) return dbError(c, read.error, read.publicMsg)
  // closing_cents lets the batch page check the packet against the list the admin reviewed (the
  // packet is a second read; a ledger write in between must not go unnoticed).
  const items: { lease_id: string; closing_cents: number; to: string; subject: string; html: string }[] = []
  const skipped: { lease_id: string; closing_cents: number; reasons: StatementBlocker[] }[] = []
  for (const r of read.rows) {
    if (r.blockers.length > 0) { skipped.push({ lease_id: r.lease_id, closing_cents: r.statement.closingCents, reasons: r.blockers }); continue }
    const { subject, html } = renderStatementEmail(r.statement, {
      leaseId: r.lease_id, tenantName: r.tenant_name, contactName: r.contact_name, propertyName: r.property_name,
      propertyAddress: r.property_address, suite: r.suite, entityLlc: r.entity_llc!,
    })
    items.push({ lease_id: r.lease_id, closing_cents: r.statement.closingCents, to: r.contact_email!, subject, html })
  }
  return c.json({ version: 1, start: range.start, end: range.end, generated_at: new Date().toISOString(), items, skipped })
})
