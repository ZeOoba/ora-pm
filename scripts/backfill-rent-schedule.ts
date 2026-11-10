/// <reference types="node" />
// scripts/backfill-rent-schedule.ts — lease abstraction plan, Phase 2.
//
// Moves existing leases onto the rent-schedule engine by writing ONE lease_rent_schedule row per lease:
// start_date..end_date at the lease's current base_rent_monthly, source='backfill'. Billing through a
// one-row schedule is identical to legacy billing, cent for cent and string for string, FOR WHOLE-CENT
// RENTS (pinned by the equivalence test in tests/lib/rent-schedule.test.ts). A sub-cent rent would be
// rounded by NUMERIC(12,2) and is therefore never backfilled (skip reason sub_cent_rent).
// Lease 'superseded-only' schedules are skipped too (any existing row → has_schedule).
// CAM is untouched: with no cam_estimate recurring row, the engine keeps billing leases.cam_estimate_monthly.
//
// Requires migration 0020 applied. Nothing bills from these rows until the cron passes schedules
// (Phase 7), so running this early is safe.
//
// Usage (DRY RUN by default; prints counts and lease ids only, no tenant names or amounts):
//   npx tsx scripts/backfill-rent-schedule.ts
//   npx tsx scripts/backfill-rent-schedule.ts --apply
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the environment.
//
// Idempotent: a lease that already has ANY lease_rent_schedule row (active or superseded) is skipped,
// and 0020's no-overlap guard rejects a duplicate active row even under a concurrent run.

export interface BackfillLease {
  id: string
  status: string
  start_date: string
  end_date: string
  base_rent_monthly: number
}

export interface BackfillRow {
  lease_id: string
  effective_start: string
  effective_end: string
  base_rent_monthly: number
  source: 'backfill'
  note: string
}

export type SkipReason = 'has_schedule' | 'not_active_or_pending' | 'invalid_dates' | 'invalid_rent' | 'sub_cent_rent'

const ISO = /^\d{4}-\d{2}-\d{2}$/

function validIso(s: unknown): s is string {
  if (typeof s !== 'string' || !ISO.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** Pure plan: which leases get a row, and why the rest are skipped. */
export function planBackfill(
  leases: readonly BackfillLease[],
  leaseIdsWithSchedule: ReadonlySet<string>,
): { rows: BackfillRow[]; skipped: { lease_id: string; reason: SkipReason }[] } {
  const rows: BackfillRow[] = []
  const skipped: { lease_id: string; reason: SkipReason }[] = []
  for (const l of leases) {
    if (leaseIdsWithSchedule.has(l.id)) { skipped.push({ lease_id: l.id, reason: 'has_schedule' }); continue }
    if (l.status !== 'active' && l.status !== 'pending') { skipped.push({ lease_id: l.id, reason: 'not_active_or_pending' }); continue }
    if (!validIso(l.start_date) || !validIso(l.end_date) || l.end_date < l.start_date) { skipped.push({ lease_id: l.id, reason: 'invalid_dates' }); continue }
    const rent = Number(l.base_rent_monthly)
    if (!Number.isFinite(rent) || rent < 0) { skipped.push({ lease_id: l.id, reason: 'invalid_rent' }); continue }
    // REFUTE C2: leases.base_rent_monthly is unbounded NUMERIC but lease_rent_schedule is NUMERIC(12,2),
    // so a sub-cent rent (e.g. 52000/12) would be rounded on insert and prorated months would drift a
    // cent from legacy. Never write it; send it for review so the rent is fixed on the lease first.
    if (Math.round(rent * 100) / 100 !== rent) { skipped.push({ lease_id: l.id, reason: 'sub_cent_rent' }); continue }
    rows.push({
      lease_id: l.id,
      effective_start: l.start_date,
      effective_end: l.end_date,
      base_rent_monthly: rent,
      source: 'backfill',
      note: 'Backfill: one row at leases.base_rent_monthly for the full term (billing-identical to legacy).',
    })
  }
  return { rows, skipped }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.')
    process.exit(2)
  }
  const { createClient } = await import('@supabase/supabase-js')
  const { fetchAllPages } = await import('../server/lib/postgrest-paging')
  const db = createClient(url, key, { auth: { persistSession: false } })

  const leases = await fetchAllPages<BackfillLease>(
    (after) => {
      const q = db.from('leases').select('id, status, start_date, end_date, base_rent_monthly').order('id').limit(1000)
      return after ? q.gt('id', after) : q
    },
    (r) => r.id,
  )
  if (leases.error) throw new Error(`reading leases failed: ${leases.error.message}`)
  const existing = await fetchAllPages<{ id: string; lease_id: string }>(
    (after) => {
      const q = db.from('lease_rent_schedule').select('id, lease_id').order('id').limit(1000)
      return after ? q.gt('id', after) : q
    },
    (r) => r.id,
  )
  if (existing.error) throw new Error(`reading lease_rent_schedule failed (is migration 0020 applied?): ${existing.error.message}`)

  const plan = planBackfill(leases.data, new Set(existing.data.map((r) => r.lease_id)))
  const byReason = plan.skipped.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.reason]: (acc[s.reason] ?? 0) + 1 }), {})
  console.log(`leases read: ${leases.data.length}; to backfill: ${plan.rows.length}; skipped: ${JSON.stringify(byReason)}`)
  for (const s of plan.skipped.filter((x) => x.reason === 'invalid_dates' || x.reason === 'invalid_rent' || x.reason === 'sub_cent_rent')) {
    console.log(`  needs review: ${s.lease_id} (${s.reason})`)
  }
  if (!apply) {
    console.log('DRY RUN — nothing written. Re-run with --apply to insert.')
    return
  }
  let inserted = 0
  for (let i = 0; i < plan.rows.length; i += 100) {
    const chunk = plan.rows.slice(i, i + 100)
    const { error } = await db.from('lease_rent_schedule').insert(chunk)
    if (error) throw new Error(`insert failed after ${inserted} row(s): ${error.message}`)
    inserted += chunk.length
  }
  console.log(`inserted ${inserted} backfill row(s).`)
}

// Run only when executed directly (tests import planBackfill).
if (process.argv[1] && /backfill-rent-schedule\.ts$/.test(process.argv[1].replace(/\\/g, '/'))) {
  main().catch((e: unknown) => {
    console.error((e as Error).message)
    process.exit(1)
  })
}
