#!/usr/bin/env node
// Import a property's rent roll from the ORA Lease Intelligence Pipeline
// (Master Lease Database/_pipeline/output/TENANTS.json) into the PM database.
//
// Idempotent: re-running skips rows that already exist (matched by natural keys
// and, for opening-balance charges, by a deterministic idempotency_key).
//
// Usage:
//   node scripts/import-from-pipeline.mjs --file <TENANTS.json> --property "Red Branch" [--dry-run] [--no-balances]
//
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env (service role bypasses RLS).
// The service role is required to write across all tables.

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

// ── args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
function arg(name, fallback = undefined) {
  const i = args.indexOf(name)
  if (i === -1) return fallback
  const next = args[i + 1]
  return next && !next.startsWith('--') ? next : true
}
const FILE = arg('--file')
const PROPERTY_LABEL = arg('--property') // pipeline `p` value, e.g. "Red Branch"
const DRY_RUN = args.includes('--dry-run')
const WITH_BALANCES = !args.includes('--no-balances')

if (!FILE || !PROPERTY_LABEL || PROPERTY_LABEL === true) {
  console.error('Usage: node scripts/import-from-pipeline.mjs --file <TENANTS.json> --property "<label>" [--dry-run] [--no-balances]')
  process.exit(2)
}

// ── property metadata (the pipeline only carries a short label; PM needs full address) ──
// Add an entry here for each property as you onboard it.
const PROPERTY_META = {
  'Red Branch': {
    name: '9050 Red Branch Road',
    address: '9050 Red Branch Rd',
    city: 'Columbia',
    state: 'MD',
    zip: '21045',          // VERIFY — Columbia MD / Oakland Mills
    property_type: 'industrial',
    entity_llc: null,      // FILL IN via the Edit Property form once confirmed
  },
}

// ── load .env ─────────────────────────────────────────────────────────────────
function loadEnv() {
  const raw = readFileSync(join(repoRoot, '.env'), 'utf8')
  const env = {}
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) env[m[1]] = m[2]
  }
  return env
}
const env = loadEnv()
const SUPABASE_URL = env.SUPABASE_URL
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env')
  process.exit(2)
}
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

// ── today / current period ─────────────────────────────────────────────────────
const today = new Date()
const todayStr = today.toISOString().slice(0, 10)
const periodStart = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`
const periodEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().slice(0, 10)

// ── load + filter pipeline records ──────────────────────────────────────────────
const all = JSON.parse(readFileSync(FILE, 'utf8'))
const records = all.filter((r) => r.p === PROPERTY_LABEL)
if (records.length === 0) {
  console.error(`No records found for property label "${PROPERTY_LABEL}" in ${FILE}`)
  process.exit(1)
}
const meta = PROPERTY_META[PROPERTY_LABEL]
if (!meta) {
  console.error(`No PROPERTY_META entry for "${PROPERTY_LABEL}". Add address details to the script.`)
  process.exit(1)
}

const totalSF = records.reduce((s, r) => s + (Number(r.sf) || 0), 0)

// ── plan summary ────────────────────────────────────────────────────────────────
const withBal = records.filter((r) => WITH_BALANCES && Number(r.bal) > 0)
console.log(`\n=== Import plan: ${meta.name} ===`)
console.log(`Source: ${FILE}`)
console.log(`Mode:   ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE WRITE'}`)
console.log(`Property: ${meta.name} | ${meta.address}, ${meta.city}, ${meta.state} ${meta.zip} | ${meta.property_type} | total_sf=${totalSF} | entity_llc=${meta.entity_llc ?? '(none — fill later)'}`)
console.log(`Units/Tenants/Leases: ${records.length}`)
console.log(`Opening balances to seed: ${withBal.length}${WITH_BALANCES ? '' : ' (disabled via --no-balances)'}`)
console.log('')
console.log('  Suite      SF     Tenant                                  Rent/mo     Term                       Balance')
console.log('  ' + '-'.repeat(110))
for (const r of records) {
  const bal = Number(r.bal) > 0 ? `$${Number(r.bal).toLocaleString()} (${r.age})` : '—'
  console.log(
    '  ' +
      String(r.u).padEnd(8) +
      String(r.sf).padStart(7) +
      '  ' +
      String(r.n).slice(0, 38).padEnd(40) +
      ('$' + Number(r.m).toLocaleString()).padStart(11) +
      '  ' +
      `${r.ls} → ${r.exp}`.padEnd(26) +
      '  ' +
      bal
  )
}
console.log('')

if (DRY_RUN) {
  console.log('DRY RUN complete — no data written. Re-run without --dry-run to apply.')
  process.exit(0)
}

// ── helpers: idempotent upserts ───────────────────────────────────────────────
async function getOrInsert(table, matchCol, matchVal, insertRow, extraMatch = {}) {
  let q = db.from(table).select('*').eq(matchCol, matchVal)
  for (const [k, v] of Object.entries(extraMatch)) q = q.eq(k, v)
  const { data: existing, error: selErr } = await q.maybeSingle()
  if (selErr) throw new Error(`${table} select: ${selErr.message}`)
  if (existing) return { row: existing, created: false }
  const { data: inserted, error: insErr } = await db.from(table).insert(insertRow).select().single()
  if (insErr) throw new Error(`${table} insert: ${insErr.message}`)
  return { row: inserted, created: true }
}

// ── run ───────────────────────────────────────────────────────────────────────
const stats = { property: 0, units: 0, unitsSkipped: 0, tenants: 0, tenantsSkipped: 0, leases: 0, leasesSkipped: 0, renewals: 0, balances: 0, balancesSkipped: 0 }

// Property
const prop = await getOrInsert('properties', 'name', meta.name, { ...meta, total_sf: totalSF })
if (prop.created) stats.property++
const propertyId = prop.row.id
console.log(`Property: ${prop.created ? 'CREATED' : 'exists'} (${propertyId})`)

for (const r of records) {
  // Unit (match on property_id + suite)
  const unit = await getOrInsert(
    'units',
    'suite',
    String(r.u),
    { property_id: propertyId, suite: String(r.u), sf: Number(r.sf), status: 'occupied' },
    { property_id: propertyId }
  )
  unit.created ? stats.units++ : stats.unitsSkipped++
  const unitId = unit.row.id

  // Tenant (match on exact name)
  const tenant = await getOrInsert('tenants', 'name', String(r.n), { name: String(r.n) })
  tenant.created ? stats.tenants++ : stats.tenantsSkipped++
  const tenantId = tenant.row.id

  // Lease (skip if an active lease already exists for this unit — DB also enforces this)
  const { data: existingLease, error: leaseSelErr } = await db
    .from('leases')
    .select('id, end_date')
    .eq('unit_id', unitId)
    .eq('status', 'active')
    .maybeSingle()
  if (leaseSelErr) throw new Error(`lease select: ${leaseSelErr.message}`)

  let leaseId
  if (existingLease) {
    leaseId = existingLease.id
    stats.leasesSkipped++
  } else {
    const { data: lease, error: leaseErr } = await db
      .from('leases')
      .insert({
        tenant_id: tenantId,
        unit_id: unitId,
        start_date: r.ls,
        end_date: r.exp,
        status: 'active',
        rent_type: 'nnn',
        base_rent_monthly: Number(r.m),
        cam_estimate_monthly: 0,
        security_deposit: 0,
        notes: `Imported from lease pipeline (${r.src}); rent ${r.r} $/SF NNN`,
      })
      .select()
      .single()
    if (leaseErr) throw new Error(`lease insert (${r.n}): ${leaseErr.message}`)
    leaseId = lease.id
    stats.leases++

    // Renewal tracking record (mirrors what the API does on lease create)
    const { error: renErr } = await db
      .from('renewals')
      .insert({ lease_id: leaseId, expiration_date: r.exp, status: 'tracking' })
    if (renErr && renErr.code !== '23505') throw new Error(`renewal insert: ${renErr.message}`)
    if (!renErr) stats.renewals++
  }

  // Opening balance (idempotent via idempotency_key)
  if (WITH_BALANCES && Number(r.bal) > 0) {
    const idemKey = `import:openingbal:${leaseId}`
    const { error: balErr } = await db.from('charges').insert({
      lease_id: leaseId,
      charge_date: todayStr,
      due_date: todayStr,
      period_start: periodStart,
      period_end: periodEnd,
      type: 'other',
      amount: Number(r.bal),
      description: `Opening balance — migrated from rent roll (aging ${r.age ?? 'n/a'})`,
      source: 'manual',
      idempotency_key: idemKey,
    })
    if (balErr) {
      if (balErr.code === '23505') stats.balancesSkipped++
      else throw new Error(`opening balance insert (${r.n}): ${balErr.message}`)
    } else {
      stats.balances++
    }
  }
}

console.log('\n=== Done ===')
console.log(JSON.stringify(stats, null, 2))
