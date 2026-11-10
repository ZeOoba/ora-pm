// B1 collections workflow: request schemas and read-time derivation for promises to pay and AR
// disputes (supabase/migrations/0022_collections_workflow.sql).
//
// Not financial-decision code: these records move no money and nothing in billing, late fees,
// autopay or the balance/aging reports reads them. Kept out of server/lib/schemas.ts (which bounds
// charge and payment inserts and is refute-gated) so the two concerns cannot blur.
import { z } from 'zod'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'Must be a real date')
const uuid = z.string().regex(UUID_RE, 'Must be a uuid')
// NUMERIC(12,2): at most 10 integer digits; cents only.
const amount = z.number().positive('Amount must be positive').max(9_999_999_999.99)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'At most two decimal places')
const note = z.string().trim().max(2000)

export const PROMISE_STATUSES = ['open', 'kept', 'broken', 'cancelled'] as const
export const DISPUTE_STATUSES = ['open', 'resolved', 'withdrawn'] as const
export type PromiseStatus = (typeof PROMISE_STATUSES)[number]
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number]

export const PromiseInsertSchema = z.object({
  lease_id: uuid,
  amount,
  promised_date: isoDate,
  notes: note.nullish(),
}).strict()

/** Resolve an open promise. Only terminal statuses: a resolved promise is never reopened. */
export const PromiseResolveSchema = z.object({
  status: z.enum(['kept', 'broken', 'cancelled']),
}).strict()

export const DisputeInsertSchema = z.object({
  lease_id: uuid,
  amount: amount.nullish(),
  reason: z.string().trim().min(1, 'Required').max(2000),
}).strict()

export const DisputeResolveSchema = z.object({
  status: z.enum(['resolved', 'withdrawn']),
  resolution: note.nullish(),
}).strict()

export const CollectionsListQuerySchema = z.object({
  status: z.enum(['open', 'all']).default('open'),
  lease_id: uuid.optional(),
  tenant_id: uuid.optional(),
}).strict()

export function isUuid(s: string): boolean {
  return UUID_RE.test(s)
}

/** Today as YYYY-MM-DD (UTC, date-only) — the clock the aging report and cron use. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/** An open promise whose date has passed. Derived, never stored, so it cannot go stale. */
export function isLapsed(p: { status: string; promised_date: string }, today: string): boolean {
  return p.status === 'open' && p.promised_date < today
}

export function withLapsed<T extends { status: string; promised_date: string }>(rows: T[], today: string): (T & { lapsed: boolean })[] {
  return rows.map((r) => ({ ...r, lapsed: isLapsed(r, today) }))
}
