-- 0028: B8 slice 3 — post tenant charges and payments into the native ledger (accrual LLCs).
--
-- Ratified 2026-11-11: batch "post through <date>" runs per LLC with a preview; payments debit
-- Undeposited Funds (bank import matches deposits later); hard AR tie-out gate; cash-basis LLCs
-- (oldest-charges-first split) follow in their own PR — this migration refuses them for now.
--
-- What posts (accrual), each at most once (gl_ar_postings UNIQUE(kind, source_id)):
--   charge          Dr AR / Cr the charge type's mapped account   dated charge_date
--   charge_void     reversal of the charge's entry                 dated the void (US Central)
--   charge_void_pre a void of a charge dated before the start date (its AR came in with the opening
--                   balance): Dr the mapped account / Cr AR        dated the void
--   payment         Dr Undeposited Funds / Cr AR                    dated payment_date (or the start
--                   date, for a pre-start payment that had not cleared at the tie-out)
--   payment_return  reversal of the payment's entry                 dated when it failed/returned
--   payment_return_pre  a return of a payment counted in the tie-out: Dr AR / Cr Undeposited Funds
--
-- Money rules, enforced in the database (direct service_role SQL included):
--   A1. Account roles (gl_ar_accounts): ar and undeposited_funds are asset accounts,
--       security_deposit and prepaid_rent are liabilities, every charge type is income, all in the
--       entity's own chart. ar and undeposited_funds are fixed once anything has posted.
--   A2. Tie-out gate (gl_confirm_ar_tieout): for an accrual LLC, the app's open AR as of the day
--       before its ledger start date must equal the AR account's balance in the ledger (its opening
--       balance) to the cent. It snapshots every pre-start charge and payment and whether it was
--       counted, so later activity dated before the start can never be double-counted or missed.
--   A3. Every AR posting is verified against its source at commit (deferred constraint trigger):
--       entity (via lease → unit → property), date, amount in exact cents, and exactly the lines
--       its kind implies, or the exact reversal of the posting it undoes. A link row cannot point
--       at a hand-made entry.
--   A4. Nothing posts without a tie-out, a ledger start date and a live opening balance; nothing
--       posts after gl_today() or the run's through date; gl_journal_entries.source gains
--       'ar_posting', and an ar_posting entry must be linked from gl_ar_postings at commit.
--   A5. gl_ar_postings, gl_ar_tieouts and gl_ar_tieout_items are insert-only.
--   A6. A charge or payment that is posted or counted at the tie-out cannot change its amount,
--       date, lease or type/method, or be deleted (void it; Stripe status changes still flow).
--       A property's ledger entity is fixed once any of its AR is tied out or posted.
--   payments.status_changed_at records when stripe_status last changed (a return is dated by it).
--
-- REFUTE-6 (adversarial pass on PR #83) added:
--   C1  the tie-out records the opening-balance entry it measured; while it exists that entry cannot
--       be reversed and the entity's start date and basis cannot change; every posting re-checks it.
--   H1  an AR entry is reversed only by the void/return posting linked in the same transaction.
--   H2  lines added to an AR entry are re-verified at commit (gl_journal_lines_ar_verify).
--   H3  activity dated in a locked month posts on the first day of the next open month
--       (gl_first_open_date; the planner mirrors it).
--   H4  a unit or lease (as well as a property) cannot move to another LLC once its AR is held.
--   H5  the ar and undeposited_funds accounts are fixed from the tie-out on.
--   M1  the tie-out holds the pre-start rows FOR SHARE; pre-start postings must match the snapshot
--       amount. M2 no temp table. M3 a held charge's void and a held payment's failed/returned/
--       canceled status are final. M4 a payment's tie-out status is its status as of as_of.
--   L1  reversal dates and gl_today() are verified. L3 status_changed_at is stamped on insert too.
--
-- ORDERING: requires 0023 and 0027. Re-runnable. Every function pins search_path = public,
-- pg_temp and qualifies pg_catalog functions an overload could capture (REFUTE passes 3–5).

-- ── payments.status_changed_at ─────────────────────────────────────────────────────────────────
ALTER TABLE payments ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION payments_stamp_status_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Server time only: a caller cannot backdate (or postdate) when a status changed (REFUTE-6 L3).
  IF TG_OP = 'INSERT' THEN
    NEW.status_changed_at := CASE WHEN NEW.stripe_status IS NULL THEN NULL ELSE now() END;
  ELSIF NEW.stripe_status IS DISTINCT FROM OLD.stripe_status THEN
    NEW.status_changed_at := now();
  ELSE
    NEW.status_changed_at := OLD.status_changed_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payments_status_changed_at ON payments;
CREATE TRIGGER payments_status_changed_at
  BEFORE INSERT OR UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_stamp_status_change();

-- ── journal source 'ar_posting' ────────────────────────────────────────────────────────────────
ALTER TABLE gl_journal_entries DROP CONSTRAINT IF EXISTS gl_journal_entries_source_check;
ALTER TABLE gl_journal_entries ADD CONSTRAINT gl_journal_entries_source_check
  CHECK (source IN ('manual', 'reversal', 'opening_balance', 'ar_posting'));

-- ── A1: account roles ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gl_ar_accounts (
  entity_id UUID NOT NULL REFERENCES gl_entities(id),
  role TEXT NOT NULL
    CONSTRAINT gl_ar_accounts_role_check CHECK (role IN (
      'ar', 'undeposited_funds', 'prepaid_rent',
      'rent', 'cam_estimate', 'cam_true_up', 'late_fee', 'security_deposit',
      'utility_water', 'utility_gas', 'utility_electric', 'utility_other', 'percentage_rent', 'other')),
  account_id UUID NOT NULL,
  updated_by TEXT NOT NULL CONSTRAINT gl_ar_accounts_updated_by_nonempty CHECK (btrim(updated_by) <> ''),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entity_id, role),
  CONSTRAINT gl_ar_accounts_account_fk FOREIGN KEY (entity_id, account_id) REFERENCES gl_accounts (entity_id, id)
);

CREATE OR REPLACE FUNCTION gl_guard_ar_account() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_type TEXT;
  v_want TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.role IN ('ar', 'undeposited_funds') AND (EXISTS (SELECT 1 FROM gl_ar_postings WHERE entity_id = OLD.entity_id)
                                                    OR EXISTS (SELECT 1 FROM gl_ar_tieouts WHERE entity_id = OLD.entity_id)) THEN
      RAISE EXCEPTION 'gl: the % account is fixed once the AR tie-out is confirmed for this entity', OLD.role USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.entity_id <> OLD.entity_id OR NEW.role <> OLD.role) THEN
    RAISE EXCEPTION 'gl: an AR account mapping''s entity and role cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  -- REFUTE-6 H5: fixed from the tie-out on (the opening AR sits in that account).
  IF TG_OP = 'UPDATE' AND NEW.account_id <> OLD.account_id AND NEW.role IN ('ar', 'undeposited_funds')
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

-- ── A5 tables ──────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gl_ar_tieouts (
  entity_id UUID PRIMARY KEY REFERENCES gl_entities(id),
  as_of DATE NOT NULL,
  app_ar_cents BIGINT NOT NULL,
  gl_ar_cents BIGINT NOT NULL,
  -- The live opening balance this tie-out was measured against (REFUTE-6 C1): every posting
  -- requires it still live and the start date still as_of + 1.
  opening_entry_id UUID NOT NULL,
  confirmed_by TEXT NOT NULL CONSTRAINT gl_ar_tieouts_by_nonempty CHECK (btrim(confirmed_by) <> ''),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT gl_ar_tieouts_ties CHECK (app_ar_cents = gl_ar_cents),
  CONSTRAINT gl_ar_tieouts_opening_fk FOREIGN KEY (entity_id, opening_entry_id) REFERENCES gl_journal_entries (entity_id, id)
);

CREATE TABLE IF NOT EXISTS gl_ar_tieout_items (
  entity_id UUID NOT NULL REFERENCES gl_ar_tieouts(entity_id),
  kind TEXT NOT NULL CONSTRAINT gl_ar_tieout_items_kind_check CHECK (kind IN ('charge', 'payment')),
  source_id UUID NOT NULL,
  cents BIGINT NOT NULL,
  counted BOOLEAN NOT NULL,
  PRIMARY KEY (kind, source_id)
);

CREATE TABLE IF NOT EXISTS gl_ar_postings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL,
  kind TEXT NOT NULL CONSTRAINT gl_ar_postings_kind_check CHECK (kind IN (
    'charge', 'charge_void', 'charge_void_pre', 'payment', 'payment_return', 'payment_return_pre')),
  source_id UUID NOT NULL,
  entry_id UUID NOT NULL,
  posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT gl_ar_postings_once UNIQUE (kind, source_id),
  CONSTRAINT gl_ar_postings_entry_once UNIQUE (entry_id),
  CONSTRAINT gl_ar_postings_entry_fk FOREIGN KEY (entity_id, entry_id) REFERENCES gl_journal_entries (entity_id, id)
);
CREATE INDEX IF NOT EXISTS gl_ar_postings_entity_idx ON gl_ar_postings (entity_id);

DROP TRIGGER IF EXISTS gl_ar_accounts_guard ON gl_ar_accounts;
CREATE TRIGGER gl_ar_accounts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON gl_ar_accounts
  FOR EACH ROW EXECUTE FUNCTION gl_guard_ar_account();

DROP TRIGGER IF EXISTS gl_ar_postings_immutable ON gl_ar_postings;
CREATE TRIGGER gl_ar_postings_immutable BEFORE UPDATE OR DELETE ON gl_ar_postings FOR EACH ROW EXECUTE FUNCTION gl_reject_change();
DROP TRIGGER IF EXISTS gl_ar_postings_no_truncate ON gl_ar_postings;
CREATE TRIGGER gl_ar_postings_no_truncate BEFORE TRUNCATE ON gl_ar_postings FOR EACH STATEMENT EXECUTE FUNCTION gl_reject_truncate();
DROP TRIGGER IF EXISTS gl_ar_tieouts_immutable ON gl_ar_tieouts;
CREATE TRIGGER gl_ar_tieouts_immutable BEFORE UPDATE OR DELETE ON gl_ar_tieouts FOR EACH ROW EXECUTE FUNCTION gl_reject_change();
DROP TRIGGER IF EXISTS gl_ar_tieouts_no_truncate ON gl_ar_tieouts;
CREATE TRIGGER gl_ar_tieouts_no_truncate BEFORE TRUNCATE ON gl_ar_tieouts FOR EACH STATEMENT EXECUTE FUNCTION gl_reject_truncate();
DROP TRIGGER IF EXISTS gl_ar_tieout_items_immutable ON gl_ar_tieout_items;
CREATE TRIGGER gl_ar_tieout_items_immutable BEFORE UPDATE OR DELETE ON gl_ar_tieout_items FOR EACH ROW EXECUTE FUNCTION gl_reject_change();
DROP TRIGGER IF EXISTS gl_ar_tieout_items_no_truncate ON gl_ar_tieout_items;
CREATE TRIGGER gl_ar_tieout_items_no_truncate BEFORE TRUNCATE ON gl_ar_tieout_items FOR EACH STATEMENT EXECUTE FUNCTION gl_reject_truncate();

-- ── helpers ───────────────────────────────────────────────────────────────────────────────────
-- Exact cents for a NUMERIC dollar amount; refuses fractions of a cent.
CREATE OR REPLACE FUNCTION gl_exact_cents(p_amount NUMERIC) RETURNS BIGINT
LANGUAGE plpgsql IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_amount IS NULL OR p_amount * 100 <> pg_catalog.trunc(p_amount * 100) THEN
    RAISE EXCEPTION 'gl: amount % is not a whole number of cents', p_amount USING ERRCODE = 'check_violation';
  END IF;
  RETURN (p_amount * 100)::bigint;
END;
$$;

-- The US Central calendar day of a timestamp (matches gl_today()).
CREATE OR REPLACE FUNCTION gl_central_date(p_ts TIMESTAMPTZ) RETURNS DATE
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$ SELECT (p_ts AT TIME ZONE 'America/Chicago')::date $$;

-- The ledger entity a lease belongs to (lease → unit → property), or NULL.
CREATE OR REPLACE FUNCTION gl_lease_entity(p_lease_id UUID) RETURNS UUID
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT p.gl_entity_id FROM leases l JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id WHERE l.id = p_lease_id
$$;

-- A payment counts as received: ACH once Stripe says succeeded; check, wire and other on entry.
CREATE OR REPLACE FUNCTION gl_payment_counts(p_method TEXT, p_status TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$ SELECT CASE WHEN p_method = 'ach_stripe' THEN p_status = 'succeeded' ELSE true END $$;

-- REFUTE-6 M4: was a payment counted as received on p_as_of? Its status then is its current one
-- if that status was set on or before p_as_of (or before 0028 stamped changes). For a status set
-- later: succeeded means it cleared later (not counted); returned or disputed mean it had cleared
-- (counted; the return posts later); failed or anything in flight means it had not. A wrong guess
-- makes the tie-out fail to tie, visibly; it cannot post anything by itself.
CREATE OR REPLACE FUNCTION gl_payment_counted_as_of(p_method TEXT, p_status TEXT, p_changed_at TIMESTAMPTZ, p_as_of DATE) RETURNS BOOLEAN
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_method <> 'ach_stripe' THEN true
    WHEN p_changed_at IS NULL OR gl_central_date(p_changed_at) <= p_as_of THEN coalesce(p_status = 'succeeded', false)
    ELSE coalesce(p_status IN ('returned', 'disputed'), false) END
$$;

-- REFUTE-6 H3: the first date on or after p_date whose month is not locked (a locked month's
-- activity posts on the first day of the next open month, as any late prior-period item does).
CREATE OR REPLACE FUNCTION gl_first_open_date(p_entity_id UUID, p_date DATE) RETURNS DATE
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE v DATE := p_date;
BEGIN
  WHILE EXISTS (SELECT 1 FROM gl_periods WHERE entity_id = p_entity_id AND status = 'locked'
                   AND period_start = pg_catalog.date_trunc('month', (v)::timestamp)::date) LOOP
    v := (pg_catalog.date_trunc('month', (v)::timestamp) + interval '1 month')::date;
  END LOOP;
  RETURN v;
END;
$$;

-- Is this charge or payment in the ledger (posted, or snapshotted at the tie-out)?
CREATE OR REPLACE FUNCTION gl_ar_held(p_kind TEXT, p_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM gl_ar_postings WHERE source_id = p_id AND kind IN (p_kind, p_kind || '_void', p_kind || '_void_pre', p_kind || '_return', p_kind || '_return_pre'))
      OR EXISTS (SELECT 1 FROM gl_ar_tieout_items WHERE kind = p_kind AND source_id = p_id)
$$;

CREATE OR REPLACE FUNCTION gl_lease_ar_held(p_lease_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM charges c WHERE c.lease_id = p_lease_id AND gl_ar_held('charge', c.id))
      OR EXISTS (SELECT 1 FROM payments p WHERE p.lease_id = p_lease_id AND gl_ar_held('payment', p.id))
$$;

-- REFUTE-6 C1: AR may post only while the tie-out still describes the ledger: accrual basis, the
-- tied opening balance still live, and the start date still the day after the tie-out.
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
    RAISE EXCEPTION 'gl: AR posting for cash-basis entities is not available yet' USING ERRCODE = 'feature_not_supported';
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

CREATE OR REPLACE FUNCTION gl_ar_account(p_entity_id UUID, p_role TEXT) RETURNS UUID
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE v UUID;
BEGIN
  SELECT account_id INTO v FROM gl_ar_accounts WHERE entity_id = p_entity_id AND role = p_role;
  IF v IS NULL THEN
    RAISE EXCEPTION 'gl: map an account to the % role before posting AR for this entity', p_role USING ERRCODE = 'check_violation';
  END IF;
  RETURN v;
END;
$$;

-- ── A2: tie-out gate ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION gl_confirm_ar_tieout(p_entity_id UUID, p_confirmed_by TEXT) RETURNS BIGINT
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ent gl_entities%ROWTYPE;
  v_as_of DATE;
  v_ar UUID;
  v_app BIGINT;
  v_gl BIGINT;
  v_ob UUID;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'gl: confirm the AR tie-out only at READ COMMITTED isolation' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT * INTO v_ent FROM gl_entities WHERE id = p_entity_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'gl: entity % not found', p_entity_id USING ERRCODE = 'no_data_found'; END IF;
  IF v_ent.accounting_basis <> 'accrual' THEN
    RAISE EXCEPTION 'gl: AR posting for cash-basis entities is not available yet' USING ERRCODE = 'feature_not_supported';
  END IF;
  IF v_ent.ledger_start_date IS NULL OR NOT EXISTS (
    SELECT 1 FROM gl_journal_entries o WHERE o.entity_id = p_entity_id AND o.source = 'opening_balance'
       AND NOT EXISTS (SELECT 1 FROM gl_journal_entries r WHERE r.reverses_entry_id = o.id)) THEN
    RAISE EXCEPTION 'gl: post the entity''s opening balance before confirming the AR tie-out' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM gl_ar_tieouts WHERE entity_id = p_entity_id) THEN
    RAISE EXCEPTION 'gl: the AR tie-out for entity % is already confirmed', p_entity_id USING ERRCODE = 'unique_violation';
  END IF;
  v_as_of := v_ent.ledger_start_date - 1;
  v_ar := gl_ar_account(p_entity_id, 'ar');

  SELECT o.id INTO v_ob FROM gl_journal_entries o
   WHERE o.entity_id = p_entity_id AND o.source = 'opening_balance'
     AND NOT EXISTS (SELECT 1 FROM gl_journal_entries r WHERE r.reverses_entry_id = o.id);

  -- REFUTE-6 M1: hold every pre-start charge and payment so an in-flight edit either commits first
  -- (and is read here) or waits and then meets the snapshot guard.
  PERFORM 1 FROM charges c WHERE c.charge_date <= v_as_of AND gl_lease_entity(c.lease_id) = p_entity_id FOR SHARE;
  PERFORM 1 FROM payments p WHERE p.payment_date <= v_as_of AND gl_lease_entity(p.lease_id) = p_entity_id FOR SHARE;

  -- Open AR in the app as of v_as_of: charges dated on or before it and not voided by then, less
  -- payments dated on or before it that had been received by then. (REFUTE-6 M2: no temp table.)
  SELECT coalesce(sum(CASE WHEN x.kind = 'charge' THEN x.cents ELSE -x.cents END) FILTER (WHERE x.counted), 0) INTO v_app
    FROM (
      SELECT 'charge' AS kind, gl_exact_cents(c.amount) AS cents, (c.voided_at IS NULL OR gl_central_date(c.voided_at) > v_as_of) AS counted
        FROM charges c WHERE c.charge_date <= v_as_of AND gl_lease_entity(c.lease_id) = p_entity_id
      UNION ALL
      SELECT 'payment', gl_exact_cents(p.amount), gl_payment_counted_as_of(p.method, p.stripe_status, p.status_changed_at, v_as_of)
        FROM payments p WHERE p.payment_date <= v_as_of AND gl_lease_entity(p.lease_id) = p_entity_id
    ) x;
  SELECT coalesce(sum(l.debit_cents - l.credit_cents), 0) INTO v_gl
    FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.entry_id
   WHERE l.account_id = v_ar AND e.entity_id = p_entity_id AND e.entry_date <= v_as_of;
  IF v_app <> v_gl THEN
    RAISE EXCEPTION 'gl: AR does not tie: the app shows % cents of open AR as of %, the ledger''s AR account % cents (difference % cents)',
      v_app, v_as_of, v_gl, v_app - v_gl USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO gl_ar_tieouts (entity_id, as_of, app_ar_cents, gl_ar_cents, opening_entry_id, confirmed_by)
    VALUES (p_entity_id, v_as_of, v_app, v_gl, v_ob, p_confirmed_by);
  INSERT INTO gl_ar_tieout_items (entity_id, kind, source_id, cents, counted)
    SELECT p_entity_id, 'charge', c.id, gl_exact_cents(c.amount), (c.voided_at IS NULL OR gl_central_date(c.voided_at) > v_as_of)
      FROM charges c WHERE c.charge_date <= v_as_of AND gl_lease_entity(c.lease_id) = p_entity_id
    UNION ALL
    SELECT p_entity_id, 'payment', p.id, gl_exact_cents(p.amount), gl_payment_counted_as_of(p.method, p.stripe_status, p.status_changed_at, v_as_of)
      FROM payments p WHERE p.payment_date <= v_as_of AND gl_lease_entity(p.lease_id) = p_entity_id;
  IF (SELECT coalesce(sum(CASE WHEN kind = 'charge' THEN cents ELSE -cents END) FILTER (WHERE counted), 0)
        FROM gl_ar_tieout_items WHERE entity_id = p_entity_id) <> v_app THEN
    RAISE EXCEPTION 'gl: AR tie-out snapshot does not match its total' USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_app;
END;
$$;

-- ── A3: every AR posting matches its source (checked at commit) ────────────────────────────────
-- Returns the expected (account, debit, credit) lines and date for a posting, or raises. Reversal
-- kinds (charge_void, payment_return) are checked against the original posting's entry instead.
CREATE OR REPLACE FUNCTION gl_check_ar_posting(p_posting_id UUID) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_post gl_ar_postings%ROWTYPE;
  v_entry gl_journal_entries%ROWTYPE;
  v_ent gl_entities%ROWTYPE;
  v_c charges%ROWTYPE;
  v_p payments%ROWTYPE;
  v_orig UUID;
  v_cents BIGINT;
  v_date DATE;
  v_dr UUID;
  v_cr UUID;
  v_item gl_ar_tieout_items%ROWTYPE;
BEGIN
  SELECT * INTO v_post FROM gl_ar_postings WHERE id = p_posting_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO v_entry FROM gl_journal_entries WHERE id = v_post.entry_id;
  SELECT * INTO v_ent FROM gl_entities WHERE id = v_post.entity_id;
  PERFORM gl_assert_ar_ready(v_post.entity_id);
  IF v_entry.entry_date > gl_today() THEN
    RAISE EXCEPTION 'gl: % % is dated in the future', v_post.kind, v_post.source_id USING ERRCODE = 'check_violation';
  END IF;

  IF v_post.kind IN ('charge', 'charge_void', 'charge_void_pre') THEN
    SELECT * INTO v_c FROM charges WHERE id = v_post.source_id;
    IF NOT FOUND OR gl_lease_entity(v_c.lease_id) IS DISTINCT FROM v_post.entity_id THEN
      RAISE EXCEPTION 'gl: charge % does not belong to entity %', v_post.source_id, v_post.entity_id USING ERRCODE = 'check_violation';
    END IF;
    v_cents := gl_exact_cents(v_c.amount);
  ELSE
    SELECT * INTO v_p FROM payments WHERE id = v_post.source_id;
    IF NOT FOUND OR gl_lease_entity(v_p.lease_id) IS DISTINCT FROM v_post.entity_id THEN
      RAISE EXCEPTION 'gl: payment % does not belong to entity %', v_post.source_id, v_post.entity_id USING ERRCODE = 'check_violation';
    END IF;
    v_cents := gl_exact_cents(v_p.amount);
  END IF;

  IF v_post.kind = 'charge' THEN
    IF v_c.charge_date < v_ent.ledger_start_date THEN
      RAISE EXCEPTION 'gl: charge % is dated before the ledger start date; its AR is in the opening balance', v_c.id USING ERRCODE = 'check_violation';
    END IF;
    v_date := gl_first_open_date(v_post.entity_id, v_c.charge_date);
    v_dr := gl_ar_account(v_post.entity_id, 'ar');
    v_cr := gl_ar_account(v_post.entity_id, v_c.type);
  ELSIF v_post.kind = 'charge_void_pre' THEN
    SELECT * INTO v_item FROM gl_ar_tieout_items WHERE kind = 'charge' AND source_id = v_c.id;
    IF NOT FOUND OR NOT v_item.counted OR v_c.voided_at IS NULL OR v_item.cents <> v_cents THEN
      RAISE EXCEPTION 'gl: charge % was not open AR at the tie-out (for this amount), or is not voided', v_c.id USING ERRCODE = 'check_violation';
    END IF;
    v_date := gl_first_open_date(v_post.entity_id, GREATEST(gl_central_date(v_c.voided_at), v_ent.ledger_start_date));
    v_dr := gl_ar_account(v_post.entity_id, v_c.type);
    v_cr := gl_ar_account(v_post.entity_id, 'ar');
  ELSIF v_post.kind = 'payment' THEN
    IF NOT gl_payment_counts(v_p.method, v_p.stripe_status) THEN
      RAISE EXCEPTION 'gl: payment % has not been received (status %)', v_p.id, coalesce(v_p.stripe_status, 'none') USING ERRCODE = 'check_violation';
    END IF;
    IF v_p.payment_date < v_ent.ledger_start_date THEN
      -- Only a pre-start payment the tie-out did NOT count (it cleared later) may post, on the start date.
      SELECT * INTO v_item FROM gl_ar_tieout_items WHERE kind = 'payment' AND source_id = v_p.id;
      IF NOT FOUND OR v_item.counted OR v_item.cents <> v_cents THEN
        RAISE EXCEPTION 'gl: payment % is in the opening balance (counted at the tie-out) or postdates the tie-out with an earlier date', v_p.id USING ERRCODE = 'check_violation';
      END IF;
      v_date := gl_first_open_date(v_post.entity_id, v_ent.ledger_start_date);
    ELSE
      v_date := gl_first_open_date(v_post.entity_id, v_p.payment_date);
    END IF;
    v_dr := gl_ar_account(v_post.entity_id, 'undeposited_funds');
    v_cr := gl_ar_account(v_post.entity_id, 'ar');
  ELSIF v_post.kind = 'payment_return_pre' THEN
    SELECT * INTO v_item FROM gl_ar_tieout_items WHERE kind = 'payment' AND source_id = v_p.id;
    IF NOT FOUND OR NOT v_item.counted OR v_item.cents <> v_cents OR v_p.method <> 'ach_stripe' OR v_p.stripe_status NOT IN ('failed', 'returned') THEN
      RAISE EXCEPTION 'gl: payment % was not counted at the tie-out (for this amount), or has not failed', v_p.id USING ERRCODE = 'check_violation';
    END IF;
    v_date := gl_first_open_date(v_post.entity_id, GREATEST(coalesce(gl_central_date(v_p.status_changed_at), v_ent.ledger_start_date), v_ent.ledger_start_date));
    v_dr := gl_ar_account(v_post.entity_id, 'ar');
    v_cr := gl_ar_account(v_post.entity_id, 'undeposited_funds');
  END IF;

  IF v_post.kind IN ('charge_void', 'payment_return') THEN
    -- The exact reversal of this source's original posting, dated by the void or the failure.
    SELECT entry_id INTO v_orig FROM gl_ar_postings WHERE kind = CASE WHEN v_post.kind = 'charge_void' THEN 'charge' ELSE 'payment' END AND source_id = v_post.source_id;
    IF v_orig IS NULL OR v_entry.source <> 'reversal' OR v_entry.reverses_entry_id IS DISTINCT FROM v_orig THEN
      RAISE EXCEPTION 'gl: % % must be the reversal of its original posting', v_post.kind, v_post.source_id USING ERRCODE = 'check_violation';
    END IF;
    IF v_post.kind = 'charge_void' AND v_c.voided_at IS NULL THEN
      RAISE EXCEPTION 'gl: charge % is not voided', v_c.id USING ERRCODE = 'check_violation';
    END IF;
    IF v_post.kind = 'payment_return' AND (v_p.method <> 'ach_stripe' OR v_p.stripe_status NOT IN ('failed', 'returned')) THEN
      RAISE EXCEPTION 'gl: payment % has not failed or been returned', v_p.id USING ERRCODE = 'check_violation';
    END IF;
    -- REFUTE-6 L1: dated as the batch dates it (a return with no recorded status time may be
    -- dated any day from the original posting to today).
    SELECT entry_date INTO v_date FROM gl_journal_entries WHERE id = v_orig;
    IF v_post.kind = 'charge_void' THEN
      v_date := gl_first_open_date(v_post.entity_id, GREATEST(gl_central_date(v_c.voided_at), v_date));
    ELSIF v_p.status_changed_at IS NOT NULL THEN
      v_date := gl_first_open_date(v_post.entity_id, GREATEST(gl_central_date(v_p.status_changed_at), v_date));
    END IF;
    IF (v_post.kind = 'charge_void' OR v_p.status_changed_at IS NOT NULL) AND v_entry.entry_date <> v_date
       OR v_entry.entry_date < v_date THEN
      RAISE EXCEPTION 'gl: % % must be dated % (got %)', v_post.kind, v_post.source_id, v_date, v_entry.entry_date USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;

  IF v_entry.source <> 'ar_posting' OR v_entry.entry_date <> v_date THEN
    RAISE EXCEPTION 'gl: % % must be an ar_posting entry dated % (got % on %)', v_post.kind, v_post.source_id, v_date, v_entry.source, v_entry.entry_date
      USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM gl_journal_lines WHERE entry_id = v_entry.id) <> 2
     OR NOT EXISTS (SELECT 1 FROM gl_journal_lines WHERE entry_id = v_entry.id AND account_id = v_dr AND debit_cents = v_cents AND credit_cents = 0)
     OR NOT EXISTS (SELECT 1 FROM gl_journal_lines WHERE entry_id = v_entry.id AND account_id = v_cr AND credit_cents = v_cents AND debit_cents = 0) THEN
    RAISE EXCEPTION 'gl: % % must post exactly % cents from its mapped accounts', v_post.kind, v_post.source_id, v_cents USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION gl_assert_ar_posting() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'gl_ar_postings' THEN
    PERFORM gl_check_ar_posting(NEW.id);
  ELSIF TG_TABLE_NAME = 'gl_journal_lines' THEN
    -- REFUTE-6 H2: a line added to a linked AR entry after its link was verified is re-checked.
    IF (SELECT source FROM gl_journal_entries WHERE id = NEW.entry_id) = 'ar_posting' THEN
      FOR v_id IN SELECT id FROM gl_ar_postings WHERE entry_id = NEW.entry_id LOOP
        PERFORM gl_check_ar_posting(v_id);
      END LOOP;
    END IF;
  ELSIF NEW.source = 'reversal'
        AND (SELECT source FROM gl_journal_entries WHERE id = NEW.reverses_entry_id) = 'ar_posting'
        AND NOT EXISTS (SELECT 1 FROM gl_ar_postings WHERE entry_id = NEW.id) THEN
    -- REFUTE-6 H1: an AR posting is undone only by the void or return that posts with it.
    RAISE EXCEPTION 'gl: entry % reverses an AR posting; void the charge or record the payment''s return in the app instead', NEW.reverses_entry_id
      USING ERRCODE = 'check_violation';
  ELSIF NEW.source = 'ar_posting' AND NOT EXISTS (SELECT 1 FROM gl_ar_postings WHERE entry_id = NEW.id) THEN
    -- A4: an ar_posting entry exists only as the target of a verified link.
    RAISE EXCEPTION 'gl: entry % is an AR posting with no gl_ar_postings link', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS gl_ar_postings_verify ON gl_ar_postings;
CREATE CONSTRAINT TRIGGER gl_ar_postings_verify
  AFTER INSERT ON gl_ar_postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION gl_assert_ar_posting();
DROP TRIGGER IF EXISTS gl_journal_entries_ar_linked ON gl_journal_entries;
CREATE CONSTRAINT TRIGGER gl_journal_entries_ar_linked
  AFTER INSERT ON gl_journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION gl_assert_ar_posting();
DROP TRIGGER IF EXISTS gl_journal_lines_ar_verify ON gl_journal_lines;
CREATE CONSTRAINT TRIGGER gl_journal_lines_ar_verify
  AFTER INSERT ON gl_journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION gl_assert_ar_posting();

-- REFUTE-6 C1: once the AR tie-out is confirmed, the opening balance it tied to stays live and the
-- entity's start date and basis stay as they were (correct later differences with entries).
CREATE OR REPLACE FUNCTION gl_guard_ar_tied_entity() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'gl_journal_entries' THEN
    IF NEW.source = 'reversal' AND EXISTS (SELECT 1 FROM gl_ar_tieouts WHERE opening_entry_id = NEW.reverses_entry_id) THEN
      RAISE EXCEPTION 'gl: this opening balance is the basis of the confirmed AR tie-out and cannot be reversed; post a correcting entry in an open month'
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF (NEW.ledger_start_date IS DISTINCT FROM OLD.ledger_start_date OR NEW.accounting_basis IS DISTINCT FROM OLD.accounting_basis)
        AND EXISTS (SELECT 1 FROM gl_ar_tieouts WHERE entity_id = OLD.id) THEN
    RAISE EXCEPTION 'gl: entity % has a confirmed AR tie-out; its start date and accounting basis cannot change', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS gl_journal_entries_ar_tie_guard ON gl_journal_entries;
CREATE TRIGGER gl_journal_entries_ar_tie_guard BEFORE INSERT ON gl_journal_entries FOR EACH ROW EXECUTE FUNCTION gl_guard_ar_tied_entity();
DROP TRIGGER IF EXISTS gl_entities_ar_tie_guard ON gl_entities;
CREATE TRIGGER gl_entities_ar_tie_guard BEFORE UPDATE ON gl_entities FOR EACH ROW EXECUTE FUNCTION gl_guard_ar_tied_entity();

-- ── A6: a charge or payment the ledger holds cannot change underneath it ───────────────────────
-- Once posted (gl_ar_postings) or counted at the tie-out (gl_ar_tieout_items), its amount, date,
-- lease and type (charges) / method (payments) are fixed and it cannot be deleted. Voids and Stripe
-- status changes stay allowed: they are posted as their own reversals.
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
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS charges_gl_guard ON charges;
CREATE TRIGGER charges_gl_guard BEFORE UPDATE OR DELETE ON charges FOR EACH ROW EXECUTE FUNCTION gl_guard_ar_source_change();
DROP TRIGGER IF EXISTS payments_gl_guard ON payments;
CREATE TRIGGER payments_gl_guard BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION gl_guard_ar_source_change();

-- A6 (property → LLC): a property's ledger entity is fixed once any of its leases' charges or
-- payments are tied out or posted (moving it would split its AR history across two ledgers).
CREATE OR REPLACE FUNCTION gl_guard_property_entity() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old UUID;
  v_new UUID;
  v_leases UUID[];
BEGIN
  -- REFUTE-6 H4: moving a property, a unit or a lease is refused when it would change the ledger
  -- entity of a lease whose AR the ledger holds.
  IF TG_TABLE_NAME = 'properties' THEN
    IF NEW.gl_entity_id IS NOT DISTINCT FROM OLD.gl_entity_id OR OLD.gl_entity_id IS NULL THEN RETURN NEW; END IF;
    SELECT array_agg(l.id) INTO v_leases FROM leases l JOIN units u ON u.id = l.unit_id WHERE u.property_id = OLD.id;
  ELSIF TG_TABLE_NAME = 'units' THEN
    IF NEW.property_id IS NOT DISTINCT FROM OLD.property_id THEN RETURN NEW; END IF;
    SELECT gl_entity_id INTO v_old FROM properties WHERE id = OLD.property_id;
    SELECT gl_entity_id INTO v_new FROM properties WHERE id = NEW.property_id;
    IF v_old IS NULL OR v_old IS NOT DISTINCT FROM v_new THEN RETURN NEW; END IF;
    SELECT array_agg(l.id) INTO v_leases FROM leases l WHERE l.unit_id = OLD.id;
  ELSE
    IF NEW.unit_id IS NOT DISTINCT FROM OLD.unit_id THEN RETURN NEW; END IF;
    SELECT p.gl_entity_id INTO v_old FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = OLD.unit_id;
    SELECT p.gl_entity_id INTO v_new FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = NEW.unit_id;
    IF v_old IS NULL OR v_old IS NOT DISTINCT FROM v_new THEN RETURN NEW; END IF;
    v_leases := ARRAY[OLD.id];
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.unnest(coalesce(v_leases, '{}'::uuid[])) AS x(id) WHERE gl_lease_ar_held(x.id)) THEN
    RAISE EXCEPTION 'gl: this %''s AR is in the general ledger of its LLC; it cannot move to another LLC',
      CASE TG_TABLE_NAME WHEN 'properties' THEN 'property' WHEN 'units' THEN 'unit' ELSE 'lease' END
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS properties_gl_entity_guard ON properties;
CREATE TRIGGER properties_gl_entity_guard BEFORE UPDATE ON properties FOR EACH ROW EXECUTE FUNCTION gl_guard_property_entity();
DROP TRIGGER IF EXISTS units_gl_entity_guard ON units;
CREATE TRIGGER units_gl_entity_guard BEFORE UPDATE ON units FOR EACH ROW EXECUTE FUNCTION gl_guard_property_entity();
DROP TRIGGER IF EXISTS leases_gl_entity_guard ON leases;
CREATE TRIGGER leases_gl_entity_guard BEFORE UPDATE ON leases FOR EACH ROW EXECUTE FUNCTION gl_guard_property_entity();

-- ── Write path: one batch, all or nothing ──────────────────────────────────────────────────────
-- p_items: JSON array of {"kind": ..., "source_id": uuid}, in posting order. The database builds
-- every entry itself from the source rows and the account roles; callers choose only WHAT to post.
CREATE OR REPLACE FUNCTION gl_post_ar_batch(p_entity_id UUID, p_through DATE, p_items JSONB, p_posted_by TEXT) RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ent gl_entities%ROWTYPE;
  v_item JSONB;
  v_kind TEXT;
  v_src UUID;
  v_entry UUID;
  v_orig UUID;
  v_c charges%ROWTYPE;
  v_p payments%ROWTYPE;
  v_cents BIGINT;
  v_date DATE;
  v_dr UUID;
  v_cr UUID;
  v_memo TEXT;
  v_n INTEGER := 0;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'gl: post AR only at READ COMMITTED isolation' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT * INTO v_ent FROM gl_entities WHERE id = p_entity_id FOR UPDATE;  -- one AR batch per entity at a time
  IF NOT FOUND THEN RAISE EXCEPTION 'gl: entity % not found', p_entity_id USING ERRCODE = 'no_data_found'; END IF;
  PERFORM gl_assert_ar_ready(p_entity_id);
  IF p_through IS NULL OR p_through < v_ent.ledger_start_date OR p_through > gl_today() THEN
    RAISE EXCEPTION 'gl: post AR through a date between the ledger start date and today' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: items must be a JSON array' USING ERRCODE = 'check_violation';
  END IF;
  SET CONSTRAINTS gl_journal_entries_balanced, gl_journal_lines_balanced, gl_journal_entries_reversal_mirror, gl_journal_lines_reversal_mirror, gl_ar_postings_verify, gl_journal_entries_ar_linked, gl_journal_lines_ar_verify DEFERRED;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_kind := v_item OPERATOR(pg_catalog.->>) 'kind'::text;
    v_src := (v_item OPERATOR(pg_catalog.->>) 'source_id'::text)::uuid;
    v_entry := NULL;
    IF v_kind IN ('charge', 'charge_void', 'charge_void_pre') THEN
      SELECT * INTO v_c FROM charges WHERE id = v_src FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'gl: charge % not found', v_src USING ERRCODE = 'no_data_found'; END IF;
      v_cents := gl_exact_cents(v_c.amount);
    ELSIF v_kind IN ('payment', 'payment_return', 'payment_return_pre') THEN
      SELECT * INTO v_p FROM payments WHERE id = v_src FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'gl: payment % not found', v_src USING ERRCODE = 'no_data_found'; END IF;
      v_cents := gl_exact_cents(v_p.amount);
    ELSE
      RAISE EXCEPTION 'gl: unknown AR posting kind %', coalesce(v_kind, '(none)') USING ERRCODE = 'check_violation';
    END IF;

    IF v_kind IN ('charge_void', 'payment_return') THEN
      SELECT entry_id INTO v_orig FROM gl_ar_postings WHERE kind = CASE WHEN v_kind = 'charge_void' THEN 'charge' ELSE 'payment' END AND source_id = v_src;
      IF v_orig IS NULL THEN RAISE EXCEPTION 'gl: % % has no original posting to reverse', v_kind, v_src USING ERRCODE = 'check_violation'; END IF;
      v_date := CASE WHEN v_kind = 'charge_void' THEN gl_central_date(v_c.voided_at)
                     ELSE coalesce(gl_central_date(v_p.status_changed_at), p_through) END;
      v_date := gl_first_open_date(p_entity_id, GREATEST(v_date, (SELECT entry_date FROM gl_journal_entries WHERE id = v_orig)));
      IF v_date IS NULL OR v_date > p_through THEN
        RAISE EXCEPTION 'gl: % % is dated after the run''s through date', v_kind, v_src USING ERRCODE = 'check_violation';
      END IF;
      v_entry := gl_reverse_entry(v_orig, v_date,
        CASE WHEN v_kind = 'charge_void' THEN 'Charge voided: ' || coalesce(v_c.void_reason, '') ELSE 'Payment ' || coalesce(v_p.stripe_status, 'failed') END,
        p_posted_by);
    ELSE
      IF v_kind = 'charge' THEN
        v_date := gl_first_open_date(p_entity_id, v_c.charge_date); v_dr := gl_ar_account(p_entity_id, 'ar'); v_cr := gl_ar_account(p_entity_id, v_c.type);
        v_memo := 'Charge ' || v_c.type || coalesce(': ' || v_c.description, '');
      ELSIF v_kind = 'charge_void_pre' THEN
        v_date := gl_first_open_date(p_entity_id, GREATEST(gl_central_date(v_c.voided_at), v_ent.ledger_start_date));
        v_dr := gl_ar_account(p_entity_id, v_c.type); v_cr := gl_ar_account(p_entity_id, 'ar');
        v_memo := 'Void of pre-start charge ' || v_c.type || coalesce(': ' || v_c.void_reason, '');
      ELSIF v_kind = 'payment' THEN
        v_date := gl_first_open_date(p_entity_id, GREATEST(v_p.payment_date, v_ent.ledger_start_date));
        v_dr := gl_ar_account(p_entity_id, 'undeposited_funds'); v_cr := gl_ar_account(p_entity_id, 'ar');
        v_memo := 'Payment (' || v_p.method || ')';
      ELSE -- payment_return_pre
        v_date := gl_first_open_date(p_entity_id, GREATEST(coalesce(gl_central_date(v_p.status_changed_at), v_ent.ledger_start_date), v_ent.ledger_start_date));
        v_dr := gl_ar_account(p_entity_id, 'ar'); v_cr := gl_ar_account(p_entity_id, 'undeposited_funds');
        v_memo := 'Return of pre-start payment (' || coalesce(v_p.stripe_status, 'failed') || ')';
      END IF;
      IF v_date > p_through THEN
        RAISE EXCEPTION 'gl: % % is dated % , after the run''s through date %', v_kind, v_src, v_date, p_through USING ERRCODE = 'check_violation';
      END IF;
      INSERT INTO gl_journal_entries (entity_id, entry_date, memo, source, posted_by)
        VALUES (p_entity_id, v_date, v_memo, 'ar_posting', p_posted_by) RETURNING id INTO v_entry;
      INSERT INTO gl_journal_lines (entry_id, entity_id, account_id, line_no, debit_cents, credit_cents)
        VALUES (v_entry, p_entity_id, v_dr, 1, v_cents, 0), (v_entry, p_entity_id, v_cr, 2, 0, v_cents);
    END IF;
    INSERT INTO gl_ar_postings (entity_id, kind, source_id, entry_id) VALUES (p_entity_id, v_kind, v_src, v_entry);
    v_n := v_n + 1;
  END LOOP;

  -- Surface any failure from this call, then restore deferral (REFUTE D5).
  SET CONSTRAINTS gl_journal_entries_balanced, gl_journal_lines_balanced, gl_ar_postings_verify, gl_journal_entries_ar_linked, gl_journal_lines_ar_verify IMMEDIATE;
  SET CONSTRAINTS gl_journal_entries_balanced, gl_journal_lines_balanced, gl_ar_postings_verify, gl_journal_entries_ar_linked, gl_journal_lines_ar_verify DEFERRED;
  RETURN v_n;
END;
$$;

-- ── Access (0023 pattern) ─────────────────────────────────────────────────────────────────────
ALTER TABLE gl_ar_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE gl_ar_tieouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE gl_ar_tieout_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE gl_ar_postings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON gl_ar_accounts, gl_ar_tieouts, gl_ar_tieout_items, gl_ar_postings FROM PUBLIC, anon, authenticated;
REVOKE TRIGGER, TRUNCATE, REFERENCES ON gl_ar_accounts, gl_ar_tieouts, gl_ar_tieout_items, gl_ar_postings FROM service_role;
REVOKE UPDATE, DELETE ON gl_ar_tieouts, gl_ar_tieout_items, gl_ar_postings FROM service_role;
DO $$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON gl_ar_accounts, gl_ar_tieouts, gl_ar_tieout_items, gl_ar_postings FROM service_role';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION gl_confirm_ar_tieout(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_post_ar_batch(UUID, DATE, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_check_ar_posting(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_exact_cents(NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_central_date(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_lease_entity(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_payment_counts(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_ar_account(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_payment_counted_as_of(TEXT, TEXT, TIMESTAMPTZ, DATE) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_first_open_date(UUID, DATE) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_ar_held(TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_lease_ar_held(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_assert_ar_ready(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION gl_confirm_ar_tieout(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION gl_post_ar_batch(UUID, DATE, JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION gl_check_ar_posting(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION gl_exact_cents(NUMERIC) TO service_role;
GRANT EXECUTE ON FUNCTION gl_central_date(TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION gl_lease_entity(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION gl_payment_counts(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION gl_ar_account(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION gl_payment_counted_as_of(TEXT, TEXT, TIMESTAMPTZ, DATE) TO service_role;
GRANT EXECUTE ON FUNCTION gl_first_open_date(UUID, DATE) TO service_role;
GRANT EXECUTE ON FUNCTION gl_ar_held(TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION gl_lease_ar_held(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION gl_assert_ar_ready(UUID) TO service_role;
