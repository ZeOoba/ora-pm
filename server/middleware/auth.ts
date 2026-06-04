import { Context, Next } from 'hono'

// Validates the Bearer token for protected cron endpoints
export async function cronAuthMiddleware(c: Context, next: Next): Promise<Response | void> {
  const authHeader = c.req.header('Authorization')
  const secret = (c.env as { CRON_SECRET?: string })?.CRON_SECRET
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  await next()
}
