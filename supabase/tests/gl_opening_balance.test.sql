-- Real-Postgres tests for 0026_gl_opening_balance.sql (B8 slice 2). Own session, own fixtures
-- (scripts/verify-gl-sql.sh). Rules O1–O6 are described in the migration header. Every block
-- raises on failure; a clean run prints only NOTICE lines.

CREATE OR REPLACE FUNCTION pg_temp.expect_error(sql TEXT, pattern TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE sql;
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM !~ pattern THEN
      RAISE EXCEPTION 'expected error matching /%/ but got: %  [sql: %]', pattern, SQLERRM, sql;
    END IF;
    SET CONSTRAINTS ALL DEFERRED;
    RETURN;
  END;
  RAISE EXCEPTION 'expected error matching /%/ but statement succeeded: %', pattern, sql;
END;
$$;

INSERT INTO gl_entities (id, name, accounting_basis) VALUES
  ('0b000000-0000-4000-8000-000000000001', 'OB Holdings LLC', 'accrual'),
  ('0b000000-0000-4000-8000-000000000002', 'OB Other LLC', 'cash');
INSERT INTO gl_accounts (id, entity_id, number, qb_name, account_type, is_active) VALUES
  ('0ba00000-0000-4000-8000-000000000001', '0b000000-0000-4000-8000-000000000001', '1000', 'Operating Cash', 'asset', true),
  ('0ba00000-0000-4000-8000-000000000002', '0b000000-0000-4000-8000-000000000001', '2500', 'Mortgage Payable', 'liability', true),
  ('0ba00000-0000-4000-8000-000000000003', '0b000000-0000-4000-8000-000000000001', '3000', 'Members'' Equity', 'equity', true),
  ('0ba00000-0000-4000-8000-000000000004', '0b000000-0000-4000-8000-000000000001', '1900', 'Old Escrow', 'asset', false),
  ('0ba00000-0000-4000-8000-000000000005', '0b000000-0000-4000-8000-000000000001', '4000', 'Rental Income', 'income', true);

-- A balanced opening trial balance: cash 125,000.00 + hidden escrow 5,000.00 = mortgage 90,000.00 + equity 40,000.00
\set ob_lines '[{"account_id":"0ba00000-0000-4000-8000-000000000001","debit_cents":12500000},{"account_id":"0ba00000-0000-4000-8000-000000000004","debit_cents":500000},{"account_id":"0ba00000-0000-4000-8000-000000000002","credit_cents":9000000},{"account_id":"0ba00000-0000-4000-8000-000000000003","credit_cents":4000000}]'

-- O1: start date is the first of a month, in range.
DO $$ BEGIN
  PERFORM pg_temp.expect_error($q$UPDATE gl_entities SET ledger_start_date = '2027-01-15' WHERE id = '0b000000-0000-4000-8000-000000000002'$q$, 'gl_entities_start_month');
  PERFORM pg_temp.expect_error($q$UPDATE gl_entities SET ledger_start_date = '1999-01-01' WHERE id = '0b000000-0000-4000-8000-000000000002'$q$, 'gl_entities_start_month');
  RAISE NOTICE 'ok: O1 ledger start date is a first-of-month in range';
END $$;

-- O2: an opening balance needs a start date and is dated the day before it (direct SQL too).
DO $$ BEGIN
  PERFORM pg_temp.expect_error($q$SELECT gl_post_entry('0b000000-0000-4000-8000-000000000001', '2026-12-31', 'x', 'opening_balance', 't', '[{"account_id":"0ba00000-0000-4000-8000-000000000001","debit_cents":1},{"account_id":"0ba00000-0000-4000-8000-000000000003","credit_cents":1}]')$q$, 'set the entity''s ledger start date');
  UPDATE gl_entities SET ledger_start_date = '2027-01-01' WHERE id = '0b000000-0000-4000-8000-000000000001';
  PERFORM pg_temp.expect_error($q$SELECT gl_post_entry('0b000000-0000-4000-8000-000000000001', '2026-12-30', 'x', 'opening_balance', 't', '[{"account_id":"0ba00000-0000-4000-8000-000000000001","debit_cents":1},{"account_id":"0ba00000-0000-4000-8000-000000000003","credit_cents":1}]')$q$, 'dated the day before the ledger start date \(2026-12-31\)');
  UPDATE gl_entities SET ledger_start_date = NULL WHERE id = '0b000000-0000-4000-8000-000000000001';
  RAISE NOTICE 'ok: O2 opening balance requires a start date and is dated start - 1';
END $$;

-- Post through the function: sets the start date, dates the entry 2026-12-31, hidden account allowed (O6).
SELECT gl_post_opening_balance('0b000000-0000-4000-8000-000000000001', '2027-01-01', :'ob_lines'::jsonb, 'tester') AS ob1 \gset
DO $$
DECLARE r RECORD;
BEGIN
  SELECT e.entry_date, e.source, en.ledger_start_date, (SELECT sum(debit_cents) FROM gl_journal_lines WHERE entry_id = e.id) AS dr,
         (SELECT count(*) FROM gl_journal_lines WHERE entry_id = e.id) AS n
    INTO r FROM gl_journal_entries e JOIN gl_entities en ON en.id = e.entity_id
   WHERE e.entity_id = '0b000000-0000-4000-8000-000000000001' AND e.source = 'opening_balance';
  IF r.entry_date <> '2026-12-31' OR r.ledger_start_date <> '2027-01-01' OR r.dr <> 13000000 OR r.n <> 4 THEN
    RAISE EXCEPTION 'opening balance not posted as expected: %', r;
  END IF;
  RAISE NOTICE 'ok: gl_post_opening_balance sets the start date, dates the entry the day before, carries a hidden account (O6)';
END $$;

-- O3: no second live opening balance; O4: nothing else before the start date; O5: start date fixed.
DO $$ BEGIN
  PERFORM pg_temp.expect_error($q$SELECT gl_post_opening_balance('0b000000-0000-4000-8000-000000000001', '2027-01-01', '[{"account_id":"0ba00000-0000-4000-8000-000000000001","debit_cents":1},{"account_id":"0ba00000-0000-4000-8000-000000000003","credit_cents":1}]', 't')$q$, 'already has an opening balance; reverse it');
  PERFORM pg_temp.expect_error($q$SELECT gl_post_entry('0b000000-0000-4000-8000-000000000001', '2026-12-15', 'pre-start', 'manual', 't', '[{"account_id":"0ba00000-0000-4000-8000-000000000001","debit_cents":1},{"account_id":"0ba00000-0000-4000-8000-000000000005","credit_cents":1}]')$q$, 'before the ledger start date 2027-01-01; that period belongs to QuickBooks');
  PERFORM pg_temp.expect_error($q$UPDATE gl_entities SET ledger_start_date = '2027-02-01' WHERE id = '0b000000-0000-4000-8000-000000000001'$q$, 'has an opening balance; reverse it before changing');
  PERFORM pg_temp.expect_error($q$UPDATE gl_entities SET ledger_start_date = NULL WHERE id = '0b000000-0000-4000-8000-000000000001'$q$, 'has an opening balance; reverse it before changing');
  RAISE NOTICE 'ok: O3 one live opening balance; O4 no entries before the start date; O5 start date fixed while an opening balance is live';
END $$;

-- O3: the reversal is dated on the opening balance's own date; then a corrected one can be posted.
DO $$ BEGIN
  PERFORM pg_temp.expect_error(format('SELECT gl_reverse_entry(%L, %L, %L, %L)',
    (SELECT id FROM gl_journal_entries WHERE source = 'opening_balance' AND entity_id = '0b000000-0000-4000-8000-000000000001'), '2027-01-02', 'wrong date', 't'),
    'reversed on its own date \(2026-12-31\)');
  PERFORM gl_reverse_entry((SELECT id FROM gl_journal_entries WHERE source = 'opening_balance' AND entity_id = '0b000000-0000-4000-8000-000000000001'), '2026-12-31', 'Wrong mortgage balance', 'tester');
  PERFORM gl_post_opening_balance('0b000000-0000-4000-8000-000000000001', '2027-01-01',
    '[{"account_id":"0ba00000-0000-4000-8000-000000000001","debit_cents":12500000},{"account_id":"0ba00000-0000-4000-8000-000000000004","debit_cents":500000},{"account_id":"0ba00000-0000-4000-8000-000000000002","credit_cents":8950000},{"account_id":"0ba00000-0000-4000-8000-000000000003","credit_cents":4050000}]', 'tester');
  SET CONSTRAINTS ALL IMMEDIATE;
  IF (SELECT count(*) FROM gl_journal_entries o WHERE o.entity_id = '0b000000-0000-4000-8000-000000000001' AND o.source = 'opening_balance'
        AND NOT EXISTS (SELECT 1 FROM gl_journal_entries r WHERE r.reverses_entry_id = o.id)) <> 1 THEN
    RAISE EXCEPTION 'expected exactly one live opening balance after reverse + re-post';
  END IF;
  -- trial balance as of 2026-12-31 nets to the corrected opening position only
  IF (SELECT sum(l.credit_cents) - sum(l.debit_cents) FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = '0ba00000-0000-4000-8000-000000000002' AND e.entry_date <= '2026-12-31') <> 8950000 THEN
    RAISE EXCEPTION 'mortgage balance as of 2026-12-31 should be the corrected 89,500.00';
  END IF;
  RAISE NOTICE 'ok: O3 reverse-and-re-post: reversal on the opening date, exactly one live opening balance, corrected balances';
END $$;

-- O4/O5 with ordinary activity: posting on/after the start date works; then the start date is fixed.
DO $$ BEGIN
  PERFORM gl_post_entry('0b000000-0000-4000-8000-000000000001', '2027-01-05', 'Jan rent', 'manual', 'tester',
    '[{"account_id":"0ba00000-0000-4000-8000-000000000001","debit_cents":2000000},{"account_id":"0ba00000-0000-4000-8000-000000000005","credit_cents":2000000}]');
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM pg_temp.expect_error($q$SELECT gl_reverse_entry((SELECT id FROM gl_journal_entries WHERE memo = 'Jan rent'), '2026-12-31', 'x', 't')$q$, 'before the ledger start date');
  PERFORM pg_temp.expect_error($q$UPDATE gl_entities SET ledger_start_date = '2027-02-01' WHERE id = '0b000000-0000-4000-8000-000000000001'$q$, 'has posted entries; its ledger start date cannot change|has an opening balance');
  RAISE NOTICE 'ok: entries on/after the start date post; their reversals cannot go before it; start date then fixed';
END $$;

-- O6 only for opening balances: a manual entry still cannot use the hidden account.
DO $$ BEGIN
  PERFORM pg_temp.expect_error($q$SELECT gl_post_entry('0b000000-0000-4000-8000-000000000001', '2027-01-06', 'x', 'manual', 't', '[{"account_id":"0ba00000-0000-4000-8000-000000000004","debit_cents":1},{"account_id":"0ba00000-0000-4000-8000-000000000003","credit_cents":1}]')$q$, 'inactive');
  RAISE NOTICE 'ok: O6 hidden accounts stay closed to ordinary postings';
END $$;

-- Unbalanced opening balance is refused by the ledger's balance rule, and leaves no start date behind.
DO $$ BEGIN
  PERFORM pg_temp.expect_error($q$SELECT gl_post_opening_balance('0b000000-0000-4000-8000-000000000002', '2027-01-01', '[{"account_id":"0ba00000-0000-4000-8000-000000000001","debit_cents":100},{"account_id":"0ba00000-0000-4000-8000-000000000003","credit_cents":99}]', 't')$q$, 'not balanced|not in entity|foreign key|violates');
  IF (SELECT ledger_start_date FROM gl_entities WHERE id = '0b000000-0000-4000-8000-000000000002') IS NOT NULL THEN
    RAISE EXCEPTION 'a failed opening balance must not leave a start date behind';
  END IF;
  RAISE NOTICE 'ok: a failed opening balance rolls back its start date';
END $$;

-- REFUTE F1: a reversal listed BEFORE its target in one multi-row INSERT (an opening balance that
-- would be "reversed" on any date, letting a second live one in) is refused.
DO $$ BEGIN
  BEGIN
    INSERT INTO gl_journal_entries (id, entity_id, entry_date, memo, source, reverses_entry_id, posted_by) VALUES
      ('0be00000-0000-4000-8000-0000000000f2', '0b000000-0000-4000-8000-000000000001', '2027-06-30', 'fake reversal', 'reversal', '0be00000-0000-4000-8000-0000000000f1', 't'),
      ('0be00000-0000-4000-8000-0000000000f1', '0b000000-0000-4000-8000-000000000001', '2026-12-31', 'second opening', 'opening_balance', NULL, 't');
    RAISE EXCEPTION 'F1: a reversal ahead of its target was accepted';
  EXCEPTION WHEN check_violation OR unique_violation THEN
    IF SQLERRM NOT LIKE '%must follow the entry it reverses%' AND SQLERRM NOT LIKE '%already has an opening balance%' THEN RAISE; END IF;
  END;
  -- and with no live opening balance at all (entity 2), the ordering trick is still refused
  BEGIN
    UPDATE gl_entities SET ledger_start_date = '2027-01-01' WHERE id = '0b000000-0000-4000-8000-000000000002';
    INSERT INTO gl_journal_entries (id, entity_id, entry_date, memo, source, reverses_entry_id, posted_by) VALUES
      ('0be00000-0000-4000-8000-0000000000f4', '0b000000-0000-4000-8000-000000000002', '2027-06-30', 'fake reversal', 'reversal', '0be00000-0000-4000-8000-0000000000f3', 't'),
      ('0be00000-0000-4000-8000-0000000000f3', '0b000000-0000-4000-8000-000000000002', '2026-12-31', 'opening', 'opening_balance', NULL, 't');
    RAISE EXCEPTION 'F1: a reversal ahead of its target was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%must follow the entry it reverses%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'ok: REFUTE F1 a reversal cannot precede its target in one INSERT';
END $$;

-- Isolation: refused outside READ COMMITTED.
BEGIN ISOLATION LEVEL REPEATABLE READ;
DO $$ BEGIN
  BEGIN
    PERFORM gl_post_opening_balance('0b000000-0000-4000-8000-000000000002', '2027-01-01', '[]', 't');
    RAISE EXCEPTION 'opening balance at REPEATABLE READ was allowed';
  EXCEPTION WHEN restrict_violation THEN
    IF SQLERRM NOT LIKE '%READ COMMITTED%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'ok: opening balances refused outside READ COMMITTED';
END $$;
COMMIT;

-- Access: the write function is service_role only.
DO $$ BEGIN
  IF has_function_privilege('anon', 'gl_post_opening_balance(uuid, date, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'gl_post_opening_balance(uuid, date, jsonb, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'gl_post_opening_balance(uuid, date, jsonb, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'gl_post_opening_balance must be EXECUTE for service_role only';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname LIKE 'gl\_%' AND NOT (coalesce(p.proconfig, '{}') @> ARRAY['search_path=public, pg_temp'])) THEN
    RAISE EXCEPTION 'a gl_ function lacks search_path = public, pg_temp';
  END IF;
  RAISE NOTICE 'ok: gl_post_opening_balance service_role only; every gl_ function pins its search_path';
END $$;
