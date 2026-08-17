// tests/lib/no-raw-db-errors.test.ts
//
// OI-042 regression tripwire: scans every server/routes/*.ts source file for
// the raw-error-passthrough pattern (`error: <expr>.message` inside a
// c.json(...) response) and fails if any occurrence exists outside the
// explicit allowlist below. A line is "raw" if it contains the JSON key
// `error:` followed later on the same line by `.message` — this catches
// `error: error.message`, `error: (err as Error).message`, and template
// literals like `` error: `...${x.message}...` `` alike, while correctly
// ignoring non-response lines like `insertErr.message?.includes(...)`
// (no `error:` key) or `console.error(...)` (no `.message` after an
// `error:` key on that line).
//
// This does NOT prove every route is fully hardened — see the allowlist
// below for the deliberate exceptions (Stripe SDK errors, a controlled
// validation throw, and the operator-only /api/cron/* surface).
//
// OI-063 (closed 2026-08-04): five files never named in any of the 11-task
// appsec plan's briefs (properties.ts, expenses.ts, payments.ts,
// portal-auth.ts, portal-insurance.ts) were confirmed still leaking raw
// Postgres/Supabase-Auth error text to the client — a genuine plan gap, not
// something already covered elsewhere, self-flagged by the implementer and
// independently confirmed by a REFUTE pass rather than assumed fixed by a
// same-titled later commit. All 5 now route through dbError().

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROUTES_DIR = join(__dirname, '../../server/routes')

function isRawErrorLine(line: string): boolean {
  const errIdx = line.indexOf('error:')
  if (errIdx === -1) return false
  const msgIdx = line.indexOf('.message', errIdx)
  return msgIdx !== -1
}

// file -> substrings that, when found on an otherwise-flagged line, mark it
// as deliberately allowed. A line must contain the file's substring to be
// excused; anything else flagged in that file still fails the test.
const ALLOWLIST: Record<string, string[]> = {
  // --- Deliberately kept (reviewed, in-scope for an earlier task) ---
  // Stripe's own SDK errors are already client-safe by design (Stripe
  // authors them for display to the payer) — not a raw Postgres error.
  'stripe.ts': ["err.message"],
  'portal.ts': ["err.message"], // same Stripe-error pattern, Task 8 scope
  // cam.ts:63 — calculateCAMTrueUp() throws a controlled validation message
  // (e.g. "totalLeasedSF must be positive"), not a raw DB error. Task 7
  // reviewed clean; out of Task 9's scope (cam.ts explicitly excluded).
  'cam.ts': ["(err as Error).message"],
  // cron.ts — operator-only /api/cron/* endpoints; Task 2's deliberate
  // judgment call to keep DB detail visible to the ops/alerting consumer,
  // not a tenant-reachable surface. Out of Task 9's scope (explicitly
  // excluded per the brief). overdueRes/existingFeeRes added 2026-08-17
  // (delinquency-check N+1 batching fix) — same rationale, new variable
  // names from the bulk fetchChunked() lookups that replaced the old
  // per-lease queries.
  'cron.ts': ["leaseErr.message", "cdErr.message", "insErr.message", "arErr.message", "overdueRes.error.message", "existingFeeRes.error.message"],

  // OI-063 closed 2026-08-04: all 5 files now route through dbError(); no
  // allowlist entries remain (see the "OI-063 scope files" assertion below).
}

describe('no-raw-db-errors tripwire (OI-042)', () => {
  const files = readdirSync(ROUTES_DIR).filter(f => f.endsWith('.ts'))

  it('found the expected route files (sanity check the scan target is real)', () => {
    expect(files).toEqual(expect.arrayContaining(['budgets.ts', 'insurance.ts', 'charges.ts', 'leases.ts']))
  })

  for (const file of files) {
    it(`${file} has no un-allowlisted raw error.message passthrough`, () => {
      const source = readFileSync(join(ROUTES_DIR, file), 'utf-8')
      const lines = source.split('\n')
      const allowed = ALLOWLIST[file] ?? []

      const violations = lines
        .map((line, i) => ({ line, num: i + 1 }))
        .filter(({ line }) => isRawErrorLine(line))
        .filter(({ line }) => !allowed.some(snippet => line.includes(snippet)))

      if (violations.length > 0) {
        const detail = violations.map(v => `  ${file}:${v.num}: ${v.line.trim()}`).join('\n')
        throw new Error(`Raw error.message passthrough found outside the allowlist:\n${detail}`)
      }
    })
  }

  // Task 9's own named scope, plus OI-063's 5-file gap closure, asserted
  // explicitly rather than only implicitly by the loop above — if one of
  // these files is ever removed from ALLOWLIST-exemption by accident, this
  // pins the expectation that they are FULLY clean (no allowlist entries).
  it('Task 9 + OI-063 scope files carry zero allowlist entries (fully swept, not partially excused)', () => {
    const fullyCleanScope = [
      'budgets.ts', 'insurance.ts', 'units.ts', 'renewals.ts',
      'charges.ts', 'leases.ts', 'tenants.ts', 'reports.ts', 'webhook.ts',
      'properties.ts', 'expenses.ts', 'payments.ts', 'portal-auth.ts', 'portal-insurance.ts',
    ]
    for (const file of fullyCleanScope) {
      expect(ALLOWLIST[file] ?? [], `${file} should have no allowlist entries`).toEqual([])
    }
  })
})
