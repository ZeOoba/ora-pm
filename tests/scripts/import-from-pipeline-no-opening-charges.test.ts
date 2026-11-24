// tests/scripts/import-from-pipeline-no-opening-charges.test.ts
//
// Audit 2026-11-23 (ora-pm, Tier 3 #10): scripts/import-from-pipeline.mjs used to write each rent-roll
// arrears balance as a `charges` row (type 'other', dated the import day). Every charge posts to the
// GL as Dr AR / Cr the charge type's INCOME account (0028_gl_ar_posting.sql), so migrated arrears
// were booked as current-period income and showed in income reports. Prior-system balances have one
// ratified home (2026-11-13): balance_forwards (0030), written only through apply_balance_forwards()
// from the QuickBooks AR aging (server/routes/balance-forwards.ts) -- QuickBooks, not the rent roll,
// is the tenant's true account, and a balance forward never touches income.

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '../..')
const IMPORTER = join(ROOT, 'scripts/import-from-pipeline.mjs')
// Checked on the RAW source (no comment stripping: stripping regexes can be fooled by '//' or
// '/*' inside strings). The importer's comments are worded so they never quote a table name.
const src = readFileSync(IMPORTER, 'utf8')
const MONEY_TABLES = ['charges', 'payments', 'balance_forwards']

describe('import-from-pipeline never books an opening balance as a charge', () => {
  it('writes nothing to charges, payments or balance_forwards', () => {
    for (const t of MONEY_TABLES) {
      // Any quoted mention of the table name: from('charges'), getOrInsert("charges", ...),
      // from(`charges`), const T = 'charges'. The script has no reason to name these tables at all.
      expect(src, t).not.toMatch(new RegExp(`['"\`]${t}['"\`]`))
    }
    expect(src).not.toMatch(/rpc\(\s*['"`]apply_balance_forwards['"`]/)
    expect(src).not.toMatch(/openingbal/)
  })

  it('refuses the removed --with-balances flag before reading anything (exit 2, points at balance forwards)', () => {
    const r = spawnSync(process.execPath, [IMPORTER, '--file', 'nonexistent.json', '--all', '--with-balances'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/balance forward/i)
  }, 60_000)
})
