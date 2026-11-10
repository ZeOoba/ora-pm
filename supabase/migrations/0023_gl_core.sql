-- B8 / roadmap P3: native general ledger — CORE ONLY (2026-11-10).
--
-- Ratified scope (Gabriel, 2026-11-10): ledger core only. Entities (LLCs), chart of accounts,
-- journal entries and lines, period lock, trial balance. NO posting from billing, payments, CAM,
-- late fees or cron yet, and no UI. QuickBooks stays the book of record during the parallel run.
--
-- Ratified design decisions this schema encodes:
--   * Accounting basis is PER ENTITY and copied from that LLC's QuickBooks file ('accrual' |
--     'cash'), so the parallel run can tie each balance sheet to QB line for line.
--   * Chart of accounts MIRRORS each LLC's QB chart (qb_name is QB's full account name, unique per
--     entity; number is QB's account number when the file uses numbers).
--   * Bank activity will arrive by CSV/OFX statement import (a later PR); nothing here assumes a
--     live bank feed.
--   * Monthly close. A locked month rejects every new posting; a lock is permanent (corrections
--     are posted in an open month). Who may lock is enforced by the API (GL_PERIOD_LOCK_EMAILS).
--
-- Money rules enforced IN THE DATABASE (not only in server/lib/gl.ts), so a bug or a direct
-- service-role write cannot break them:
--   1. Integer cents. Each line is a debit XOR a credit, strictly positive (CHECK).
--   2. Balanced entries. Σ debits = Σ credits > 0 with at least two lines, checked by DEFERRABLE
--      INITIALLY DEFERRED constraint triggers at COMMIT on both tables (an entry with no lines,
--      or lines that do not balance, cannot commit).
--   3. Same-entity accounts. Composite foreign keys (entity_id, entry_id) and
--      (entity_id, account_id): a line can only hit an account of its own entry's entity.
--   4. Immutability. Posted entries and lines cannot be UPDATEd or DELETEd (trigger); a
--      correction is a reversing entry. Each entry can be reversed at most once (UNIQUE), and a
--      reversal cannot itself be reversed.
--   5. Period lock. No entry may be inserted dated in a locked month (trigger); a locked month
--      cannot be unlocked or deleted (trigger). gl_post_entry and gl_lock_period serialize on the
--      period row, so a posting and a lock of the same month cannot interleave.
--   6. Inactive accounts cannot take new lines.
--   7. Lines are written only in the transaction that created their entry (trigger), so no one
--      can later append a balanced pair of lines to an old entry, e.g. one in a locked month.
--      posted_at is forced to now() (the transaction start time) on insert, and a line's entry
--      must carry posted_at = now(). Unlike an xmin check this also holds inside savepoints.
--
-- Writes go through two functions (gl_post_entry, gl_reverse_entry) and gl_lock_period, so header
-- and lines land in ONE transaction (PostgREST runs each RPC in its own transaction).
--
-- RLS: enabled with NO policies on every table (default-deny for anon/authenticated, the
-- 0013/0018 pattern). Functions: SECURITY INVOKER, EXECUTE revoked from PUBLIC/anon/authenticated
-- and granted to service_role only (the 0014 pattern).
--
-- ORDERING: purely additive (new tables, functions, triggers; one nullable column on properties).
-- Independent of 0022. ci.yml's migrations-applied gate blocks the deploy until applied.
-- RE-RUNNABLE: IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS throughout.

-- ── Entities (LLCs) ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gl_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE
    CONSTRAINT gl_entities_name_nonempty CHECK (btrim(name) <> ''),
  accounting_basis TEXT NOT NULL
    CONSTRAINT gl_entities_basis_check CHECK (accounting_basis IN ('accrual', 'cash')),
  qb_file_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE properties ADD COLUMN IF NOT EXISTS gl_entity_id UUID REFERENCES gl_entities(id);

-- ── Chart of accounts (mirrors each LLC's QB chart) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gl_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES gl_entities(id),
  number TEXT,
  qb_name TEXT NOT NULL
    CONSTRAINT gl_accounts_qb_name_nonempty CHECK (btrim(qb_name) <> ''),
  account_type TEXT NOT NULL
    CONSTRAINT gl_accounts_type_check CHECK (account_type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT gl_accounts_entity_qb_name_key UNIQUE (entity_id, qb_name),
  CONSTRAINT gl_accounts_entity_id_key UNIQUE (entity_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS gl_accounts_entity_number_key ON gl_accounts (entity_id, number) WHERE number IS NOT NULL;

-- ── Periods (monthly) ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gl_periods (
  entity_id UUID NOT NULL REFERENCES gl_entities(id),
  period_start DATE NOT NULL
    CONSTRAINT gl_periods_month_start CHECK (EXTRACT(DAY FROM period_start) = 1),
  status TEXT NOT NULL DEFAULT 'open'
    CONSTRAINT gl_periods_status_check CHECK (status IN ('open', 'locked')),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  PRIMARY KEY (entity_id, period_start),
  CONSTRAINT gl_periods_lock_pair CHECK ((status = 'locked') = (locked_at IS NOT NULL AND locked_by IS NOT NULL))
);

-- ── Journal ───────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gl_journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES gl_entities(id),
  entry_date DATE NOT NULL,
  memo TEXT NOT NULL
    CONSTRAINT gl_journal_entries_memo_nonempty CHECK (btrim(memo) <> ''),
  source TEXT NOT NULL
    CONSTRAINT gl_journal_entries_source_check CHECK (source IN ('manual', 'reversal', 'opening_balance')),
  reverses_entry_id UUID UNIQUE REFERENCES gl_journal_entries(id),
  posted_by TEXT NOT NULL
    CONSTRAINT gl_journal_entries_posted_by_nonempty CHECK (btrim(posted_by) <> ''),
  posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT gl_journal_entries_entity_id_key UNIQUE (entity_id, id),
  -- A reversal must reverse an entry of its own entity.
  CONSTRAINT gl_journal_entries_reverses_same_entity FOREIGN KEY (entity_id, reverses_entry_id) REFERENCES gl_journal_entries (entity_id, id),
  CONSTRAINT gl_journal_entries_reversal_pair CHECK ((source = 'reversal') = (reverses_entry_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS gl_journal_entries_entity_date_idx ON gl_journal_entries (entity_id, entry_date);

CREATE TABLE IF NOT EXISTS gl_journal_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id UUID NOT NULL,
  entity_id UUID NOT NULL,
  account_id UUID NOT NULL,
  line_no INTEGER NOT NULL
    CONSTRAINT gl_journal_lines_line_no_positive CHECK (line_no > 0),
  debit_cents BIGINT NOT NULL DEFAULT 0
    CONSTRAINT gl_journal_lines_debit_nonneg CHECK (debit_cents >= 0),
  credit_cents BIGINT NOT NULL DEFAULT 0
    CONSTRAINT gl_journal_lines_credit_nonneg CHECK (credit_cents >= 0),
  memo TEXT,
  CONSTRAINT gl_journal_lines_one_side CHECK ((debit_cents > 0) <> (credit_cents > 0)),
  CONSTRAINT gl_journal_lines_entry_fk FOREIGN KEY (entity_id, entry_id) REFERENCES gl_journal_entries (entity_id, id),
  CONSTRAINT gl_journal_lines_account_fk FOREIGN KEY (entity_id, account_id) REFERENCES gl_accounts (entity_id, id),
  CONSTRAINT gl_journal_lines_entry_line_key UNIQUE (entry_id, line_no)
);
CREATE INDEX IF NOT EXISTS gl_journal_lines_entity_account_idx ON gl_journal_lines (entity_id, account_id);

-- ── Rule 2: balanced, at least two lines (checked at COMMIT) ──────────────────────────────────
CREATE OR REPLACE FUNCTION gl_assert_entry_balanced() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_entry UUID;
  v_lines INTEGER;
  v_debits BIGINT;
  v_credits BIGINT;
BEGIN
  -- IF, not CASE: PL/pgSQL resolves every CASE branch's record field, and the entries row has no
  -- entry_id (caught by supabase/tests/gl_core.test.sql on real Postgres).
  IF TG_TABLE_NAME = 'gl_journal_entries' THEN
    v_entry := NEW.id;
  ELSE
    v_entry := NEW.entry_id;
  END IF;
  SELECT count(*), COALESCE(sum(debit_cents), 0), COALESCE(sum(credit_cents), 0)
    INTO v_lines, v_debits, v_credits
    FROM gl_journal_lines WHERE entry_id = v_entry;
  IF v_lines < 2 OR v_debits <> v_credits OR v_debits = 0 THEN
    RAISE EXCEPTION 'gl: journal entry % is not balanced (lines=%, debits=%, credits=% cents)', v_entry, v_lines, v_debits, v_credits
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS gl_journal_entries_balanced ON gl_journal_entries;
CREATE CONSTRAINT TRIGGER gl_journal_entries_balanced
  AFTER INSERT ON gl_journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION gl_assert_entry_balanced();

DROP TRIGGER IF EXISTS gl_journal_lines_balanced ON gl_journal_lines;
CREATE CONSTRAINT TRIGGER gl_journal_lines_balanced
  AFTER INSERT ON gl_journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION gl_assert_entry_balanced();

-- ── Rule 4: immutability ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION gl_reject_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'gl: % rows are immutable once posted; post a reversing entry instead', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS gl_journal_entries_immutable ON gl_journal_entries;
CREATE TRIGGER gl_journal_entries_immutable
  BEFORE UPDATE OR DELETE ON gl_journal_entries
  FOR EACH ROW EXECUTE FUNCTION gl_reject_change();
DROP TRIGGER IF EXISTS gl_journal_entries_no_truncate ON gl_journal_entries;
CREATE TRIGGER gl_journal_entries_no_truncate
  BEFORE TRUNCATE ON gl_journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION gl_reject_change();

DROP TRIGGER IF EXISTS gl_journal_lines_immutable ON gl_journal_lines;
CREATE TRIGGER gl_journal_lines_immutable
  BEFORE UPDATE OR DELETE ON gl_journal_lines
  FOR EACH ROW EXECUTE FUNCTION gl_reject_change();
DROP TRIGGER IF EXISTS gl_journal_lines_no_truncate ON gl_journal_lines;
CREATE TRIGGER gl_journal_lines_no_truncate
  BEFORE TRUNCATE ON gl_journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION gl_reject_change();

-- ── Rules 5 and 6: locked periods, inactive accounts ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION gl_assert_entry_period_open() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- The posting time is the database's, never the caller's (rule 7 depends on it).
  NEW.posted_at := now();
  IF EXISTS (
    SELECT 1 FROM gl_periods
     WHERE entity_id = NEW.entity_id
       AND period_start = date_trunc('month', NEW.entry_date)::date
       AND status = 'locked'
  ) THEN
    RAISE EXCEPTION 'gl: period % is locked for entity %; post in an open month', date_trunc('month', NEW.entry_date)::date, NEW.entity_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS gl_journal_entries_period_open ON gl_journal_entries;
CREATE TRIGGER gl_journal_entries_period_open
  BEFORE INSERT ON gl_journal_entries
  FOR EACH ROW EXECUTE FUNCTION gl_assert_entry_period_open();

CREATE OR REPLACE FUNCTION gl_assert_account_active() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM gl_accounts WHERE id = NEW.account_id AND entity_id = NEW.entity_id AND is_active) THEN
    RAISE EXCEPTION 'gl: account % is inactive or not in entity %', NEW.account_id, NEW.entity_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION gl_assert_line_same_tx() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM gl_journal_entries e
     WHERE e.id = NEW.entry_id AND e.posted_at = now()
  ) THEN
    RAISE EXCEPTION 'gl: lines can only be added in the transaction that posts their entry (entry %)', NEW.entry_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS gl_journal_lines_same_tx ON gl_journal_lines;
CREATE TRIGGER gl_journal_lines_same_tx
  BEFORE INSERT ON gl_journal_lines
  FOR EACH ROW EXECUTE FUNCTION gl_assert_line_same_tx();

DROP TRIGGER IF EXISTS gl_journal_lines_account_active ON gl_journal_lines;
CREATE TRIGGER gl_journal_lines_account_active
  BEFORE INSERT ON gl_journal_lines
  FOR EACH ROW EXECUTE FUNCTION gl_assert_account_active();

CREATE OR REPLACE FUNCTION gl_guard_period_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'locked' THEN
      RAISE EXCEPTION 'gl: a locked period cannot be deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'locked' THEN
    RAISE EXCEPTION 'gl: a locked period cannot be changed or unlocked' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.entity_id <> OLD.entity_id OR NEW.period_start <> OLD.period_start THEN
    RAISE EXCEPTION 'gl: a period''s entity and month cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS gl_periods_guard ON gl_periods;
CREATE TRIGGER gl_periods_guard
  BEFORE UPDATE OR DELETE ON gl_periods
  FOR EACH ROW EXECUTE FUNCTION gl_guard_period_change();

-- ── Write path ────────────────────────────────────────────────────────────────────────────────
-- Holds the period row (FOR SHARE) for the rest of the transaction, creating it as 'open' if it
-- does not exist yet. gl_lock_period takes the same row FOR UPDATE, so lock and post serialize.
CREATE OR REPLACE FUNCTION gl_hold_open_period(p_entity_id UUID, p_date DATE) RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
BEGIN
  INSERT INTO gl_periods (entity_id, period_start) VALUES (p_entity_id, date_trunc('month', p_date)::date)
    ON CONFLICT (entity_id, period_start) DO NOTHING;
  SELECT status INTO v_status FROM gl_periods
   WHERE entity_id = p_entity_id AND period_start = date_trunc('month', p_date)::date
   FOR SHARE;
  IF v_status = 'locked' THEN
    RAISE EXCEPTION 'gl: period % is locked for entity %; post in an open month', date_trunc('month', p_date)::date, p_entity_id
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

-- p_lines: JSON array of {"account_id": uuid, "debit_cents": int, "credit_cents": int, "memo": text?}.
-- Returns the new entry id. Every rule above is enforced by the table constraints and triggers;
-- this function only makes the header + lines atomic and holds the period.
CREATE OR REPLACE FUNCTION gl_post_entry(
  p_entity_id UUID,
  p_entry_date DATE,
  p_memo TEXT,
  p_source TEXT,
  p_posted_by TEXT,
  p_lines JSONB
) RETURNS UUID
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_entry UUID;
  v_line JSONB;
  v_no INTEGER := 0;
BEGIN
  IF p_source NOT IN ('manual', 'opening_balance') THEN
    RAISE EXCEPTION 'gl: source % cannot be posted directly (reversals go through gl_reverse_entry)', p_source
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: lines must be a JSON array' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM gl_hold_open_period(p_entity_id, p_entry_date);

  INSERT INTO gl_journal_entries (entity_id, entry_date, memo, source, posted_by)
    VALUES (p_entity_id, p_entry_date, p_memo, p_source, p_posted_by)
    RETURNING id INTO v_entry;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    v_no := v_no + 1;
    INSERT INTO gl_journal_lines (entry_id, entity_id, account_id, line_no, debit_cents, credit_cents, memo)
      VALUES (
        v_entry, p_entity_id, (v_line->>'account_id')::uuid, v_no,
        COALESCE((v_line->>'debit_cents')::bigint, 0), COALESCE((v_line->>'credit_cents')::bigint, 0),
        NULLIF(btrim(v_line->>'memo'), '')
      );
  END LOOP;
  -- Balance is enforced at COMMIT by the deferred constraint triggers; check now as well so the
  -- caller gets the error from this call rather than from an opaque commit failure.
  SET CONSTRAINTS gl_journal_entries_balanced, gl_journal_lines_balanced IMMEDIATE;
  RETURN v_entry;
END;
$$;

-- Posts the exact mirror of an entry (debits and credits swapped) on p_entry_date, in an open
-- month. An entry can be reversed once (UNIQUE reverses_entry_id); a reversal cannot be reversed.
CREATE OR REPLACE FUNCTION gl_reverse_entry(
  p_entry_id UUID,
  p_entry_date DATE,
  p_memo TEXT,
  p_posted_by TEXT
) RETURNS UUID
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_orig gl_journal_entries%ROWTYPE;
  v_entry UUID;
BEGIN
  SELECT * INTO v_orig FROM gl_journal_entries WHERE id = p_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gl: journal entry % not found', p_entry_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_orig.source = 'reversal' THEN
    RAISE EXCEPTION 'gl: a reversal cannot itself be reversed; post a new entry' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM gl_hold_open_period(v_orig.entity_id, p_entry_date);

  INSERT INTO gl_journal_entries (entity_id, entry_date, memo, source, reverses_entry_id, posted_by)
    VALUES (v_orig.entity_id, p_entry_date, p_memo, 'reversal', v_orig.id, p_posted_by)
    RETURNING id INTO v_entry;

  INSERT INTO gl_journal_lines (entry_id, entity_id, account_id, line_no, debit_cents, credit_cents, memo)
    SELECT v_entry, entity_id, account_id, line_no, credit_cents, debit_cents, memo
      FROM gl_journal_lines WHERE entry_id = v_orig.id;

  SET CONSTRAINTS gl_journal_entries_balanced, gl_journal_lines_balanced IMMEDIATE;
  RETURN v_entry;
END;
$$;

-- Locks a month for an entity (creating the period row if needed). Idempotent for an
-- already-locked month only in the sense that it raises: a lock is never re-stamped.
CREATE OR REPLACE FUNCTION gl_lock_period(p_entity_id UUID, p_period_start DATE, p_locked_by TEXT) RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF p_period_start <> date_trunc('month', p_period_start)::date THEN
    RAISE EXCEPTION 'gl: period_start must be the first day of a month' USING ERRCODE = 'check_violation';
  END IF;
  IF p_locked_by IS NULL OR btrim(p_locked_by) = '' THEN
    RAISE EXCEPTION 'gl: locked_by is required' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO gl_periods (entity_id, period_start) VALUES (p_entity_id, p_period_start)
    ON CONFLICT (entity_id, period_start) DO NOTHING;
  SELECT status INTO v_status FROM gl_periods
   WHERE entity_id = p_entity_id AND period_start = p_period_start
   FOR UPDATE;
  IF v_status = 'locked' THEN
    RAISE EXCEPTION 'gl: period % is already locked for entity %', p_period_start, p_entity_id USING ERRCODE = 'unique_violation';
  END IF;
  UPDATE gl_periods SET status = 'locked', locked_at = NOW(), locked_by = p_locked_by
   WHERE entity_id = p_entity_id AND period_start = p_period_start;
END;
$$;

-- ── Access ────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE gl_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE gl_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE gl_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE gl_journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE gl_journal_lines ENABLE ROW LEVEL SECURITY;

REVOKE EXECUTE ON FUNCTION gl_post_entry(UUID, DATE, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_reverse_entry(UUID, DATE, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_lock_period(UUID, DATE, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_hold_open_period(UUID, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION gl_post_entry(UUID, DATE, TEXT, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION gl_reverse_entry(UUID, DATE, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION gl_lock_period(UUID, DATE, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION gl_hold_open_period(UUID, DATE) TO service_role;

COMMENT ON TABLE gl_entities IS 'B8 ledger core: one row per LLC. accounting_basis copied from that LLC''s QuickBooks file for the parallel run.';
COMMENT ON TABLE gl_accounts IS 'B8 ledger core: chart of accounts mirroring each LLC''s QuickBooks chart (qb_name = QB full name).';
COMMENT ON TABLE gl_periods IS 'B8 ledger core: monthly periods. A locked period rejects postings and can never be unlocked.';
COMMENT ON TABLE gl_journal_entries IS 'B8 ledger core: immutable journal headers. Balanced (≥2 lines, Σdr = Σcr > 0) at commit; corrections are reversals.';
COMMENT ON TABLE gl_journal_lines IS 'B8 ledger core: immutable journal lines in integer cents; each a debit XOR a credit; account must belong to the entry''s entity.';
