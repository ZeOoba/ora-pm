/// <reference types="node" />
// scripts/check-refute-required.ts — OI-255
//
// ora-pm is the only ORA repo that moves real money: Stripe ACH autopay debits, late-fee posting,
// tenant-initiated ACH PaymentIntents, and the webhook transitions that decide whether a payment
// counts. A change to one of those files must carry a `Refute-Reviewed:` (or, with justification,
// `Refute-Skip:`) commit trailer attesting that an adversarial REFUTE pass ran on it. This turns
// the Engineering-OS done-bar doctrine into a mechanical check so it cannot silently lapse.
//
// Ported from oxford-command-center/scripts/check-refute-required.ts (same mechanism); the path set
// is THIS repo's, verified file-by-file — see FINANCIAL_SOURCE_PATHS below.
//
// Default mode WARNS and exits 0 (local dev — never blocks WIP). `--strict` EXITS 1 on a violation
// (wired into CI for pull requests). Fails OPEN on any git/tooling gap.
//
// Usage: tsx scripts/check-refute-required.ts [--strict] [--base=<ref>]
//   base defaults to $REFUTE_BASE, else 'origin/main'.
//
// Exported functions are pure (no I/O — the SQL reader is injected) so they unit-test without the
// process.exit side effects; the bottom-of-file guard runs main() only when executed directly.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// Enumerated, not a directory prefix: server/routes/ and server/lib/ are mostly CRUD and reporting
// plumbing (tenants, properties, units, exports, reports, insurance, IIF export). Each entry below
// was verified by reading the file. When a NEW file starts posting charges, inserting payments, or
// calling Stripe, add it here AND to tests/unit/check-refute-required.test.ts — the membership
// test pins the count so an omission is a visible diff, not a silent gap.
export const FINANCIAL_SOURCE_PATHS: ReadonlySet<string> = new Set([
  // Monthly billing cron: bulk charges upsert, autopay PaymentIntent creation + payments insert,
  // delinquency sweep + $50 late_fee inserts. The autopay debit path is the largest blast radius
  // in the repo.
  'server/routes/cron.ts',
  // Tenant-initiated ACH: SetupIntent (bank attach), PaymentIntent create with the $50k ceiling and
  // outstanding-balance cap, payments insert.
  'server/routes/stripe.ts',
  // Stripe client config — maxNetworkRetries bounds the retry budget every debit relies on.
  'server/lib/stripe.ts',
  // Webhook handler: payment_intent.succeeded / failed / canceled, charge.failed (ACH return),
  // charge.dispute.created → payments.stripe_status transitions.
  'server/lib/stripe-events.ts',
  // Webhook route: signature verification + the idempotency read that decides whether a
  // side-effecting handler re-runs (OI-222) — a double-apply gate, not just plumbing.
  'server/routes/webhook.ts',
  // CAM true-up math (pro-rata share, owed, true-up amount).
  'server/lib/cam.ts',
  // CAM route: recoverable-expense total feeding /calculate, and /bill which posts cam_true_up
  // charges.
  'server/routes/cam.ts',
  // Manual payment recording (check/wire/other) — inserts into payments.
  'server/routes/payments.ts',
  // Manual charge posting + delete (auto charges protected) — inserts into charges.
  'server/routes/charges.ts',
  // Monthly charge builder: rent / cam_estimate amounts, proration, due dates, idempotency keys.
  'server/lib/billing.ts',
  // Zod schemas bounding charge / payment inserts and the payment-intent request id — a contract
  // change here carries the same blast radius the reference repo learned from its LTV bound.
  'server/lib/schemas.ts',
])

// Tables whose schema/view/index changes are financial: charges (what tenants owe), payments
// (what was collected / debited), ar_ledger (the balance view the autopay debit and delinquency
// sweep read).
export const FINANCIAL_TABLES: readonly string[] = ['charges', 'payments', 'ar_ledger']

const MIGRATION_RE = /^supabase\/migrations\/[^/]+\.sql$/

function normalize(p: string): string {
  return p.replace(/\\/g, '/')
}

/** True when a changed path is an enumerated financial-decision SOURCE file (never a test/doc/json). */
export function isFinancialSourcePath(p: string): boolean {
  const path = normalize(p)
  if (/\.(test|spec)\.(ts|tsx)$/.test(path) || path.endsWith('.md') || path.endsWith('.json')) return false
  return FINANCIAL_SOURCE_PATHS.has(path)
}

/** True for supabase/migrations/<name>.sql — the files whose CONTENT decides financial relevance. */
export function isMigrationPath(p: string): boolean {
  return MIGRATION_RE.test(normalize(p))
}

// Identifier-aware match: underscore counts as a separator, so `idx_charges_lease`, `ar_ledger_v2`,
// `public.payments` and `"charges"` all match, while `recharges` and `stripe_payment_intent_id` do
// not. Deliberately not comment-stripped — a comment-only edit in a money migration is cheap to
// attest and expensive to miss.
const FINANCIAL_TABLE_RE = new RegExp(`(^|[^a-z0-9])(${FINANCIAL_TABLES.join('|')})(?![a-z0-9])`, 'i')

/** True when a migration's SQL references any financial table. */
export function migrationTouchesFinancialTables(sql: string): boolean {
  return FINANCIAL_TABLE_RE.test(sql)
}

/**
 * From a list of changed paths, return (normalized) the ones that require a refute attestation.
 * `readSql` is consulted only for migration paths; a `null` result (deleted / unreadable) fails
 * CLOSED — a vanished money migration deserves a look, and attesting is one trailer away.
 */
export function selectFinancialChanges(changed: readonly string[], readSql: (path: string) => string | null): string[] {
  const out: string[] = []
  for (const raw of changed) {
    const path = normalize(raw)
    if (isFinancialSourcePath(path)) {
      out.push(path)
    } else if (isMigrationPath(path)) {
      const sql = readSql(path)
      if (sql === null || migrationTouchesFinancialTables(sql)) out.push(path)
    }
  }
  return out
}

/**
 * True when a refute attestation trailer appears at the start of a line anywhere in the blob, in
 * git trailer form (`Token: value`). Requiring whitespace + a value after the colon is what keeps
 * prose that merely mentions the tokens — e.g. a wrapped body line beginning
 * "Refute-Reviewed:/Refute-Skip: trailer when…" — from counting as an attestation (found while
 * writing this gate's own commit message).
 */
export function hasRefuteApproval(messageBlob: string): boolean {
  return /(^|\n)[ \t]*Refute-(Reviewed|Skip):[ \t]+\S/i.test(messageBlob)
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' })
}

// Read a migration as committed at HEAD (what the PR actually lands), falling back to the working
// tree for local runs with uncommitted edits. null = deleted or unreadable → fail closed upstream.
function readMigrationSql(path: string): string | null {
  try {
    return git(['show', `HEAD:${path}`])
  } catch {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  }
}

function main(): void {
  const argv = process.argv.slice(2)
  const strict = argv.includes('--strict')
  const base = argv.find((a) => a.startsWith('--base='))?.slice('--base='.length) ?? process.env.REFUTE_BASE ?? 'origin/main'

  let changed: string[]
  let messageBlob: string
  try {
    changed = git(['diff', '--name-only', `${base}...HEAD`]).split('\n').map((s) => s.trim()).filter(Boolean)
    messageBlob = git(['log', `${base}..HEAD`, '--format=%B'])
  } catch (err) {
    // No usable base ref (shallow clone, detached HEAD, fresh repo) — never block on a tooling gap.
    console.warn(`check:refute — skipped: could not diff against '${base}' (${(err as Error).message.split('\n')[0]}).`)
    return
  }

  const financial = selectFinancialChanges(changed, readMigrationSql)
  if (financial.length === 0) {
    console.log('check:refute — OK: no financial-decision files changed in this range.')
    return
  }
  if (hasRefuteApproval(messageBlob)) {
    console.log(`check:refute — OK: ${financial.length} financial file(s) changed; a Refute-Reviewed/Skip trailer is present.`)
    return
  }

  const msg = [
    `check:refute — ${financial.length} financial-decision file(s) changed WITHOUT a refute attestation:`,
    ...financial.map((f) => `    ${f}`),
    '',
    'Run an adversarial REFUTE pass on the change, then add a commit trailer:',
    '    Refute-Reviewed: <review ref>        (or, with justification)  Refute-Skip: <reason>',
    `(checked range: ${base}..HEAD)`,
  ].join('\n')

  if (strict) {
    console.error(msg)
    process.exit(1)
  }
  console.warn(msg)
}

if (process.argv[1] && normalize(process.argv[1]).endsWith('check-refute-required.ts')) {
  main()
}
