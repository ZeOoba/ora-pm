import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { adminAuthMiddleware } from './middleware/admin-auth'
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
import { portalAuthRouter } from './routes/portal-auth'
import { portalRouter } from './routes/portal'
import { portalInsuranceRouter } from './routes/portal-insurance'
import { errorHandlerMiddleware } from './middleware/error-handler'

export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  CRON_SECRET: string
  STRIPE_SECRET_KEY: string
  STRIPE_WEBHOOK_SECRET: string
  RESEND_API_KEY?: string
  RESEND_FROM_EMAIL?: string
}

export function createApp() {
  const app = new Hono<{ Bindings: Env }>()

  app.use('*', errorHandlerMiddleware)

  // Webhook MUST be before CORS — needs raw body
  app.route('/api/webhooks', webhookRouter)

  app.use('/api/*', cors())

  app.get('/api/health', (c) =>
    c.json({ status: 'ok', ts: new Date().toISOString() })
  )

  // Admin auth: gate all /api/* routes except public/already-authed paths
  const ADMIN_EXEMPT = [
    '/api/webhooks',
    '/api/cron',
    '/api/portal',
    '/api/admin',
    '/api/health',
    '/api/stripe',
  ]
  app.use('/api/*', async (c, next) => {
    const path = new URL(c.req.url).pathname
    if (ADMIN_EXEMPT.some(prefix => path.startsWith(prefix))) return next()
    return adminAuthMiddleware(c as unknown as Parameters<typeof adminAuthMiddleware>[0], next)
  })

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
  app.route('/api/admin', portalAuthRouter)
  app.route('/api/portal', portalRouter)
  app.route('/api/portal/insurance', portalInsuranceRouter)

  return app
}

export default createApp()
