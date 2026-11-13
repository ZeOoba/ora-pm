-- Autopay reservation row under the per-lease payment lock
-- (2026-11-12 audit finding 1: autopay-ignores-inflight-portal-ach)
--
-- POST /api/cron/monthly-billing (server/routes/cron.ts) computed each autopay
-- debit as min(period charges − period paid, ar_ledger.balance). Both terms
-- count ACH only once it is 'succeeded', and the cron never took the
-- per-lease lock reserve_payment_intent() (0014) takes. A tenant who paid the
-- period's rent in the portal on the 1st — ACH 'processing' for 3-5 business
-- days — was therefore debited the same rent AGAIN by a later drain
-- invocation. In the other direction, the cron wrote its payments row only
-- AFTER the Stripe call, so a portal payment made while an autopay debit was
-- in flight could not see it either.
--
-- reserve_autopay_payment() moves the autopay amount decision and the ledger
-- write into ONE transaction under the SAME advisory lock key as
-- reserve_payment_intent(), and writes the row BEFORE the Stripe call (same
-- pattern as 0014). Both functions now see each other's in-flight rows:
--   - the autopay amount subtracts in-period pending/processing ACH from the
--     period outstanding, and ALL pending/processing ACH from the balance cap;
--   - the portal cap (0014 step c) already subtracts every pending/processing
--     ach_stripe row, which now includes an autopay reservation.
--
-- PRE-FLIGHT (run against the LIVE database BEFORE applying; must return zero
-- rows — if it returns rows, STOP and investigate, do not apply):
--   SELECT proname FROM pg_proc WHERE proname = 'reserve_autopay_payment';
--
-- Additive: one function, no table or view changes. Apply BEFORE deploying the
-- cron.ts change that calls it — until then the RPC errors and the cron fails
-- closed (no debit, autopayErrors), never debits blind.

-- ---------------------------------------------------------------------------
-- reserve_autopay_payment(): one call per lease that the cron's bulk
-- pre-filter says may owe this period.
--
--   a. pg_advisory_xact_lock with EXACTLY the key reserve_payment_intent()
--      uses: (hashtext(lease_id), hashtext('reserve_payment_intent')). The
--      second component is a shared namespace, not this function's name —
--      changing it here would silently stop the two paths serializing.
--   b. A payments row for (lease, autopay_period) already exists → 'existing'
--      (a concurrent or earlier run reserved this period). Nothing written.
--   c. Recompute the debit from committed state, under the lock:
--        period_charges    non-voided charges due within [period_start, period_end]
--        period_paid       payments dated in the period that count as paid
--                          (check/wire/other, or ach_stripe 'succeeded' — the
--                          ar_ledger rule, 0016)
--        period_in_flight  ach_stripe 'pending'/'processing' dated in the period
--          (both period terms skip a row stamped for ANOTHER autopay_period: a catch-up run
--           of last month's autopay dated in this month pays last month, not this one)
--        balance           ar_ledger.balance (includes a live balance forward, 0030)
--        in_flight         ALL ach_stripe 'pending'/'processing' for the lease
--      amount = LEAST(period_charges − period_paid − period_in_flight,
--                     balance − in_flight)
--      Autopay may collect only THIS period's charges (never sweep older
--      arrears) and never more than the tenant still owes once money already
--      moving is counted.
--      Before c, under a FOR SHARE lock on the lease row (serializes with
--      apply_balance_forwards, 0030): a live balance forward whose as_of is on or
--      after p_period_start → 'nothing_due' (reason balance_forward_covers_period);
--      otherwise period charges dated on or before its as_of are left out (they are
--      inside the QuickBooks figure).
--   d. amount <= 0 → 'nothing_due'. Nothing written.
--   e. INSERT the reservation: 'pending', PI id NULL, autopay_period stamped
--      (payments_autopay_period_uniq, 0011, is the second line of defence),
--      client_request_id = gen_random_uuid(). The cron stamps it into the
--      PaymentIntent's metadata (the webhook's client_request_id fallback,
--      server/lib/stripe-events.ts OI-233, completes the row if the cron's
--      write-back is lost) and into the Stripe idempotency key, so each
--      reservation is its own Stripe request: a reservation released after a
--      definitive failure never makes a later one replay that failure.
--
--   If this function commits but its response is lost, the row stays 'pending'
--   with no PaymentIntent and blocks the period (fails closed, no debit). It
--   shows up in the reconciliation query below; there is no automatic resume.
--
--   Returns one jsonb object:
--     {outcome:'reserved',    payment_id, client_request_id, amount_cents, period_charges_cents,
--                             period_paid_cents, period_in_flight_cents, balance_cents, in_flight_cents}
--     {outcome:'existing',    payment_id, stripe_payment_intent_id, stripe_status, amount_cents}
--     {outcome:'nothing_due', period_charges_cents, period_paid_cents, period_in_flight_cents,
--                             balance_cents, in_flight_cents}
--
--   Amounts are summed in dollars (NUMERIC) and converted to integer cents
--   once per term, the same rounding 0014 uses.
--
--   SECURITY INVOKER (default): called only by the service-role client, which
--   bypasses RLS. Same grant stance as 0014.
CREATE OR REPLACE FUNCTION reserve_autopay_payment(
  p_lease_id UUID,
  p_period_start DATE,
  p_period_end DATE,
  p_payment_date DATE,
  p_notes TEXT DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_existing payments%ROWTYPE;
  v_bf_as_of DATE;
  v_period_charges_cents BIGINT;
  v_period_paid_cents BIGINT;
  v_period_in_flight_cents BIGINT;
  v_balance_cents BIGINT;
  v_in_flight_cents BIGINT;
  v_amount_cents BIGINT;
  v_request_id UUID;
  v_id UUID;
BEGIN
  IF p_lease_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL OR p_payment_date IS NULL THEN
    RAISE EXCEPTION 'reserve_autopay_payment: p_lease_id, p_period_start, p_period_end and p_payment_date are required';
  END IF;
  IF p_period_end < p_period_start THEN
    RAISE EXCEPTION 'reserve_autopay_payment: p_period_end (%) is before p_period_start (%)', p_period_end, p_period_start;
  END IF;

  -- (a) Same lock as reserve_payment_intent() — see header.
  PERFORM pg_advisory_xact_lock(hashtext(p_lease_id::text), hashtext('reserve_payment_intent'));

  -- (b) This period already reserved / collected?
  SELECT * INTO v_existing FROM payments
   WHERE lease_id = p_lease_id AND autopay_period = p_period_start;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'outcome', 'existing',
      'payment_id', v_existing.id,
      'stripe_payment_intent_id', v_existing.stripe_payment_intent_id,
      'stripe_status', v_existing.stripe_status,
      'amount_cents', round(v_existing.amount * 100)::bigint
    );
  END IF;

  -- (b2) Balance forward from QuickBooks (0030). Lock the lease row FOR SHARE — the row
  --      apply_balance_forwards() locks FOR UPDATE — so a balance forward cannot be applied between
  --      this check and the reservation. A live one whose as_of reaches this period means the app
  --      cannot see what was paid for the month in QuickBooks: no autopay for it (same policy as the
  --      cron's #99 pre-filter, re-checked here under the lock).
  PERFORM 1 FROM leases WHERE id = p_lease_id FOR SHARE;
  SELECT max(bf.as_of) INTO v_bf_as_of
    FROM balance_forwards bf
   WHERE bf.lease_id = p_lease_id AND bf.voided_at IS NULL;
  IF v_bf_as_of IS NOT NULL AND v_bf_as_of >= p_period_start THEN
    RETURN jsonb_build_object('outcome', 'nothing_due', 'reason', 'balance_forward_covers_period', 'balance_forward_as_of', v_bf_as_of);
  END IF;

  -- (c) Recompute under the lock. A charge dated on or before a live balance forward's as_of is
  --     inside the QuickBooks figure (already in ar_ledger.balance), so it never counts as this
  --     period's charge even if it falls due in the period.
  SELECT round(COALESCE(SUM(c.amount), 0) * 100)::bigint
    INTO v_period_charges_cents
    FROM charges c
   WHERE c.lease_id = p_lease_id
     AND c.voided_at IS NULL
     AND c.due_date BETWEEN p_period_start AND p_period_end
     AND (v_bf_as_of IS NULL OR c.charge_date > v_bf_as_of);

  SELECT round(COALESCE(SUM(p.amount), 0) * 100)::bigint
    INTO v_period_paid_cents
    FROM payments p
   WHERE p.lease_id = p_lease_id
     AND p.payment_date BETWEEN p_period_start AND p_period_end
     AND (p.autopay_period IS NULL OR p.autopay_period = p_period_start)
     AND ((p.method = 'ach_stripe' AND p.stripe_status = 'succeeded')
          OR p.method IN ('check', 'wire', 'other'));

  SELECT round(COALESCE(SUM(p.amount), 0) * 100)::bigint
    INTO v_period_in_flight_cents
    FROM payments p
   WHERE p.lease_id = p_lease_id
     AND p.payment_date BETWEEN p_period_start AND p_period_end
     AND (p.autopay_period IS NULL OR p.autopay_period = p_period_start)
     AND p.method = 'ach_stripe'
     AND p.stripe_status IN ('pending', 'processing');

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

  v_amount_cents := LEAST(
    v_period_charges_cents - v_period_paid_cents - v_period_in_flight_cents,
    v_balance_cents - v_in_flight_cents
  );

  -- (d)
  IF v_amount_cents <= 0 THEN
    RETURN jsonb_build_object(
      'outcome', 'nothing_due',
      'period_charges_cents', v_period_charges_cents,
      'period_paid_cents', v_period_paid_cents,
      'period_in_flight_cents', v_period_in_flight_cents,
      'balance_cents', v_balance_cents,
      'in_flight_cents', v_in_flight_cents
    );
  END IF;

  -- (e) Reserve. stripe_payment_intent_id stays NULL until Stripe answers.
  v_request_id := gen_random_uuid();
  INSERT INTO payments (lease_id, payment_date, amount, method, stripe_payment_intent_id, stripe_status,
                        notes, autopay_period, client_request_id)
  VALUES (p_lease_id, p_payment_date, v_amount_cents / 100.0, 'ach_stripe', NULL, 'pending',
          p_notes, p_period_start, v_request_id)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'outcome', 'reserved',
    'payment_id', v_id,
    'client_request_id', v_request_id,
    'amount_cents', v_amount_cents,
    'period_charges_cents', v_period_charges_cents,
    'period_paid_cents', v_period_paid_cents,
    'period_in_flight_cents', v_period_in_flight_cents,
    'balance_cents', v_balance_cents,
    'in_flight_cents', v_in_flight_cents
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION reserve_autopay_payment(UUID, DATE, DATE, DATE, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reserve_autopay_payment(UUID, DATE, DATE, DATE, TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- Reconciliation (reference): autopay reservations whose Stripe call never got
-- written back. Each has metadata.client_request_id on at most one Stripe
-- PaymentIntent (Dashboard → Payments → search "metadata:client_request_id=<uuid>").
--   SELECT id, lease_id, amount, autopay_period, client_request_id, created_at
--   FROM payments
--   WHERE autopay_period IS NOT NULL AND method = 'ach_stripe'
--     AND stripe_status = 'pending' AND stripe_payment_intent_id IS NULL
--     AND created_at < now() - interval '1 hour'
--   ORDER BY created_at;
--
-- Rollback (reference):
--   REVOKE EXECUTE ON FUNCTION reserve_autopay_payment(UUID, DATE, DATE, DATE, TEXT) FROM service_role;
--   DROP FUNCTION IF EXISTS reserve_autopay_payment(UUID, DATE, DATE, DATE, TEXT);
