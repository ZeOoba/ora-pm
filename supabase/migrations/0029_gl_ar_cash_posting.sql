-- 0029: B8 slice 4 — post tenant charges and payments into the native ledger for CASH-basis LLCs.
--
-- Ratified 2026-11-11 (on top of 0028's batch run / Undeposited Funds / hard tie-out rulings):
--   * payments apply to the lease's oldest open charges first (OI-234: by due date), and within one
--     due date in this order: security deposit, rent, CAM estimate, CAM true-up, utilities (water,
--     gas, electric, other), percentage rent, other, late fees last;
--   * cash beyond the open charges is a tenant credit, held in the prepaid_rent liability until a
--     later charge uses it (then moved to that charge's account);
--   * tie-out gate: the app's tenant credits as of the day before the start date must equal the
--     prepaid_rent account's opening balance, to the cent.
--
-- Model. Cash-basis books recognize a charge only as cash pays it, and the app keeps no payment →
-- charge application table: who paid what is oldest-first over the lease's whole history, so a void
-- or an ACH return can change, after the fact, which charges earlier cash paid. The ledger therefore
-- replays each lease as a sequence of EVENTS (gl_ar_cash_events, numbered by seq):
--   charge          the charge exists (dated its charge date): it may absorb the tenant's credit
--   charge_void     the charge is gone (dated the void): cash it held moves to other charges/credit
--   payment         cash in (dated its payment date): Dr Undeposited Funds
--   payment_return  cash out (ACH failed/returned, dated the status change): Cr Undeposited Funds
-- After each event the database recomputes the lease's oldest-first allocation of its cash over its
-- live charges (gl_ar_cash_alloc) and posts the CHANGE per account (gl_ar_cash_expected): each
-- charge type's mapped account for the cash it now holds, prepaid_rent for the credit, Undeposited
-- Funds for the cash itself. An event that changes nothing (a charge with no credit to absorb)
-- posts no entry but is recorded, so later cash pays it. Past entries are never rewritten. The
-- starting point (seq 0) is the AR tie-out snapshot: pre-start charges paid before the start date
-- were income in QuickBooks, and the pre-start credit is the opening prepaid_rent balance.
--
-- Money rules, enforced in the database (direct service_role SQL included):
--   C1. Each event is verified at commit (deferred constraint trigger): source, lease and entity;
--       the event's date; that the event is allowed (a payment that counts, a return of cash already
--       in, a void of a live charge); and that its entry is exactly the allocation change, account
--       by account, or that there is no entry when nothing changed. Lines added later re-verify.
--   C2. Events are insert-only; seq is assigned by the database under the entity's row lock, so
--       events of one entity are numbered in commit order and cannot be inserted "in the past".
--   C3. A payment event requires every charge live by its date to be in the replay first (no cash
--       can land in prepaid_rent while a charge it should pay is left out).
--   C4. Tie-out (gl_confirm_ar_tieout, now both bases): for cash-basis, Σ per-lease credits
--       (counted pre-start cash beyond counted pre-start charges) = prepaid_rent opening balance.
--   C5. 0028's guards extend to cash events (held sources, unit/lease/property moves, voids and
--       terminal Stripe statuses final); a held cash-basis charge's due date is fixed too (it
--       orders the allocation); prepaid_rent is fixed from the tie-out on, like ar.
--
-- REFUTE-7 (adversarial pass on PR #84) and the rulings it prompted (2026-11-11):
--   H1  each event has a replay date (alloc_date), never earlier than its lease's previous one; the
--       allocation change posts then. Cash dated earlier posts on its own date into prepaid rent
--       first (two entries: 'cash' and 'alloc' legs), so one run and several runs give the same books.
--   M5  (ruled) billing order: cash fills charges by the replay date they became live, then due
--       date and type; a charge billed late takes only unapplied cash, never income already booked.
--   H2/H3  a tie-out and its items are written in one transaction (items need their tie-out's
--       transaction) and re-verified at commit against the source rows and the ledger.
--   (ruled) cash basis: paid pre-start security deposits also tie to the deposits account.
--   M4  every role mapping of a cash-basis entity is fixed from the tie-out on.
--   L   held ACH cash cannot move succeeded → canceled.
-- Cash-basis entities never use gl_ar_postings (0028's accrual functions still refuse them), and
-- an ar_posting entry must be linked from exactly one of the two link tables.
--
-- ORDERING: requires 0028. Re-runnable. Every function pins search_path = public, pg_temp.

-- ── Charge-type order within one due date (ratified) ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION gl_ar_cash_priority(p_type TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE p_type
    WHEN 'security_deposit' THEN 0 WHEN 'rent' THEN 1 WHEN 'cam_estimate' THEN 2 WHEN 'cam_true_up' THEN 3
    WHEN 'utility_water' THEN 4 WHEN 'utility_gas' THEN 5 WHEN 'utility_electric' THEN 6 WHEN 'utility_other' THEN 7
    WHEN 'percentage_rent' THEN 8 WHEN 'other' THEN 9 WHEN 'late_fee' THEN 10 ELSE 99 END
$$;

-- ── Events ─────────────────────────────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS gl_ar_cash_events_seq;

CREATE TABLE IF NOT EXISTS gl_ar_cash_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq BIGINT NOT NULL CONSTRAINT gl_ar_cash_events_seq_key UNIQUE,
  entity_id UUID NOT NULL REFERENCES gl_entities(id),
  lease_id UUID NOT NULL,
  kind TEXT NOT NULL CONSTRAINT gl_ar_cash_events_kind_check CHECK (kind IN ('charge', 'charge_void', 'payment', 'payment_return')),
  source_id UUID NOT NULL,
  -- event_date: the event's own date (charge date, void date, cash date). alloc_date: its replay
  -- date, never earlier than the lease's previous replay date (REFUTE-7 H1), on which the allocation
  -- change posts. A payment or return dated before its replay date posts its cash on event_date
  -- (against prepaid rent) and the reallocation on alloc_date.
  event_date DATE NOT NULL,
  alloc_date DATE NOT NULL,
  posted_by TEXT NOT NULL CONSTRAINT gl_ar_cash_events_by_nonempty CHECK (btrim(posted_by) <> ''),
  posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT gl_ar_cash_events_once UNIQUE (kind, source_id),
  CONSTRAINT gl_ar_cash_events_dates CHECK (alloc_date >= event_date)
);
CREATE INDEX IF NOT EXISTS gl_ar_cash_events_lease_idx ON gl_ar_cash_events (lease_id, seq);
CREATE INDEX IF NOT EXISTS gl_ar_cash_events_entity_idx ON gl_ar_cash_events (entity_id);

-- The entries an event posted: its 'alloc' leg (none when nothing changed) and, for cash dated
-- before its replay date, its 'cash' leg.
CREATE TABLE IF NOT EXISTS gl_ar_cash_entries (
  event_id UUID NOT NULL REFERENCES gl_ar_cash_events(id),
  leg TEXT NOT NULL CONSTRAINT gl_ar_cash_entries_leg_check CHECK (leg IN ('alloc', 'cash')),
  entity_id UUID NOT NULL,
  entry_id UUID NOT NULL CONSTRAINT gl_ar_cash_entries_entry_once UNIQUE,
  CONSTRAINT gl_ar_cash_entries_entry_fk FOREIGN KEY (entity_id, entry_id) REFERENCES gl_journal_entries (entity_id, id),
  PRIMARY KEY (event_id, leg)
);

-- C2: seq is the database's, taken under the entity's row lock (held to commit).
CREATE OR REPLACE FUNCTION gl_ar_cash_event_seq() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'gl: post cash-basis AR only at READ COMMITTED isolation' USING ERRCODE = 'restrict_violation';
  END IF;
  PERFORM 1 FROM gl_entities WHERE id = NEW.entity_id FOR UPDATE;
  NEW.seq := pg_catalog.nextval('gl_ar_cash_events_seq'::regclass);
  NEW.posted_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS gl_ar_cash_events_seq_assign ON gl_ar_cash_events;
CREATE TRIGGER gl_ar_cash_events_seq_assign BEFORE INSERT ON gl_ar_cash_events FOR EACH ROW EXECUTE FUNCTION gl_ar_cash_event_seq();

DROP TRIGGER IF EXISTS gl_ar_cash_events_immutable ON gl_ar_cash_events;
CREATE TRIGGER gl_ar_cash_events_immutable BEFORE UPDATE OR DELETE ON gl_ar_cash_events FOR EACH ROW EXECUTE FUNCTION gl_reject_change();
DROP TRIGGER IF EXISTS gl_ar_cash_events_no_truncate ON gl_ar_cash_events;
CREATE TRIGGER gl_ar_cash_events_no_truncate BEFORE TRUNCATE ON gl_ar_cash_events FOR EACH STATEMENT EXECUTE FUNCTION gl_reject_truncate();
DROP TRIGGER IF EXISTS gl_ar_cash_entries_immutable ON gl_ar_cash_entries;
CREATE TRIGGER gl_ar_cash_entries_immutable BEFORE UPDATE OR DELETE ON gl_ar_cash_entries FOR EACH ROW EXECUTE FUNCTION gl_reject_change();
DROP TRIGGER IF EXISTS gl_ar_cash_entries_no_truncate ON gl_ar_cash_entries;
CREATE TRIGGER gl_ar_cash_entries_no_truncate BEFORE TRUNCATE ON gl_ar_cash_entries FOR EACH STATEMENT EXECUTE FUNCTION gl_reject_truncate();

-- ── The allocation ─────────────────────────────────────────────────────────────────────────────
-- A lease's allocation after events up to p_seq (0 = the tie-out snapshot): one row per live charge
-- (cents of cash it holds) and one credit row (role prepaid_rent). Cash fills charges in BILLING
-- order (ratified 2026-11-11, REFUTE-7 M5): by the replay date each became live (tie-out charges
-- first), then oldest due date, then deposit, rent, CAM, utilities, percentage rent, other, late
-- fees, then id. A charge billed late therefore takes only cash still unapplied; income already
-- recognized never moves to it.
CREATE OR REPLACE FUNCTION gl_ar_cash_alloc(p_lease_id UUID, p_seq BIGINT) RETURNS TABLE (charge_id UUID, role TEXT, cents BIGINT)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  WITH ch AS (
    SELECT c.id, c.type, c.due_date, gl_exact_cents(c.amount) AS amt,
           coalesce((SELECT e.alloc_date FROM gl_ar_cash_events e WHERE e.kind = 'charge' AND e.source_id = c.id AND e.seq <= p_seq),
                    CASE WHEN EXISTS (SELECT 1 FROM gl_ar_tieout_items i WHERE i.kind = 'charge' AND i.source_id = c.id AND i.counted)
                         THEN DATE '0001-01-01' END) AS live
      FROM charges c
     WHERE c.lease_id = p_lease_id
       AND NOT EXISTS (SELECT 1 FROM gl_ar_cash_events e WHERE e.kind = 'charge_void' AND e.source_id = c.id AND e.seq <= p_seq)
  ), live AS (
    SELECT * FROM ch WHERE ch.live IS NOT NULL
  ), cash AS (
    SELECT coalesce(sum(gl_exact_cents(p.amount)), 0)::bigint AS total
      FROM payments p
     WHERE p.lease_id = p_lease_id
       AND (EXISTS (SELECT 1 FROM gl_ar_tieout_items i WHERE i.kind = 'payment' AND i.source_id = p.id AND i.counted)
            OR EXISTS (SELECT 1 FROM gl_ar_cash_events e WHERE e.kind = 'payment' AND e.source_id = p.id AND e.seq <= p_seq))
       AND NOT EXISTS (SELECT 1 FROM gl_ar_cash_events e WHERE e.kind = 'payment_return' AND e.source_id = p.id AND e.seq <= p_seq)
  ), ord AS (
    SELECT live.id, live.type, live.amt,
           coalesce(sum(live.amt) OVER (ORDER BY live.live, live.due_date, gl_ar_cash_priority(live.type), live.id
                                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)::bigint AS before
      FROM live
  )
  SELECT ord.id, ord.type, GREATEST(0, LEAST(ord.amt, (SELECT total FROM cash) - ord.before))::bigint FROM ord
  UNION ALL
  SELECT NULL::uuid, 'prepaid_rent', GREATEST(0, (SELECT total FROM cash) - coalesce((SELECT sum(amt) FROM live), 0))::bigint
$$;

-- The entry one leg of an event must post: net (debit − credit) per account, non-zero accounts only.
-- 'alloc' leg (dated alloc_date): the allocation change, plus the cash itself on Undeposited Funds;
-- when the cash is dated before the replay date, the cash sits in prepaid rent in between:
-- 'cash' leg (dated event_date) Dr UF / Cr prepaid, and the alloc leg moves it out of prepaid.
CREATE OR REPLACE FUNCTION gl_ar_cash_expected(p_event_id UUID, p_leg TEXT) RETURNS TABLE (account_id UUID, net BIGINT)
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ev gl_ar_cash_events%ROWTYPE;
  v_cash BIGINT := 0;
  v_split BOOLEAN;
BEGIN
  SELECT * INTO v_ev FROM gl_ar_cash_events WHERE id = p_event_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_ev.kind IN ('payment', 'payment_return') THEN
    SELECT gl_exact_cents(amount) INTO v_cash FROM payments WHERE id = v_ev.source_id;
    IF v_ev.kind = 'payment_return' THEN v_cash := -v_cash; END IF;
  END IF;
  v_split := v_cash <> 0 AND v_ev.event_date < v_ev.alloc_date;
  IF p_leg = 'cash' THEN
    IF v_split THEN
      RETURN QUERY SELECT x.acct, x.amt FROM (VALUES (gl_ar_account(v_ev.entity_id, 'undeposited_funds'), v_cash),
                                                     (gl_ar_account(v_ev.entity_id, 'prepaid_rent'), -v_cash)) x(acct, amt);
    END IF;
    RETURN;
  END IF;
  RETURN QUERY
    WITH d AS (
      SELECT a.role, sum(a.cents)::bigint AS delta FROM (
        SELECT n.role, n.cents FROM gl_ar_cash_alloc(v_ev.lease_id, v_ev.seq) n
        UNION ALL
        SELECT o.role, -o.cents FROM gl_ar_cash_alloc(v_ev.lease_id, v_ev.seq - 1) o
      ) a GROUP BY a.role
    ), lines AS (
      SELECT gl_ar_account(v_ev.entity_id, d.role) AS acct, -d.delta AS amt FROM d WHERE d.delta <> 0
      UNION ALL
      SELECT gl_ar_account(v_ev.entity_id, CASE WHEN v_split THEN 'prepaid_rent' ELSE 'undeposited_funds' END), v_cash WHERE v_cash <> 0
    )
    SELECT lines.acct, sum(lines.amt)::bigint FROM lines GROUP BY lines.acct HAVING sum(lines.amt) <> 0;
END;
$$;

-- A lease's replay date for its next event: never before its previous one (REFUTE-7 H1).
CREATE OR REPLACE FUNCTION gl_ar_cash_alloc_date(p_entity_id UUID, p_lease_id UUID, p_event_date DATE, p_before_seq BIGINT) RETURNS DATE
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT gl_first_open_date(p_entity_id, GREATEST(p_event_date,
    (SELECT max(e.alloc_date) FROM gl_ar_cash_events e WHERE e.lease_id = p_lease_id AND e.seq < p_before_seq)))
$$;

-- ── C1: every cash event verified at commit ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION gl_check_ar_cash_event(p_event_id UUID) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ev gl_ar_cash_events%ROWTYPE;
  v_ent gl_entities%ROWTYPE;
  v_tie gl_ar_tieouts%ROWTYPE;
  v_c charges%ROWTYPE;
  v_p payments%ROWTYPE;
  v_item gl_ar_tieout_items%ROWTYPE;
  v_base DATE;
  v_date DATE;
  v_lease UUID;
  v_entry gl_journal_entries%ROWTYPE;
  v_entry_id UUID;
  v_bad BOOLEAN;
  v_leg TEXT;
BEGIN
  SELECT * INTO v_ev FROM gl_ar_cash_events WHERE id = p_event_id;
  IF NOT FOUND THEN RETURN; END IF;
  -- Serialize with any other event writer of this entity (they hold this lock to commit).
  SELECT * INTO v_ent FROM gl_entities WHERE id = v_ev.entity_id FOR UPDATE;
  IF v_ent.accounting_basis <> 'cash' THEN
    RAISE EXCEPTION 'gl: cash-basis AR events are for cash-basis entities only' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_tie FROM gl_ar_tieouts WHERE entity_id = v_ev.entity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gl: confirm the AR tie-out before posting AR for entity %', v_ev.entity_id USING ERRCODE = 'check_violation';
  END IF;
  IF v_ent.ledger_start_date IS DISTINCT FROM v_tie.as_of + 1
     OR EXISTS (SELECT 1 FROM gl_journal_entries r WHERE r.reverses_entry_id = v_tie.opening_entry_id) THEN
    RAISE EXCEPTION 'gl: entity %''s opening balance or start date no longer matches its AR tie-out', v_ev.entity_id USING ERRCODE = 'check_violation';
  END IF;
  IF v_ev.event_date < v_ent.ledger_start_date OR v_ev.event_date > gl_today() THEN
    RAISE EXCEPTION 'gl: % % is dated %, outside the ledger start date .. today', v_ev.kind, v_ev.source_id, v_ev.event_date USING ERRCODE = 'check_violation';
  END IF;

  IF v_ev.kind IN ('charge', 'charge_void') THEN
    SELECT * INTO v_c FROM charges WHERE id = v_ev.source_id;
    v_lease := v_c.lease_id;
    SELECT * INTO v_item FROM gl_ar_tieout_items WHERE kind = 'charge' AND source_id = v_ev.source_id;
  ELSE
    SELECT * INTO v_p FROM payments WHERE id = v_ev.source_id;
    v_lease := v_p.lease_id;
    SELECT * INTO v_item FROM gl_ar_tieout_items WHERE kind = 'payment' AND source_id = v_ev.source_id;
  END IF;
  IF v_lease IS NULL OR v_lease <> v_ev.lease_id OR gl_lease_entity(v_lease) IS DISTINCT FROM v_ev.entity_id THEN
    RAISE EXCEPTION 'gl: % % does not belong to lease % of entity %', v_ev.kind, v_ev.source_id, v_ev.lease_id, v_ev.entity_id USING ERRCODE = 'check_violation';
  END IF;
  IF v_item.source_id IS NOT NULL AND v_item.cents <> gl_exact_cents(coalesce(v_c.amount, v_p.amount)) THEN
    RAISE EXCEPTION 'gl: % % no longer matches its AR tie-out amount', v_ev.kind, v_ev.source_id USING ERRCODE = 'check_violation';
  END IF;

  IF v_ev.kind = 'charge' THEN
    v_date := gl_first_open_date(v_ev.entity_id, v_c.charge_date);
    IF v_c.charge_date < v_ent.ledger_start_date THEN
      RAISE EXCEPTION 'gl: charge % is dated before the ledger start date (it is in the tie-out snapshot)', v_c.id USING ERRCODE = 'check_violation';
    END IF;
    IF v_c.voided_at IS NOT NULL AND gl_central_date(v_c.voided_at) <= v_date THEN
      RAISE EXCEPTION 'gl: charge % was voided before it was live', v_c.id USING ERRCODE = 'check_violation';
    END IF;
  ELSIF v_ev.kind = 'charge_void' THEN
    IF v_item.counted THEN
      v_base := v_ent.ledger_start_date;
    ELSE
      SELECT e.alloc_date INTO v_base FROM gl_ar_cash_events e WHERE e.kind = 'charge' AND e.source_id = v_c.id AND e.seq < v_ev.seq;
    END IF;
    IF v_base IS NULL OR v_c.voided_at IS NULL THEN
      RAISE EXCEPTION 'gl: charge % is not live in the replay, or is not voided', v_c.id USING ERRCODE = 'check_violation';
    END IF;
    v_date := gl_first_open_date(v_ev.entity_id, GREATEST(gl_central_date(v_c.voided_at), v_base));
  ELSIF v_ev.kind = 'payment' THEN
    IF NOT gl_payment_counts(v_p.method, v_p.stripe_status) THEN
      RAISE EXCEPTION 'gl: payment % has not been received (status %)', v_p.id, coalesce(v_p.stripe_status, 'none') USING ERRCODE = 'check_violation';
    END IF;
    IF v_p.payment_date < v_ent.ledger_start_date AND (v_item.source_id IS NULL OR v_item.counted) THEN
      RAISE EXCEPTION 'gl: payment % is in the tie-out snapshot as received, or postdates the tie-out with an earlier date', v_p.id USING ERRCODE = 'check_violation';
    END IF;
    v_date := gl_first_open_date(v_ev.entity_id, GREATEST(v_p.payment_date, v_ent.ledger_start_date));
    -- C3: every charge live by this date is already in the replay.
    IF EXISTS (
      SELECT 1 FROM charges c
       WHERE c.lease_id = v_ev.lease_id AND c.charge_date >= v_ent.ledger_start_date AND c.amount > 0
         AND gl_first_open_date(v_ev.entity_id, c.charge_date) <= v_ev.event_date
         AND (c.voided_at IS NULL OR gl_central_date(c.voided_at) > gl_first_open_date(v_ev.entity_id, c.charge_date))
         AND NOT EXISTS (SELECT 1 FROM gl_ar_cash_events e WHERE e.kind = 'charge' AND e.source_id = c.id AND e.seq < v_ev.seq)) THEN
      RAISE EXCEPTION 'gl: payment % would post before a charge live on its date; post the lease''s charges first', v_p.id USING ERRCODE = 'check_violation';
    END IF;
  ELSE -- payment_return
    IF v_item.counted THEN
      v_base := v_ent.ledger_start_date;
    ELSE
      SELECT e.event_date INTO v_base FROM gl_ar_cash_events e WHERE e.kind = 'payment' AND e.source_id = v_p.id AND e.seq < v_ev.seq;
    END IF;
    IF v_base IS NULL OR v_p.method <> 'ach_stripe' OR v_p.stripe_status NOT IN ('failed', 'returned') THEN
      RAISE EXCEPTION 'gl: payment % is not cash in the replay, or has not failed', v_p.id USING ERRCODE = 'check_violation';
    END IF;
    IF v_p.status_changed_at IS NOT NULL THEN
      v_date := gl_first_open_date(v_ev.entity_id, GREATEST(gl_central_date(v_p.status_changed_at), v_base));
    ELSIF v_ev.event_date < v_base THEN
      v_date := v_base;  -- reported below
    ELSE
      v_date := v_ev.event_date;  -- no recorded status time: any day from the payment's own date
    END IF;
  END IF;
  IF v_ev.event_date <> v_date THEN
    RAISE EXCEPTION 'gl: % % must be dated % (got %)', v_ev.kind, v_ev.source_id, v_date, v_ev.event_date USING ERRCODE = 'check_violation';
  END IF;
  v_date := gl_ar_cash_alloc_date(v_ev.entity_id, v_ev.lease_id, v_ev.event_date, v_ev.seq);
  IF v_ev.alloc_date <> v_date OR v_ev.alloc_date > gl_today() THEN
    RAISE EXCEPTION 'gl: % % must replay on % (got %)', v_ev.kind, v_ev.source_id, v_date, v_ev.alloc_date USING ERRCODE = 'check_violation';
  END IF;

  -- Each leg: exactly its expected lines, account by account, or no entry when it has none.
  FOREACH v_leg IN ARRAY ARRAY['cash', 'alloc'] LOOP
    v_entry_id := NULL;
    SELECT entry_id INTO v_entry_id FROM gl_ar_cash_entries WHERE event_id = v_ev.id AND leg = v_leg;
    IF NOT EXISTS (SELECT 1 FROM gl_ar_cash_expected(v_ev.id, v_leg)) THEN
      IF v_entry_id IS NOT NULL THEN
        RAISE EXCEPTION 'gl: % % changes nothing (% leg) and must post no entry for it', v_ev.kind, v_ev.source_id, v_leg USING ERRCODE = 'check_violation';
      END IF;
      CONTINUE;
    END IF;
    v_date := CASE WHEN v_leg = 'cash' THEN v_ev.event_date ELSE v_ev.alloc_date END;
    SELECT * INTO v_entry FROM gl_journal_entries WHERE id = v_entry_id;
    IF v_entry_id IS NULL OR v_entry.source <> 'ar_posting' OR v_entry.entity_id <> v_ev.entity_id OR v_entry.entry_date <> v_date THEN
      RAISE EXCEPTION 'gl: % % must post an ar_posting entry dated % (% leg)', v_ev.kind, v_ev.source_id, v_date, v_leg USING ERRCODE = 'check_violation';
    END IF;
    SELECT EXISTS (
        SELECT l.account_id, sum(l.debit_cents - l.credit_cents)::bigint FROM gl_journal_lines l WHERE l.entry_id = v_entry_id GROUP BY l.account_id
        EXCEPT SELECT x.account_id, x.net FROM gl_ar_cash_expected(v_ev.id, v_leg) x)
      OR EXISTS (
        SELECT x.account_id, x.net FROM gl_ar_cash_expected(v_ev.id, v_leg) x
        EXCEPT SELECT l.account_id, sum(l.debit_cents - l.credit_cents)::bigint FROM gl_journal_lines l WHERE l.entry_id = v_entry_id GROUP BY l.account_id)
      OR (SELECT count(*) FROM gl_journal_lines WHERE entry_id = v_entry_id) <> (SELECT count(*) FROM gl_ar_cash_expected(v_ev.id, v_leg))
      INTO v_bad;
    IF v_bad THEN
      RAISE EXCEPTION 'gl: % % must post exactly its allocation change, one line per account', v_ev.kind, v_ev.source_id USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
END;
$$;

-- 0028's commit-time trigger function, extended to cash events and their entries.
CREATE OR REPLACE FUNCTION gl_assert_ar_posting() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'gl_ar_postings' THEN
    PERFORM gl_check_ar_posting(NEW.id);
  ELSIF TG_TABLE_NAME = 'gl_ar_cash_events' THEN
    PERFORM gl_check_ar_cash_event(NEW.id);
  ELSIF TG_TABLE_NAME = 'gl_ar_cash_entries' THEN
    PERFORM gl_check_ar_cash_event(NEW.event_id);
  ELSIF TG_TABLE_NAME = 'gl_journal_lines' THEN
    -- REFUTE-6 H2: a line added to a linked AR entry after its link was verified is re-checked.
    IF (SELECT source FROM gl_journal_entries WHERE id = NEW.entry_id) = 'ar_posting' THEN
      FOR v_id IN SELECT id FROM gl_ar_postings WHERE entry_id = NEW.entry_id LOOP
        PERFORM gl_check_ar_posting(v_id);
      END LOOP;
      FOR v_id IN SELECT DISTINCT event_id FROM gl_ar_cash_entries WHERE entry_id = NEW.entry_id LOOP
        PERFORM gl_check_ar_cash_event(v_id);
      END LOOP;
    END IF;
  ELSIF NEW.source = 'reversal'
        AND (SELECT source FROM gl_journal_entries WHERE id = NEW.reverses_entry_id) = 'ar_posting'
        AND NOT EXISTS (SELECT 1 FROM gl_ar_postings WHERE entry_id = NEW.id) THEN
    -- REFUTE-6 H1: an AR posting is undone only by the void or return that posts with it.
    RAISE EXCEPTION 'gl: entry % reverses an AR posting; void the charge or record the payment''s return in the app instead', NEW.reverses_entry_id
      USING ERRCODE = 'check_violation';
  ELSIF NEW.source = 'ar_posting'
        AND NOT EXISTS (SELECT 1 FROM gl_ar_postings WHERE entry_id = NEW.id)
        AND NOT EXISTS (SELECT 1 FROM gl_ar_cash_entries WHERE entry_id = NEW.id) THEN
    -- A4: an ar_posting entry exists only as the target of a verified link.
    RAISE EXCEPTION 'gl: entry % is an AR posting with no AR link', NEW.id USING ERRCODE = 'check_violation';
  ELSIF NEW.source = 'ar_posting'
        AND EXISTS (SELECT 1 FROM gl_ar_postings WHERE entry_id = NEW.id)
        AND EXISTS (SELECT 1 FROM gl_ar_cash_entries WHERE entry_id = NEW.id) THEN
    RAISE EXCEPTION 'gl: entry % is linked as both an accrual and a cash AR posting', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS gl_ar_cash_events_verify ON gl_ar_cash_events;
CREATE CONSTRAINT TRIGGER gl_ar_cash_events_verify
  AFTER INSERT ON gl_ar_cash_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION gl_assert_ar_posting();
DROP TRIGGER IF EXISTS gl_ar_cash_entries_verify ON gl_ar_cash_entries;
CREATE CONSTRAINT TRIGGER gl_ar_cash_entries_verify
  AFTER INSERT ON gl_ar_cash_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION gl_assert_ar_posting();

-- ── C5: 0028's guards, extended ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION gl_ar_held(p_kind TEXT, p_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM gl_ar_postings WHERE source_id = p_id AND kind IN (p_kind, p_kind || '_void', p_kind || '_void_pre', p_kind || '_return', p_kind || '_return_pre'))
      OR EXISTS (SELECT 1 FROM gl_ar_cash_events WHERE source_id = p_id AND kind IN (p_kind, p_kind || '_void', p_kind || '_return'))
      OR EXISTS (SELECT 1 FROM gl_ar_tieout_items WHERE kind = p_kind AND source_id = p_id)
$$;

CREATE OR REPLACE FUNCTION gl_guard_ar_source_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_kind TEXT := CASE WHEN TG_TABLE_NAME = 'charges' THEN 'charge' ELSE 'payment' END;
  v_held BOOLEAN;
BEGIN
  v_held := gl_ar_held(v_kind, OLD.id);
  IF NOT v_held THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'gl: this % is in the general ledger and cannot be deleted; void it instead', v_kind USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_TABLE_NAME = 'charges' THEN
    IF NEW.amount IS DISTINCT FROM OLD.amount OR NEW.charge_date IS DISTINCT FROM OLD.charge_date
       OR NEW.lease_id IS DISTINCT FROM OLD.lease_id OR NEW.type IS DISTINCT FROM OLD.type THEN
      RAISE EXCEPTION 'gl: this charge is in the general ledger; its amount, date, lease and type cannot change (void it and add a new one)' USING ERRCODE = 'restrict_violation';
    END IF;
    -- 0029 C5: on a cash-basis LLC the due date orders the oldest-first allocation.
    IF NEW.due_date IS DISTINCT FROM OLD.due_date
       AND (SELECT accounting_basis FROM gl_entities WHERE id = gl_lease_entity(OLD.lease_id)) = 'cash' THEN
      RAISE EXCEPTION 'gl: this charge is in a cash-basis general ledger; its due date cannot change (void it and add a new one)' USING ERRCODE = 'restrict_violation';
    END IF;
    -- REFUTE-6 M3: a void is final once the ledger holds the charge (re-bill with a new charge).
    IF OLD.voided_at IS NOT NULL AND NEW.voided_at IS DISTINCT FROM OLD.voided_at THEN
      RAISE EXCEPTION 'gl: this charge is in the general ledger and voided; the void cannot be undone or re-dated (add a new charge)' USING ERRCODE = 'restrict_violation';
    END IF;
  ELSE
    IF NEW.amount IS DISTINCT FROM OLD.amount OR NEW.payment_date IS DISTINCT FROM OLD.payment_date
       OR NEW.lease_id IS DISTINCT FROM OLD.lease_id OR NEW.method IS DISTINCT FROM OLD.method THEN
      RAISE EXCEPTION 'gl: this payment is in the general ledger; its amount, date, lease and method cannot change' USING ERRCODE = 'restrict_violation';
    END IF;
    -- REFUTE-6 M3: failed, returned and canceled are final (as in stripe-events.ts).
    IF OLD.stripe_status IN ('failed', 'returned', 'canceled') AND NEW.stripe_status IS DISTINCT FROM OLD.stripe_status THEN
      RAISE EXCEPTION 'gl: this payment is in the general ledger as %; that status is final', OLD.stripe_status USING ERRCODE = 'restrict_violation';
    END IF;
    -- REFUTE-7 L: received cash leaves only by failing or being returned (a canceled payment never
    -- arrived, so it could never post its return).
    IF OLD.stripe_status = 'succeeded' AND NEW.stripe_status = 'canceled' THEN
      RAISE EXCEPTION 'gl: this payment is in the general ledger as received; it can fail or be returned, not be canceled' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

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
    ELSE 'income' END;
  IF v_type IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION 'gl: the % role needs an % account (got %)', NEW.role, v_want, coalesce(v_type, 'none') USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ── C4: the tie-out, for both bases ────────────────────────────────────────────────────────────
-- REFUTE-7 H2/H3: a tie-out and its snapshot items are written in one transaction and re-verified
-- at commit against the source rows, so a race or a direct INSERT cannot leave items the totals
-- did not count (they would seed the cash replay with cash or charges the ledger never had).
ALTER TABLE gl_ar_tieouts ADD COLUMN IF NOT EXISTS created_txid BIGINT;

CREATE OR REPLACE FUNCTION gl_stamp_ar_tieout() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'gl_ar_tieouts' THEN
    NEW.created_txid := pg_catalog.txid_current();
  ELSIF NOT EXISTS (SELECT 1 FROM gl_ar_tieouts t WHERE t.entity_id = NEW.entity_id AND t.created_txid = pg_catalog.txid_current()) THEN
    RAISE EXCEPTION 'gl: AR tie-out items are written only with their tie-out, by gl_confirm_ar_tieout' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS gl_ar_tieouts_stamp ON gl_ar_tieouts;
CREATE TRIGGER gl_ar_tieouts_stamp BEFORE INSERT ON gl_ar_tieouts FOR EACH ROW EXECUTE FUNCTION gl_stamp_ar_tieout();
DROP TRIGGER IF EXISTS gl_ar_tieout_items_stamp ON gl_ar_tieout_items;
CREATE TRIGGER gl_ar_tieout_items_stamp BEFORE INSERT ON gl_ar_tieout_items FOR EACH ROW EXECUTE FUNCTION gl_stamp_ar_tieout();

-- Every pre-start charge and payment of an entity and whether it counted as of p_as_of.
CREATE OR REPLACE FUNCTION gl_ar_tieout_source(p_entity_id UUID, p_as_of DATE)
  RETURNS TABLE (kind TEXT, source_id UUID, lease_id UUID, cents BIGINT, counted BOOLEAN)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT 'charge'::text, c.id, c.lease_id, gl_exact_cents(c.amount), (c.voided_at IS NULL OR gl_central_date(c.voided_at) > p_as_of)
    FROM charges c WHERE c.charge_date <= p_as_of AND gl_lease_entity(c.lease_id) = p_entity_id
  UNION ALL
  SELECT 'payment'::text, p.id, p.lease_id, gl_exact_cents(p.amount), gl_payment_counted_as_of(p.method, p.stripe_status, p.status_changed_at, p_as_of)
    FROM payments p WHERE p.payment_date <= p_as_of AND gl_lease_entity(p.lease_id) = p_entity_id
$$;

-- Re-verifies a tie-out from scratch: start date and opening balance, the snapshot equal to the
-- source rows, the totals, and (cash basis) paid pre-start deposits = the deposits account.
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
    RAISE EXCEPTION 'gl: the AR tie-out snapshot does not match the pre-start charges and payments (one changed meanwhile); confirm the tie-out again'
      USING ERRCODE = 'check_violation';
  END IF;
  v_ctl := gl_ar_account(p_entity_id, CASE WHEN v_ent.accounting_basis = 'accrual' THEN 'ar' ELSE 'prepaid_rent' END);
  IF v_ent.accounting_basis = 'accrual' THEN
    SELECT coalesce(sum(CASE WHEN s.kind = 'charge' THEN s.cents ELSE -s.cents END) FILTER (WHERE s.counted), 0) INTO v_app
      FROM gl_ar_tieout_source(p_entity_id, v_tie.as_of) s;
    SELECT coalesce(sum(l.debit_cents - l.credit_cents), 0) INTO v_gl
      FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = v_ctl AND e.entity_id = p_entity_id AND e.entry_date <= v_tie.as_of;
  ELSE
    SELECT coalesce(sum(GREATEST(0, x.cash - x.billed)), 0) INTO v_app FROM (
      SELECT s.lease_id,
             coalesce(sum(s.cents) FILTER (WHERE s.kind = 'payment' AND s.counted), 0) AS cash,
             coalesce(sum(s.cents) FILTER (WHERE s.kind = 'charge' AND s.counted), 0) AS billed
        FROM gl_ar_tieout_source(p_entity_id, v_tie.as_of) s GROUP BY s.lease_id) x;
    SELECT coalesce(sum(l.credit_cents - l.debit_cents), 0) INTO v_gl
      FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = v_ctl AND e.entity_id = p_entity_id AND e.entry_date <= v_tie.as_of;
  END IF;
  IF v_app <> v_tie.app_ar_cents OR v_gl <> v_tie.gl_ar_cents OR v_app <> v_gl THEN
    RAISE EXCEPTION 'gl: the AR tie-out totals do not match the snapshot and the ledger (app % / ledger % cents)', v_app, v_gl USING ERRCODE = 'check_violation';
  END IF;
  IF v_ent.accounting_basis = 'cash' THEN
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

CREATE OR REPLACE FUNCTION gl_assert_ar_tieout() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM gl_check_ar_tieout(NEW.entity_id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS gl_ar_tieouts_verify ON gl_ar_tieouts;
CREATE CONSTRAINT TRIGGER gl_ar_tieouts_verify
  AFTER INSERT ON gl_ar_tieouts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION gl_assert_ar_tieout();

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

  IF v_ent.accounting_basis = 'accrual' THEN
    -- Open AR: counted charges less counted payments, across the entity.
    v_what := 'open AR';
    SELECT coalesce(sum(CASE WHEN s.kind = 'charge' THEN s.cents ELSE -s.cents END) FILTER (WHERE s.counted), 0) INTO v_app
      FROM gl_ar_tieout_source(p_entity_id, v_as_of) s;
    SELECT coalesce(sum(l.debit_cents - l.credit_cents), 0) INTO v_gl
      FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = v_ctl AND e.entity_id = p_entity_id AND e.entry_date <= v_as_of;
  ELSE
    -- Tenant credits: per lease, counted cash beyond counted charges (never netted across leases).
    v_what := 'tenant credits';
    SELECT coalesce(sum(GREATEST(0, x.cash - x.billed)), 0) INTO v_app FROM (
      SELECT s.lease_id,
             coalesce(sum(s.cents) FILTER (WHERE s.kind = 'payment' AND s.counted), 0) AS cash,
             coalesce(sum(s.cents) FILTER (WHERE s.kind = 'charge' AND s.counted), 0) AS billed
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

-- ── Write path: one batch, all or nothing ──────────────────────────────────────────────────────
-- p_items: JSON array of {"kind": ..., "source_id": uuid}, in replay order. The database dates
-- each event, computes its allocation change and builds its entry; callers choose only WHAT.
CREATE OR REPLACE FUNCTION gl_post_ar_cash_batch(p_entity_id UUID, p_through DATE, p_items JSONB, p_posted_by TEXT) RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ent gl_entities%ROWTYPE;
  v_tie gl_ar_tieouts%ROWTYPE;
  v_item JSONB;
  v_kind TEXT;
  v_src UUID;
  v_c charges%ROWTYPE;
  v_p payments%ROWTYPE;
  v_lease UUID;
  v_base DATE;
  v_date DATE;
  v_ev UUID;
  v_alloc DATE;
  v_leg TEXT;
  v_entry UUID;
  v_line INTEGER;
  v_x RECORD;
  v_memo TEXT;
  v_n INTEGER := 0;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'gl: post cash-basis AR only at READ COMMITTED isolation' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT * INTO v_ent FROM gl_entities WHERE id = p_entity_id FOR UPDATE;  -- one AR batch per entity at a time
  IF NOT FOUND THEN RAISE EXCEPTION 'gl: entity % not found', p_entity_id USING ERRCODE = 'no_data_found'; END IF;
  IF v_ent.accounting_basis <> 'cash' THEN
    RAISE EXCEPTION 'gl: this entity is accrual-basis; post its AR with gl_post_ar_batch' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_tie FROM gl_ar_tieouts WHERE entity_id = p_entity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gl: confirm the AR tie-out before posting AR for this entity' USING ERRCODE = 'check_violation';
  END IF;
  IF p_through IS NULL OR p_through < v_ent.ledger_start_date OR p_through > gl_today() THEN
    RAISE EXCEPTION 'gl: post AR through a date between the ledger start date and today' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: items must be a JSON array' USING ERRCODE = 'check_violation';
  END IF;
  SET CONSTRAINTS gl_journal_entries_balanced, gl_journal_lines_balanced, gl_journal_entries_ar_linked, gl_journal_lines_ar_verify, gl_ar_cash_events_verify, gl_ar_cash_entries_verify DEFERRED;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_kind := v_item OPERATOR(pg_catalog.->>) 'kind'::text;
    v_src := (v_item OPERATOR(pg_catalog.->>) 'source_id'::text)::uuid;
    IF v_kind IN ('charge', 'charge_void') THEN
      SELECT * INTO v_c FROM charges WHERE id = v_src FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'gl: charge % not found', v_src USING ERRCODE = 'no_data_found'; END IF;
      v_lease := v_c.lease_id;
      IF v_kind = 'charge' THEN
        v_date := gl_first_open_date(p_entity_id, v_c.charge_date);
        v_memo := 'Charge ' || v_c.type || coalesce(': ' || v_c.description, '');
      ELSE
        v_base := CASE WHEN EXISTS (SELECT 1 FROM gl_ar_tieout_items WHERE kind = 'charge' AND source_id = v_src AND counted) THEN v_ent.ledger_start_date
                       ELSE (SELECT alloc_date FROM gl_ar_cash_events WHERE kind = 'charge' AND source_id = v_src) END;
        v_date := gl_first_open_date(p_entity_id, GREATEST(gl_central_date(v_c.voided_at), v_base));
        v_memo := 'Charge voided: ' || v_c.type || coalesce(': ' || v_c.void_reason, '');
      END IF;
    ELSIF v_kind IN ('payment', 'payment_return') THEN
      SELECT * INTO v_p FROM payments WHERE id = v_src FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'gl: payment % not found', v_src USING ERRCODE = 'no_data_found'; END IF;
      v_lease := v_p.lease_id;
      IF v_kind = 'payment' THEN
        v_date := gl_first_open_date(p_entity_id, GREATEST(v_p.payment_date, v_ent.ledger_start_date));
        v_memo := 'Payment (' || v_p.method || ')';
      ELSE
        v_base := CASE WHEN EXISTS (SELECT 1 FROM gl_ar_tieout_items WHERE kind = 'payment' AND source_id = v_src AND counted) THEN v_ent.ledger_start_date
                       ELSE (SELECT event_date FROM gl_ar_cash_events WHERE kind = 'payment' AND source_id = v_src) END;
        v_date := gl_first_open_date(p_entity_id, GREATEST(coalesce(gl_central_date(v_p.status_changed_at), p_through), v_base));
        v_memo := 'Payment ' || coalesce(v_p.stripe_status, 'failed');
      END IF;
    ELSE
      RAISE EXCEPTION 'gl: unknown cash AR event kind %', coalesce(v_kind, '(none)') USING ERRCODE = 'check_violation';
    END IF;
    v_alloc := gl_ar_cash_alloc_date(p_entity_id, v_lease, v_date, 9223372036854775807);
    IF v_date IS NULL OR v_alloc > p_through THEN
      RAISE EXCEPTION 'gl: % % is not live, or replays after the run''s through date %', v_kind, v_src, p_through USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO gl_ar_cash_events (entity_id, lease_id, kind, source_id, event_date, alloc_date, posted_by, seq)
      VALUES (p_entity_id, v_lease, v_kind, v_src, v_date, v_alloc, p_posted_by, 0) RETURNING id INTO v_ev;
    FOREACH v_leg IN ARRAY ARRAY['cash', 'alloc'] LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM gl_ar_cash_expected(v_ev, v_leg));
      INSERT INTO gl_journal_entries (entity_id, entry_date, memo, source, posted_by)
        VALUES (p_entity_id, CASE WHEN v_leg = 'cash' THEN v_date ELSE v_alloc END,
                v_memo || CASE WHEN v_leg = 'cash' THEN ' (cash, applied ' || v_alloc || ')' ELSE '' END, 'ar_posting', p_posted_by)
        RETURNING id INTO v_entry;
      v_line := 0;
      FOR v_x IN SELECT x.account_id, x.net FROM gl_ar_cash_expected(v_ev, v_leg) x ORDER BY x.net DESC, x.account_id LOOP
        v_line := v_line + 1;
        INSERT INTO gl_journal_lines (entry_id, entity_id, account_id, line_no, debit_cents, credit_cents)
          VALUES (v_entry, p_entity_id, v_x.account_id, v_line, GREATEST(v_x.net, 0), GREATEST(-v_x.net, 0));
      END LOOP;
      INSERT INTO gl_ar_cash_entries (event_id, leg, entity_id, entry_id) VALUES (v_ev, v_leg, p_entity_id, v_entry);
    END LOOP;
    v_n := v_n + 1;
  END LOOP;

  -- Surface any failure from this call, then restore deferral (REFUTE D5).
  SET CONSTRAINTS gl_journal_entries_balanced, gl_journal_lines_balanced, gl_journal_entries_ar_linked, gl_journal_lines_ar_verify, gl_ar_cash_events_verify, gl_ar_cash_entries_verify IMMEDIATE;
  SET CONSTRAINTS gl_journal_entries_balanced, gl_journal_lines_balanced, gl_journal_entries_ar_linked, gl_journal_lines_ar_verify, gl_ar_cash_events_verify, gl_ar_cash_entries_verify DEFERRED;
  RETURN v_n;
END;
$$;

-- 0028's accrual readiness check, now pointing a cash-basis entity at its own path.
CREATE OR REPLACE FUNCTION gl_assert_ar_ready(p_entity_id UUID) RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ent gl_entities%ROWTYPE;
  v_tie gl_ar_tieouts%ROWTYPE;
BEGIN
  SELECT * INTO v_ent FROM gl_entities WHERE id = p_entity_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'gl: entity % not found', p_entity_id USING ERRCODE = 'no_data_found'; END IF;
  IF v_ent.accounting_basis <> 'accrual' THEN
    RAISE EXCEPTION 'gl: entity % is cash-basis; its AR posts through gl_post_ar_cash_batch', p_entity_id USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_tie FROM gl_ar_tieouts WHERE entity_id = p_entity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gl: confirm the AR tie-out before posting AR for entity %', p_entity_id USING ERRCODE = 'check_violation';
  END IF;
  IF v_ent.ledger_start_date IS DISTINCT FROM v_tie.as_of + 1
     OR EXISTS (SELECT 1 FROM gl_journal_entries r WHERE r.reverses_entry_id = v_tie.opening_entry_id) THEN
    RAISE EXCEPTION 'gl: entity %''s opening balance or start date no longer matches its AR tie-out', p_entity_id USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

-- ── Access (0023 pattern) ─────────────────────────────────────────────────────────────────────
ALTER TABLE gl_ar_cash_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE gl_ar_cash_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON gl_ar_cash_events, gl_ar_cash_entries FROM PUBLIC, anon, authenticated;
REVOKE TRIGGER, TRUNCATE, REFERENCES, UPDATE, DELETE ON gl_ar_cash_events, gl_ar_cash_entries FROM service_role;
REVOKE ALL ON SEQUENCE gl_ar_cash_events_seq FROM PUBLIC, anon, authenticated;
REVOKE UPDATE ON SEQUENCE gl_ar_cash_events_seq FROM service_role;  -- no setval: seq cannot be rewound
GRANT USAGE ON SEQUENCE gl_ar_cash_events_seq TO service_role;
DO $$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON gl_ar_cash_events, gl_ar_cash_entries FROM service_role';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION gl_post_ar_cash_batch(UUID, DATE, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_check_ar_cash_event(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_ar_cash_expected(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_ar_cash_alloc_date(UUID, UUID, DATE, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_ar_cash_alloc(UUID, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_ar_cash_priority(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_ar_tieout_source(UUID, DATE) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_confirm_ar_tieout(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_ar_held(TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_check_ar_tieout(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION gl_post_ar_cash_batch(UUID, DATE, JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION gl_check_ar_cash_event(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION gl_ar_cash_expected(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION gl_ar_cash_alloc_date(UUID, UUID, DATE, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION gl_ar_cash_alloc(UUID, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION gl_ar_cash_priority(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION gl_ar_tieout_source(UUID, DATE) TO service_role;
GRANT EXECUTE ON FUNCTION gl_confirm_ar_tieout(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION gl_ar_held(TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION gl_check_ar_tieout(UUID) TO service_role;
