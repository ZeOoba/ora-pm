// server/middleware/error-handler.ts
import type { Context, Next } from 'hono'

/**
 * Catch unhandled errors thrown by route handlers.
 * Returns a sanitized 500 — never exposes raw DB/ORM messages externally.
 */
export async function errorHandlerMiddleware(c: Context, next: Next) {
  try {
    await next()
  } catch (err) {
    console.error('[ORA PM] Unhandled error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}
