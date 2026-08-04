import { Hono } from 'hono'
import { getDb } from '../db/client'
import { getStripe } from '../lib/stripe'
import { buildMonthlyCharges } from '../lib/billing'
import { cronAuthMiddleware } from '../middleware/auth'
import { checkRateLimit } from '../lib/rate-limit'

type Env = {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  CRON_SECRET: string
  STRIPE_SECRET_KEY: string
  RESEND_API_KEY?: string
  RESEND_FROM_EMAIL?: string
  RATE_LIMIT_KV?: KVNamespace
}

export const cronRouter = new Hono<{ Bindings: Env }>()

cronRouter.use('/*', cronAuthMiddleware)

// OI-038 remainder: 10/hour per cron endpoint path (not per caller — the
// only expected caller is the ORA fleet scheduler, authenticated via
// CRON_SECRET; runs AFTER cronAuthMiddleware so an invalid-secret guess
// never consumes budget). Sized generous specifically to absorb a
// legitimate catch-up burst — if the scheduler misses a run (e.g. an
// outage) it re-triggers the missed cron(s) close together on recovery.
// This repo has no separate catch-up-burst doc to size precisely against
// (checked: no match for "catch-up"/"catchup" in any tracked file), so this
// errs generous per task-6-brief.md's explicit instruction rather than risk
// breaking legitimate ops; each endpoint's own documented cadence (monthly,
// or once daily) is nowhere near 10/hour in normal operation.
cronRouter.use('/*', async (c, next) => {
  const { allowed, retryAfterMs } = await checkRateLimit(c.env.RATE_LIMIT_KV, c.req.path, {
    scope: 'cron',
    maxCalls: 10,
    windowMs: 60 * 60 * 1000,
  })
  if (!allowed) {
    return c.json({ error: `Too many cron requests — retry in ${Math.ceil(retryAfterMs / 1000)}s` }, 429)
  }
  return next()
})

// POST /api/cron/monthly-billing?year=2026&month=6
cronRouter.post('/monthly-billing', async (c) => {
  const db = getDb(c.env)
  const now = new Date()
  const year  = parseInt(c.req.query('year')  ?? String(now.getFullYear()))
  const month = parseInt(c.req.query('month') ?? String(now.getMonth() + 1))

  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    return c.json({ error: 'Invalid year or month' }, 400)
  }

  const periodStartStr = `${year}-${String(month).padStart(2, '0')}-01`
  const lastDay = new Date(year, month, 0).getDate()
  const periodEndStr = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

  const { data: leases, error: leaseErr } = await db
    .from('leases')
    .select('id, tenant_id, base_rent_monthly, cam_estimate_monthly, start_date, autopay_enabled, autopay_payment_method_id, tenants(id, stripe_customer_id)')
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
          skipped++ // unique constraint = already posted (idempotent)
        } else {
          errors++
          errorMessages.push(`lease ${lease.id}: ${insErr.message}`)
        }
      } else {
        posted++
      }
    }

    // Auto-pay: create a PaymentIntent if autopay is enabled and bank account is saved
    const tenant = Array.isArray(lease.tenants) ? lease.tenants[0] : lease.tenants
    if (lease.autopay_enabled && lease.autopay_payment_method_id && tenant?.stripe_customer_id) {
      // Idempotency guard: one autopay collection per lease per billing period.
      // autopay_period is stamped with the canonical period start (periodStartStr,
      // always the first of the billing month), so a catch-up-burst re-run or a
      // manual re-trigger days later produces the same value and is caught here —
      // and, in a concurrent race, by the payments_autopay_period_uniq index below.
      const { data: priorAutopay, error: priorErr } = await db
        .from('payments')
        .select('id')
        .eq('lease_id', lease.id)
        .eq('autopay_period', periodStartStr)
        .limit(1)

      if (priorErr) {
        // Unknown whether this period was already collected — never debit blind.
        errors++
        errorMessages.push(`autopay lease ${lease.id}: period pre-check failed: ${priorErr.message}`)
        continue
      }
      if (priorAutopay && priorAutopay.length > 0) {
        skipped++ // this period already collected (idempotent)
        continue
      }

      const { data: openCharges } = await db
        .from('charges')
        .select('amount')
        .eq('lease_id', lease.id)
        .gte('due_date', periodStartStr)
        .lte('due_date', periodEndStr)

      const periodChargeTotal = (openCharges ?? []).reduce((s: number, ch: { amount: number }) => s + ch.amount, 0)

      // Period-paid: manual (check/wire/other) or succeeded ACH payments dated
      // WITHIN this period. Autopay is only authorized to collect THIS period's
      // rent — it must never sweep older, unrelated arrears via an automated
      // ACH debit the tenant didn't specifically authorize for that purpose.
      const { data: periodPayments, error: ppErr } = await db
        .from('payments')
        .select('amount, method, stripe_status')
        .eq('lease_id', lease.id)
        .gte('payment_date', periodStartStr)
        .lte('payment_date', periodEndStr)

      if (ppErr) {
        errors++
        errorMessages.push(`autopay lease ${lease.id}: period-payment lookup failed: ${ppErr.message}`)
        continue
      }

      const periodPaid = (periodPayments ?? []).reduce(
        (s: number, p: { amount: number; method: string; stripe_status?: string }) => {
          if (p.method === 'ach_stripe' && p.stripe_status === 'succeeded') return s + p.amount
          if (['check', 'wire', 'other'].includes(p.method)) return s + p.amount
          return s
        },
        0,
      )
      const periodOutstanding = Math.max(0, periodChargeTotal - periodPaid)

      // Lifetime cap: never debit more than the lease's true outstanding AR
      // balance, however period-scoping above is what prevents re-debiting a
      // tenant who already paid THIS period and what prevents sweeping arrears
      // from an earlier period into an unrelated autopay charge.
      const { data: arRows, error: arErr } = await db
        .from('ar_ledger')
        .select('balance')
        .eq('lease_id', lease.id)
        .limit(1)

      if (arErr) {
        // Unknown balance — never debit blind.
        errors++
        errorMessages.push(`autopay lease ${lease.id}: balance lookup failed: ${arErr.message}`)
        continue
      }

      const outstandingBalance = arRows?.[0]?.balance ?? 0
      const debitAmount = Math.min(periodOutstanding, outstandingBalance)
      if (debitAmount <= 0) {
        skipped++ // nothing outstanding to collect for this period
        continue
      }

      try {
        const stripe = getStripe(c.env.STRIPE_SECRET_KEY)
        const pi = await stripe.paymentIntents.create({
          amount: Math.round(debitAmount * 100),
          currency: 'usd',
          customer: tenant.stripe_customer_id,
          payment_method: lease.autopay_payment_method_id,
          payment_method_types: ['us_bank_account'],
          confirm: true,
          off_session: true,
          description: `Autopay — ${periodStartStr}`,
          metadata: { lease_id: lease.id, tenant_id: tenant.id },
        }, {
          // Deterministic per lease+period: a re-run inside Stripe's idempotency
          // window returns the original PaymentIntent instead of debiting again.
          idempotencyKey: `autopay:${lease.id}:${periodStartStr}`,
        })
        const { error: payErr } = await db.from('payments').insert({
          lease_id: lease.id,
          payment_date: new Date().toISOString().slice(0, 10),
          amount: debitAmount,
          method: 'ach_stripe',
          stripe_payment_intent_id: pi.id,
          stripe_status: pi.status,
          notes: `Autopay — ${periodStartStr}`,
          autopay_period: periodStartStr,
        })
        if (payErr) {
          if (payErr.code === '23505') {
            skipped++ // concurrent run recorded this period first (idempotent)
          } else {
            // Real insert failure — the debit happened but wasn't recorded; surface loudly.
            errors++
            errorMessages.push(`autopay lease ${lease.id}: payment ${pi.id} created but not recorded: ${payErr.message}`)
          }
        }
      } catch (err) {
        errors++
        errorMessages.push(`autopay lease ${lease.id}: ${(err as Error).message}`)
      }
    }
  }

  return c.json({ posted, skipped, errors, errorMessages, year, month })
})

// POST /api/cron/critical-dates-alerts
// Daily: query critical_dates view, dedup via sent_notifications, send email digest
cronRouter.post('/critical-dates-alerts', async (c) => {
  const db = getDb(c.env)
  const RECIPIENTS = ['ggoldberg@oxfordra.net', 'egoldberg@oxfordra.net']
  const HORIZON_DAYS = 90

  // Query critical dates within horizon
  const horizonDate = new Date()
  horizonDate.setDate(horizonDate.getDate() + HORIZON_DAYS)
  const horizonStr = horizonDate.toISOString().slice(0, 10)

  const { data: criticalDates, error: cdErr } = await db
    .from('critical_dates')
    .select('*')
    .lte('critical_date', horizonStr)

  if (cdErr) return c.json({ error: cdErr.message }, 500)
  if (!criticalDates || criticalDates.length === 0) {
    return c.json({ new_alerts: 0, skipped: 0, emailed: false })
  }

  // Dedup: check which reference_ids already notified this recipient
  const refIds = criticalDates.map((r: { reference_id: string }) => r.reference_id)
  const { data: alreadySent } = await db
    .from('sent_notifications')
    .select('reference_id, recipient')
    .in('reference_id', refIds)

  const sentSet = new Set((alreadySent ?? []).map((s: { reference_id: string; recipient: string }) => `${s.reference_id}:${s.recipient}`))

  // Determine new alerts (items not yet sent to at least one recipient)
  type CritRow = { date_type: string; reference_id: string; tenant_name: string; property_name: string | null; suite: string | null; critical_date: string; days_until: number; urgency: string }
  const newAlerts: CritRow[] = (criticalDates as CritRow[]).filter(r =>
    RECIPIENTS.some(rec => !sentSet.has(`${r.reference_id}:${rec}`))
  )

  if (newAlerts.length === 0) {
    return c.json({ new_alerts: 0, skipped: criticalDates.length, emailed: false })
  }

  // Record in sent_notifications (upsert / ignore duplicates)
  const notifications = newAlerts.flatMap(r =>
    RECIPIENTS.map(rec => ({
      notification_type: 'critical_date_alert',
      reference_id: r.reference_id,
      recipient: rec,
    }))
  )

  // Record dedup rows BEFORE emailing — if this fails, skip the email so the
  // next run retries cleanly rather than re-sending alerts the principals already got.
  const { error: insErr } = await db.from('sent_notifications').insert(notifications)
  if (insErr) return c.json({ error: `Failed to record notifications: ${insErr.message}` }, 500)

  // Build email digest
  const urgencyOrder: Record<string, number> = { overdue: 0, urgent: 1, warning: 2, notice: 3 }
  const sorted = [...newAlerts].sort((a, b) => (urgencyOrder[a.urgency] ?? 9) - (urgencyOrder[b.urgency] ?? 9))

  const urgencyLabel: Record<string, string> = { overdue: '🔴 OVERDUE', urgent: '🟠 URGENT (≤30d)', warning: '🟡 WARNING (≤60d)', notice: '⚪ NOTICE (≤90d)' }

  const lines = sorted.map(r => {
    const location = [r.property_name, r.suite].filter(Boolean).join(' · ')
    return `${urgencyLabel[r.urgency] ?? r.urgency} | ${r.date_type.replace(/_/g,' ')} | ${r.tenant_name} | ${location} | ${r.critical_date} (${r.days_until}d)`
  })

  const bodyText = `ORA PM — Critical Dates Alert\n${new Date().toISOString().slice(0,10)}\n\n${lines.join('\n')}\n\nTotal: ${newAlerts.length} item(s)\nhttps://ora-pm.pages.dev/critical-dates`

  // Send email if Resend is configured
  let emailed = false
  if (c.env.RESEND_API_KEY) {
    const fromEmail = c.env.RESEND_FROM_EMAIL ?? 'pm@oxfordra.net'
    try {
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${c.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `ORA Property Manager <${fromEmail}>`,
          to: RECIPIENTS,
          subject: `[ORA PM] ${newAlerts.length} Critical Date${newAlerts.length > 1 ? 's' : ''} — ${new Date().toISOString().slice(0,10)}`,
          text: bodyText,
        }),
      })
      emailed = emailRes.ok
    } catch (err) {
      // Network failure — dedup rows already recorded; report not-emailed, don't 500 the cron.
      console.error('Resend fetch failed:', err)
    }
  }

  return c.json({ new_alerts: newAlerts.length, skipped: criticalDates.length - newAlerts.length, emailed })
})

// POST /api/cron/delinquency-check
// Daily: check AR for overdue balances, post late_fee if none this month
cronRouter.post('/delinquency-check', async (c) => {
  const db = getDb(c.env)
  const today = new Date().toISOString().slice(0, 10)
  const [year, month] = today.split('-')
  const periodStart = `${year}-${month}-01`
  const GRACE_DAYS = 30
  const LATE_FEE_AMOUNT = 50 // $50 flat late fee — adjust as needed
  const RECIPIENTS = ['ggoldberg@oxfordra.net', 'egoldberg@oxfordra.net']

  // Fetch AR ledger rows with a positive balance
  const { data: arRows, error: arErr } = await db
    .from('ar_ledger')
    .select('*')
    .gt('balance', 0)

  if (arErr) return c.json({ error: arErr.message }, 500)
  if (!arRows || arRows.length === 0) return c.json({ late_fees_posted: 0, delinquent_count: 0, emailed: false })

  type ARRow = { lease_id: string; tenant_id: string; tenant_name: string; property_name: string | null; suite: string | null; balance: number }

  // GRACE_DAYS cutoff is the same for every row — compute once.
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - GRACE_DAYS)
  const cutoffStr = cutoffDate.toISOString().slice(0, 10)

  let lateFeesPosted = 0
  const delinquentLeases: { tenant_name: string; property: string; balance: number }[] = []

  for (const ar of arRows as ARRow[]) {
    // Find oldest unpaid charge to check if > GRACE_DAYS past due
    const { data: overdueCharges } = await db
      .from('charges')
      .select('id, due_date, amount')
      .eq('lease_id', ar.lease_id)
      .lte('due_date', cutoffStr)
      .order('due_date')
      .limit(1)

    if (!overdueCharges || overdueCharges.length === 0) continue

    // Check if a late_fee charge already exists for this lease this period
    const { data: existingFee } = await db
      .from('charges')
      .select('id')
      .eq('lease_id', ar.lease_id)
      .eq('type', 'late_fee')
      .gte('charge_date', periodStart)
      .limit(1)

    if (existingFee && existingFee.length > 0) {
      delinquentLeases.push({ tenant_name: ar.tenant_name, property: [ar.property_name, ar.suite].filter(Boolean).join(' '), balance: ar.balance })
      continue
    }

    // Post late fee charge
    const { error: feeErr } = await db.from('charges').insert({
      lease_id: ar.lease_id,
      charge_date: today,
      due_date: today,
      period_start: periodStart,
      period_end: today,
      type: 'late_fee',
      amount: LATE_FEE_AMOUNT,
      description: `Late fee — balance outstanding as of ${today}`,
      source: 'auto',
      idempotency_key: `late_fee_${ar.lease_id}_${year}_${month}`,
    })

    const property = [ar.property_name, ar.suite].filter(Boolean).join(' ')
    if (!feeErr) {
      lateFeesPosted++
      delinquentLeases.push({ tenant_name: ar.tenant_name, property, balance: ar.balance + LATE_FEE_AMOUNT })
    } else if (feeErr.code === '23505') {
      // Unique idempotency_key collision — a concurrent/prior run already posted this
      // month's fee (the existingFee guard missed it by a hair). Still a delinquent tenant.
      delinquentLeases.push({ tenant_name: ar.tenant_name, property, balance: ar.balance })
    } else {
      // Real insert failure — surface it so a delinquent tenant isn't silently dropped.
      console.error(`late_fee insert failed for lease ${ar.lease_id}: ${feeErr.message}`)
      delinquentLeases.push({ tenant_name: ar.tenant_name, property, balance: ar.balance })
    }
  }

  // Send delinquency digest email if Resend configured and there are delinquent leases
  let emailed = false
  if (delinquentLeases.length > 0 && c.env.RESEND_API_KEY) {
    const lines = delinquentLeases.map(d => `  • ${d.tenant_name} | ${d.property} | Balance: $${d.balance.toFixed(2)}`)
    const bodyText = `ORA PM — Delinquency Report\n${today}\n\n${lines.join('\n')}\n\nLate fees posted: ${lateFeesPosted}\nhttps://ora-pm.pages.dev/ar`
    const fromEmail = c.env.RESEND_FROM_EMAIL ?? 'pm@oxfordra.net'
    try {
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${c.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `ORA Property Manager <${fromEmail}>`,
          to: RECIPIENTS,
          subject: `[ORA PM] ${delinquentLeases.length} Delinquent Tenant${delinquentLeases.length > 1 ? 's' : ''} — ${today}`,
          text: bodyText,
        }),
      })
      emailed = emailRes.ok
    } catch (err) {
      // Network failure — late fees already posted; report not-emailed, don't 500 the cron.
      console.error('Resend fetch failed:', err)
    }
  }

  return c.json({ late_fees_posted: lateFeesPosted, delinquent_count: delinquentLeases.length, emailed })
})
