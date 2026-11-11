-- 0026: B8 slice 2 — opening balances and each LLC's ledger start date.
--
-- Ratified 2026-11-10: the native ledger starts on a per-LLC ledger_start_date (Jan 1, 2027 for
-- the parallel run), and each LLC's opening position is its QuickBooks trial balance as of the
-- day before, imported from a CSV of QB's Trial Balance report (server/lib/gl-opening-balance.ts,
-- POST /api/gl/entities/:id/opening-balance). Full trial balance, year-to-date income and expense
-- included. A wrong opening balance is corrected by reversing it and posting a new one.
--
-- Money rules, enforced in the database (direct service_role SQL included):
--   O1. gl_entities.ledger_start_date is the first day of a month (2000–2100).
--   O2. An opening_balance entry is dated exactly ledger_start_date - 1, and needs a start date.
--   O3. One LIVE opening balance per entity: a second one is refused until the first is reversed.
--       Its reversal is dated the same day as it (so a re-post replaces it on every report).
--   O4. Every other entry (manual, and reversals of anything else) is dated on or after
--       ledger_start_date: the period before it belongs to QuickBooks.
--   O5. ledger_start_date cannot change once the entity has a manual entry or a live opening
--       balance (reverse the opening balance first).
--   O6. Opening-balance lines may use inactive accounts: QuickBooks can hide an account that
--       still carries a balance, and the opening position must tie to QB line for line.
--   O3 and O5 refuse to run outside READ COMMITTED (REFUTE-4 F2: an older snapshot would miss a
--   committed opening balance or entry), and serialize on the entity row (FOR UPDATE).
--
-- ORDERING: requires 0023 (replaces 0023's gl_assert_line_insert to add O6; nothing else of 0023
-- changes). Independent of 0024/0025. Re-runnable (IF NOT EXISTS, DROP ... IF EXISTS + ADD,
-- CREATE OR REPLACE, DROP TRIGGER IF EXISTS). Every function pins search_path = public, pg_temp
-- and names pg_catalog functions it could otherwise resolve by overload (REFUTE passes 3–5).

ALTER TABLE gl_entities ADD COLUMN IF NOT EXISTS ledger_start_date DATE;
ALTER TABLE gl_entities DROP CONSTRAINT IF EXISTS gl_entities_start_month;
ALTER TABLE gl_entities ADD CONSTRAINT gl_entities_start_month CHECK (
  ledger_start_date IS NULL
  OR (EXTRACT(DAY FROM ledger_start_date) = 1 AND ledger_start_date BETWEEN DATE '2000-01-01' AND DATE '2100-12-01')
);

-- ── O2, O3, O4: every journal entry insert ──────────────────────────────────────────────────────
-- Fires after 0023's gl_journal_entries_insert_guard (BEFORE triggers run in name order).
CREATE OR REPLACE FUNCTION gl_assert_entry_start_date() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_start DATE;
  v_target gl_journal_entries%ROWTYPE;
BEGIN
  IF NEW.source = 'opening_balance' THEN
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'gl: post an opening balance only at READ COMMITTED isolation' USING ERRCODE = 'restrict_violation';
    END IF;
    -- Serialize opening balances (and start-date changes) for this entity.
    SELECT ledger_start_date INTO v_start FROM gl_entities WHERE id = NEW.entity_id FOR UPDATE;
    IF v_start IS NULL THEN
      RAISE EXCEPTION 'gl: set the entity''s ledger start date before posting its opening balance' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.entry_date <> v_start - 1 THEN
      RAISE EXCEPTION 'gl: an opening balance is dated the day before the ledger start date (%), not %', v_start - 1, NEW.entry_date
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM gl_journal_entries o
       WHERE o.entity_id = NEW.entity_id AND o.source = 'opening_balance'
         AND NOT EXISTS (SELECT 1 FROM gl_journal_entries r WHERE r.reverses_entry_id = o.id)
    ) THEN
      RAISE EXCEPTION 'gl: entity % already has an opening balance; reverse it before posting a new one', NEW.entity_id
        USING ERRCODE = 'unique_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT ledger_start_date INTO v_start FROM gl_entities WHERE id = NEW.entity_id;
  IF NEW.source = 'reversal' THEN
    SELECT * INTO v_target FROM gl_journal_entries WHERE id = NEW.reverses_entry_id;
    -- The target must already exist (REFUTE F1): in a multi-row INSERT a reversal listed before
    -- its target would otherwise skip the opening-balance date rule, retire a live opening
    -- balance on any later date, and let a second one in.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'gl: a reversal must follow the entry it reverses' USING ERRCODE = 'check_violation';
    END IF;
    IF v_target.source = 'opening_balance' THEN
      IF NEW.entry_date <> v_target.entry_date THEN
        RAISE EXCEPTION 'gl: an opening balance is reversed on its own date (%)', v_target.entry_date USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  IF v_start IS NOT NULL AND NEW.entry_date < v_start THEN
    RAISE EXCEPTION 'gl: % is before the ledger start date %; that period belongs to QuickBooks', NEW.entry_date, v_start
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS gl_journal_entries_start_guard ON gl_journal_entries;
CREATE TRIGGER gl_journal_entries_start_guard
  BEFORE INSERT ON gl_journal_entries
  FOR EACH ROW EXECUTE FUNCTION gl_assert_entry_start_date();

-- ── O5: the start date is fixed once used ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION gl_guard_entity_start_date() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.ledger_start_date IS NOT DISTINCT FROM OLD.ledger_start_date THEN
    RETURN NEW;
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'gl: change a ledger start date only at READ COMMITTED isolation' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM gl_journal_entries WHERE entity_id = OLD.id AND source = 'manual') THEN
    RAISE EXCEPTION 'gl: entity % has posted entries; its ledger start date cannot change', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM gl_journal_entries o
     WHERE o.entity_id = OLD.id AND o.source = 'opening_balance'
       AND NOT EXISTS (SELECT 1 FROM gl_journal_entries r WHERE r.reverses_entry_id = o.id)
  ) THEN
    RAISE EXCEPTION 'gl: entity % has an opening balance; reverse it before changing the ledger start date', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS gl_entities_start_guard ON gl_entities;
CREATE TRIGGER gl_entities_start_guard
  BEFORE UPDATE ON gl_entities
  FOR EACH ROW EXECUTE FUNCTION gl_guard_entity_start_date();

-- ── O6: 0023's line guard, with opening-balance lines allowed on inactive accounts ─────────────
-- Identical to 0023 except the active-account rule exempts 'opening_balance' as well as 'reversal'.
CREATE OR REPLACE FUNCTION gl_assert_line_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_entry gl_journal_entries%ROWTYPE;
  v_active BOOLEAN;
BEGIN
  SELECT * INTO v_entry FROM gl_journal_entries WHERE id = NEW.entry_id;
  IF NOT FOUND OR v_entry.posted_txid IS DISTINCT FROM pg_current_xact_id()::text::bigint THEN
    RAISE EXCEPTION 'gl: lines can only be added in the transaction that posts their entry (entry %)', NEW.entry_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  PERFORM gl_hold_open_period(v_entry.entity_id, v_entry.entry_date);
  -- Hold the account row (REFUTE-2 S3): deactivation or a type/entity change cannot race this
  -- line; such an UPDATE waits and its guard then sees the committed line.
  SELECT is_active INTO v_active FROM gl_accounts WHERE id = NEW.account_id AND entity_id = NEW.entity_id FOR SHARE;
  IF v_entry.source NOT IN ('reversal', 'opening_balance') AND v_active IS NOT TRUE THEN
    RAISE EXCEPTION 'gl: account % is inactive or not in entity %', NEW.account_id, NEW.entity_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ── Write path ──────────────────────────────────────────────────────────────────────────────────
-- Sets (or confirms) the entity's ledger start date and posts its opening balance, dated the day
-- before, through gl_post_entry (balance, accounts and period rules all apply). One transaction:
-- if the posting fails, the start date change rolls back with it.
CREATE OR REPLACE FUNCTION gl_post_opening_balance(
  p_entity_id UUID,
  p_start_date DATE,
  p_lines JSONB,
  p_posted_by TEXT
) RETURNS UUID
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_start DATE;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'gl: post an opening balance only at READ COMMITTED isolation' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT ledger_start_date INTO v_start FROM gl_entities WHERE id = p_entity_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gl: entity % not found', p_entity_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_start IS DISTINCT FROM p_start_date THEN
    UPDATE gl_entities SET ledger_start_date = p_start_date WHERE id = p_entity_id;
  END IF;
  RETURN gl_post_entry(
    p_entity_id,
    p_start_date - 1,
    'Opening balance from QuickBooks as of ' || (p_start_date - 1)::text,
    'opening_balance',
    p_posted_by,
    p_lines
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION gl_post_opening_balance(UUID, DATE, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION gl_post_opening_balance(UUID, DATE, JSONB, TEXT) TO service_role;

COMMENT ON COLUMN gl_entities.ledger_start_date IS 'B8: first day the native ledger owns for this LLC (parallel run: 2027-01-01). Its opening balance is dated the day before; earlier periods belong to QuickBooks. Fixed once used (gl_entities_start_guard).';
