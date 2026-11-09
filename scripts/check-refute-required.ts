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
// (wired into CI for pull requests). A git/tooling gap (unresolvable base ref, shallow clone) warns
// and exits 0 in default mode, but FAILS CLOSED (exit 1) under `--strict` (M12, 2026-11-08): a CI
// misconfiguration must not silently pass every money PR.
//
// Usage: tsx scripts/check-refute-required.ts [--strict] [--base=<ref>]
//   base defaults to $REFUTE_BASE, else 'origin/main'.
//
// Exported functions are pure (no I/O — git, the SQL reader and the logger are injected) so they
// unit-test without the process.exit side effects; the bottom-of-file guard runs main() only when
// executed directly.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// Enumerated, not a directory prefix: server/routes/ and server/lib/ are mostly CRUD and reporting
// plumbing (tenants, properties, units, reports, insurance). Each entry below was verified by
// reading the file. When a NEW file starts posting charges, inserting payments, or calling Stripe,
// add it here AND to tests/unit/check-refute-required.test.ts — the membership test pins the count
// so an omission is a visible diff, not a silent gap, and its import-closure test fails when a
// gated file imports a server/lib module that is neither gated nor classified non-financial.
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
  // charge.dispute.created / charge.dispute.closed → payments.stripe_status transitions.
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
  // M3 (2026-11-08): keyset/chunked PostgREST reads under the cron's autopay debit amounts and
  // delinquency sweep, the CAM recoverable-expense pool and the IIF journal. A paging bug silently
  // truncates a money total with no gated file changing.
  'server/lib/postgrest-paging.ts',
  // QuickBooks IIF journal (books of record): which charges post, to which accounts, for how much.
  'server/routes/exports.ts',
  'server/lib/iif-export.ts',
  // AR-aging oldest-first allocation of payments to charges (the aging buckets and their totals).
  'server/lib/ar-aging.ts',
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
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
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

export interface RefuteCheckIO {
  argv: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  /** Runs git with the given args and returns stdout; throws on a non-zero exit. */
  git: (args: string[]) => string
  /** Migration SQL as landed; null = deleted/unreadable (fails closed in selectFinancialChanges). */
  readSql: (path: string) => string | null
  logger: { log: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }
}

/** The gate's whole decision, with I/O injected. Returns the process exit code (0 or 1). */
export function runRefuteCheck(io: RefuteCheckIO): number {
  const strict = io.argv.includes('--strict')
  const base = io.argv.find((a) => a.startsWith('--base='))?.slice('--base='.length) ?? io.env.REFUTE_BASE ?? 'origin/main'

  let changed: string[]
  let messageBlob: string
  try {
    // REFUTE finding: an empty base made the range `...HEAD` (= HEAD...HEAD), an empty diff that
    // reported "OK". Require a non-empty base that resolves to a commit before trusting the range.
    if (base.trim() === '') throw new Error('base ref is empty')
    io.git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`])
    changed = io.git(['diff', '--name-only', `${base}...HEAD`]).split('\n').map((s) => s.trim()).filter(Boolean)
    messageBlob = io.git(['log', `${base}..HEAD`, '--format=%B'])
  } catch (err) {
    // No usable base ref (shallow clone, detached HEAD, fresh repo, misnamed base).
    const reason = `could not diff against '${base}' (${String((err as Error)?.message ?? err).split('\n')[0]})`
    if (strict) {
      // M12: under --strict an unverifiable range is a failure, not a pass. CI must fetch the
      // base (fetch-depth: 0 or an explicit fetch) for the gate to run at all.
      io.logger.error(`check:refute — FAILED (--strict): ${reason}. The financial-change range cannot be verified, so the gate fails closed.`)
      return 1
    }
    // Local runs never block on a tooling gap.
    io.logger.warn(`check:refute — skipped: ${reason}.`)
    return 0
  }

  const financial = selectFinancialChanges(changed, io.readSql)
  if (financial.length === 0) {
    io.logger.log('check:refute — OK: no financial-decision files changed in this range.')
    return 0
  }
  if (hasRefuteApproval(messageBlob)) {
    io.logger.log(`check:refute — OK: ${financial.length} financial file(s) changed; a Refute-Reviewed/Skip trailer is present.`)
    return 0
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
    io.logger.error(msg)
    return 1
  }
  io.logger.warn(msg)
  return 0
}

function main(): void {
  const code = runRefuteCheck({
    argv: process.argv.slice(2),
    env: process.env,
    git,
    readSql: readMigrationSql,
    logger: { log: console.log, warn: console.warn, error: console.error },
  })
  if (code !== 0) process.exit(code)
}

if (process.argv[1] && normalize(process.argv[1]).endsWith('check-refute-required.ts')) {
  main()
}
