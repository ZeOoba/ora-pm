// B8 ledger core (roadmap P3): request schemas, cents parsing, entry validation and the trial
// balance. FINANCIAL-DECISION CODE (refute-gated): see scripts/check-refute-required.ts.
//
// The database is the authority (supabase/migrations/0023_gl_core.sql enforces balance, one side
// per line, same-entity accounts, immutability and period lock). validateEntryLines mirrors those
// rules only to return a precise 422 before the RPC; it never relaxes them.
import { z } from 'zod'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuid = z.string().regex(UUID_RE, 'Must be a uuid')
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`)
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s)
  }, 'Must be a real date')

/** Largest amount accepted on one line: $1 trillion (1e14 cents), far inside Number.MAX_SAFE_INTEGER. */
export const MAX_LINE_CENTS = 1_000_000_000_000_00

/**
 * Exact decimal-string dollars to integer cents. Accepts "1234", "1234.5", "1234.56"; rejects
 * signs, exponents, separators, more than two decimals, and anything over MAX_LINE_CENTS. Strings
 * only: a JSON number like 0.1 + 0.2 has already lost precision before it reaches us.
 */
export function parseCents(input: string): number | null {
  const m = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(input.trim())
  if (!m) return null
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
  return Number.isSafeInteger(cents) && cents <= MAX_LINE_CENTS ? cents : null
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const a = Math.abs(cents)
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`
}

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

export const EntityInsertSchema = z.object({
  name: z.string().trim().min(1).max(200),
  accounting_basis: z.enum(['accrual', 'cash']),
  qb_file_name: z.string().trim().max(300).nullish(),
}).strict()

const AccountSchema = z.object({
  number: z.string().trim().min(1).max(40).nullish(),
  qb_name: z.string().trim().min(1).max(300),
  account_type: z.enum(ACCOUNT_TYPES),
  is_active: z.boolean().optional(),
}).strict()

/** Chart of accounts import: mirrors the LLC's QuickBooks chart (one call per entity). */
export const AccountsImportSchema = z.object({
  accounts: z.array(AccountSchema).min(1).max(1000),
}).strict()

const amountString = z.string().max(20)

export const JournalPostSchema = z.object({
  entity_id: uuid,
  entry_date: isoDate,
  memo: z.string().trim().min(1).max(500),
  source: z.enum(['manual', 'opening_balance']).default('manual'),
  lines: z.array(z.object({
    account_id: uuid,
    debit: amountString.optional(),
    credit: amountString.optional(),
    memo: z.string().trim().max(500).nullish(),
  }).strict()).min(2).max(500),
}).strict()

export const JournalReverseSchema = z.object({
  entry_date: isoDate,
  memo: z.string().trim().min(1).max(500),
}).strict()

export const PeriodLockSchema = z.object({
  entity_id: uuid,
  period_start: isoDate.refine((s) => s.endsWith('-01'), 'Must be the first day of a month'),
}).strict()

export type JournalPost = z.infer<typeof JournalPostSchema>
export type CentsLine = { account_id: string; debit_cents: number; credit_cents: number; memo: string | null }

export type LineValidation =
  | { ok: true; lines: CentsLine[]; totalCents: number }
  | { ok: false; errors: string[] }

/** Debit XOR credit per line, exact cents, at least two lines, Σ debits = Σ credits > 0. */
export function validateEntryLines(lines: JournalPost['lines']): LineValidation {
  const errors: string[] = []
  const out: CentsLine[] = []
  lines.forEach((l, i) => {
    const n = i + 1
    const hasD = l.debit !== undefined && l.debit.trim() !== ''
    const hasC = l.credit !== undefined && l.credit.trim() !== ''
    if (hasD === hasC) {
      errors.push(`line ${n}: enter a debit or a credit, not ${hasD ? 'both' : 'neither'}`)
      return
    }
    const cents = parseCents((hasD ? l.debit : l.credit) as string)
    if (cents === null || cents === 0) {
      errors.push(`line ${n}: amount must be a positive dollar amount with at most two decimals`)
      return
    }
    out.push({ account_id: l.account_id, debit_cents: hasD ? cents : 0, credit_cents: hasD ? 0 : cents, memo: l.memo?.trim() || null })
  })
  if (errors.length) return { ok: false, errors }
  const debits = out.reduce((s, l) => s + l.debit_cents, 0)
  const credits = out.reduce((s, l) => s + l.credit_cents, 0)
  // Each line is capped at MAX_LINE_CENTS, but enough lines could push a JS sum past 2^53 and make
  // the balance comparison inexact. Refuse rather than compare rounded numbers.
  if (!Number.isSafeInteger(debits) || !Number.isSafeInteger(credits)) {
    return { ok: false, errors: ['entry total is too large to post as one entry'] }
  }
  if (debits !== credits) {
    return { ok: false, errors: [`entry does not balance: debits ${formatCents(debits)} ≠ credits ${formatCents(credits)}`] }
  }
  return { ok: true, lines: out, totalCents: debits }
}

export interface TbAccount { id: string; number: string | null; qb_name: string; account_type: AccountType; is_active: boolean }
export interface TbLine { account_id: string; debit_cents: number | string; credit_cents: number | string }
export interface TbRow {
  account_id: string
  number: string | null
  qb_name: string
  account_type: AccountType
  debit_cents: number
  credit_cents: number
  /** Debit-positive net (debits − credits). */
  net_cents: number
}

function toInt(v: number | string, what: string): number {
  const n = typeof v === 'string' ? Number(v) : v
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`non-integer or negative ${what}: ${String(v)}`)
  return n
}

/**
 * Trial balance: per-account debit and credit totals in integer cents, every account listed
 * (zero rows included, so a missing account is visible), plus totals. Throws on a line whose
 * account is not in the entity's chart: the DB forbids it, so seeing one means a bad read.
 */
export function trialBalance(accounts: TbAccount[], lines: TbLine[]): { rows: TbRow[]; debit_cents: number; credit_cents: number; balanced: boolean } {
  const byId = new Map(accounts.map((a) => [a.id, { ...a, d: 0, c: 0 }]))
  for (const l of lines) {
    const a = byId.get(l.account_id)
    if (!a) throw new Error(`trial balance: line references account ${l.account_id} outside this entity`)
    a.d += toInt(l.debit_cents, 'debit_cents')
    a.c += toInt(l.credit_cents, 'credit_cents')
    if (!Number.isSafeInteger(a.d) || !Number.isSafeInteger(a.c)) throw new Error('trial balance: total exceeds safe integer range')
  }
  const rows: TbRow[] = [...byId.values()]
    .map((a) => ({ account_id: a.id, number: a.number, qb_name: a.qb_name, account_type: a.account_type, debit_cents: a.d, credit_cents: a.c, net_cents: a.d - a.c }))
    .sort((x, y) => (x.number ?? '￿').localeCompare(y.number ?? '￿', 'en-US', { numeric: true }) || x.qb_name.localeCompare(y.qb_name))
  const debit_cents = rows.reduce((s, r) => s + r.debit_cents, 0)
  const credit_cents = rows.reduce((s, r) => s + r.credit_cents, 0)
  return { rows, debit_cents, credit_cents, balanced: debit_cents === credit_cents }
}

/**
 * Who may lock a period: the GL_PERIOD_LOCK_EMAILS allowlist (comma-separated, exact match).
 * Fail-closed: no allowlist configured means nobody can lock. Ratified 2026-11-10: monthly
 * close, Gabriel locks; the address lives in the environment, not in source.
 */
export function canLockPeriods(adminEmail: string | undefined, allowlist: string | undefined): boolean {
  if (!adminEmail) return false
  const allowed = (allowlist ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
  return allowed.includes(adminEmail.trim().toLowerCase())
}

export function isUuid(s: string): boolean {
  return UUID_RE.test(s)
}

/**
 * Message safe to return to the admin client for a GL write failure: only the ledger's own
 * rule violations (raised as "gl: ..." by 0023's functions and triggers) and our named CHECK /
 * UNIQUE constraints; anything else is a generic message (the raw error is logged by dbError).
 */
export function glRuleMessage(err: { message?: string; code?: string } | null | undefined): string | null {
  const m = err?.message ?? ''
  if (m.startsWith('gl: ')) return m.slice(4)
  const named = /constraint "(gl_[a-z0-9_]+)"/.exec(m)
  if (named) return `ledger rule violated (${named[1]})`
  return null
}
