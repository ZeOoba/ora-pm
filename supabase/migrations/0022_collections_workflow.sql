-- B1 (redesign plan 2026-11-10): collections workflow records — promises to pay and AR disputes.
--
-- What these tables are: a WORK LOG for the collections queue (Today, Collections, Tenant pages).
-- An admin records that a tenant promised an amount by a date, or disputes part of a balance,
-- and later resolves it. Written only by server/routes/collections.ts (admin-gated).
--
-- What they are NOT: nothing here posts, voids, applies or waives money. Billing, late fees,
-- autopay and the balance/aging reports do not read these tables. A promise marked "kept" is an
-- admin's judgement, not a payment application (none exists yet); a dispute does not pause late
-- fees. Changing either of those would be financial-decision code and its own refuted change.
--
-- Status model (both tables): one open state and terminal states. resolved_at is set exactly
-- when the row leaves the open state (pair CHECK), so "still open" is one indexed predicate.
-- A promise is "lapsed" when it is open and its promised_date has passed. That is derived at
-- read time by the API (server/lib/collections.ts), not stored, so it can never go stale.
--
-- RLS: enabled with NO policies — default-deny for the anon/authenticated roles, the
-- 0013_enable_rls_remaining_tables.sql / 0018 pattern. The API uses the service-role client.
--
-- ORDERING: purely additive (two new tables, two indexes). Apply before deploying the Worker
-- that reads them; ci.yml's migrations-applied gate blocks the deploy until it is applied.
-- RE-RUNNABLE: CREATE ... IF NOT EXISTS throughout; ENABLE RLS and COMMENT ON are idempotent.

CREATE TABLE IF NOT EXISTS promises_to_pay (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id UUID NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL
    CONSTRAINT promises_to_pay_amount_positive CHECK (amount > 0),
  promised_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CONSTRAINT promises_to_pay_status_check CHECK (status IN ('open', 'kept', 'broken', 'cancelled')),
  notes TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  CONSTRAINT promises_to_pay_resolved_pair CHECK ((status = 'open') = (resolved_at IS NULL))
);
CREATE INDEX IF NOT EXISTS promises_to_pay_lease_status_idx ON promises_to_pay (lease_id, status);

CREATE TABLE IF NOT EXISTS ar_disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id UUID NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  amount NUMERIC(12,2)
    CONSTRAINT ar_disputes_amount_positive CHECK (amount IS NULL OR amount > 0),
  reason TEXT NOT NULL
    CONSTRAINT ar_disputes_reason_nonempty CHECK (btrim(reason) <> ''),
  status TEXT NOT NULL DEFAULT 'open'
    CONSTRAINT ar_disputes_status_check CHECK (status IN ('open', 'resolved', 'withdrawn')),
  resolution TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  CONSTRAINT ar_disputes_resolved_pair CHECK ((status = 'open') = (resolved_at IS NULL))
);
CREATE INDEX IF NOT EXISTS ar_disputes_lease_status_idx ON ar_disputes (lease_id, status);

ALTER TABLE promises_to_pay ENABLE ROW LEVEL SECURITY;
ALTER TABLE ar_disputes ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE promises_to_pay IS 'Collections work log (B1): a tenant''s promise to pay an amount by a date. Admin-recorded; moves no money and is read by no billing, late-fee or balance code.';
COMMENT ON COLUMN promises_to_pay.status IS 'open | kept | broken | cancelled. "kept" is an admin judgement, not a payment application. Lapsed = open and promised_date passed (derived at read).';
COMMENT ON TABLE ar_disputes IS 'Collections work log (B1): a tenant dispute of all or part of a balance. Admin-recorded; does not pause late fees or change any balance.';
COMMENT ON COLUMN ar_disputes.amount IS 'Disputed amount when the tenant named one; NULL = unspecified.';
