import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { propertiesRouter } from './routes/properties'
import { unitsRouter } from './routes/units'
import { tenantsRouter } from './routes/tenants'
import { leasesRouter } from './routes/leases'
import { chargesRouter } from './routes/charges'
import { paymentsRouter } from './routes/payments'
import { cronRouter } from './routes/cron'

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

  app.route('/api/properties', propertiesRouter)
  app.route('/api/units', unitsRouter)
  app.route('/api/tenants', tenantsRouter)
  app.route('/api/leases', leasesRouter)
  app.route('/api/charges', chargesRouter)
  app.route('/api/payments', paymentsRouter)
  app.route('/api/cron', cronRouter)

  return app
}

export default createApp()
