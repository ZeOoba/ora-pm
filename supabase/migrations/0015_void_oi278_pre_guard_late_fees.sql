-- OI-278 (data half): void the 103 auto late fees posted BEFORE the payments-
-- feed guard, per Gabriel's ruling 2026-09-13. Requires 0014_charges_void.sql.
--
-- Verified read-only census of production `charges` (2026-09-13):
--   type='late_fee' AND source='auto'  -> 103 rows, all amount 50.00,
--   SUM(amount) = 5,150.00, 68 distinct leases, idempotency_key
--   late_fee_<lease>_<year>_<month>; created_at 08-04 (23), 08-05 (1),
--   08-22 (11), 09-02 (35), 09-07 (33); max created_at 2026-09-07T16:19:30Z.
--   `payments` has 0 rows ever, so every delinquency those fees were based on
--   was an artifact of an empty payments feed.
--
-- Population predicate: auto late fees, not already voided, created before
-- the guard went live (2026-09-12T00:00:00Z, ora-pm PR #26 / fa72f52). The
-- created_at bound is what keeps a fee the GUARDED endpoint legitimately posts
-- later out of this sweep; `voided_at IS NULL` keeps already-voided rows out.
--
-- FAIL CLOSED: the DO block counts and sums the population BEFORE updating and
-- RAISEs (aborting the transaction — nothing is voided) unless it is EXACTLY
-- 103 rows / 5,150.00. Any drift between the census and apply time means the
-- predicate no longer describes the ruled population and a human must re-census
-- before this runs. The row count of the UPDATE and the post-void population are
-- asserted the same way.
--
-- REPLAYABLE (PR #42 refute): `supabase db push` applies every untracked
-- migration in order, `db reset` / a branch DB / a fresh project replay all of
-- them, and a Dashboard paste can be repeated — on none of those is the table
-- at census state. Exactly two count=0 shapes are benign and RETURN with a
-- NOTICE instead of blocking every later migration:
--   * 0 to void AND exactly 103 rows already carry the OI-278 void_reason
--       -> already applied on this database
--   * 0 to void AND 0 rows carry that reason
--       -> a database with no pre-guard late fees at all (fresh / non-prod)
-- ANY other count/sum combination (a partial prior void, drift, a fee posted
-- into the window later) still RAISEs. The real production apply is the
-- exact-103 path below, unchanged.
--
-- No DELETE anywhere in this file — void, never delete (audit trail, reversible).

DO $$
DECLARE
  v_count   BIGINT;
  v_sum     NUMERIC(12,2);
  v_already BIGINT;
  v_updated BIGINT;
  v_voided  BIGINT;
BEGIN
  SELECT count(*), COALESCE(SUM(amount), 0)
    INTO v_count, v_sum
    FROM charges
   WHERE type = 'late_fee' AND source = 'auto' AND voided_at IS NULL AND created_at < '2026-09-12T00:00:00Z';

  SELECT count(*)
    INTO v_already
    FROM charges
   WHERE void_reason = 'OI-278: posted while payments feed absent (payments table empty); voided per Gabriel ruling 2026-09-13';

  IF v_count = 0 AND v_already = 103 THEN
    RAISE NOTICE 'OI-278 void already applied on this database (103 rows carry the OI-278 void_reason); nothing to do';
    RETURN;
  END IF;

  IF v_count = 0 AND v_already = 0 THEN
    RAISE NOTICE 'OI-278: no pre-guard late fees present; nothing to void';
    RETURN;
  END IF;

  IF v_count <> 103 OR v_sum <> 5150.00 THEN
    RAISE EXCEPTION 'OI-278 void aborted: target population drifted from the 2026-09-13 census (expected 103 rows / 5150.00, found v_count=% / v_sum=%) — re-census before applying', v_count, v_sum;
  END IF;

  UPDATE charges
     SET voided_at = now(),
         void_reason = 'OI-278: posted while payments feed absent (payments table empty); voided per Gabriel ruling 2026-09-13'
   WHERE type = 'late_fee' AND source = 'auto' AND voided_at IS NULL AND created_at < '2026-09-12T00:00:00Z';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 103 THEN
    RAISE EXCEPTION 'OI-278 void aborted: UPDATE touched % rows, expected 103', v_updated;
  END IF;

  SELECT count(*)
    INTO v_voided
    FROM charges
   WHERE void_reason = 'OI-278: posted while payments feed absent (payments table empty); voided per Gabriel ruling 2026-09-13';

  IF v_voided <> 103 THEN
    RAISE EXCEPTION 'OI-278 void aborted: post-void population is % rows, expected 103', v_voided;
  END IF;
END
$$;

-- POST-APPLY VERIFICATION (run against the live database right after apply):
--   -- 1) No live late fee at all at apply time (the guarded endpoint has posted
--   --    none since 2026-09-12 and the payments feed is still absent):
--   SELECT count(*) FROM charges WHERE type = 'late_fee' AND voided_at IS NULL;   -- expect 0
--   -- 2) Exactly the ruled population voided under the exact reason:
--   SELECT count(*), SUM(amount) FROM charges
--    WHERE void_reason = 'OI-278: posted while payments feed absent (payments table empty); voided per Gabriel ruling 2026-09-13';   -- expect 103 | 5150.00
--   -- 3) No auto late fee from the pre-guard window is still live:
--   SELECT count(*) FROM charges
--    WHERE type = 'late_fee' AND source = 'auto' AND voided_at IS NULL AND created_at < '2026-09-12T00:00:00Z';   -- expect 0
--   -- 4) ar_ledger no longer carries the $5,150:
--   SELECT SUM(total_charged) FROM ar_ledger;   -- 5,150.00 lower than before apply

-- ---------------------------------------------------------------------------
-- Rollback (reference) — un-voids ONLY the rows this migration voided, keyed
-- on the exact void_reason string so a void applied for any other reason is
-- left alone. Both columns go back to NULL together (0014's pair CHECK).
--   UPDATE charges SET voided_at = NULL, void_reason = NULL
--    WHERE void_reason = 'OI-278: posted while payments feed absent (payments table empty); voided per Gabriel ruling 2026-09-13';
