import { Hono } from 'hono'
import { getDb } from '../db/client'
import { calculateCAMTrueUp } from '../lib/cam'
import { CamCalculateSchema } from '../lib/schemas'
import { dbError } from '../lib/api-error'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const camRouter = new Hono<{ Bindings: Env }>()

camRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const { data, error } = await db
    .from('cam_reconciliations')
    .select('*, leases(tenant_id, tenants(name), units(suite, properties(name)))')
    .order('reconciliation_year', { ascending: false })
  if (error) return dbError(c, error, 'Failed to load CAM reconciliations')
  return c.json({ data })
})

// Calculate and save CAM reconciliation for a lease/year
// Body: { lease_id, reconciliation_year, total_property_recoverable_expenses, total_leased_sf }
camRouter.post('/calculate', async (c) => {
  const db = getDb(c.env)
  const raw = await c.req.json()
  const parsed = CamCalculateSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const { lease_id, reconciliation_year, total_property_recoverable_expenses, total_leased_sf } =
    parsed.data

  // Get tenant's SF from their unit
  const { data: lease } = await db
    .from('leases')
    .select('units(sf)')
    .eq('id', lease_id)
    .single()

  const tenantSF: number = (lease as { units: { sf: number } } | null)?.units?.sf ?? 0

  // Sum all CAM estimate charges billed this year
  const { data: camCharges } = await db
    .from('charges')
    .select('amount')
    .eq('lease_id', lease_id)
    .eq('type', 'cam_estimate')
    .gte('period_start', `${reconciliation_year}-01-01`)
    .lte('period_end', `${reconciliation_year}-12-31`)

  const estimatedCamPaid = (camCharges ?? []).reduce(
    (s: number, ch: { amount: number }) => s + ch.amount,
    0
  )

  let result
  try {
    result = calculateCAMTrueUp({
      totalRecoverableExpenses: total_property_recoverable_expenses,
      tenantSF,
      totalLeasedSF: total_leased_sf,
      estimatedCamPaid,
    })
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400)
  }

  const { data, error } = await db
    .from('cam_reconciliations')
    .upsert(
      {
        lease_id,
        reconciliation_year,
        total_property_recoverable_expenses,
        tenant_pro_rata_share_pct: result.tenantProRataSharePct,
        estimated_cam_paid: estimatedCamPaid,
        actual_cam_owed: result.actualCamOwed,
        true_up_amount: result.trueUpAmount,
        status: 'draft',
      },
      { onConflict: 'lease_id,reconciliation_year' }
    )
    .select()
    .single()

  if (error) return dbError(c, error, 'Failed to save CAM reconciliation')
  return c.json({ data })
})

// Approve CAM reconciliation — posts true-up charge to tenant ledger.
//
// OI-046 fix: this used to be a read-check-act sequence (select status, check
// it's 'draft', insert the true-up charge, then update status) — two
// concurrent approve calls could both observe 'draft' and both post a
// true-up charge, double-billing the tenant. Both branches below now use an
// insert-first, conditional-update-second pattern instead:
//   1. Insert (idempotency-keyed per lease+year) — a concurrent/retried
//      request collides on the unique key (23505) instead of posting twice.
//   2. Conditionally transition status with `.eq('status', 'draft')` — an
//      atomic compare-and-swap. Zero rows back means someone else already
//      billed it; return 400 rather than treating that as an error.
// Crash-safety: crash after insert but before the update leaves a posted
// charge + status still 'draft' — safe to retry (insert hits 23505, update
// completes). Crash before insert leaves nothing — safe to retry from
// scratch. The ordering is load-bearing; do not swap it.
camRouter.post('/:id/approve', async (c) => {
  const db = getDb(c.env)
  const id = c.req.param('id')
  const { data: rec, error: recErr } = await db
    .from('cam_reconciliations')
    .select('*')
    .eq('id', id)
    .single()

  if (recErr || !rec) return c.json({ error: 'Not found' }, 404)

  const r = rec as { true_up_amount: number; lease_id: string; reconciliation_year: number }
  const trueUp = r.true_up_amount
  if (trueUp === 0) return c.json({ message: 'No true-up required (balanced)', true_up_amount: 0 })

  const today = new Date().toISOString().slice(0, 10)

  // KNOWN LIMITATION (Phase 1): A negative true-up (credit owed to tenant) is not
  // auto-posted as a charge, because charges.amount has CHECK (amount >= 0) and the
  // ar_ledger view would treat a posted "credit" charge as a DEBIT, overstating
  // tenant AR. Credits must be reconciled manually until Phase 1.1 adds a proper
  // credit mechanism (credit_amount column or separate credits table). This branch
  // only transitions status — mirrored via the same conditional-update guard as the
  // positive-true-up path below (no insert, so no idempotency key needed here).
  if (trueUp < 0) {
    const { data: updated, error: updateErr } = await db
      .from('cam_reconciliations')
      .update({
        status: 'billed',
        billed_date: today,
        notes: `Credit of ${Math.abs(trueUp).toFixed(2)} owed to tenant — handle manually (Phase 1 limitation)`,
      })
      .eq('id', id)
      .eq('status', 'draft')
      .select()

    if (updateErr) return dbError(c, updateErr, 'Failed to approve CAM reconciliation')
    if (!updated || updated.length === 0) return c.json({ error: 'already billed' }, 400)

    return c.json({
      success: true,
      true_up_amount: trueUp,
      message: 'Credit owed to tenant — flagged for manual handling (not auto-posted)',
    })
  }

  const { error: insertErr } = await db.from('charges').insert({
    lease_id: r.lease_id,
    charge_date: today,
    due_date: today,
    period_start: `${r.reconciliation_year}-01-01`,
    period_end: `${r.reconciliation_year}-12-31`,
    type: 'cam_true_up',
    amount: Math.abs(trueUp),
    description: `${r.reconciliation_year} CAM True-Up`,
    source: 'manual',
    idempotency_key: `cam_true_up:${r.lease_id}:${r.reconciliation_year}`,
  })

  // 23505 = unique-constraint conflict on idempotency_key: this true-up was
  // already posted by a concurrent/earlier approve call. Treat as an already-
  // posted no-op and continue to the status update — do not re-insert, do not error.
  if (insertErr && insertErr.code !== '23505') {
    return dbError(c, insertErr, 'Failed to post CAM true-up charge')
  }

  const { data: updated, error: updateErr } = await db
    .from('cam_reconciliations')
    .update({ status: 'billed', billed_date: today })
    .eq('id', id)
    .eq('status', 'draft')
    .select()

  if (updateErr) return dbError(c, updateErr, 'Failed to approve CAM reconciliation')
  if (!updated || updated.length === 0) return c.json({ error: 'already billed' }, 400)

  return c.json({ success: true, true_up_amount: trueUp })
})
