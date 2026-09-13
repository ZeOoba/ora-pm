-- Payment-intent reservation row + per-lease serialization
-- (schema half of OI-065, OI-223, OI-233 — payment-intent hardening 2026-09)
--
-- Three defects in POST /api/stripe/payment-intent (server/routes/stripe.ts)
-- share one root cause: the ledger row was written AFTER Stripe confirmed
-- the ACH debit, and the outstanding-balance cap was evaluated from a view
-- that cannot see money already in flight.
--   OI-065  two concurrent requests for the same lease both read the same
--           ar_ledger.balance, both pass the cap, both mint a PaymentIntent
--           (distinct idempotency keys, so payments_stripe_pi_uniq never fires).
--   OI-223  ar_ledger only credits stripe_status = 'succeeded'; ACH sits in
--           'processing' for 3-5 business days, during which the full balance
--           still reads as owed and a second full payment passes the cap.
--   OI-233  if the post-confirm payments INSERT failed, the debit had no
--           ledger row at all — nothing to reconcile Stripe's dashboard against.
-- The fix moves the ledger write BEFORE the Stripe call (a 'pending'
-- reservation keyed by the client's request id) and moves the balance check
-- + reservation into one Postgres function that holds a per-lease advisory
-- lock for its duration. PostgREST runs every RPC call in its own
-- transaction and hands out no persistent connection, so a lock taken by a
-- separate "lock" call would be released before the balance read — the
-- lock, the read and the insert MUST live in the same function.
--
-- PRE-FLIGHT (run against the LIVE database BEFORE applying; checks 1-2 must
-- return zero rows — if either returns rows, STOP and investigate, do not
-- apply; check 3 is informational):
--
--   1. 0014 not already partially applied (column would make ADD COLUMN fail
--      and CREATE OR REPLACE FUNCTION would silently overwrite):
--        SELECT column_name FROM information_schema.columns
--        WHERE table_schema = 'public' AND table_name = 'payments'
--          AND column_name = 'client_request_id';
--        SELECT proname FROM pg_proc WHERE proname = 'reserve_payment_intent';
--
--   2. Every ach_stripe row has a stripe_status the in-flight filter below
--      understands (any other value is a data-quality problem that would be
--      silently treated as "not in flight"):
--        SELECT DISTINCT stripe_status FROM payments
--        WHERE method = 'ach_stripe'
--          AND stripe_status NOT IN ('pending','processing','succeeded','failed','returned',
--                                    'requires_payment_method','requires_action','canceled');
--
--   3. Rows currently in flight — these start counting against the
--      outstanding-balance cap the moment this migration applies, which is the
--      intended OI-223 behavior, but know the number before flipping it:
--        SELECT lease_id, count(*), sum(amount) FROM payments
--        WHERE method = 'ach_stripe' AND stripe_status IN ('pending','processing')
--        GROUP BY 1;

-- ---------------------------------------------------------------------------
-- 1) payments.client_request_id: the client's per-attempt UUID (already sent
--    by src/portal/pages/PortalPayNow.tsx and already the tail of the Stripe
--    idempotency key `pi:<tenantId>:<client_request_id>`, OI-035) becomes the
--    ledger row's identity from BEFORE the Stripe call. NULL for every row
--    that is not a portal payment-intent (checks, wires, cron.ts autopay).
--    The partial UNIQUE index is what serializes a genuine double-submit of
--    the same attempt: the second INSERT collides instead of both proceeding
--    to Stripe.
ALTER TABLE payments ADD COLUMN client_request_id UUID;
COMMENT ON COLUMN payments.client_request_id IS 'Portal payment-intent attempt id (OI-035 client_request_id); reservation key written BEFORE the Stripe call. NULL for non-portal rows.';

CREATE UNIQUE INDEX payments_client_request_id_uniq
  ON payments(client_request_id)
  WHERE client_request_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2) reserve_payment_intent(): the whole reserve step in ONE transaction.
--
--    Order matters and is pinned by tests/db/payment-intent-migration-0014.test.ts:
--      a. pg_advisory_xact_lock keyed by the lease — every concurrent caller
--         for the same lease queues here and, when it proceeds, sees the
--         previous caller's committed reservation (OI-065). Keyed per lease,
--         not global, so tenants never queue behind each other.
--      b. same client_request_id already reserved → return that row's state
--         ('existing') and write nothing; the route decides whether that is a
--         dedupe (PI already recorded), an in-flight duplicate, or a resume.
--      c. ar_ledger.balance (unchanged view — still 'succeeded'-only; other
--         readers depend on that definition) MINUS this lease's ach_stripe
--         rows in 'pending'/'processing' = what the tenant can still pay
--         (OI-223). A reservation whose Stripe call never completed is
--         'pending' with a NULL PI id and counts here deliberately: money MAY
--         have moved, so the safe failure direction is to refuse a second
--         payment until it is resolved (webhook fallback, same-id resume, or
--         a human), never to allow a double debit.
--      d. INSERT the 'pending' reservation with stripe_payment_intent_id NULL.
--         The PI id/status are written back by the route after Stripe
--         responds, or by the webhook (server/lib/stripe-events.ts) via the
--         client_request_id the route stamps into the PaymentIntent's
--         metadata, if the route's write-back failed (OI-233).
--
--    Returns jsonb (one object, never a set) so the caller gets a single
--    typed result through supabase-js .rpc():
--      {outcome:'reserved',        payment_id, outstanding_balance_cents, in_flight_cents, available_cents}
--      {outcome:'existing',        payment_id, stripe_payment_intent_id, stripe_status, amount_cents, age_seconds}
--      {outcome:'no_balance',      outstanding_balance_cents, in_flight_cents, available_cents}
--      {outcome:'exceeds_balance', outstanding_balance_cents, in_flight_cents, available_cents}
--
--    Amounts cross the boundary as integer cents (the API's unit) and are
--    stored as dollars (payments.amount NUMERIC(12,2), per 0011).
--    SECURITY INVOKER (the default): the only caller is the service-role
--    client (server/db/client.ts), which already bypasses RLS; a DEFINER
--    function would add a privilege-escalation surface for no benefit.
CREATE OR REPLACE FUNCTION reserve_payment_intent(
  p_lease_id UUID,
  p_client_request_id UUID,
  p_amount_cents BIGINT,
  p_notes TEXT DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_existing payments%ROWTYPE;
  v_balance_cents BIGINT;
  v_in_flight_cents BIGINT;
  v_available_cents BIGINT;
  v_id UUID;
BEGIN
  IF p_lease_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'reserve_payment_intent: p_lease_id and p_client_request_id are required';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'reserve_payment_intent: p_amount_cents must be a positive integer (got %)', p_amount_cents;
  END IF;

  -- (a) Serialize per lease for the rest of this transaction.
  PERFORM pg_advisory_xact_lock(hashtext(p_lease_id::text), hashtext('reserve_payment_intent'));

  -- (b) Same attempt already reserved?
  SELECT * INTO v_existing FROM payments WHERE client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.lease_id <> p_lease_id THEN
      RAISE EXCEPTION 'reserve_payment_intent: client_request_id % was already used for lease %',
        p_client_request_id, v_existing.lease_id
        USING ERRCODE = 'unique_violation';
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'existing',
      'payment_id', v_existing.id,
      'stripe_payment_intent_id', v_existing.stripe_payment_intent_id,
      'stripe_status', v_existing.stripe_status,
      'amount_cents', round(v_existing.amount * 100)::bigint,
      'age_seconds', floor(extract(epoch FROM (now() - v_existing.created_at)))::bigint
    );
  END IF;

  -- (c) What can still be paid: ar_ledger balance minus in-flight ACH.
  SELECT round(COALESCE(l.balance, 0) * 100)::bigint
    INTO v_balance_cents
    FROM ar_ledger l
   WHERE l.lease_id = p_lease_id;
  v_balance_cents := COALESCE(v_balance_cents, 0);

  SELECT round(COALESCE(SUM(p.amount), 0) * 100)::bigint
    INTO v_in_flight_cents
    FROM payments p
   WHERE p.lease_id = p_lease_id
     AND p.method = 'ach_stripe'
     AND p.stripe_status IN ('pending', 'processing');

  v_available_cents := v_balance_cents - v_in_flight_cents;

  IF v_balance_cents <= 0 THEN
    RETURN jsonb_build_object(
      'outcome', 'no_balance',
      'outstanding_balance_cents', v_balance_cents,
      'in_flight_cents', v_in_flight_cents,
      'available_cents', v_available_cents
    );
  END IF;
  IF p_amount_cents > v_available_cents THEN
    RETURN jsonb_build_object(
      'outcome', 'exceeds_balance',
      'outstanding_balance_cents', v_balance_cents,
      'in_flight_cents', v_in_flight_cents,
      'available_cents', v_available_cents
    );
  END IF;

  -- (d) Reserve. stripe_payment_intent_id stays NULL until Stripe answers.
  INSERT INTO payments (lease_id, payment_date, amount, method, stripe_payment_intent_id, stripe_status, notes, client_request_id)
  VALUES (p_lease_id, CURRENT_DATE, p_amount_cents / 100.0, 'ach_stripe', NULL, 'pending', p_notes, p_client_request_id)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'outcome', 'reserved',
    'payment_id', v_id,
    'outstanding_balance_cents', v_balance_cents,
    'in_flight_cents', v_in_flight_cents,
    'available_cents', v_available_cents
  );
END;
$$;

-- Service-role only. The function reads ar_ledger across tenants and writes
-- payments; the anon/authenticated keys ship in the client bundle and must
-- not be able to reach it through PostgREST /rpc (same default-deny stance
-- as 0013). Stock Supabase grants EXECUTE to PUBLIC on new functions.
REVOKE EXECUTE ON FUNCTION reserve_payment_intent(UUID, UUID, BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reserve_payment_intent(UUID, UUID, BIGINT, TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- Reconciliation query (reference) — reservations whose Stripe call never
-- got written back. Each is a client_request_id that appears in Stripe as
-- metadata.client_request_id on at most one PaymentIntent (Dashboard →
-- Payments → search "metadata:client_request_id=<uuid>"). Older than an hour
-- means the route's write-back AND the webhook fallback both missed it:
--   SELECT id, lease_id, amount, client_request_id, created_at
--   FROM payments
--   WHERE method = 'ach_stripe' AND stripe_status = 'pending'
--     AND stripe_payment_intent_id IS NULL
--     AND created_at < now() - interval '1 hour'
--   ORDER BY created_at;
--
-- ---------------------------------------------------------------------------
-- Rollback (reference):
--   REVOKE EXECUTE ON FUNCTION reserve_payment_intent(UUID, UUID, BIGINT, TEXT) FROM service_role;
--   DROP FUNCTION IF EXISTS reserve_payment_intent(UUID, UUID, BIGINT, TEXT);
--   DROP INDEX IF EXISTS payments_client_request_id_uniq;
--   ALTER TABLE payments DROP COLUMN client_request_id;
-- Rolling back the schema also requires rolling back server/routes/stripe.ts
-- to the insert-after-Stripe code path in the same deploy — the new route
-- calls the function unconditionally and fails closed (500, no Stripe call)
-- without it. Dropping the column discards the reservation keys of any rows
-- still 'pending' with a NULL PI id; run the reconciliation query above and
-- resolve them FIRST, or they become untraceable.
