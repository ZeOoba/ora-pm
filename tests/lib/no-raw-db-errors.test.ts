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
// below, which is intentionally NOT small: Task 9's named scope (the mass-
// assignment sweep files, reports.ts, webhook.ts) is fully clean, but five
// files never named in any of the 11-task plan's briefs (properties.ts,
// expenses.ts, payments.ts, portal-auth.ts, portal-insurance.ts) still leak
// raw Postgres error text to the client. Verified against
// .superpowers/sdd/progress.md's Task 1-8 completion notes and Task
// 10/11 brief titles (MFA flow; RLS docs + tripwire) before concluding this
// is a genuine plan gap, not something already covered elsewhere — flagged
// in task-9-report.md for the final whole-branch review, not silently swept
// into a "small" allowlist as if it were an intentional exception.

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
  // excluded per the brief).
  'cron.ts': ["leaseErr.message", "cdErr.message", "insErr.message", "arErr.message"],

  // --- NOT covered by any task in the 11-task plan — genuine gap, flagged
  //     to the final whole-branch review in task-9-report.md, not fixed
  //     here (would be scope creep beyond Task 9's named file list). ---
  'properties.ts': ["error.message"],
  'expenses.ts': ["error.message"],
  'payments.ts': ["error.message"],
  'portal-auth.ts': ["inviteErr.message", "deleteErr.message"],
  'portal-insurance.ts': ["error.message"],
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

  // Task 9's own named scope, asserted explicitly rather than only
  // implicitly by the loop above — if one of these files is ever removed
  // from ALLOWLIST-exemption by accident, this pins the expectation that
  // they are FULLY clean (no allowlist entries at all).
  it('Task 9 scope files carry zero allowlist entries (fully swept, not partially excused)', () => {
    const task9Scope = [
      'budgets.ts', 'insurance.ts', 'units.ts', 'renewals.ts',
      'charges.ts', 'leases.ts', 'tenants.ts', 'reports.ts', 'webhook.ts',
    ]
    for (const file of task9Scope) {
      expect(ALLOWLIST[file] ?? [], `${file} should have no allowlist entries`).toEqual([])
    }
  })
})
