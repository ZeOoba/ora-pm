import type { Context } from 'hono'

// Shared error-hygiene helper (OI-042): logs the real DB error server-side
// (code + message) and returns a generic client-safe message. Never echo
// error.message to the client — Postgres errors can leak schema/constraint
// names and internal detail. Reused by Tasks 8 and 9 — keep this signature
// stable, do not add required params.
export function dbError(c: Context, error: { message: string; code?: string }, publicMsg = 'Database error') {
  console.error(`[ORA PM] ${c.req.method} ${new URL(c.req.url).pathname}:`, error.code, error.message)
  return c.json({ error: publicMsg }, 500)
}
