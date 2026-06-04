import { Hono } from 'hono'
import { cors } from 'hono/cors'

export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  CRON_SECRET: string
}

export function createApp() {
  const app = new Hono<{ Bindings: Env }>()

  app.use('/api/*', cors())

  app.get('/api/health', (c) =>
    c.json({ status: 'ok', ts: new Date().toISOString() })
  )

  // Routes mounted in subsequent tasks

  return app
}

export default createApp()
