#!/usr/bin/env node
// OI-312 deploy-ordering gate.
//
// ci.yml's push-to-main job went straight from "Check commit is still the tip of main" to "Deploy
// to Cloudflare Pages" with nothing DB-related in between, while db-migrate.yml is
// workflow_dispatch-only and deliberately decoupled. So an app deploy could land BEFORE the
// migration it depends on: 0016_charges_void.sql's own header says the app must deploy AFTER 0016
// is live, because `.is('voided_at', null)` raises 42703 against the old schema. That is exactly
// what almost happened merging PR #42 -- caught only because a human was watching CI live. Nothing
// would have caught it on an unattended merge.
//
// This script fails the deploy when any local migration file has no matching remote entry, forcing
// a human to run `DB Migrate (manual)` first rather than racing it.
//
// FAILS CLOSED, always. An unparseable table, a CLI error, a missing secret and a genuinely pending
// migration all block the deploy. The failure mode this guards against is a broken production app;
// the cost of a false positive is re-running a job. Those are not close.

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// `supabase migration list --linked` prints a three-column table. A row whose LOCAL cell holds a
// version but whose REMOTE cell is blank is a migration that exists in the repo and not in the
// database -- i.e. pending. Box-drawing separators vary across CLI versions, so accept both.
const COLUMN_SEPARATORS = /[│|]/

// The CLI wraps each version in backticks -- the real production output is
//     `0013` | `0013` | `0013`
// not a bare 0013. The first version of this gate tested the raw cell against /^\d+$/, parsed zero
// rows against live output, and blocked the deploy on the very first push to main that ran it
// (run 35388439275). It failed closed and said exactly why, which is the only reason that was a
// blocked deploy and not a silently-skipped check -- but the parser was still wrong. Normalise the
// decoration away before matching, and never assume a cell is bare.
function cellValue(raw) {
  return raw.replace(/`/g, '').trim()
}

export function parseMigrationList(stdout) {
  const pending = []
  let sawAnyRow = false

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (!COLUMN_SEPARATORS.test(line)) continue

    const cells = line.split(COLUMN_SEPARATORS).map(cellValue)
    if (cells.length < 2) continue

    const [local, remote] = cells
    // Anything that is not a bare version after normalisation -- the `Local | Remote | Time (UTC)`
    // header, the ----|----|---- rule, a remote-only row -- is not a local migration.
    if (!/^\d+$/.test(local)) continue

    sawAnyRow = true
    if (!/^\d+$/.test(remote)) pending.push(local)
  }

  return { pending, sawAnyRow }
}

function fail(message) {
  console.error(`::error::${message}`)
  process.exit(1)
}

function main() {
  const password = process.env.SUPABASE_DB_PASSWORD
  const token = process.env.SUPABASE_ACCESS_TOKEN
  if (!password || !token) {
    fail(
      'Migration gate cannot run: SUPABASE_ACCESS_TOKEN and/or SUPABASE_DB_PASSWORD are not set. ' +
        'Refusing to deploy rather than deploying past an unverified schema.',
    )
  }

  let stdout
  try {
    stdout = execFileSync('supabase', ['migration', 'list', '--linked', '--password', password], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    // Never echo err.stdout/stderr wholesale -- the password is on the argv of the failing command
    // and some CLI errors echo their own invocation back.
    fail(
      `Migration gate could not read the remote migration state (supabase migration list failed: ${err.code ?? 'non-zero exit'}). ` +
        'Refusing to deploy.',
    )
  }

  const { pending, sawAnyRow } = parseMigrationList(stdout)

  if (!sawAnyRow) {
    fail(
      'Migration gate could not parse any migration rows from `supabase migration list --linked`. ' +
        'The CLI output format may have changed. Refusing to deploy until this script is updated.',
    )
  }

  if (pending.length > 0) {
    fail(
      `${pending.length} migration(s) exist in supabase/migrations/ but are NOT applied to production: ${pending.join(', ')}. ` +
        'Run the "DB Migrate (manual)" workflow first, then re-run this job. ' +
        'Deploying the app ahead of its schema is the OI-312 race.',
    )
  }

  console.log(`✓ Migration gate: all local migrations are applied to production (${sawAnyRow ? 'table parsed' : ''}).`)
}

// Only run when invoked directly, so the parser can be unit-tested.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
