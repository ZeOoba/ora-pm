import type { Context } from 'hono'

// Shared error-hygiene helper (OI-042): logs the real DB error server-side
// (code + message) and returns a generic client-safe message. Never echo
// error.message to the client — Postgres errors can leak schema/constraint
// names and internal detail. Reused by Tasks 8 and 9 — keep this signature
// stable, do not add required params.
//
// One exception: a refusal the database raises with a message written for the user, prefixed
// 'bf: ' (the balance-forward rules, migration 0030 — e.g. a payment dated before a lease's
// QuickBooks cut-off). It is shown as written (prefix dropped): 409 when the data moved under the
// request (40001) or a duplicate exists (23505), else 422.
export function userRuleMessage(error: { message?: string } | null | undefined): string | null {
  const m = error?.message ?? ''
  return m.startsWith('bf: ') ? m.slice(4) : null
}

export function dbError(c: Context, error: { message: string; code?: string }, publicMsg = 'Database error') {
  const rule = userRuleMessage(error)
  if (rule) return c.json({ error: rule }, error.code === '40001' || error.code === '23505' ? 409 : 422)
  console.error(`[ORA PM] ${c.req.method} ${new URL(c.req.url).pathname}:`, error.code, error.message)
  return c.json({ error: publicMsg }, 500)
}
