#!/usr/bin/env node
// Import properties' rent rolls from the ORA Lease Intelligence Pipeline
// (Master Lease Database/_pipeline/output/TENANTS.json) into the PM database.
//
// Idempotent: re-running skips rows that already exist (natural keys; opening
// balances guarded by a deterministic idempotency_key).
//
// Usage:
//   node scripts/import-from-pipeline.mjs --file <TENANTS.json> --property "<label>" [--dry-run] [--no-balances]
//   node scripts/import-from-pipeline.mjs --file <TENANTS.json> --all [--dry-run] [--no-balances]
//
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env (service role bypasses RLS).

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
const PROPERTY_LABEL = arg('--property')
const ALL = args.includes('--all')
const DRY_RUN = args.includes('--dry-run')
const WITH_BALANCES = !args.includes('--no-balances')

if (!FILE || (!ALL && (!PROPERTY_LABEL || PROPERTY_LABEL === true))) {
  console.error('Usage: import-from-pipeline.mjs --file <TENANTS.json> (--property "<label>" | --all) [--dry-run] [--no-balances]')
  process.exit(2)
}

// ── property metadata ─────────────────────────────────────────────────────────
// Keyed by the pipeline `p` label. Street from pipeline config/property_map.json;
// city/state from the firm's Master workbook (Command Center snapshot, authoritative).
// ZIP intentionally null unless independently confirmed (firm SoR does not track ZIP).
// entity_llc null pending confirmation (real ownership entities are messy in source).
const PROPERTY_META = {
  'REDACTED-032':   { name: 'REDACTED-022',          address: 'REDACTED-022',          city: 'Columbus',     state: 'OH', zip: null,    property_type: 'industrial', entity_llc: null },
  'REDACTED-034':   { name: 'REDACTED-024',          address: 'REDACTED-024',          city: 'Columbus',     state: 'OH', zip: null,    property_type: 'industrial', entity_llc: null },
  'REDACTED-040':     { name: 'REDACTED-027',           address: 'REDACTED-027',           city: 'Columbus',     state: 'OH', zip: null,    property_type: 'industrial', entity_llc: null },
  'REDACTED-030':   { name: 'REDACTED-016',         address: 'REDACTED-016',         city: 'Cambridge',    state: 'MD', zip: null,    property_type: 'industrial', entity_llc: null },
  'REDACTED-033':   { name: 'REDACTED-019',          address: 'REDACTED-019',          city: 'Owings Mills', state: 'MD', zip: null,    property_type: 'industrial', entity_llc: null },
  'REDACTED-026': { name: 'REDACTED-026 Ave',       address: 'REDACTED-026 Ave',       city: 'Beltsville',   state: 'MD', zip: '20705', property_type: 'industrial', entity_llc: null },
  'REDACTED-044':        { name: 'REDACTED-023',          address: 'REDACTED-023',          city: 'Columbus',     state: 'OH', zip: null,    property_type: 'industrial', entity_llc: null },
  'REDACTED-042':       { name: 'REDACTED-021',          address: 'REDACTED-021',          city: 'Baltimore',    state: 'MD', zip: null,    property_type: 'industrial', entity_llc: null },
  'E 5th Ave':      { name: 'REDACTED-028',           address: 'REDACTED-028',           city: 'Columbus',     state: 'OH', zip: null,    property_type: 'industrial', entity_llc: null },
  'E REDACTED-038':   { name: 'REDACTED-005',    address: 'REDACTED-005',    city: 'Columbus',     state: 'OH', zip: null,    property_type: 'industrial', entity_llc: null },
  'REDACTED-046 Dr':      { name: 'REDACTED-015',         address: 'REDACTED-015',         city: 'Dublin',       state: 'OH', zip: null,    property_type: 'industrial', entity_llc: null },
  'Hwy 350':        { name: 'REDACTED-004',   address: 'REDACTED-004',   city: 'Raytown',      state: 'MO', zip: null,    property_type: 'industrial', entity_llc: null },
  'Info Lane':      { name: 'REDACTED-002',    address: 'REDACTED-002',    city: 'Easton',       state: 'MD', zip: null,    property_type: 'industrial', entity_llc: null },
  'Morrison':       { name: 'REDACTED-008',      address: 'REDACTED-008',      city: 'Columbus',     state: 'OH', zip: null,    property_type: 'industrial', entity_llc: null },
  'REDACTED-041':      { name: 'REDACTED-003',   address: 'REDACTED-003',   city: 'Salisbury',    state: 'MD', zip: null,    property_type: 'industrial', entity_llc: null },
  'REDACTED-047':          { name: 'REDACTED-029',           address: 'REDACTED-029',           city: 'Columbus',     state: 'OH', zip: null,    property_type: 'industrial', entity_llc: null },
  'Red Branch':     { name: 'REDACTED-006',     address: 'REDACTED-010',       city: 'Columbia',     state: 'MD', zip: '21045', property_type: 'industrial', entity_llc: null },
  'REDACTED-035':    { name: 'REDACTED-009',      address: 'REDACTED-009',      city: 'Columbus',     state: 'OH', zip: null,    property_type: 'industrial', entity_llc: null },
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

// ── dates ───────────────────────────────────────────────────────────────────
const today = new Date()
const todayStr = today.toISOString().slice(0, 10)
const periodStart = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`
const periodEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().slice(0, 10)

// ── suite sanitization ──────────────────────────────────────────────────────
// Source rent rolls occasionally carry non-ASCII flag glyphs (e.g. a "⚑verify"
// marker, sometimes mojibake'd) or an em-dash "—" for whole-building tenancies.
function cleanSuite(raw) {
  let s = String(raw).replace(/[^\x20-\x7E]/g, '').trim() // drop non-ASCII
  let flagged = false
  if (/verify/i.test(s)) {
    s = s.replace(/verify/gi, '').trim()
    flagged = true
  }
  s = s.replace(/\s+/g, ' ').replace(/^[-\s]+|[-\s]+$/g, '').trim()
  if (!s) s = 'Whole Building'
  return { suite: s, flagged }
}

// Strip mojibake / non-ASCII from tenant names (e.g. "PalmerÃ¢â‚¬â„¢s" → "Palmers").
function cleanName(raw) {
  return String(raw).replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim()
}

// Vacant rent-roll lines carry a "VACANT" marker and/or no lease dates.
function isVacant(r) {
  return /vacant/i.test(String(r.n)) || (!r.ls && !r.exp)
}

// Classify + dedupe a property's raw records into actionable rows.
// Returns { leases:[…], vacants:[…], held:[…], totalSF }.
function prepareRecords(records) {
  const leases = []
  const vacants = []
  const held = []
  const seenLeaseSig = new Set() // (sf|m|ls|exp) — catches the same physical lease entered twice
  const suiteSF = new Map()      // unique suite → sf (for accurate total)

  for (const r of records) {
    const { suite, flagged } = cleanSuite(r.u)
    const name = cleanName(r.n)
    const sf = Number(r.sf) || 0

    // Held rows (flagged or duplicate) do NOT count toward total SF.
    if (flagged) {
      held.push({ suite, name, reason: 'source flagged for verification', raw: r })
      continue
    }
    if (isVacant(r)) {
      if (!suiteSF.has(suite)) suiteSF.set(suite, sf)
      vacants.push({ suite, sf })
      continue
    }
    const sig = `${sf}|${Number(r.m) || 0}|${r.ls}|${r.exp}`
    if (seenLeaseSig.has(sig)) {
      held.push({ suite, name, reason: 'exact-duplicate lease (deduped)', raw: r })
      continue
    }
    seenLeaseSig.add(sig)
    if (!suiteSF.has(suite)) suiteSF.set(suite, sf)
    leases.push({ suite, name, sf, r })
  }

  const totalSF = [...suiteSF.values()].reduce((s, v) => s + v, 0)
  return { leases, vacants, held, totalSF }
}

// ── load file ─────────────────────────────────────────────────────────────────
const all = JSON.parse(readFileSync(FILE, 'utf8'))

function labelsToRun() {
  if (ALL) {
    const present = [...new Set(all.map((r) => r.p))]
    const known = present.filter((p) => PROPERTY_META[p])
    const unknown = present.filter((p) => !PROPERTY_META[p])
    if (unknown.length) console.warn(`\n[WARN] No PROPERTY_META for: ${unknown.join(', ')} — skipped.\n`)
    return known.sort()
  }
  return [PROPERTY_LABEL]
}

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

async function processProperty(label) {
  const records = all.filter((r) => r.p === label)
  const meta = PROPERTY_META[label]
  if (!meta) throw new Error(`No PROPERTY_META for "${label}"`)
  if (records.length === 0) {
    console.log(`\n${label}: no records, skipping`)
    return null
  }
  const { leases: leaseRows, vacants, held, totalSF } = prepareRecords(records)
  const withBal = leaseRows.filter((x) => WITH_BALANCES && Number(x.r.bal) > 0)

  console.log(`\n=== ${meta.name} (${label}) ===`)
  console.log(`${meta.address}, ${meta.city}, ${meta.state}${meta.zip ? ' ' + meta.zip : ''} | ${meta.property_type} | total_sf=${totalSF} | leases=${leaseRows.length} | vacant=${vacants.length} | held=${held.length} | opening balances=${withBal.length}`)
  for (const x of leaseRows) {
    const r = x.r
    const bal = Number(r.bal) > 0 ? ` | bal $${Number(r.bal).toLocaleString()} (${r.age})` : ''
    console.log(`  ${x.suite.padEnd(16)} ${String(x.sf).padStart(6)} SF  ${x.name.slice(0, 36).padEnd(38)} $${Number(r.m).toLocaleString()}/mo  ${r.ls}→${r.exp}${bal}`)
  }
  for (const v of vacants) console.log(`  ${v.suite.padEnd(16)} ${String(v.sf).padStart(6)} SF  -- VACANT --`)
  for (const h of held) console.log(`  [HELD] ${h.suite} / ${h.name} — ${h.reason}`)
  if (DRY_RUN) return { dryRun: true, held }

  const stats = { units: 0, unitsSkipped: 0, tenants: 0, tenantsSkipped: 0, leases: 0, leasesSkipped: 0, renewals: 0, balances: 0, balancesSkipped: 0, vacants: 0, held: held.length }

  const prop = await getOrInsert('properties', 'name', meta.name, { ...meta, total_sf: totalSF })
  const propertyId = prop.row.id

  // Occupied leases
  for (const x of leaseRows) {
    const r = x.r
    const unit = await getOrInsert(
      'units', 'suite', x.suite,
      { property_id: propertyId, suite: x.suite, sf: x.sf, status: 'occupied' },
      { property_id: propertyId }
    )
    unit.created ? stats.units++ : stats.unitsSkipped++
    const unitId = unit.row.id

    const tenant = await getOrInsert('tenants', 'name', x.name, { name: x.name })
    tenant.created ? stats.tenants++ : stats.tenantsSkipped++
    const tenantId = tenant.row.id

    const { data: existingLease, error: leaseSelErr } = await db
      .from('leases').select('id').eq('unit_id', unitId).eq('status', 'active').maybeSingle()
    if (leaseSelErr) throw new Error(`lease select: ${leaseSelErr.message}`)

    let leaseId
    if (existingLease) {
      leaseId = existingLease.id
      stats.leasesSkipped++
    } else {
      const { data: lease, error: leaseErr } = await db
        .from('leases')
        .insert({
          tenant_id: tenantId, unit_id: unitId,
          start_date: r.ls, end_date: r.exp, status: 'active', rent_type: 'nnn',
          base_rent_monthly: Number(r.m) || 0, cam_estimate_monthly: 0, security_deposit: 0,
          notes: `Imported from lease pipeline (${r.src}); rent ${r.r ?? 0} $/SF NNN`,
        })
        .select().single()
      if (leaseErr) throw new Error(`lease insert (${x.name} @ ${label}): ${leaseErr.message}`)
      leaseId = lease.id
      stats.leases++

      const { error: renErr } = await db.from('renewals').insert({ lease_id: leaseId, expiration_date: r.exp, status: 'tracking' })
      if (renErr && renErr.code !== '23505') throw new Error(`renewal insert: ${renErr.message}`)
      if (!renErr) stats.renewals++
    }

    if (WITH_BALANCES && Number(r.bal) > 0) {
      const { error: balErr } = await db.from('charges').insert({
        lease_id: leaseId, charge_date: todayStr, due_date: todayStr,
        period_start: periodStart, period_end: periodEnd,
        type: 'other', amount: Number(r.bal),
        description: `Opening balance — migrated from rent roll (aging ${r.age ?? 'n/a'})`,
        source: 'manual', idempotency_key: `import:openingbal:${leaseId}`,
      })
      if (balErr) {
        if (balErr.code === '23505') stats.balancesSkipped++
        else throw new Error(`opening balance insert (${x.name}): ${balErr.message}`)
      } else stats.balances++
    }
  }

  // Vacant units (no tenant/lease). Skip if suite already exists (e.g. collision with an occupied unit).
  for (const v of vacants) {
    const { data: existingUnit } = await db.from('units').select('id').eq('property_id', propertyId).eq('suite', v.suite).maybeSingle()
    if (existingUnit) continue
    const { error: uErr } = await db.from('units').insert({ property_id: propertyId, suite: v.suite, sf: v.sf, status: 'vacant' })
    if (uErr && uErr.code !== '23505') throw new Error(`vacant unit insert: ${uErr.message}`)
    if (!uErr) stats.vacants++
  }

  console.log(`  → property ${prop.created ? 'CREATED' : 'exists'}; ` + JSON.stringify(stats))
  return { ...stats, heldRows: held }
}

// ── run ───────────────────────────────────────────────────────────────────────
const labels = labelsToRun()
console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE WRITE'} | properties: ${labels.length} | balances: ${WITH_BALANCES ? 'on' : 'off'}`)

const totals = { properties: 0, units: 0, tenants: 0, leases: 0, balances: 0 }
for (const label of labels) {
  const s = await processProperty(label)
  if (s && !s.dryRun) {
    totals.properties++
    totals.units += s.units
    totals.tenants += s.tenants
    totals.leases += s.leases
    totals.balances += s.balances
  }
}

if (DRY_RUN) {
  console.log('\nDRY RUN complete — no data written.')
} else {
  console.log('\n=== TOTALS (newly created this run) ===')
  console.log(JSON.stringify(totals, null, 2))
}
