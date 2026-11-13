-- 0032: B8 — the native ledger counts balance forwards from QuickBooks (0030) instead of blocking
-- them. Ratified 2026-11-13:
--   * accrual LLCs: a balance forward dated on or before the tie-out date is part of the app's open
--     AR at the tie-out (signed); nothing posts for it afterwards (it is inside the opening AR);
--   * cash-basis LLCs: a positive balance forward is an old receivable that later cash pays, due on
--     its own as_of date, AFTER security deposits due that day and ahead of every other charge type;
--     the income goes to a new per-LLC role 'balance_forward', which defaults to the 'rent' account
--     when unmapped. A negative one is a credit already on account;
--   * a balance forward dated after the tie-out date (on or after the ledger start date) refuses the
--     tie-out until it is voided and re-imported as of the day before the start date or earlier.
--
-- Rules (0030's B4 — "no tie-out while a balance forward is live" — is replaced by B4' / BF7):
--   BF1 gl_ar_tieout_items gains kind 'balance_forward' (source_id = balance_forwards.id, cents =
--       its SIGNED amount; the only kind whose cents may be negative). gl_ar_tieout_source lists every
--       LIVE balance forward of the entity dated on or before the tie-out date, counted = true.
--   BF2 gl_ar_account(entity, 'balance_forward') falls back to the 'rent' mapping; with neither
--       mapped it raises. On a tied-out cash-basis LLC the role cannot be mapped afterwards (REFUTE-7
--       M4: a role's account never changes once money has moved through it).
--   BF3 gl_ar_cash_alloc: a counted positive balance forward is a pseudo-charge live from the start
--       (like a pre-start counted charge), due on its as_of, ordered after a security deposit due the
--       same day (priority 0, then the balance-forward flag) and before rent; its row carries
--       charge_id = balance_forwards.id and role 'balance_forward'. A counted negative one adds its
--       size to the lease's cash. Read from the tie-out snapshot only, never from the live row.
--       Leases with no counted balance forward allocate exactly as under 0029.
--   BF4 the tie-out totals: accrual open AR = counted charges − counted payments + counted balance
--       forwards (signed); cash tenant credits per lease = max(0, payments + |negative forwards| −
--       charges − positive forwards). Both the confirm and the commit-time re-check use the same
--       formulas; the cash re-check also asserts they equal the replay's starting credit (alloc seq 0).
--   BF5 a lease whose balance forward is counted is held in its LLC (gl_lease_ar_held, REFUTE-6 H4).
--   BF6 a balance forward counted in a tie-out can never be voided (the A6 analogue); together with
--       0030 B3 the lease's charges and payments dated on or before its as_of are then frozen for good.
--   BF7 (B4') a tie-out is refused while the entity has a live balance forward dated after the
--       tie-out date; new balance forwards for a tied-out LLC stay refused (apply_balance_forwards),
--       and so do moves of a lease with one into a tied-out LLC (0030 balance_forward_entity_move).
--   BF8 concurrency: confirm locks the gl_entities row FOR UPDATE (as before); apply and void lock it
--       FOR SHARE, so a void or an import either commits first and is read by the tie-out, or waits
--       and then meets the tie-out (and is refused).
--
-- REFUTE-9 (adversarial pass on this migration) added:
--   F1  a charge or payment dated on or before a lease's live balance forward is counted at the
--       tie-out by its CURRENT state (what balance_forward_app_cents measured when the forward was
--       made, frozen since by 0030 B3), not its state on the tie-out date: otherwise a charge voided,
--       or an ACH settled, between the tie-out date and the import is counted twice.
--   F2/F4/F5/F6  apply and void lock the lease, its unit and its property before resolving its
--       entity; a property/unit/lease move locks its OLD and NEW entity rows (FOR SHARE, id order),
--       so a move cannot interleave with a tie-out, an import or a void of the leases it carries.
--   F3  a BEFORE INSERT trigger on balance_forwards refuses a tied-out LLC (any writer, not only apply).
--   F7  void_balance_forward requires READ COMMITTED (a stale snapshot could miss the tie-out items).
--   F9  the history-freeze message (0030 B3) no longer advises voiding a forward the ledger counted.
--
-- REFUTE-10 (final adversarial round) added:
--   C1  a forward records, when it is inserted, the ids of the payments it counted
--       (balance_forwards.counted_payment_ids, computed by its insert trigger in the same statement
--       that re-checks app_balance). Inside a forward a payment counts iff its id is on that list:
--       nothing is inferred from its current status, so a dispute won (back to 'succeeded') or lost
--       (written as 'failed') after the import is counted exactly as the forward measured it.
--   C2  payment_status_history (append-only, written by a trigger on payments) records every
--       stripe_status a payment holds and when. Outside a forward an ACH counts on the tie-out date
--       by the status it held at the end of that day; only for history older than this migration
--       (one backfilled row: the status as of now) does it fall back to 0028's inference.
--   C3  an import refuses any ACH on or before its date whose status is not settled (anything but
--       succeeded, failed, returned, canceled, disputed), not only pending/processing/requires_action.
--   R1  every lock chain (apply, void, the insert trigger, a lease/unit move's old AND new chain) is
--       walked one table at a time — lease, then its unit, then that unit's property, then that
--       property's entity — each row locked FOR SHARE and read after the lock, never through a join.
--   G1  re-saving an existing balance_forward mapping on a tied-out cash LLC (an upsert) reaches the
--       usual cash rule (refused only if the account changes); only a first mapping is refused.
--
-- REFUTE-11 (re-check of REFUTE-10) added:
--   I1  the 0030 R1 idempotency-key shortcut locks the existing row instead of only seeing it, so a
--       key freed by a concurrent delete cannot carry a new row into a forward's frozen window.
--   G2  payment_status_history is written only by its trigger (service_role: SELECT only).
--   H1  a pre-0032 (backfilled) status set after the tie-out date that reads succeeded or failed
--       refuses the tie-out instead of guessing (production had no ACH payments when this shipped).
--   H2  history timestamps never go backwards for one payment (writers are ordered by its row lock).
--   D1  apply_balance_forwards locks all its leases in id order up front; billing sorts its bulk
--       charge upsert by lease, so the two cannot deadlock.
--
-- ORDERING: requires 0028, 0029, 0030. Re-runnable. Every function pins search_path = public, pg_temp.

-- ── BF1 / BF2: the new item kind and account role ──────────────────────────────────────────────
ALTER TABLE gl_ar_tieout_items DROP CONSTRAINT IF EXISTS gl_ar_tieout_items_kind_check;
ALTER TABLE gl_ar_tieout_items ADD CONSTRAINT gl_ar_tieout_items_kind_check CHECK (kind IN ('charge', 'payment', 'balance_forward'));
ALTER TABLE gl_ar_tieout_items DROP CONSTRAINT IF EXISTS gl_ar_tieout_items_cents_sign;
ALTER TABLE gl_ar_tieout_items ADD CONSTRAINT gl_ar_tieout_items_cents_sign
  CHECK (CASE kind WHEN 'balance_forward' THEN cents <> 0 ELSE cents >= 0 END);

ALTER TABLE gl_ar_accounts DROP CONSTRAINT IF EXISTS gl_ar_accounts_role_check;
ALTER TABLE gl_ar_accounts ADD CONSTRAINT gl_ar_accounts_role_check CHECK (role IN (
  'ar', 'undeposited_funds', 'prepaid_rent',
  'rent', 'cam_estimate', 'cam_true_up', 'late_fee', 'security_deposit',
  'utility_water', 'utility_gas', 'utility_electric', 'utility_other', 'percentage_rent', 'other',
  'balance_forward'));

CREATE INDEX IF NOT EXISTS balance_forwards_lease_idx ON balance_forwards (lease_id);

-- BF2: 'balance_forward' falls back to the 'rent' account when unmapped (the single resolver, so the
-- entry builder and the commit-time check can never disagree).
CREATE OR REPLACE FUNCTION gl_ar_account(p_entity_id UUID, p_role TEXT) RETURNS UUID
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE v UUID;
BEGIN
  SELECT account_id INTO v FROM gl_ar_accounts WHERE entity_id = p_entity_id AND role = p_role;
  IF v IS NULL AND p_role = 'balance_forward' THEN
    SELECT account_id INTO v FROM gl_ar_accounts WHERE entity_id = p_entity_id AND role = 'rent';
    IF v IS NULL THEN
      RAISE EXCEPTION 'gl: map an account to the balance_forward role (or the rent role, its default) before posting AR for this entity'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF v IS NULL THEN
    RAISE EXCEPTION 'gl: map an account to the % role before posting AR for this entity', p_role USING ERRCODE = 'check_violation';
  END IF;
  RETURN v;
END;
$$;

-- BF3: a balance forward shares the deposit's priority; gl_ar_cash_alloc orders it after a deposit
-- due the same day (its balance-forward flag sorts last within a priority) and before rent.
CREATE OR REPLACE FUNCTION gl_ar_cash_priority(p_type TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE p_type
    WHEN 'security_deposit' THEN 0 WHEN 'balance_forward' THEN 0 WHEN 'rent' THEN 1 WHEN 'cam_estimate' THEN 2 WHEN 'cam_true_up' THEN 3
    WHEN 'utility_water' THEN 4 WHEN 'utility_gas' THEN 5 WHEN 'utility_electric' THEN 6 WHEN 'utility_other' THEN 7
    WHEN 'percentage_rent' THEN 8 WHEN 'other' THEN 9 WHEN 'late_fee' THEN 10 ELSE 99 END
$$;

-- BF3: the counted balance forward joins the allocation (charge_id = balance_forwards.id when
-- role = 'balance_forward'). With none, the output is exactly 0029's.
CREATE OR REPLACE FUNCTION gl_ar_cash_alloc(p_lease_id UUID, p_seq BIGINT) RETURNS TABLE (charge_id UUID, role TEXT, cents BIGINT)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  WITH bf AS (
    -- BF3: counted balance forwards, from the tie-out snapshot (cents signed).
    SELECT b.id, b.as_of, i.cents
      FROM balance_forwards b
      JOIN gl_ar_tieout_items i ON i.kind = 'balance_forward' AND i.source_id = b.id AND i.counted
     WHERE b.lease_id = p_lease_id
  ), ch AS (
    SELECT c.id, c.type, c.due_date, gl_exact_cents(c.amount) AS amt,
           coalesce((SELECT e.alloc_date FROM gl_ar_cash_events e WHERE e.kind = 'charge' AND e.source_id = c.id AND e.seq <= p_seq),
                    CASE WHEN EXISTS (SELECT 1 FROM gl_ar_tieout_items i WHERE i.kind = 'charge' AND i.source_id = c.id AND i.counted)
                         THEN DATE '0001-01-01' END) AS live
      FROM charges c
     WHERE c.lease_id = p_lease_id
       AND NOT EXISTS (SELECT 1 FROM gl_ar_cash_events e WHERE e.kind = 'charge_void' AND e.source_id = c.id AND e.seq <= p_seq)
  ), live AS (
    SELECT ch.id, ch.type, ch.due_date, ch.amt, ch.live, false AS is_bf FROM ch WHERE ch.live IS NOT NULL
    UNION ALL
    SELECT bf.id, 'balance_forward'::text, bf.as_of, bf.cents, DATE '0001-01-01', true FROM bf WHERE bf.cents > 0
  ), cash AS (
    SELECT (coalesce(sum(gl_exact_cents(p.amount)), 0)
            + coalesce((SELECT sum(-bf.cents) FROM bf WHERE bf.cents < 0), 0))::bigint AS total
      FROM payments p
     WHERE p.lease_id = p_lease_id
       AND (EXISTS (SELECT 1 FROM gl_ar_tieout_items i WHERE i.kind = 'payment' AND i.source_id = p.id AND i.counted)
            OR EXISTS (SELECT 1 FROM gl_ar_cash_events e WHERE e.kind = 'payment' AND e.source_id = p.id AND e.seq <= p_seq))
       AND NOT EXISTS (SELECT 1 FROM gl_ar_cash_events e WHERE e.kind = 'payment_return' AND e.source_id = p.id AND e.seq <= p_seq)
  ), ord AS (
    SELECT live.id, live.type, live.amt,
           coalesce(sum(live.amt) OVER (ORDER BY live.live, live.due_date, gl_ar_cash_priority(live.type), live.is_bf, live.id
                                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)::bigint AS before
      FROM live
  )
  SELECT ord.id, ord.type, GREATEST(0, LEAST(ord.amt, (SELECT total FROM cash) - ord.before))::bigint FROM ord
  UNION ALL
  SELECT NULL::uuid, 'prepaid_rent', GREATEST(0, (SELECT total FROM cash) - coalesce((SELECT sum(amt) FROM live), 0))::bigint
$$;

-- ── REFUTE-10 C2: payment status history ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_status_history (
  id BIGSERIAL PRIMARY KEY,
  payment_id UUID NOT NULL,
  stripe_status TEXT,
  changed_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  backfilled BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS payment_status_history_payment_idx ON payment_status_history (payment_id, changed_at);
ALTER TABLE payment_status_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON payment_status_history FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE payment_status_history_id_seq FROM PUBLIC, anon, authenticated, service_role;
-- REFUTE-11 G2: the SECURITY DEFINER trigger is the only writer; service_role reads.
GRANT SELECT ON payment_status_history TO service_role;

-- Backfill once: one row per existing payment, its current status as of when it was set (a status
-- set before 0028 stamped changes counts from the beginning of time, as 0028 treats it).
DO $$ BEGIN
  INSERT INTO payment_status_history (payment_id, stripe_status, changed_at, backfilled)
  SELECT p.id, p.stripe_status, coalesce(p.status_changed_at, '-infinity'::timestamptz), true FROM payments p
   WHERE NOT EXISTS (SELECT 1 FROM payment_status_history h WHERE h.payment_id = p.id);
END $$;

CREATE OR REPLACE FUNCTION payment_status_history_record() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.stripe_status IS DISTINCT FROM OLD.stripe_status THEN
    -- REFUTE-11 H2: now() is the writer's transaction START; two writers of one payment are ordered
    -- by its row lock, so keep the history in that order (never earlier than the previous change).
    SELECT max(h.changed_at) INTO v_prev FROM payment_status_history h WHERE h.payment_id = NEW.id;
    INSERT INTO payment_status_history (payment_id, stripe_status, changed_at)
      VALUES (NEW.id, NEW.stripe_status, GREATEST(coalesce(NEW.status_changed_at, pg_catalog.now()), coalesce(v_prev, '-infinity'::timestamptz)));
  END IF;
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION payment_status_history_record() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS payment_status_history_record ON payments;
CREATE TRIGGER payment_status_history_record AFTER INSERT OR UPDATE OF stripe_status ON payments
  FOR EACH ROW EXECUTE FUNCTION payment_status_history_record();

CREATE OR REPLACE FUNCTION payment_status_history_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'gl: payment status history is append-only' USING ERRCODE = 'restrict_violation';
END $$;
REVOKE EXECUTE ON FUNCTION payment_status_history_immutable() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS payment_status_history_immutable ON payment_status_history;
CREATE TRIGGER payment_status_history_immutable BEFORE UPDATE OR DELETE ON payment_status_history
  FOR EACH ROW EXECUTE FUNCTION payment_status_history_immutable();
DROP TRIGGER IF EXISTS payment_status_history_no_truncate ON payment_status_history;
CREATE TRIGGER payment_status_history_no_truncate BEFORE TRUNCATE ON payment_status_history
  FOR EACH STATEMENT EXECUTE FUNCTION payment_status_history_immutable();

-- Was an ACH counted as received on p_as_of? By the status it held at the end of that day (the
-- latest recorded change on or before it). With no recorded status by then (history older than
-- 0032, or a payment entered later), 0028's inference applied to the FIRST status recorded after
-- p_as_of rather than the current one: returned or disputed mean it had cleared.
CREATE OR REPLACE FUNCTION gl_payment_counted_on(p_id UUID, p_method TEXT, p_status TEXT, p_changed_at TIMESTAMPTZ, p_as_of DATE) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status TEXT;
  v_backfilled BOOLEAN;
BEGIN
  IF p_method <> 'ach_stripe' THEN RETURN true; END IF;
  SELECT h.stripe_status INTO v_status FROM payment_status_history h
   WHERE h.payment_id = p_id AND gl_central_date(h.changed_at) <= p_as_of
   ORDER BY h.changed_at DESC, h.id DESC LIMIT 1;
  IF FOUND THEN RETURN coalesce(v_status = 'succeeded', false); END IF;
  SELECT h.stripe_status, h.backfilled INTO v_status, v_backfilled FROM payment_status_history h
   WHERE h.payment_id = p_id ORDER BY h.changed_at, h.id LIMIT 1;
  -- REFUTE-11 H1: a backfilled row set after p_as_of that reads succeeded or failed cannot say
  -- whether the ACH had cleared by then (settled late, or a dispute won/lost); refuse, never guess.
  IF FOUND AND v_backfilled AND v_status IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'gl: ACH payment % changed to "%" after %, before the ledger kept a status history; whether it had cleared by then is unknown. Confirm it in Stripe and post a manual journal entry, or contact support',
      p_id, v_status, p_as_of USING ERRCODE = 'check_violation';
  END IF;
  IF FOUND THEN RETURN coalesce(v_status IN ('returned', 'disputed'), false); END IF;
  RETURN gl_payment_counted_as_of(p_method, p_status, p_changed_at, p_as_of);
END $$;
REVOKE EXECUTE ON FUNCTION gl_payment_counted_on(UUID, TEXT, TEXT, TIMESTAMPTZ, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION gl_payment_counted_on(UUID, TEXT, TEXT, TIMESTAMPTZ, DATE) TO service_role;

-- ── REFUTE-10 C1: the payments a forward counted ─────────────────────────────────────────────
ALTER TABLE balance_forwards ADD COLUMN IF NOT EXISTS counted_payment_ids UUID[];
-- Backfill (none exist in production when this ships): by the payments' current state, which is
-- what balance_forward_app_cents measured if nothing changed since.
DO $$ BEGIN
  ALTER TABLE balance_forwards DISABLE TRIGGER balance_forwards_immutable;
  UPDATE balance_forwards b SET counted_payment_ids = coalesce((
    SELECT array_agg(p.id ORDER BY p.id) FROM payments p
     WHERE p.lease_id = b.lease_id AND p.payment_date <= b.as_of
       AND (p.method IN ('check', 'wire', 'other') OR (p.method = 'ach_stripe' AND p.stripe_status = 'succeeded'))), '{}')
   WHERE b.counted_payment_ids IS NULL;
  ALTER TABLE balance_forwards ENABLE TRIGGER balance_forwards_immutable;
END $$;
ALTER TABLE balance_forwards ALTER COLUMN counted_payment_ids SET DEFAULT '{}';
ALTER TABLE balance_forwards ALTER COLUMN counted_payment_ids SET NOT NULL;

-- ── REFUTE-10 R1: lock chains, one table at a time ────────────────────────────────────────────
-- Each SELECT ... FOR SHARE on one row returns its latest committed version once the lock is held,
-- so each next step reads the row the previous lock pinned. Returns the entity (NULL if none).
CREATE OR REPLACE FUNCTION gl_lock_property_entity(p_property UUID) RETURNS UUID
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE v_entity UUID;
BEGIN
  IF p_property IS NULL THEN RETURN NULL; END IF;
  SELECT pr.gl_entity_id INTO v_entity FROM properties pr WHERE pr.id = p_property FOR SHARE;
  RETURN v_entity;
END $$;
CREATE OR REPLACE FUNCTION gl_lock_unit_entity(p_unit UUID) RETURNS UUID
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE v_property UUID;
BEGIN
  IF p_unit IS NULL THEN RETURN NULL; END IF;
  SELECT u.property_id INTO v_property FROM units u WHERE u.id = p_unit FOR SHARE;
  RETURN gl_lock_property_entity(v_property);
END $$;
CREATE OR REPLACE FUNCTION gl_lock_lease_entity(p_lease UUID) RETURNS UUID
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE v_unit UUID;
BEGIN
  IF p_lease IS NULL THEN RETURN NULL; END IF;
  SELECT l.unit_id INTO v_unit FROM leases l WHERE l.id = p_lease FOR SHARE;
  RETURN gl_lock_unit_entity(v_unit);
END $$;
REVOKE EXECUTE ON FUNCTION gl_lock_property_entity(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_lock_unit_entity(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_lock_lease_entity(UUID) FROM PUBLIC, anon, authenticated;

-- Every pre-start charge, payment and balance forward of an entity, and whether it counted.
CREATE OR REPLACE FUNCTION gl_ar_tieout_source(p_entity_id UUID, p_as_of DATE)
  RETURNS TABLE (kind TEXT, source_id UUID, lease_id UUID, cents BIGINT, counted BOOLEAN)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  -- REFUTE-9 F1: inside a live balance forward (dated on or before its as_of), an item counts by its
  -- current state, as the forward measured it; elsewhere by its state on the tie-out date.
  SELECT 'charge'::text, c.id, c.lease_id, gl_exact_cents(c.amount),
         CASE WHEN EXISTS (SELECT 1 FROM balance_forwards b WHERE b.lease_id = c.lease_id AND b.voided_at IS NULL AND c.charge_date <= b.as_of)
              THEN c.voided_at IS NULL
              ELSE (c.voided_at IS NULL OR gl_central_date(c.voided_at) > p_as_of) END
    FROM charges c WHERE c.charge_date <= p_as_of AND gl_lease_entity(c.lease_id) = p_entity_id
  UNION ALL
  -- REFUTE-10 C1: a payment inside a forward counts iff the forward counted it (its id is on the
  -- list the insert trigger recorded); any later status change posts as its own event. C2: outside
  -- a forward, by the status it held at the end of the tie-out date.
  SELECT 'payment'::text, p.id, p.lease_id, gl_exact_cents(p.amount),
         CASE WHEN bf.id IS NULL THEN gl_payment_counted_on(p.id, p.method, p.stripe_status, p.status_changed_at, p_as_of)
              ELSE p.id = ANY (bf.counted_payment_ids) END
    FROM payments p
    LEFT JOIN balance_forwards bf ON bf.lease_id = p.lease_id AND bf.voided_at IS NULL AND p.payment_date <= bf.as_of
    WHERE p.payment_date <= p_as_of AND gl_lease_entity(p.lease_id) = p_entity_id
  UNION ALL
  -- BF1/BF4: live balance forwards dated on or before the tie-out date (a void is a correction, not
  -- an event, so a voided one is simply not there; BF6 keeps a counted one from being voided).
  SELECT 'balance_forward'::text, b.id, b.lease_id, gl_exact_cents(b.amount), true
    FROM balance_forwards b WHERE b.voided_at IS NULL AND b.as_of <= p_as_of AND gl_lease_entity(b.lease_id) = p_entity_id
$$;

-- BF4/BF7: the commit-time re-check (gl_ar_tieouts_verify) with balance forwards.
CREATE OR REPLACE FUNCTION gl_check_ar_tieout(p_entity_id UUID) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ent gl_entities%ROWTYPE;
  v_tie gl_ar_tieouts%ROWTYPE;
  v_ctl UUID;
  v_app BIGINT;
  v_gl BIGINT;
  v_dep UUID;
  v_dep_app BIGINT;
  v_dep_gl BIGINT := 0;
  v_late RECORD;
  v_replay BIGINT;
BEGIN
  SELECT * INTO v_tie FROM gl_ar_tieouts WHERE entity_id = p_entity_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO v_ent FROM gl_entities WHERE id = p_entity_id;
  IF v_ent.ledger_start_date IS DISTINCT FROM v_tie.as_of + 1
     OR NOT EXISTS (SELECT 1 FROM gl_journal_entries o WHERE o.id = v_tie.opening_entry_id AND o.entity_id = p_entity_id AND o.source = 'opening_balance'
                       AND NOT EXISTS (SELECT 1 FROM gl_journal_entries r WHERE r.reverses_entry_id = o.id)) THEN
    RAISE EXCEPTION 'gl: the AR tie-out must be measured against the entity''s live opening balance, the day before its start date' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT i.kind, i.source_id, i.cents, i.counted FROM gl_ar_tieout_items i WHERE i.entity_id = p_entity_id
             EXCEPT SELECT s.kind, s.source_id, s.cents, s.counted FROM gl_ar_tieout_source(p_entity_id, v_tie.as_of) s)
     OR EXISTS (SELECT s.kind, s.source_id, s.cents, s.counted FROM gl_ar_tieout_source(p_entity_id, v_tie.as_of) s
             EXCEPT SELECT i.kind, i.source_id, i.cents, i.counted FROM gl_ar_tieout_items i WHERE i.entity_id = p_entity_id) THEN
    RAISE EXCEPTION 'gl: the AR tie-out snapshot does not match the pre-start charges, payments and balance forwards (one changed meanwhile); confirm the tie-out again'
      USING ERRCODE = 'check_violation';
  END IF;
  -- BF7: a live balance forward dated after the tie-out date would be in the app balance but in
  -- neither the snapshot nor any posting.
  SELECT b.lease_id, b.as_of INTO v_late FROM balance_forwards b
   WHERE b.voided_at IS NULL AND b.as_of > v_tie.as_of AND gl_lease_entity(b.lease_id) = p_entity_id
   ORDER BY b.as_of, b.lease_id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'gl: lease % has a balance forward from QuickBooks dated %, after the AR tie-out date %; void it and import it again as of % or earlier',
      v_late.lease_id, v_late.as_of, v_tie.as_of, v_tie.as_of USING ERRCODE = 'check_violation';
  END IF;
  v_ctl := gl_ar_account(p_entity_id, CASE WHEN v_ent.accounting_basis = 'accrual' THEN 'ar' ELSE 'prepaid_rent' END);
  IF v_ent.accounting_basis = 'accrual' THEN
    SELECT coalesce(sum(CASE WHEN s.kind = 'payment' THEN -s.cents ELSE s.cents END) FILTER (WHERE s.counted), 0) INTO v_app
      FROM gl_ar_tieout_source(p_entity_id, v_tie.as_of) s;
    SELECT coalesce(sum(l.debit_cents - l.credit_cents), 0) INTO v_gl
      FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = v_ctl AND e.entity_id = p_entity_id AND e.entry_date <= v_tie.as_of;
  ELSE
    SELECT coalesce(sum(GREATEST(0, x.cash - x.billed)), 0) INTO v_app FROM (
      SELECT s.lease_id,
             coalesce(sum(s.cents) FILTER (WHERE s.kind = 'payment' AND s.counted), 0)
               + coalesce(sum(-s.cents) FILTER (WHERE s.kind = 'balance_forward' AND s.counted AND s.cents < 0), 0) AS cash,
             coalesce(sum(s.cents) FILTER (WHERE s.kind = 'charge' AND s.counted), 0)
               + coalesce(sum(s.cents) FILTER (WHERE s.kind = 'balance_forward' AND s.counted AND s.cents > 0), 0) AS billed
        FROM gl_ar_tieout_source(p_entity_id, v_tie.as_of) s GROUP BY s.lease_id) x;
    SELECT coalesce(sum(l.credit_cents - l.debit_cents), 0) INTO v_gl
      FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = v_ctl AND e.entity_id = p_entity_id AND e.entry_date <= v_tie.as_of;
  END IF;
  IF v_app <> v_tie.app_ar_cents OR v_gl <> v_tie.gl_ar_cents OR v_app <> v_gl THEN
    RAISE EXCEPTION 'gl: the AR tie-out totals do not match the snapshot and the ledger (app % / ledger % cents)', v_app, v_gl USING ERRCODE = 'check_violation';
  END IF;
  IF v_ent.accounting_basis = 'cash' THEN
    -- BF4: the snapshot's tenant credits are exactly the replay's starting credit.
    SELECT coalesce(sum(a.cents), 0) INTO v_replay
      FROM (SELECT DISTINCT s.lease_id FROM gl_ar_tieout_source(p_entity_id, v_tie.as_of) s) l, LATERAL gl_ar_cash_alloc(l.lease_id, 0) a
     WHERE a.role = 'prepaid_rent';
    IF v_replay <> v_app THEN
      RAISE EXCEPTION 'gl: tenant credits (% cents) do not match the replay''s starting point (% cents)', v_app, v_replay USING ERRCODE = 'check_violation';
    END IF;
    -- BF2: a counted positive balance forward needs an income account before any cash can pay it.
    IF EXISTS (SELECT 1 FROM gl_ar_tieout_items i WHERE i.entity_id = p_entity_id AND i.kind = 'balance_forward' AND i.counted AND i.cents > 0) THEN
      PERFORM gl_ar_account(p_entity_id, 'balance_forward');
    END IF;
    -- Ratified 2026-11-11: paid pre-start security deposits tie to the deposits account too.
    SELECT coalesce(sum(a.cents), 0) INTO v_dep_app
      FROM (SELECT DISTINCT s.lease_id FROM gl_ar_tieout_source(p_entity_id, v_tie.as_of) s) l, LATERAL gl_ar_cash_alloc(l.lease_id, 0) a
     WHERE a.role = 'security_deposit';
    SELECT account_id INTO v_dep FROM gl_ar_accounts WHERE entity_id = p_entity_id AND role = 'security_deposit';
    IF v_dep IS NULL AND v_dep_app <> 0 THEN
      v_dep := gl_ar_account(p_entity_id, 'security_deposit');  -- raises: map the role
    END IF;
    IF v_dep IS NOT NULL THEN
      SELECT coalesce(sum(l.credit_cents - l.debit_cents), 0) INTO v_dep_gl
        FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = v_dep AND e.entity_id = p_entity_id AND e.entry_date <= v_tie.as_of;
    END IF;
    IF v_dep_app <> v_dep_gl THEN
      RAISE EXCEPTION 'gl: deposits do not tie: the app shows % cents of paid security deposits as of %, the ledger''s security deposits account % cents (difference % cents)',
        v_dep_app, v_tie.as_of, v_dep_gl, v_dep_app - v_dep_gl USING ERRCODE = 'check_violation';
    END IF;
  END IF;
END;
$$;

-- BF4/BF7/BF8: confirm the tie-out with balance forwards.
CREATE OR REPLACE FUNCTION gl_confirm_ar_tieout(p_entity_id UUID, p_confirmed_by TEXT) RETURNS BIGINT
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ent gl_entities%ROWTYPE;
  v_as_of DATE;
  v_ctl UUID;
  v_app BIGINT;
  v_gl BIGINT;
  v_ob UUID;
  v_what TEXT;
  v_late RECORD;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'gl: confirm the AR tie-out only at READ COMMITTED isolation' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT * INTO v_ent FROM gl_entities WHERE id = p_entity_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'gl: entity % not found', p_entity_id USING ERRCODE = 'no_data_found'; END IF;
  IF v_ent.ledger_start_date IS NULL OR NOT EXISTS (
    SELECT 1 FROM gl_journal_entries o WHERE o.entity_id = p_entity_id AND o.source = 'opening_balance'
       AND NOT EXISTS (SELECT 1 FROM gl_journal_entries r WHERE r.reverses_entry_id = o.id)) THEN
    RAISE EXCEPTION 'gl: post the entity''s opening balance before confirming the AR tie-out' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM gl_ar_tieouts WHERE entity_id = p_entity_id) THEN
    RAISE EXCEPTION 'gl: the AR tie-out for entity % is already confirmed', p_entity_id USING ERRCODE = 'unique_violation';
  END IF;
  v_as_of := v_ent.ledger_start_date - 1;
  v_ctl := gl_ar_account(p_entity_id, CASE WHEN v_ent.accounting_basis = 'accrual' THEN 'ar' ELSE 'prepaid_rent' END);

  SELECT o.id INTO v_ob FROM gl_journal_entries o
   WHERE o.entity_id = p_entity_id AND o.source = 'opening_balance'
     AND NOT EXISTS (SELECT 1 FROM gl_journal_entries r WHERE r.reverses_entry_id = o.id);

  -- REFUTE-6 M1: hold every pre-start charge and payment so an in-flight edit either commits first
  -- (and is read here) or waits and then meets the snapshot guard.
  PERFORM 1 FROM charges c WHERE c.charge_date <= v_as_of AND gl_lease_entity(c.lease_id) = p_entity_id FOR SHARE;
  PERFORM 1 FROM payments p WHERE p.payment_date <= v_as_of AND gl_lease_entity(p.lease_id) = p_entity_id FOR SHARE;
  -- BF8: balance forwards are held by the gl_entities lock above (apply and void take it FOR SHARE).

  -- BF7: a live balance forward dated after the tie-out date would be in the app balance but in
  -- neither the snapshot nor any posting.
  SELECT b.lease_id, b.as_of INTO v_late FROM balance_forwards b
   WHERE b.voided_at IS NULL AND b.as_of > v_as_of AND gl_lease_entity(b.lease_id) = p_entity_id
   ORDER BY b.as_of, b.lease_id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'gl: lease % has a balance forward from QuickBooks dated %, after the AR tie-out date %; void it and import it again as of % or earlier',
      v_late.lease_id, v_late.as_of, v_as_of, v_as_of USING ERRCODE = 'check_violation';
  END IF;

  IF v_ent.accounting_basis = 'accrual' THEN
    -- Open AR: counted charges less counted payments, plus counted balance forwards, across the entity.
    v_what := 'open AR';
    SELECT coalesce(sum(CASE WHEN s.kind = 'payment' THEN -s.cents ELSE s.cents END) FILTER (WHERE s.counted), 0) INTO v_app
      FROM gl_ar_tieout_source(p_entity_id, v_as_of) s;
    SELECT coalesce(sum(l.debit_cents - l.credit_cents), 0) INTO v_gl
      FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = v_ctl AND e.entity_id = p_entity_id AND e.entry_date <= v_as_of;
  ELSE
    -- Tenant credits: per lease, counted cash beyond counted charges (never netted across leases).
    v_what := 'tenant credits';
    SELECT coalesce(sum(GREATEST(0, x.cash - x.billed)), 0) INTO v_app FROM (
      SELECT s.lease_id,
             coalesce(sum(s.cents) FILTER (WHERE s.kind = 'payment' AND s.counted), 0)
               + coalesce(sum(-s.cents) FILTER (WHERE s.kind = 'balance_forward' AND s.counted AND s.cents < 0), 0) AS cash,
             coalesce(sum(s.cents) FILTER (WHERE s.kind = 'charge' AND s.counted), 0)
               + coalesce(sum(s.cents) FILTER (WHERE s.kind = 'balance_forward' AND s.counted AND s.cents > 0), 0) AS billed
        FROM gl_ar_tieout_source(p_entity_id, v_as_of) s GROUP BY s.lease_id) x;
    SELECT coalesce(sum(l.credit_cents - l.debit_cents), 0) INTO v_gl
      FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = v_ctl AND e.entity_id = p_entity_id AND e.entry_date <= v_as_of;
  END IF;
  IF v_app <> v_gl THEN
    RAISE EXCEPTION 'gl: AR does not tie: the app shows % cents of % as of %, the ledger''s % account % cents (difference % cents)',
      v_app, v_what, v_as_of, CASE WHEN v_ent.accounting_basis = 'accrual' THEN 'AR' ELSE 'prepaid rent' END, v_gl, v_app - v_gl
      USING ERRCODE = 'check_violation';
  END IF;
  SET CONSTRAINTS gl_ar_tieouts_verify DEFERRED;  -- the check needs the items below
  INSERT INTO gl_ar_tieouts (entity_id, as_of, app_ar_cents, gl_ar_cents, opening_entry_id, confirmed_by)
    VALUES (p_entity_id, v_as_of, v_app, v_gl, v_ob, p_confirmed_by);
  INSERT INTO gl_ar_tieout_items (entity_id, kind, source_id, cents, counted)
    SELECT p_entity_id, s.kind, s.source_id, s.cents, s.counted FROM gl_ar_tieout_source(p_entity_id, v_as_of) s;
  -- Fail here with the message, and leave the deferred check queued: it re-runs at commit, after
  -- anything else this transaction does (SET CONSTRAINTS ... IMMEDIATE would consume it).
  PERFORM gl_check_ar_tieout(p_entity_id);
  RETURN v_app;
END;
$$;

-- BF2: the balance_forward role is income, and fixed (to its rent fallback) after a cash tie-out.
CREATE OR REPLACE FUNCTION gl_guard_ar_account() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_type TEXT;
  v_want TEXT;
BEGIN
  -- ar, undeposited_funds and prepaid_rent are fixed from the tie-out on: the opening AR (accrual)
  -- or the opening tenant credits (cash) sit in them (REFUTE-6 H5; 0029 C5).
  -- REFUTE-7 M4: on a cash-basis LLC every mapping is fixed from the tie-out on (each event moves
  -- money between the roles' CURRENT accounts, so a remap would split a role across two accounts).
  IF TG_OP IN ('UPDATE', 'DELETE') AND EXISTS (SELECT 1 FROM gl_ar_tieouts WHERE entity_id = OLD.entity_id)
     AND (SELECT accounting_basis FROM gl_entities WHERE id = OLD.entity_id) = 'cash'
     AND (TG_OP = 'DELETE' OR NEW.account_id <> OLD.account_id) THEN
    RAISE EXCEPTION 'gl: the % account is fixed once the AR tie-out is confirmed for this cash-basis entity', OLD.role USING ERRCODE = 'restrict_violation';
  END IF;
  -- BF2: the balance_forward role falls back to rent; mapping it after a cash-basis tie-out would
  -- split balance-forward income across two accounts (REFUTE-7 M4).
  -- REFUTE-10 G1: only a FIRST mapping; an upsert of an existing one reaches the UPDATE rule above.
  IF TG_OP = 'INSERT' AND NEW.role = 'balance_forward' AND EXISTS (SELECT 1 FROM gl_ar_tieouts WHERE entity_id = NEW.entity_id)
     AND NOT EXISTS (SELECT 1 FROM gl_ar_accounts a WHERE a.entity_id = NEW.entity_id AND a.role = 'balance_forward')
     AND (SELECT accounting_basis FROM gl_entities WHERE id = NEW.entity_id) = 'cash' THEN
    RAISE EXCEPTION 'gl: the balance_forward account is fixed once the AR tie-out is confirmed for this cash-basis entity (it follows rent)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.role IN ('ar', 'undeposited_funds', 'prepaid_rent') AND (EXISTS (SELECT 1 FROM gl_ar_postings WHERE entity_id = OLD.entity_id)
                                                    OR EXISTS (SELECT 1 FROM gl_ar_tieouts WHERE entity_id = OLD.entity_id)) THEN
      RAISE EXCEPTION 'gl: the % account is fixed once the AR tie-out is confirmed for this entity', OLD.role USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.entity_id <> OLD.entity_id OR NEW.role <> OLD.role) THEN
    RAISE EXCEPTION 'gl: an AR account mapping''s entity and role cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.account_id <> OLD.account_id AND NEW.role IN ('ar', 'undeposited_funds', 'prepaid_rent')
     AND (EXISTS (SELECT 1 FROM gl_ar_postings WHERE entity_id = NEW.entity_id) OR EXISTS (SELECT 1 FROM gl_ar_tieouts WHERE entity_id = NEW.entity_id)) THEN
    RAISE EXCEPTION 'gl: the % account is fixed once the AR tie-out is confirmed for this entity', NEW.role USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT account_type INTO v_type FROM gl_accounts WHERE id = NEW.account_id AND entity_id = NEW.entity_id;
  v_want := CASE
    WHEN NEW.role IN ('ar', 'undeposited_funds') THEN 'asset'
    WHEN NEW.role IN ('security_deposit', 'prepaid_rent') THEN 'liability'
    WHEN NEW.role = 'balance_forward' THEN 'income'
    ELSE 'income' END;
  IF v_type IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION 'gl: the % role needs an % account (got %)', NEW.role, v_want, coalesce(v_type, 'none') USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- BF5: a lease whose balance forward is counted stays in its LLC.
CREATE OR REPLACE FUNCTION gl_lease_ar_held(p_lease_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM charges c WHERE c.lease_id = p_lease_id AND gl_ar_held('charge', c.id))
      OR EXISTS (SELECT 1 FROM payments p WHERE p.lease_id = p_lease_id AND gl_ar_held('payment', p.id))
      OR EXISTS (SELECT 1 FROM balance_forwards b WHERE b.lease_id = p_lease_id AND gl_ar_held('balance_forward', b.id))
$$;

-- BF6: a counted balance forward cannot be voided.
CREATE OR REPLACE FUNCTION balance_forward_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'bf: balance forwards cannot be deleted; void it instead' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'bf: balance forward % is already voided', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  -- BF6: counted in a tie-out, it is part of the ledger's opening position.
  IF NEW.voided_at IS NOT NULL AND EXISTS (SELECT 1 FROM gl_ar_tieout_items i WHERE i.kind = 'balance_forward' AND i.source_id = OLD.id) THEN
    RAISE EXCEPTION 'bf: this balance forward was counted in the ledger''s AR tie-out and cannot be voided; record any later difference as a manual journal entry'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.lease_id, NEW.as_of, NEW.qb_balance, NEW.app_balance, NEW.amount, NEW.qb_customer, NEW.source, NEW.source_ref, NEW.created_by, NEW.created_at, NEW.counted_payment_ids)
     IS DISTINCT FROM (OLD.id, OLD.lease_id, OLD.as_of, OLD.qb_balance, OLD.app_balance, OLD.amount, OLD.qb_customer, OLD.source, OLD.source_ref, OLD.created_by, OLD.created_at, OLD.counted_payment_ids) THEN
    RAISE EXCEPTION 'bf: a balance forward can only be voided, not changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- BF8: a void waits for (or is seen by) a concurrent tie-out.
CREATE OR REPLACE FUNCTION void_balance_forward(p_id UUID, p_actor TEXT, p_reason TEXT) RETURNS balance_forwards
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row balance_forwards%ROWTYPE;
  v_entity UUID;
BEGIN
  -- REFUTE-9 F7: a stale snapshot would miss tie-out items committed while this waited.
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'bf: void_balance_forward must run in READ COMMITTED' USING ERRCODE = 'invalid_transaction_state';
  END IF;
  -- BF8 / REFUTE-9 F4 / REFUTE-10 R1: hold the lease's chain one row at a time (a move waits, or has
  -- committed and is read), then serialize with a tie-out of its entity (it holds it FOR UPDATE).
  v_entity := gl_lock_lease_entity((SELECT b.lease_id FROM balance_forwards b WHERE b.id = p_id));
  IF v_entity IS NOT NULL THEN PERFORM 1 FROM gl_entities WHERE id = v_entity FOR SHARE; END IF;
  UPDATE balance_forwards SET voided_at = pg_catalog.now(), voided_by = btrim(p_actor), void_reason = btrim(p_reason)
    WHERE id = p_id AND voided_at IS NULL
    RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bf: balance forward % does not exist or is already voided', p_id USING ERRCODE = 'no_data_found';
  END IF;
  RETURN v_row;
END $$;

-- BF7: unchanged except the message (the tie-out now counts balance forwards).
CREATE OR REPLACE FUNCTION apply_balance_forwards(p_as_of DATE, p_source TEXT, p_source_ref TEXT, p_actor TEXT, p_rows JSONB)
  RETURNS SETOF balance_forwards
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r JSONB;
  v_lease UUID;
  v_qb NUMERIC;
  v_expected NUMERIC;
  v_app BIGINT;
  v_entity UUID;
  v_row balance_forwards%ROWTYPE;
  v_seen UUID[] := '{}';
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'bf: apply_balance_forwards must run in READ COMMITTED' USING ERRCODE = 'invalid_transaction_state';
  END IF;
  IF p_as_of IS NULL OR p_as_of >= (pg_catalog.now() AT TIME ZONE 'America/Chicago')::date THEN
    RAISE EXCEPTION 'bf: the balance forward date % must be before today', p_as_of USING ERRCODE = 'check_violation';
  END IF;
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'bf: balance forwards need the importing user' USING ERRCODE = 'check_violation';
  END IF;
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' OR pg_catalog.jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'bf: no balance forward rows given' USING ERRCODE = 'check_violation';
  END IF;

  -- REFUTE-11 D1: take every lease in one global (id) order before the loop, as billing's bulk
  -- upsert does (cron sorts by lease), so the two never deadlock.
  PERFORM 1 FROM leases l WHERE l.id IN (SELECT (e->>'lease_id')::uuid FROM pg_catalog.jsonb_array_elements(p_rows) e) ORDER BY l.id FOR UPDATE;
  FOR r IN SELECT * FROM pg_catalog.jsonb_array_elements(p_rows) LOOP
    v_lease := (r->>'lease_id')::uuid;
    v_qb := (r->>'qb_balance')::numeric;
    v_expected := (r->>'expected_app_balance')::numeric;
    IF v_lease IS NULL OR v_qb IS NULL OR v_expected IS NULL THEN
      RAISE EXCEPTION 'bf: each row needs lease_id, qb_balance and expected_app_balance' USING ERRCODE = 'check_violation';
    END IF;
    IF v_qb <> pg_catalog.round(v_qb, 2) OR v_expected <> pg_catalog.round(v_expected, 2) THEN
      RAISE EXCEPTION 'bf: lease %: amounts must be whole cents', v_lease USING ERRCODE = 'check_violation';
    END IF;
    IF v_lease = ANY (v_seen) THEN
      RAISE EXCEPTION 'bf: lease % appears twice', v_lease USING ERRCODE = 'check_violation';
    END IF;
    v_seen := v_seen || v_lease;

    PERFORM 1 FROM leases WHERE id = v_lease FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'bf: lease % does not exist', v_lease USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM balance_forwards b WHERE b.lease_id = v_lease AND b.voided_at IS NULL) THEN
      RAISE EXCEPTION 'bf: lease % already has a balance forward; void it first', v_lease USING ERRCODE = 'unique_violation';
    END IF;
    -- REFUTE-9 F2/F5 / REFUTE-10 R1: hold the lease's unit and property (one row at a time), so a
    -- move of either waits for this import (and then meets the committed forward) or has committed
    -- and is read here.
    v_entity := gl_lock_lease_entity(v_lease);
    -- R3: serialize with a tie-out of the same entity (gl_confirm_ar_tieout locks it FOR UPDATE).
    IF v_entity IS NOT NULL THEN PERFORM 1 FROM gl_entities WHERE id = v_entity FOR SHARE; END IF;
    IF v_entity IS NOT NULL AND EXISTS (SELECT 1 FROM gl_ar_tieouts t WHERE t.entity_id = v_entity) THEN
      RAISE EXCEPTION 'bf: lease %: its LLC is already tied out in the ledger; a balance forward must be imported before the AR tie-out', v_lease
        USING ERRCODE = 'check_violation';
    END IF;
    -- REFUTE-10 C3: any ACH not yet settled (every in-flight PaymentIntent status, or none).
    IF EXISTS (SELECT 1 FROM payments p WHERE p.lease_id = v_lease AND p.payment_date <= p_as_of AND p.method = 'ach_stripe'
                 AND (p.stripe_status IS NULL OR p.stripe_status NOT IN ('succeeded', 'failed', 'returned', 'canceled', 'disputed'))) THEN
      RAISE EXCEPTION 'bf: lease % has an ACH payment still pending on or before %; wait for it to settle', v_lease, p_as_of
        USING ERRCODE = 'check_violation';
    END IF;
    v_app := balance_forward_app_cents(v_lease, p_as_of);
    IF v_app <> pg_catalog.round(v_expected * 100) THEN
      RAISE EXCEPTION 'bf: lease %: the app balance as of % is now %, not % as previewed; preview again',
        v_lease, p_as_of, (v_app::numeric / 100), v_expected USING ERRCODE = 'serialization_failure';
    END IF;
    CONTINUE WHEN pg_catalog.round(v_qb * 100) = v_app;

    INSERT INTO balance_forwards (lease_id, as_of, qb_balance, app_balance, amount, qb_customer, source, source_ref, created_by)
      VALUES (v_lease, p_as_of, v_qb, v_app::numeric / 100, v_qb - v_app::numeric / 100, NULLIF(btrim(r->>'qb_customer'), ''),
              coalesce(p_source, 'qb_ar_aging'), NULLIF(btrim(p_source_ref), ''), btrim(p_actor))
      RETURNING * INTO v_row;
    RETURN NEXT v_row;
  END LOOP;
END $$;

-- BF7 (B4'): a direct tie-out insert is refused while a live balance forward is dated after it.
CREATE OR REPLACE FUNCTION gl_ar_tieout_no_balance_forward() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_late RECORD;
BEGIN
  -- R3/BF8: serialize with apply_balance_forwards and void_balance_forward (FOR SHARE).
  PERFORM 1 FROM gl_entities WHERE id = NEW.entity_id FOR UPDATE;
  SELECT b.lease_id, b.as_of INTO v_late FROM balance_forwards b
   WHERE b.voided_at IS NULL AND b.as_of > NEW.as_of AND gl_lease_entity(b.lease_id) = NEW.entity_id
   ORDER BY b.as_of, b.lease_id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'gl: lease % has a balance forward from QuickBooks dated %, after the AR tie-out date %; void it and import it again as of % or earlier',
      v_late.lease_id, v_late.as_of, NEW.as_of, NEW.as_of USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- REFUTE-9 F6: a move locks its old and new entity rows.
CREATE OR REPLACE FUNCTION balance_forward_entity_move() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_entity UUID;
  v_old UUID;
  v_lease UUID;
BEGIN
  IF TG_TABLE_NAME = 'properties' THEN
    IF NEW.gl_entity_id IS NOT DISTINCT FROM OLD.gl_entity_id THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME = 'units' THEN
    IF NEW.property_id IS NOT DISTINCT FROM OLD.property_id THEN RETURN NEW; END IF;
  ELSE
    IF NEW.unit_id IS NOT DISTINCT FROM OLD.unit_id THEN RETURN NEW; END IF;
  END IF;
  -- A stale (REPEATABLE READ) snapshot would miss a tie-out or an import committed while this waited.
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'bf: moving a property, unit or lease to another LLC must run in READ COMMITTED' USING ERRCODE = 'invalid_transaction_state';
  END IF;
  -- REFUTE-9 re-check / REFUTE-10 R1: lock the OLD and the NEW chain one row at a time (unit, then
  -- its property), reading each after its lock, so a concurrent move of any link either commits
  -- first (and is read here) or waits for this. The row being updated is already locked, and OLD
  -- is its latest version.
  IF TG_TABLE_NAME = 'properties' THEN
    v_entity := NEW.gl_entity_id;
    v_old := OLD.gl_entity_id;
  ELSIF TG_TABLE_NAME = 'units' THEN
    v_old := gl_lock_property_entity(OLD.property_id);
    v_entity := gl_lock_property_entity(NEW.property_id);
  ELSE
    v_old := gl_lock_unit_entity(OLD.unit_id);
    v_entity := gl_lock_unit_entity(NEW.unit_id);
  END IF;
  -- REFUTE-9 F6: lock both entities (id order) so a move never interleaves with either one's tie-out
  -- (it holds its entity FOR UPDATE): the move waits and then meets the tie-out's items, or commits
  -- first and the tie-out reads the lease where it now is.
  PERFORM 1 FROM gl_entities WHERE id IN (v_entity, v_old) ORDER BY id FOR SHARE;
  IF v_entity IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM gl_ar_tieouts t WHERE t.entity_id = v_entity) THEN RETURN NEW; END IF;
  SELECT b.lease_id INTO v_lease FROM balance_forwards b JOIN leases l ON l.id = b.lease_id JOIN units u ON u.id = l.unit_id
   WHERE b.voided_at IS NULL
     AND CASE TG_TABLE_NAME WHEN 'properties' THEN u.property_id = NEW.id WHEN 'units' THEN u.id = NEW.id ELSE l.id = NEW.id END
   LIMIT 1;
  IF v_lease IS NOT NULL THEN
    RAISE EXCEPTION 'bf: lease % has a balance forward from QuickBooks and cannot move into an LLC already tied out in the ledger', v_lease
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- REFUTE-9 F3 (BF7): any insert into balance_forwards, not only apply_balance_forwards, is refused for
-- a lease whose LLC is tied out.
CREATE OR REPLACE FUNCTION balance_forward_insert_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_entity UUID;
  v_ids UUID[];
  v_app BIGINT;
BEGIN
  -- A stale (REPEATABLE READ) snapshot would miss a tie-out committed while this waited.
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'bf: balance forwards can only be added in READ COMMITTED' USING ERRCODE = 'invalid_transaction_state';
  END IF;
  -- REFUTE-10 R1: the lease row first (0030 B3's history guard waits on it), then its chain.
  v_entity := gl_lock_lease_entity(NEW.lease_id);
  IF v_entity IS NOT NULL THEN
    PERFORM 1 FROM gl_entities WHERE id = v_entity FOR SHARE;
    IF EXISTS (SELECT 1 FROM gl_ar_tieouts t WHERE t.entity_id = v_entity) THEN
      RAISE EXCEPTION 'bf: lease %: its LLC is already tied out in the ledger; a balance forward must be imported before the AR tie-out', NEW.lease_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- REFUTE-10 C3: no ACH on or before the date may still be in flight (any writer, not only apply).
  IF EXISTS (SELECT 1 FROM payments p WHERE p.lease_id = NEW.lease_id AND p.payment_date <= NEW.as_of AND p.method = 'ach_stripe'
               AND (p.stripe_status IS NULL OR p.stripe_status NOT IN ('succeeded', 'failed', 'returned', 'canceled', 'disputed'))) THEN
    RAISE EXCEPTION 'bf: lease % has an ACH payment still pending on or before %; wait for it to settle', NEW.lease_id, NEW.as_of
      USING ERRCODE = 'check_violation';
  END IF;
  -- REFUTE-10 C1: record exactly the payments this forward counts, read in one statement with the
  -- balance it is checked against (balance_forward_app_cents' populations).
  SELECT x.ids, x.charged - x.paid INTO v_ids, v_app FROM (
    SELECT (SELECT coalesce(sum(c.amount), 0) FROM charges c
              WHERE c.lease_id = NEW.lease_id AND c.voided_at IS NULL AND c.charge_date <= NEW.as_of) * 100 AS charged,
           coalesce(sum(p.amount), 0) * 100 AS paid,
           coalesce(array_agg(p.id ORDER BY p.id) FILTER (WHERE p.id IS NOT NULL), '{}') AS ids
      FROM payments p
     WHERE p.lease_id = NEW.lease_id AND p.payment_date <= NEW.as_of
       AND (p.method IN ('check', 'wire', 'other') OR (p.method = 'ach_stripe' AND p.stripe_status = 'succeeded'))) x;
  IF v_app <> pg_catalog.round(NEW.app_balance * 100) THEN
    RAISE EXCEPTION 'bf: lease %: the app balance as of % is now %, not %; preview again',
      NEW.lease_id, NEW.as_of, (v_app::numeric / 100), NEW.app_balance USING ERRCODE = 'serialization_failure';
  END IF;
  NEW.counted_payment_ids := v_ids;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS balance_forwards_insert_guard ON balance_forwards;
CREATE TRIGGER balance_forwards_insert_guard BEFORE INSERT ON balance_forwards FOR EACH ROW EXECUTE FUNCTION balance_forward_insert_guard();
REVOKE EXECUTE ON FUNCTION balance_forward_insert_guard() FROM PUBLIC, anon, authenticated;

-- REFUTE-9 F9: the history-freeze message once the ledger counted the forward.
CREATE OR REPLACE FUNCTION balance_forward_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old_lease UUID;
  v_new_lease UUID;
  v_old_date DATE;
  v_new_date DATE;
  v_cut DATE;
  v_counted BOOLEAN;
BEGIN
  -- R1: an insert whose idempotency key is already taken never lands (ON CONFLICT DO NOTHING, or a
  -- unique violation); a billing re-run must not be refused for it. (ON CONFLICT DO UPDATE would
  -- update the existing row, and that UPDATE is checked below.)
  -- REFUTE-11 I1: the key's row is LOCKED, not merely seen: a delete in flight is waited out (then
  -- nothing is found and the insert is checked like any other); a row found locked cannot vanish
  -- before this insert meets it, so the insert never lands.
  IF TG_OP = 'INSERT' AND NEW.idempotency_key IS NOT NULL THEN
    IF TG_TABLE_NAME = 'charges' THEN
      PERFORM 1 FROM charges c WHERE c.idempotency_key = NEW.idempotency_key FOR SHARE;
      IF FOUND THEN RETURN NEW; END IF;
    ELSE
      PERFORM 1 FROM payments p WHERE p.idempotency_key = NEW.idempotency_key FOR SHARE;
      IF FOUND THEN RETURN NEW; END IF;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'charges' THEN
    IF TG_OP <> 'INSERT' THEN v_old_lease := OLD.lease_id; v_old_date := OLD.charge_date; END IF;
    IF TG_OP <> 'DELETE' THEN v_new_lease := NEW.lease_id; v_new_date := NEW.charge_date; END IF;
    IF TG_OP = 'UPDATE' AND (NEW.lease_id, NEW.charge_date, NEW.amount, NEW.voided_at IS NULL)
                            IS NOT DISTINCT FROM (OLD.lease_id, OLD.charge_date, OLD.amount, OLD.voided_at IS NULL) THEN
      RETURN NEW;
    END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN v_old_lease := OLD.lease_id; v_old_date := OLD.payment_date; END IF;
    IF TG_OP <> 'DELETE' THEN v_new_lease := NEW.lease_id; v_new_date := NEW.payment_date; END IF;
    IF TG_OP = 'UPDATE' AND (NEW.lease_id, NEW.payment_date, NEW.amount, NEW.method)
                            IS NOT DISTINCT FROM (OLD.lease_id, OLD.payment_date, OLD.amount, OLD.method) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'bf: changes to charges and payments must run in READ COMMITTED (balance forward guard)'
      USING ERRCODE = 'invalid_transaction_state';
  END IF;
  -- Wait out a concurrent import on the same lease, then read what it committed.
  PERFORM 1 FROM leases WHERE id IN (v_old_lease, v_new_lease) ORDER BY id FOR SHARE;
  FOR v_cut, v_old_lease, v_old_date, v_counted IN
    SELECT b.as_of, x.lease, x.d, EXISTS (SELECT 1 FROM gl_ar_tieout_items i WHERE i.kind = 'balance_forward' AND i.source_id = b.id)
      FROM (VALUES (v_old_lease, v_old_date), (v_new_lease, v_new_date)) AS x(lease, d)
      JOIN balance_forwards b ON b.lease_id = x.lease AND b.voided_at IS NULL
     WHERE x.d <= b.as_of
  LOOP
    IF v_counted THEN
      RAISE EXCEPTION 'bf: lease % has a balance forward from QuickBooks as of % that the ledger counted at its AR tie-out; its % dated on or before then (%) are frozen for good. Record any difference as a manual journal entry.',
        v_old_lease, v_cut, TG_TABLE_NAME, v_old_date USING ERRCODE = 'check_violation';
    END IF;
    RAISE EXCEPTION 'bf: lease % has a balance forward from QuickBooks as of %; its % dated on or before then (%) cannot change. Void the balance forward first, then import again.',
      v_old_lease, v_cut, TG_TABLE_NAME, v_old_date USING ERRCODE = 'check_violation';
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
