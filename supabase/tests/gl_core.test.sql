-- Real-Postgres tests for 0023_gl_core.sql (B8 ledger core). pg-mem cannot run plpgsql, triggers or
-- deferred constraint triggers, which carry this migration's money rules, so these run against an
-- actual Postgres 15+ via scripts/verify-gl-sql.sh (stubs + migration + this file, ON_ERROR_STOP).
-- Every block raises on failure; a clean run prints only NOTICE lines.

-- Runs `sql` in a subtransaction, forcing deferred constraint checks, and requires it to fail with
-- a message matching `pattern`.
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

-- Fixtures: two entities, accounts in each.
INSERT INTO gl_entities (id, name, accounting_basis) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'Raytown Flex Holdings LLC', 'accrual'),
  ('e0000000-0000-4000-8000-000000000002', 'Columbia Trade LLC', 'cash');
INSERT INTO gl_accounts (id, entity_id, number, qb_name, account_type) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', '1000', 'Operating Cash', 'asset'),
  ('a0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001', '4000', 'Rental Income', 'income'),
  ('a0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000001', '6100', 'Repairs', 'expense'),
  ('a0000000-0000-4000-8000-000000000009', 'e0000000-0000-4000-8000-000000000002', '1000', 'Operating Cash', 'asset');
INSERT INTO gl_accounts (id, entity_id, qb_name, account_type, is_active) VALUES
  ('a0000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-000000000001', 'Old Account', 'expense', false);

-- ── Schema checks ──────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  PERFORM pg_temp.expect_error($q$INSERT INTO gl_entities (name, accounting_basis) VALUES ('X', 'modified')$q$, 'gl_entities_basis_check');
  PERFORM pg_temp.expect_error($q$INSERT INTO gl_entities (name, accounting_basis) VALUES ('  ', 'cash')$q$, 'gl_entities_name_nonempty');
  PERFORM pg_temp.expect_error($q$INSERT INTO gl_accounts (entity_id, qb_name, account_type) VALUES ('e0000000-0000-4000-8000-000000000001', 'Operating Cash', 'asset')$q$, 'gl_accounts_entity_qb_name_key');
  PERFORM pg_temp.expect_error($q$INSERT INTO gl_accounts (entity_id, number, qb_name, account_type) VALUES ('e0000000-0000-4000-8000-000000000001', '1000', 'Dup number', 'asset')$q$, 'gl_accounts_entity_number_key');
  PERFORM pg_temp.expect_error($q$INSERT INTO gl_accounts (entity_id, qb_name, account_type) VALUES ('e0000000-0000-4000-8000-000000000001', 'Z', 'revenue')$q$, 'gl_accounts_type_check');
  PERFORM pg_temp.expect_error($q$INSERT INTO gl_periods (entity_id, period_start) VALUES ('e0000000-0000-4000-8000-000000000001', '2026-11-15')$q$, 'gl_periods_month_start');
  RAISE NOTICE 'ok: schema checks';
END $$;

-- ── Posting: balanced entries succeed, the rest fail ──────────────────────────────────────────
DO $$
DECLARE v UUID;
BEGIN
  v := gl_post_entry('e0000000-0000-4000-8000-000000000001', '2026-10-05', 'Oct rent, Ste 3', 'manual', 'tester',
    '[{"account_id":"a0000000-0000-4000-8000-000000000001","debit_cents":2019250},{"account_id":"a0000000-0000-4000-8000-000000000002","credit_cents":2019250}]');
  SET CONSTRAINTS ALL IMMEDIATE;
  IF (SELECT count(*) FROM gl_journal_lines WHERE entry_id = v) <> 2 THEN RAISE EXCEPTION 'expected 2 lines'; END IF;
  IF (SELECT period_start FROM gl_periods WHERE entity_id = 'e0000000-0000-4000-8000-000000000001' AND period_start = '2026-10-01') IS NULL THEN
    RAISE EXCEPTION 'posting should open the period row';
  END IF;
  RAISE NOTICE 'ok: balanced entry posts, period row created open';
END $$;

DO $$ BEGIN
  -- unbalanced
  PERFORM pg_temp.expect_error($q$SELECT gl_post_entry('e0000000-0000-4000-8000-000000000001', '2026-10-06', 'bad', 'manual', 't',
    '[{"account_id":"a0000000-0000-4000-8000-000000000001","debit_cents":100},{"account_id":"a0000000-0000-4000-8000-000000000002","credit_cents":99}]')$q$, 'not balanced');
  -- one line
  PERFORM pg_temp.expect_error($q$SELECT gl_post_entry('e0000000-0000-4000-8000-000000000001', '2026-10-06', 'bad', 'manual', 't',
    '[{"account_id":"a0000000-0000-4000-8000-000000000001","debit_cents":0,"credit_cents":0}]')$q$, 'gl_journal_lines_one_side|not balanced');
  -- no lines
  PERFORM pg_temp.expect_error($q$SELECT gl_post_entry('e0000000-0000-4000-8000-000000000001', '2026-10-06', 'bad', 'manual', 't', '[]')$q$, 'not balanced');
  -- both sides on one line
  PERFORM pg_temp.expect_error($q$SELECT gl_post_entry('e0000000-0000-4000-8000-000000000001', '2026-10-06', 'bad', 'manual', 't',
    '[{"account_id":"a0000000-0000-4000-8000-000000000001","debit_cents":5,"credit_cents":5},{"account_id":"a0000000-0000-4000-8000-000000000002","credit_cents":0,"debit_cents":0}]')$q$, 'gl_journal_lines_one_side');
  -- negative
  PERFORM pg_temp.expect_error($q$SELECT gl_post_entry('e0000000-0000-4000-8000-000000000001', '2026-10-06', 'bad', 'manual', 't',
    '[{"account_id":"a0000000-0000-4000-8000-000000000001","debit_cents":-5},{"account_id":"a0000000-0000-4000-8000-000000000002","credit_cents":-5}]')$q$, 'gl_journal_lines_debit_nonneg|gl_journal_lines_credit_nonneg');
  -- another entity's account
  PERFORM pg_temp.expect_error($q$SELECT gl_post_entry('e0000000-0000-4000-8000-000000000001', '2026-10-06', 'bad', 'manual', 't',
    '[{"account_id":"a0000000-0000-4000-8000-000000000009","debit_cents":100},{"account_id":"a0000000-0000-4000-8000-000000000002","credit_cents":100}]')$q$, 'inactive or not in entity|gl_journal_lines_account_fk');
  -- inactive account
  PERFORM pg_temp.expect_error($q$SELECT gl_post_entry('e0000000-0000-4000-8000-000000000001', '2026-10-06', 'bad', 'manual', 't',
    '[{"account_id":"a0000000-0000-4000-8000-000000000004","debit_cents":100},{"account_id":"a0000000-0000-4000-8000-000000000002","credit_cents":100}]')$q$, 'inactive or not in entity');
  -- reversal source cannot be posted directly
  PERFORM pg_temp.expect_error($q$SELECT gl_post_entry('e0000000-0000-4000-8000-000000000001', '2026-10-06', 'bad', 'reversal', 't',
    '[{"account_id":"a0000000-0000-4000-8000-000000000001","debit_cents":100},{"account_id":"a0000000-0000-4000-8000-000000000002","credit_cents":100}]')$q$, 'cannot be posted directly');
  -- blank memo
  PERFORM pg_temp.expect_error($q$SELECT gl_post_entry('e0000000-0000-4000-8000-000000000001', '2026-10-06', '  ', 'manual', 't',
    '[{"account_id":"a0000000-0000-4000-8000-000000000001","debit_cents":100},{"account_id":"a0000000-0000-4000-8000-000000000002","credit_cents":100}]')$q$, 'gl_journal_entries_memo_nonempty');
  RAISE NOTICE 'ok: unbalanced / one-line / empty / two-sided / negative / cross-entity / inactive / direct-reversal / blank memo rejected';
END $$;

-- Direct service-role writes cannot dodge the rules either.
DO $$ BEGIN
  -- header with no lines cannot commit
  PERFORM pg_temp.expect_error($q$INSERT INTO gl_journal_entries (entity_id, entry_date, memo, source, posted_by)
    VALUES ('e0000000-0000-4000-8000-000000000001', '2026-10-07', 'orphan', 'manual', 't')$q$, 'not balanced');
  RAISE NOTICE 'ok: header without lines cannot commit';
END $$;

-- posted_at is the database's: a caller-supplied time is overwritten (rule 7 depends on it).
DO $$
DECLARE v UUID := gen_random_uuid();
BEGIN
  INSERT INTO gl_journal_entries (id, entity_id, entry_date, memo, source, posted_by, posted_at)
    VALUES (v, 'e0000000-0000-4000-8000-000000000002', '2026-10-08', 'direct', 'manual', 't', '2001-01-01');
  INSERT INTO gl_journal_lines (entry_id, entity_id, account_id, line_no, debit_cents) VALUES (v, 'e0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000009', 1, 5);
  INSERT INTO gl_journal_lines (entry_id, entity_id, account_id, line_no, credit_cents) VALUES (v, 'e0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000009', 2, 5);
  SET CONSTRAINTS ALL IMMEDIATE;
  IF (SELECT posted_at FROM gl_journal_entries WHERE id = v) <> now() THEN
    RAISE EXCEPTION 'caller-supplied posted_at must be replaced by now()';
  END IF;
  RAISE NOTICE 'ok: posted_at is set by the database, not the caller';
END $$;

-- ── Immutability ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE v UUID := (SELECT id FROM gl_journal_entries WHERE memo = 'Oct rent, Ste 3');
BEGIN
  PERFORM pg_temp.expect_error(format('UPDATE gl_journal_entries SET memo = %L WHERE id = %L', 'edited', v), 'immutable');
  PERFORM pg_temp.expect_error(format('DELETE FROM gl_journal_entries WHERE id = %L', v), 'immutable');
  PERFORM pg_temp.expect_error(format('UPDATE gl_journal_lines SET debit_cents = 1 WHERE entry_id = %L', v), 'immutable');
  PERFORM pg_temp.expect_error(format('DELETE FROM gl_journal_lines WHERE entry_id = %L', v), 'immutable');
  PERFORM pg_temp.expect_error('TRUNCATE gl_journal_lines', 'immutable');
  -- appending a balanced pair to an entry posted in an earlier transaction
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO gl_journal_lines (entry_id, entity_id, account_id, line_no, debit_cents) VALUES (%L, %L, %L, 3, 7);' ||
    'INSERT INTO gl_journal_lines (entry_id, entity_id, account_id, line_no, credit_cents) VALUES (%L, %L, %L, 4, 7)',
    v, 'e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003',
    v, 'e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002'), 'only be added in the transaction');
  RAISE NOTICE 'ok: entries and lines immutable; no appending lines to an old entry';
END $$;

-- ── Reversal ──────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE v UUID := (SELECT id FROM gl_journal_entries WHERE memo = 'Oct rent, Ste 3');
DECLARE r UUID;
BEGIN
  r := gl_reverse_entry(v, '2026-10-31', 'Reverse: wrong suite', 'tester');
  SET CONSTRAINTS ALL IMMEDIATE;
  IF (SELECT sum(debit_cents) - sum(credit_cents) FROM gl_journal_lines WHERE entry_id IN (v, r) AND account_id = 'a0000000-0000-4000-8000-000000000001') <> 0 THEN
    RAISE EXCEPTION 'reversal should net the cash account to zero';
  END IF;
  PERFORM pg_temp.expect_error(format('SELECT gl_reverse_entry(%L, %L, %L, %L)', v, '2026-10-31', 'again', 't'), 'gl_journal_entries_reverses_entry_id_key|duplicate key');
  PERFORM pg_temp.expect_error(format('SELECT gl_reverse_entry(%L, %L, %L, %L)', r, '2026-10-31', 'rev of rev', 't'), 'cannot itself be reversed');
  RAISE NOTICE 'ok: reversal mirrors and nets to zero; once only; no reversal of a reversal';
END $$;

-- ── Period lock ───────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE v UUID;
BEGIN
  v := gl_post_entry('e0000000-0000-4000-8000-000000000001', '2026-09-15', 'Sep repair', 'manual', 'tester',
    '[{"account_id":"a0000000-0000-4000-8000-000000000003","debit_cents":485000},{"account_id":"a0000000-0000-4000-8000-000000000001","credit_cents":485000}]');
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM gl_lock_period('e0000000-0000-4000-8000-000000000001', '2026-09-01', 'owner@example.test');
  PERFORM pg_temp.expect_error($q$SELECT gl_post_entry('e0000000-0000-4000-8000-000000000001', '2026-09-20', 'late', 'manual', 't',
    '[{"account_id":"a0000000-0000-4000-8000-000000000001","debit_cents":100},{"account_id":"a0000000-0000-4000-8000-000000000002","credit_cents":100}]')$q$, 'is locked');
  -- direct insert into a locked month is blocked by the trigger too
  PERFORM pg_temp.expect_error($q$INSERT INTO gl_journal_entries (entity_id, entry_date, memo, source, posted_by)
    VALUES ('e0000000-0000-4000-8000-000000000001', '2026-09-30', 'sneak', 'manual', 't')$q$, 'is locked');
  -- a reversal dated in the locked month is rejected; dated in an open month it is allowed
  PERFORM pg_temp.expect_error(format('SELECT gl_reverse_entry(%L, %L, %L, %L)', v, '2026-09-30', 'rev', 't'), 'is locked');
  PERFORM gl_reverse_entry(v, '2026-11-02', 'Reverse Sep repair in Nov', 'tester');
  SET CONSTRAINTS ALL IMMEDIATE;
  -- unlock / edit / delete / relock refused
  PERFORM pg_temp.expect_error($q$UPDATE gl_periods SET status = 'open', locked_at = NULL, locked_by = NULL WHERE period_start = '2026-09-01'$q$, 'cannot be changed or unlocked');
  PERFORM pg_temp.expect_error($q$DELETE FROM gl_periods WHERE period_start = '2026-09-01'$q$, 'cannot be deleted');
  PERFORM pg_temp.expect_error($q$SELECT gl_lock_period('e0000000-0000-4000-8000-000000000001', '2026-09-01', 'x')$q$, 'already locked');
  PERFORM pg_temp.expect_error($q$SELECT gl_lock_period('e0000000-0000-4000-8000-000000000001', '2026-09-02', 'x')$q$, 'first day of a month');
  PERFORM pg_temp.expect_error($q$SELECT gl_lock_period('e0000000-0000-4000-8000-000000000001', '2026-08-01', ' ')$q$, 'locked_by is required');
  -- the lock is per entity: the other LLC's September is still open
  PERFORM gl_post_entry('e0000000-0000-4000-8000-000000000002', '2026-09-20', 'Columbia Sep', 'manual', 'tester',
    '[{"account_id":"a0000000-0000-4000-8000-000000000009","debit_cents":100},{"account_id":"a0000000-0000-4000-8000-000000000009","credit_cents":100}]');
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE NOTICE 'ok: locked month rejects postings (function and direct), reversals go to an open month, lock is permanent and per entity';
END $$;

-- ── Trial balance (the sum the API computes) ──────────────────────────────────────────────────
DO $$
DECLARE d BIGINT; c BIGINT;
BEGIN
  SELECT sum(debit_cents), sum(credit_cents) INTO d, c FROM gl_journal_lines WHERE entity_id = 'e0000000-0000-4000-8000-000000000001';
  IF d <> c THEN RAISE EXCEPTION 'trial balance does not tie: % vs %', d, c; END IF;
  RAISE NOTICE 'ok: entity trial balance ties (% cents each side)', d;
END $$;

-- ── REFUTE regressions (2026-11-10 adversarial pass) ───────────────────────────────────────────
-- D1: two transactions in ONE simple-query message share now(). The second must still be unable to
-- append lines to the first's entry. `\;` keeps everything in a single message to psql's server.
BEGIN \; SELECT gl_post_entry('e0000000-0000-4000-8000-000000000002', '2026-10-20', 'D1 victim', 'manual', 'tester', '[{"account_id":"a0000000-0000-4000-8000-000000000009","debit_cents":100},{"account_id":"a0000000-0000-4000-8000-000000000009","credit_cents":100}]') \; COMMIT \; BEGIN \; SELECT pg_temp.expect_error(format('INSERT INTO gl_journal_lines (entry_id, entity_id, account_id, line_no, debit_cents) VALUES (%L, %L, %L, 3, 999900); INSERT INTO gl_journal_lines (entry_id, entity_id, account_id, line_no, credit_cents) VALUES (%L, %L, %L, 4, 999900)', (SELECT id FROM gl_journal_entries WHERE memo = 'D1 victim'), 'e0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000009', (SELECT id FROM gl_journal_entries WHERE memo = 'D1 victim'), 'e0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000009'), 'only be added in the transaction') \; COMMIT;
DO $$ BEGIN
  IF (SELECT count(*) FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.entry_id WHERE e.memo = 'D1 victim') <> 2 THEN
    RAISE EXCEPTION 'D1: lines were appended to an entry from another transaction';
  END IF;
  IF (SELECT posted_txid FROM gl_journal_entries WHERE memo = 'D1 victim') IS NULL THEN
    RAISE EXCEPTION 'D1: posted_txid must be set by the database';
  END IF;
  RAISE NOTICE 'ok: D1 same-message transactions cannot append lines to another transaction''s entry';
END $$;

-- D3: periods, accounts and entities cannot be truncated; no period row (open or locked) can be deleted.
DO $$ BEGIN
  PERFORM pg_temp.expect_error('TRUNCATE gl_periods', 'cannot be truncated');
  PERFORM pg_temp.expect_error('TRUNCATE gl_accounts CASCADE', 'cannot be truncated');
  PERFORM pg_temp.expect_error('TRUNCATE gl_entities CASCADE', 'cannot be truncated');
  PERFORM pg_temp.expect_error($q$DELETE FROM gl_periods WHERE period_start = '2026-10-01'$q$, 'cannot be deleted');
  IF NOT EXISTS (SELECT 1 FROM gl_periods WHERE period_start = '2026-09-01' AND status = 'locked') THEN
    RAISE EXCEPTION 'D3: the September lock must survive';
  END IF;
  RAISE NOTICE 'ok: D3 locks survive TRUNCATE/DELETE attempts; accounts and entities cannot be truncated';
END $$;

-- D4: reversal integrity holds for direct inserts too.
DO $$
DECLARE v_real UUID; v_rev UUID;
BEGIN
  v_real := gl_post_entry('e0000000-0000-4000-8000-000000000001', '2026-11-03', 'D4 real', 'manual', 'tester',
    '[{"account_id":"a0000000-0000-4000-8000-000000000003","debit_cents":700},{"account_id":"a0000000-0000-4000-8000-000000000001","credit_cents":700}]');
  SELECT id INTO v_rev FROM gl_journal_entries WHERE source = 'reversal' LIMIT 1;
  -- a direct "reversal of a reversal"
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO gl_journal_entries (entity_id, entry_date, memo, source, reverses_entry_id, posted_by) VALUES (%L, %L, %L, %L, %L, %L)',
    'e0000000-0000-4000-8000-000000000001', '2026-11-04', 'rev of rev', 'reversal', v_rev, 't'), 'cannot itself be reversed');
  -- a direct fake "reversal" of the real entry with non-mirror lines (would block the real reversal)
  PERFORM pg_temp.expect_error(format(
    'WITH e AS (INSERT INTO gl_journal_entries (entity_id, entry_date, memo, source, reverses_entry_id, posted_by) VALUES (%L, %L, %L, %L, %L, %L) RETURNING id) ' ||
    'INSERT INTO gl_journal_lines (entry_id, entity_id, account_id, line_no, debit_cents, credit_cents) ' ||
    'SELECT id, %L::uuid, %L::uuid, 1, 5::bigint, 0::bigint FROM e UNION ALL SELECT id, %L::uuid, %L::uuid, 2, 0::bigint, 5::bigint FROM e',
    'e0000000-0000-4000-8000-000000000001', '2026-11-04', 'fake', 'reversal', v_real, 't',
    'e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
    'e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002'), 'does not exactly mirror');
  -- the real reversal still works afterwards
  PERFORM gl_reverse_entry(v_real, '2026-11-05', 'D4 real reversal', 'tester');
  RAISE NOTICE 'ok: D4 no direct reversal-of-reversal; non-mirror fake reversal rejected; real reversal unblocked';
END $$;

-- D5: two postings (and a reversal) in one transaction.
DO $$
DECLARE a UUID; b UUID;
BEGIN
  a := gl_post_entry('e0000000-0000-4000-8000-000000000001', '2026-11-06', 'D5 first', 'manual', 'tester',
    '[{"account_id":"a0000000-0000-4000-8000-000000000001","debit_cents":10},{"account_id":"a0000000-0000-4000-8000-000000000002","credit_cents":10}]');
  b := gl_post_entry('e0000000-0000-4000-8000-000000000001', '2026-11-06', 'D5 second', 'manual', 'tester',
    '[{"account_id":"a0000000-0000-4000-8000-000000000001","debit_cents":20},{"account_id":"a0000000-0000-4000-8000-000000000002","credit_cents":20}]');
  PERFORM gl_reverse_entry(a, '2026-11-07', 'D5 reverse first', 'tester');
  PERFORM gl_post_entry('e0000000-0000-4000-8000-000000000001', '2026-11-07', 'D5 third', 'manual', 'tester',
    '[{"account_id":"a0000000-0000-4000-8000-000000000001","debit_cents":30},{"account_id":"a0000000-0000-4000-8000-000000000002","credit_cents":30}]');
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE NOTICE 'ok: D5 several postings and a reversal in one transaction';
END $$;

-- Observations: deactivated accounts stay reversible; posted history cannot be reclassified; only
-- ended months can be locked.
DO $$
DECLARE v UUID;
BEGIN
  v := gl_post_entry('e0000000-0000-4000-8000-000000000001', '2026-11-08', 'Obs repairs', 'manual', 'tester',
    '[{"account_id":"a0000000-0000-4000-8000-000000000003","debit_cents":4000},{"account_id":"a0000000-0000-4000-8000-000000000001","credit_cents":4000}]');
  SET CONSTRAINTS ALL IMMEDIATE;
  UPDATE gl_accounts SET is_active = false, qb_name = 'Repairs (retired)', number = '6100R' WHERE id = 'a0000000-0000-4000-8000-000000000003';
  PERFORM gl_reverse_entry(v, '2026-11-09', 'Reverse through a retired account', 'tester');
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM pg_temp.expect_error($q$UPDATE gl_accounts SET account_type = 'asset' WHERE id = 'a0000000-0000-4000-8000-000000000003'$q$, 'entity and type cannot change');
  PERFORM pg_temp.expect_error($q$UPDATE gl_entities SET accounting_basis = 'cash' WHERE id = 'e0000000-0000-4000-8000-000000000001'$q$, 'accounting basis cannot change');
  PERFORM pg_temp.expect_error(format('SELECT gl_lock_period(%L, %L, %L)', 'e0000000-0000-4000-8000-000000000001', date_trunc('month', current_date)::date, 'x'), 'has ended');
  PERFORM pg_temp.expect_error(format('SELECT gl_lock_period(%L, %L, %L)', 'e0000000-0000-4000-8000-000000000001', '2099-12-01', 'x'), 'has ended');
  RAISE NOTICE 'ok: retired accounts stay reversible; type/basis frozen once used; only ended months lock';
END $$;

-- ── REFUTE pass 2 regressions ─────────────────────────────────────────────────────────────────
-- B1: lines added to a reversal AFTER gl_reverse_entry's immediate check are still mirror-checked
-- (here: a $999,999 pair on a retired account).
DO $$
DECLARE v UUID; r UUID;
BEGIN
  BEGIN
    v := gl_post_entry('e0000000-0000-4000-8000-000000000001', '2026-11-08', 'B1 original', 'manual', 'tester',
      '[{"account_id":"a0000000-0000-4000-8000-000000000001","debit_cents":500},{"account_id":"a0000000-0000-4000-8000-000000000002","credit_cents":500}]');
    r := gl_reverse_entry(v, '2026-11-09', 'B1 reversal', 'tester');
    INSERT INTO gl_journal_lines (entry_id, entity_id, account_id, line_no, debit_cents, credit_cents) VALUES
      (r, 'e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003', 10, 99999900, 0),
      (r, 'e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003', 11, 0, 99999900);
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'B1: extra lines on a reversal were accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%does not exactly mirror%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'ok: B1 lines added to a reversal after its check are re-checked at commit';
END $$;

-- S1: reversal of a reversal hidden in one multi-row INSERT (B listed before the A it reverses).
DO $$
DECLARE y UUID;
BEGIN
  BEGIN
    y := gl_post_entry('e0000000-0000-4000-8000-000000000001', '2026-11-08', 'S1 Y', 'manual', 'tester',
      '[{"account_id":"a0000000-0000-4000-8000-000000000001","debit_cents":800},{"account_id":"a0000000-0000-4000-8000-000000000002","credit_cents":800}]');
    INSERT INTO gl_journal_entries (id, entity_id, entry_date, memo, source, reverses_entry_id, posted_by) VALUES
      ('5e000000-0000-4000-8000-00000000000b', 'e0000000-0000-4000-8000-000000000001', '2026-11-09', 'S1 B', 'reversal', '5e000000-0000-4000-8000-00000000000a', 't'),
      ('5e000000-0000-4000-8000-00000000000a', 'e0000000-0000-4000-8000-000000000001', '2026-11-09', 'S1 A', 'reversal', y, 't');
    INSERT INTO gl_journal_lines (entry_id, entity_id, account_id, line_no, debit_cents, credit_cents)
      SELECT '5e000000-0000-4000-8000-00000000000a'::uuid, entity_id, account_id, line_no, credit_cents, debit_cents FROM gl_journal_lines WHERE entry_id = y
      UNION ALL
      SELECT '5e000000-0000-4000-8000-00000000000b'::uuid, entity_id, account_id, line_no, debit_cents, credit_cents FROM gl_journal_lines WHERE entry_id = y;
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'S1: a reversal of a reversal was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%cannot itself be reversed%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'ok: S1 reversal-of-reversal rejected even within one multi-row INSERT';
END $$;

-- S2: locking rules hold for direct SQL on gl_periods, not only through gl_lock_period.
DO $$ BEGIN
  PERFORM pg_temp.expect_error($q$INSERT INTO gl_periods (entity_id, period_start, status, locked_at, locked_by) VALUES ('e0000000-0000-4000-8000-000000000001', '2027-06-01', 'locked', now(), ' ')$q$, 'created open');
  PERFORM pg_temp.expect_error($q$UPDATE gl_periods SET status = 'locked', locked_at = now(), locked_by = 'x' WHERE entity_id = 'e0000000-0000-4000-8000-000000000001' AND period_start = '2026-11-01'$q$, 'has ended');
  INSERT INTO gl_periods (entity_id, period_start) VALUES ('e0000000-0000-4000-8000-000000000001', '2026-07-01');
  PERFORM pg_temp.expect_error($q$UPDATE gl_periods SET status = 'locked', locked_at = now(), locked_by = '  ' WHERE entity_id = 'e0000000-0000-4000-8000-000000000001' AND period_start = '2026-07-01'$q$, 'locked_by is required');
  IF gl_today() <> (now() AT TIME ZONE 'America/Chicago')::date THEN
    RAISE EXCEPTION 'S2/N2: gl_today must be the US Central date';
  END IF;
  RAISE NOTICE 'ok: S2 periods are born open; direct-SQL locks need an ended month (US Central) and a locker';
END $$;

-- N1: no infinite or absurd entry dates.
DO $$ BEGIN
  PERFORM pg_temp.expect_error($q$SELECT gl_post_entry('e0000000-0000-4000-8000-000000000001', 'infinity', 'N1', 'manual', 'tester', '[{"account_id":"a0000000-0000-4000-8000-000000000001","debit_cents":1},{"account_id":"a0000000-0000-4000-8000-000000000002","credit_cents":1}]')$q$, 'gl_journal_entries_date_range');
  RAISE NOTICE 'ok: N1 entry dates must fall in 2000–2100';
END $$;

-- ── Privileges ────────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF has_function_privilege('anon', 'gl_post_entry(uuid, date, text, text, text, jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'gl_post_entry(uuid, date, text, text, text, jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'gl_lock_period(uuid, date, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'gl_reverse_entry(uuid, date, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon/authenticated must not be able to execute the GL write functions';
  END IF;
  IF NOT has_function_privilege('service_role', 'gl_post_entry(uuid, date, text, text, text, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role must be able to post';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname LIKE 'gl\_%' AND relkind = 'r' AND NOT relrowsecurity) THEN
    RAISE EXCEPTION 'every gl_ table must have RLS enabled';
  END IF;
  RAISE NOTICE 'ok: write functions service_role only; RLS on every gl_ table';
END $$;
