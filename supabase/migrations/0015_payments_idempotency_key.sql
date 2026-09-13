-- payments.idempotency_key: manual-entry (check/wire/other) duplicate protection
-- (OI-082 — mirrors 0011 section 3's charges.idempotency_key treatment)
--
-- Why: 0011 gave `payments` two PARTIAL unique indexes — payments_stripe_pi_uniq
-- (stripe_payment_intent_id IS NOT NULL) and payments_autopay_period_uniq
-- (autopay_period IS NOT NULL). Rows with method IN ('check','wire','other'),
-- entered by admin staff through POST /api/payments, are NULL on BOTH columns,
-- so neither index applies to them and nothing stopped a duplicate manual
-- entry (double-submitted form, retried request, re-run import). ar_ledger's
-- payment_totals CTE sums every such row unconditionally, so a duplicate
-- silently understated the tenant's balance — and that balance is what
-- stripe.ts's amount cap and cron.ts's autopay lifetime cap both read.
--
-- PRE-FLIGHT (run against the LIVE database BEFORE applying; checks 1a/1b are
-- a data-hygiene gate for a human to adjudicate, not an apply-safety gate —
-- the backfill in section 2 is per-row unique on the immutable id, so this
-- migration cannot fail to apply over pre-existing duplicates. Check 2 IS an
-- apply-safety gate and must return zero rows):
--
--   1a. Pre-existing duplicate manual payments, same lease/date/amount/method.
--      This migration does NOT dedupe (unlike 0011 section 1) because two
--      such rows can be legitimate — e.g. two checks of the same amount on
--      the same day. Columns beyond the grouping key are included so a human
--      can adjudicate each group against the deposit records without a
--      second query; delete only the confirmed double-entries:
--        SELECT id, lease_id, payment_date, amount, method, check_number,
--               notes, created_at
--        FROM payments p
--        WHERE method IN ('check','wire','other')
--          AND EXISTS (
--            SELECT 1 FROM payments d
--            WHERE d.lease_id = p.lease_id AND d.payment_date = p.payment_date
--              AND d.amount = p.amount AND d.method = p.method AND d.id <> p.id
--          )
--        ORDER BY lease_id, payment_date, amount;
--
--   1b. The same-check-number shape check 1a's grouping key can miss — e.g. a
--      duplicate check entered under two different payment_date values.
--      check_number is nullable (not every method carries one), so this is
--      scoped to rows that have it:
--        SELECT id, lease_id, payment_date, amount, method, check_number,
--               notes, created_at
--        FROM payments p
--        WHERE check_number IS NOT NULL
--          AND EXISTS (
--            SELECT 1 FROM payments d
--            WHERE d.lease_id = p.lease_id AND d.check_number = p.check_number
--              AND d.id <> p.id
--          )
--        ORDER BY lease_id, check_number;
--
--   2. Backfill-value collision for payments.idempotency_key (astronomically
--      unlikely since id is a uuid, and the column doesn't exist yet so this
--      can only collide if a partial apply left it behind — check anyway):
--        SELECT column_name FROM information_schema.columns
--        WHERE table_schema = 'public' AND table_name = 'payments'
--          AND column_name = 'idempotency_key';
--      (must return zero rows; if it returns one, this migration — or a
--      concurrent workstream's — was already partially applied)

-- ---------------------------------------------------------------------------
-- 1) Add the column nullable first so existing rows can be backfilled before
--    the NOT NULL is applied (ALTER ... ADD COLUMN ... NOT NULL without a
--    default would fail on any non-empty table).
ALTER TABLE payments ADD COLUMN idempotency_key TEXT;

-- ---------------------------------------------------------------------------
-- 2) Backfill legacy rows with a per-row unique value. `legacy:` is the same
--    prefix 0011 reserved for charges; every pre-0015 payment row — Stripe,
--    autopay AND manual — gets one, so historical rows can never collide
--    with each other or with anything the application generates.
UPDATE payments
  SET idempotency_key = 'legacy:' || id::text
  WHERE idempotency_key IS NULL;

-- ---------------------------------------------------------------------------
-- 3) DB default for the insert paths that do NOT set idempotency_key —
--    stripe.ts (/portal/pay PaymentIntent recording) and cron.ts (autopay
--    collection). This is a deliberate divergence from charges (0011 gave
--    charges.idempotency_key no default; charges.ts / billing.ts / cron.ts
--    all set one explicitly):
--
--    Those two paths already have their own dedupe — payments_stripe_pi_uniq
--    and payments_autopay_period_uniq — and BOTH routes branch on the
--    constraint NAME in the 23505 message (stripe.ts: `deduped: true` only
--    for payments_stripe_pi_uniq; cron.ts: `skipped++` on 23505). Postgres
--    checks unique indexes in an order the application cannot rely on, so if
--    those paths were changed to derive idempotency_key from the same facts
--    (e.g. 'stripe:' || pi.id), a duplicate could surface as a 23505 naming
--    payments_idempotency_key_uniq instead — and stripe.ts would misreport a
--    successful retry as a 500. A random per-row default keeps this column
--    inert for them: it can never be the index that fires, so their existing
--    dedupe semantics are untouched. `auto:` (not `legacy:`/`manual:`) keeps
--    DB-generated values obviously distinct from the backfill and from
--    payments.ts's manual:<uuid> route default.
ALTER TABLE payments ALTER COLUMN idempotency_key
  SET DEFAULT ('auto:' || gen_random_uuid()::text);

-- ---------------------------------------------------------------------------
-- 4) NOT NULL: TEXT UNIQUE alone is useless while NULLs are allowed (Postgres
--    treats NULLs as distinct) — the exact 0011 section 3 lesson. Ordered
--    after the DEFAULT (3) rather than before it: both apply paths this repo
--    supports (the Supabase CLI's `db push`, and the dashboard-paste script's
--    single wrapping transaction) run this whole file atomically, so there is
--    no live window either way — but placing DEFAULT first means an insert
--    racing a HYPOTHETICAL future non-transactional apply between these two
--    statements would still succeed (falling back to the not-yet-set default)
--    rather than fail NOT NULL on a payment whose Stripe/ACH side already
--    confirmed (stripe.ts:223 confirms before this insert). Costs nothing to
--    order this way; removes a dependency that cost something to reason about.
ALTER TABLE payments ALTER COLUMN idempotency_key SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 5) The unique index. Named (not the implicit <table>_<col>_key from a
--    UNIQUE constraint) because payments.ts branches on this exact name in
--    the 23505 message to report "already recorded" — same pattern as
--    stripe.ts's payments_stripe_pi_uniq check.
CREATE UNIQUE INDEX payments_idempotency_key_uniq
  ON payments(idempotency_key);

COMMENT ON COLUMN payments.idempotency_key IS
  'Dedupe token, unique. manual:<uuid> from POST /api/payments (client-supplied per form session, else server-generated); auto:<uuid> DB default for stripe.ts/cron.ts inserts; legacy:<id> for rows backfilled by 0015.';

-- ---------------------------------------------------------------------------
-- Rollback (reference):
--   DROP INDEX IF EXISTS payments_idempotency_key_uniq;
--   ALTER TABLE payments DROP COLUMN idempotency_key;
-- No data loss on rollback: this migration only adds a column and a
-- constraint; the DROP COLUMN discards nothing the application reads back.
-- ar_ledger is untouched (no view drop/recreate needed — the column is not
-- referenced by any view), so 0011's ar_ledger definition remains live.
