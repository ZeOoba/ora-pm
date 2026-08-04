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
import { intakeRouter } from './routes/intake'
import { errorHandlerMiddleware } from './middleware/error-handler'

// OI-037: explicit CORS allowlist — the app was previously mounting Hono's bare
// cors(), whose default `origin: '*'` echoes Access-Control-Allow-Origin: * to
// any caller on every /api/* route (admin CRUD, portal, and Stripe endpoints
// included). Origins:
//   - https://ora-pm.pages.dev  — confirmed live production host (curl -I).
//   - https://pm.oxfordra.net, https://tenant.oxfordra.net — documented custom
//     domains (README.md "DNS" step: CNAME to ora-pm.pages.dev); DNS is not yet
//     live (unresolvable as of this change) and cutover needs Gabriel's explicit
//     go-ahead per README, but listing them here is inert until then and avoids a
//     second code change the day DNS goes live.
//   - http://localhost:5173 — Vite dev server.
const ALLOWED = [
  'https://ora-pm.pages.dev',
  'https://pm.oxfordra.net',
  'https://tenant.oxfordra.net',
  'http://localhost:5173',
]

export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  CRON_SECRET: string
  STRIPE_SECRET_KEY: string
  STRIPE_WEBHOOK_SECRET: string
  RESEND_API_KEY?: string
  RESEND_FROM_EMAIL?: string
  ANTHROPIC_API_KEY?: string
  CONFIDENTIAL_TERMS?: string  // comma-separated denylist; never commit real terms
  INTAKE_MODEL?: string        // optional override for the lease-intake extraction model
  ADMIN_EMAILS?: string        // comma-separated exact-match admin allowlist (OI-036); see admin-auth.ts
}

export function createApp() {
  const app = new Hono<{ Bindings: Env }>()

  app.use('*', errorHandlerMiddleware)

  // Webhook MUST be before CORS — needs raw body
  app.route('/api/webhooks', webhookRouter)

  app.use('/api/*', cors({
    origin: (origin) => (ALLOWED.includes(origin) ? origin : undefined),
    credentials: false,
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }))

  app.get('/api/health', (c) =>
    c.json({ status: 'ok', ts: new Date().toISOString() })
  )

  // Admin auth: gate all /api/* routes except public/already-authed paths.
  // NOTE: /api/admin is intentionally NOT exempt — its tenant invite/revoke
  // endpoints are privileged admin actions and must pass adminAuthMiddleware.
  const ADMIN_EXEMPT = [
    '/api/webhooks',
    '/api/cron',
    '/api/portal',
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
  app.route('/api/intake', intakeRouter)
  app.route('/api/stripe', stripeRouter)
  app.route('/api/admin', portalAuthRouter)
  app.route('/api/portal', portalRouter)
  app.route('/api/portal/insurance', portalInsuranceRouter)

  return app
}

export default createApp()
