-- Atomic CAM approval: approve_cam_reconciliation()
--
-- POST /api/cam/:id/approve (server/routes/cam.ts) posts a tenant's CAM true-up charge and marks the
-- reconciliation billed. Until now it did that in application code: an idempotency-keyed charges
-- INSERT, then a compare-and-swap status UPDATE, then compensation (approveLostRace, a credit-branch
-- re-check that put the row back to draft). Four REFUTE rounds on PR #72 (F1-F4) narrowed it but
-- left two paths open, because the insert and the status change were separate PostgREST calls:
--   * LOUD:   two overlapping approves plus a recalculation could end with the row billed as a
--             CREDIT while a +true-up charge from the earlier figures was live on the ledger.
--   * SILENT: the same, when the compensating write never ran: a cancelled request, a DB error
--             between the two calls, or a human deleting the charge mid-approve.
-- PostgREST runs each RPC in its own transaction, so the lock, the checks, the insert and the
-- status change must all live in ONE function (same reasoning as 0014's reserve_payment_intent).
--
-- What the function does, in one transaction:
--   1. SELECT the cam_reconciliations row FOR UPDATE. A concurrent approve of the same row waits
--      here and then sees it billed; a concurrent /calculate (UPDATE ... WHERE status = 'draft')
--      waits on the row lock and then matches zero rows (its existing 409 "already billed").
--   2. Require status = 'draft', a non-null share_basis (0021 / REFUTE H2), and true_up_amount and
--      share_basis equal to the figures the caller priced (the route's recompute-and-compare gate).
--   3. Look up the charge holding cam_true_up:<lease_id>:<year>, locking it FOR UPDATE so a
--      DELETE /charges/:id cannot remove it between this check and the commit:
--        live cam_true_up for this lease, amount = a POSITIVE true-up  -> already posted, bill it
--        live, any other amount, or the draft is a credit / balanced   -> refuse (live_mismatch)
--        voided                                                        -> refuse (voided)
--        another type or another lease (POST /charges takes a client
--        supplied idempotency_key)                                     -> refuse (foreign)
--        absent                                                        -> continue
--   4. INSERT the charge only for a positive true-up. ON CONFLICT DO NOTHING: a key holder that
--      committed after step 3 (only a manual POST /charges can create one; every approve is
--      serialized by step 1) is re-read and classified exactly as in step 3, never billed over.
--   5. Set the row billed (credits get the Phase 1 "handle manually" note; a balanced draft is NOT
--      billed, matching the route's existing "No true-up required" answer).
-- Any error raised anywhere rolls back the whole transaction: there is no state in which a charge
-- is posted and the row is not billed, or the row is billed against a different charge.
--
-- Returns jsonb {outcome, ...}. outcome is one of:
--   billed          positive true-up; inserted = true when this call posted the charge, false when
--                   a live equal charge was already posted (crash recovery for rows left by the old
--                   two-call code path)
--   billed_credit   negative true-up; nothing posted, row billed with the manual-credit note
--   balanced        zero true-up, nothing posted, nothing changed
--   not_found       no reconciliation with that id
--   not_draft       status is billed/collected            (+ status)
--   no_basis        draft has no share_basis             (+ status)
--   changed         true_up_amount / share_basis differ from what the caller priced
--                   (+ true_up_amount, share_basis: the row's current values)
--   live_mismatch   a live true-up charge holds the key and does not match the draft (+ charge_amount)
--   voided          a voided charge holds the key
--   foreign         a charge of another type or lease holds the key
--
-- Other writers of cam_true_up charges: none. This function is the only path that creates one.
-- POST /charges (server/routes/charges.ts) refuses type 'cam_true_up' and any idempotency_key that
-- starts with 'cam_true_up:', because a hand-posted true-up is invisible to step 3 (approving the
-- draft would post a second true-up, or bill a credit while it is live) and a reserved key would
-- block the real one. That guard also closes the one window step 1 cannot: for a credit or balanced
-- draft nothing is inserted, so an outside insert of the reserved key between step 3 and the commit
-- would go unseen. Deploy the route and this migration together (see DEPLOY ORDER).
--
-- SECURITY INVOKER (the default): the only caller is the service-role client, which bypasses RLS
-- already; DEFINER would add an escalation surface for nothing. EXECUTE is revoked from PUBLIC/anon/
-- authenticated (anon/authenticated keys ship in the browser bundle and can reach /rpc).
--
-- PRE-FLIGHT (live DB, before applying): none required. The function is new; CREATE OR REPLACE on a
-- name that did not exist. Check:   SELECT proname FROM pg_proc WHERE proname = 'approve_cam_reconciliation';
-- (zero rows expected on first apply; one row on a re-paste, which this file handles).
-- DATA CHECK (must return zero rows): live true-ups not held under the exact key this function would
-- use for their lease/year. They predate the POST /charges guard and are invisible to step 3, so
-- approving that lease/year would post a second true-up (or bill a credit while it is live):
--   SELECT id, lease_id, period_start, amount FROM charges
--   WHERE type = 'cam_true_up' AND voided_at IS NULL
--     AND idempotency_key IS DISTINCT FROM
--         'cam_true_up:' || lease_id::text || ':' || extract(year FROM period_start)::int::text;
-- For each row: void it, or confirm no draft for that lease/year will be approved, before approving
-- CAM for that lease (same rule as supabase/migrations/README.md).
--
-- DEPLOY ORDER: apply this migration BEFORE deploying the route that calls it. The new route calls
-- the function unconditionally and fails closed (500, nothing posted) if it does not exist.
--
-- RE-RUNNABLE: CREATE OR REPLACE + REVOKE/GRANT are idempotent.

CREATE OR REPLACE FUNCTION approve_cam_reconciliation(
  p_id UUID,
  p_true_up_amount NUMERIC,
  p_share_basis TEXT,
  p_today DATE
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_rec cam_reconciliations%ROWTYPE;
  v_key TEXT;
  v_charge charges%ROWTYPE;
  v_inserted_id UUID;
  v_attempt INT;
BEGIN
  IF p_id IS NULL OR p_true_up_amount IS NULL OR p_share_basis IS NULL OR p_today IS NULL THEN
    RAISE EXCEPTION 'approve_cam_reconciliation: p_id, p_true_up_amount, p_share_basis and p_today are required';
  END IF;

  -- (1) Lock the reconciliation row for the rest of the transaction.
  SELECT * INTO v_rec FROM cam_reconciliations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  -- (2) Only a priced, unchanged draft may be approved.
  IF v_rec.status <> 'draft' THEN
    RETURN jsonb_build_object('outcome', 'not_draft', 'status', v_rec.status);
  END IF;
  IF v_rec.share_basis IS NULL THEN
    RETURN jsonb_build_object('outcome', 'no_basis', 'status', v_rec.status);
  END IF;
  IF v_rec.true_up_amount IS DISTINCT FROM p_true_up_amount OR v_rec.share_basis IS DISTINCT FROM p_share_basis THEN
    RETURN jsonb_build_object(
      'outcome', 'changed',
      'true_up_amount', v_rec.true_up_amount,
      'share_basis', v_rec.share_basis
    );
  END IF;

  v_key := 'cam_true_up:' || v_rec.lease_id::text || ':' || v_rec.reconciliation_year::text;

  -- (3)+(4) Classify the key holder; insert only for a positive true-up with no holder. The loop
  -- runs at most twice: the second pass re-reads a holder that committed between the first
  -- pass's lookup and the INSERT (ON CONFLICT DO NOTHING inserted nothing).
  FOR v_attempt IN 1..2 LOOP
    SELECT * INTO v_charge FROM charges WHERE idempotency_key = v_key FOR UPDATE;
    IF FOUND THEN
      IF v_charge.type <> 'cam_true_up' OR v_charge.lease_id <> v_rec.lease_id THEN
        RETURN jsonb_build_object('outcome', 'foreign');
      END IF;
      IF v_charge.voided_at IS NOT NULL THEN
        RETURN jsonb_build_object('outcome', 'voided');
      END IF;
      IF NOT (v_rec.true_up_amount > 0 AND v_charge.amount = v_rec.true_up_amount) THEN
        RETURN jsonb_build_object('outcome', 'live_mismatch', 'charge_amount', v_charge.amount, 'true_up_amount', v_rec.true_up_amount);
      END IF;
      -- Live and equal: already posted (rows left mid-approve by the pre-0022 code). Bill it.
      UPDATE cam_reconciliations SET status = 'billed', billed_date = p_today WHERE id = p_id;
      RETURN jsonb_build_object('outcome', 'billed', 'inserted', false, 'true_up_amount', v_rec.true_up_amount);
    END IF;

    -- No holder.
    IF v_rec.true_up_amount = 0 THEN
      RETURN jsonb_build_object('outcome', 'balanced');
    END IF;
    IF v_rec.true_up_amount < 0 THEN
      -- Phase 1 limitation (charges.amount CHECK >= 0; ar_ledger treats a charge as a debit):
      -- credits are not posted, only flagged on the row for manual handling.
      UPDATE cam_reconciliations
         SET status = 'billed', billed_date = p_today,
             notes = 'Credit of ' || to_char(abs(v_rec.true_up_amount), 'FM999999999990.00')
                     || ' owed to tenant — handle manually (Phase 1 limitation)'
       WHERE id = p_id;
      RETURN jsonb_build_object('outcome', 'billed_credit', 'true_up_amount', v_rec.true_up_amount);
    END IF;

    INSERT INTO charges (lease_id, charge_date, due_date, period_start, period_end, type, amount, description, source, idempotency_key)
    VALUES (
      v_rec.lease_id, p_today, p_today,
      make_date(v_rec.reconciliation_year, 1, 1), make_date(v_rec.reconciliation_year, 12, 31),
      'cam_true_up', v_rec.true_up_amount, v_rec.reconciliation_year::text || ' CAM True-Up', 'manual', v_key
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_inserted_id;

    IF v_inserted_id IS NOT NULL THEN
      UPDATE cam_reconciliations SET status = 'billed', billed_date = p_today WHERE id = p_id;
      RETURN jsonb_build_object('outcome', 'billed', 'inserted', true, 'charge_id', v_inserted_id, 'true_up_amount', v_rec.true_up_amount);
    END IF;
    -- Conflict: a holder committed after the lookup above. Loop once to classify it.
  END LOOP;

  -- The INSERT conflicted on both passes: a holder committed, was deleted before the second lookup,
  -- and another holder committed before the second INSERT. Never guess: fail the whole
  -- transaction, nothing posted, row unchanged (the route answers 500).
  RAISE EXCEPTION 'approve_cam_reconciliation: true-up key % conflicted but no holder could be read', v_key;
END;
$$;

REVOKE EXECUTE ON FUNCTION approve_cam_reconciliation(UUID, NUMERIC, TEXT, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION approve_cam_reconciliation(UUID, NUMERIC, TEXT, DATE) TO service_role;

-- ---------------------------------------------------------------------------
-- Rollback (reference):
--   REVOKE EXECUTE ON FUNCTION approve_cam_reconciliation(UUID, NUMERIC, TEXT, DATE) FROM service_role;
--   DROP FUNCTION IF EXISTS approve_cam_reconciliation(UUID, NUMERIC, TEXT, DATE);
-- Roll back server/routes/cam.ts in the same deploy: the route calls this function unconditionally.
