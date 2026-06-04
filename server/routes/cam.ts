import { Hono } from 'hono'
import { getDb } from '../db/client'
import { calculateCAMTrueUp } from '../lib/cam'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export const camRouter = new Hono<{ Bindings: Env }>()

camRouter.get('/', async (c) => {
  const db = getDb(c.env)
  const { data, error } = await db
    .from('cam_reconciliations')
    .select('*, leases(tenant_id, tenants(name), units(suite, properties(name)))')
    .order('reconciliation_year', { ascending: false })
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// Calculate and save CAM reconciliation for a lease/year
// Body: { lease_id, reconciliation_year, total_property_recoverable_expenses, total_leased_sf }
camRouter.post('/calculate', async (c) => {
  const db = getDb(c.env)
  const { lease_id, reconciliation_year, total_property_recoverable_expenses, total_leased_sf } =
    await c.req.json()

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

  if (error) return c.json({ error: error.message }, 400)
  return c.json({ data })
})

// Approve CAM reconciliation — posts true-up charge to tenant ledger
camRouter.post('/:id/approve', async (c) => {
  const db = getDb(c.env)
  const { data: rec, error: recErr } = await db
    .from('cam_reconciliations')
    .select('*')
    .eq('id', c.req.param('id'))
    .single()

  if (recErr || !rec) return c.json({ error: 'Not found' }, 404)
  if ((rec as { status: string }).status !== 'draft') {
    return c.json({ error: 'Reconciliation already billed' }, 400)
  }

  const trueUp = (rec as { true_up_amount: number; lease_id: string; reconciliation_year: number }).true_up_amount
  if (trueUp === 0) return c.json({ message: 'No true-up required (balanced)', true_up_amount: 0 })

  const r = rec as { true_up_amount: number; lease_id: string; reconciliation_year: number }
  const today = new Date().toISOString().slice(0, 10)

  // KNOWN LIMITATION (Phase 1): A negative true-up (credit owed to tenant) is posted
  // as a positive cam_true_up charge with "(Credit)" in the description, because
  // charges.amount has CHECK (amount >= 0). The ar_ledger view will treat this as a
  // DEBIT, overstating tenant AR. Credits must be reconciled manually until Phase 1.1
  // adds a proper credit mechanism (credit_amount column or separate credits table).
  // For now: when true_up_amount < 0, do NOT auto-post — flag for manual handling.
  if (trueUp < 0) {
    await db
      .from('cam_reconciliations')
      .update({ status: 'billed', billed_date: today, notes: `Credit of ${Math.abs(trueUp).toFixed(2)} owed to tenant — handle manually (Phase 1 limitation)` })
      .eq('id', c.req.param('id'))
    return c.json({
      success: true,
      true_up_amount: trueUp,
      message: 'Credit owed to tenant — flagged for manual handling (not auto-posted)',
    })
  }

  await db.from('charges').insert({
    lease_id: r.lease_id,
    charge_date: today,
    due_date: today,
    period_start: `${r.reconciliation_year}-01-01`,
    period_end: `${r.reconciliation_year}-12-31`,
    type: 'cam_true_up',
    amount: Math.abs(trueUp),
    description: `${r.reconciliation_year} CAM True-Up${trueUp < 0 ? ' (Credit)' : ''}`,
    source: 'manual',
  })

  await db
    .from('cam_reconciliations')
    .update({ status: 'billed', billed_date: today })
    .eq('id', c.req.param('id'))

  return c.json({ success: true, true_up_amount: trueUp })
})
