import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { propertiesRouter } from './routes/properties'
import { unitsRouter } from './routes/units'
import { tenantsRouter } from './routes/tenants'
import { leasesRouter } from './routes/leases'
import { chargesRouter } from './routes/charges'
import { paymentsRouter } from './routes/payments'
import { cronRouter } from './routes/cron'
import { reportsRouter } from './routes/reports'
import { camRouter } from './routes/cam'
import { expensesRouter } from './routes/expenses'
import { budgetsRouter } from './routes/budgets'
import { renewalsRouter } from './routes/renewals'
import { insuranceRouter } from './routes/insurance'
import { exportsRouter } from './routes/exports'
import { stripeRouter } from './routes/stripe'
import { webhookRouter } from './routes/webhook'

export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  CRON_SECRET: string
  STRIPE_SECRET_KEY: string
  STRIPE_WEBHOOK_SECRET: string
}

export function createApp() {
  const app = new Hono<{ Bindings: Env }>()

  // Webhook MUST be before CORS — needs raw body
  app.route('/api/webhooks', webhookRouter)

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
  app.route('/api/reports', reportsRouter)
  app.route('/api/cam', camRouter)
  app.route('/api/expenses', expensesRouter)
  app.route('/api/budgets', budgetsRouter)
  app.route('/api/renewals', renewalsRouter)
  app.route('/api/insurance', insuranceRouter)
  app.route('/api/exports', exportsRouter)
  app.route('/api/stripe', stripeRouter)

  return app
}

export default createApp()
