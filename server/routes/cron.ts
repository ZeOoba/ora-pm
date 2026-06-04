import { Hono } from 'hono'
import { getDb } from '../db/client'
import { buildMonthlyCharges } from '../lib/billing'
import { cronAuthMiddleware } from '../middleware/auth'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string; CRON_SECRET: string }

export const cronRouter = new Hono<{ Bindings: Env }>()

cronRouter.use('/*', cronAuthMiddleware)

// POST /api/cron/monthly-billing?year=2026&month=6
cronRouter.post('/monthly-billing', async (c) => {
  const db = getDb(c.env)
  const now = new Date()
  const year  = parseInt(c.req.query('year')  ?? String(now.getFullYear()))
  const month = parseInt(c.req.query('month') ?? String(now.getMonth() + 1))

  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    return c.json({ error: 'Invalid year or month' }, 400)
  }

  const { data: leases, error: leaseErr } = await db
    .from('leases')
    .select('id, base_rent_monthly, cam_estimate_monthly, start_date')
    .eq('status', 'active')

  if (leaseErr) return c.json({ error: leaseErr.message }, 500)

  let posted = 0, skipped = 0, errors = 0
  const errorMessages: string[] = []

  for (const lease of (leases ?? [])) {
    const { charges } = buildMonthlyCharges({
      leaseId: lease.id,
      baseRentMonthly: lease.base_rent_monthly,
      camEstimateMonthly: lease.cam_estimate_monthly,
      leaseStartDate: lease.start_date,
      periodYear: year,
      periodMonth: month,
    })

    for (const charge of charges) {
      const { error: insErr } = await db.from('charges').insert(charge)
      if (insErr) {
        if (insErr.code === '23505') {
          skipped++ // unique constraint violation = already posted (idempotent)
        } else {
          errors++
          errorMessages.push(`lease ${lease.id}: ${insErr.message}`)
        }
      } else {
        posted++
      }
    }
  }

  return c.json({ posted, skipped, errors, errorMessages, year, month })
})
