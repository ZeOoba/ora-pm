-- Real-Postgres tests for 0029_gl_ar_cash_posting.sql (B8 slice 4, cash-basis AR posting). Own
-- session, own fixtures (scripts/verify-gl-sql.sh). Rules C1–C5 are described in the migration
-- header. Ledger start date 2026-10-01. Amounts in the comments are dollars; balances are cents.

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

-- Balance (debit − credit) of one of the cash LLC's accounts, by number.
CREATE OR REPLACE FUNCTION pg_temp.bal(p_number TEXT) RETURNS BIGINT LANGUAGE sql AS $$
  SELECT coalesce(sum(l.debit_cents - l.credit_cents), 0)::bigint
    FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.entry_id JOIN gl_accounts a ON a.id = l.account_id
   WHERE e.entity_id = 'a8000000-0000-4000-8000-000000000001' AND a.number = p_number
$$;

-- Fixtures: a cash-basis LLC, one property and unit, two leases.
INSERT INTO gl_entities (id, name, accounting_basis) VALUES ('a8000000-0000-4000-8000-000000000001', 'Cash Flex LLC', 'cash');
INSERT INTO properties (id, name) VALUES ('a8100000-0000-4000-8000-000000000001', 'Grandview Flex');
UPDATE properties SET gl_entity_id = 'a8000000-0000-4000-8000-000000000001' WHERE id = 'a8100000-0000-4000-8000-000000000001';
INSERT INTO units (id, property_id, suite) VALUES ('a8200000-0000-4000-8000-000000000001', 'a8100000-0000-4000-8000-000000000001', 'A');
INSERT INTO leases (id, unit_id) VALUES
  ('a8300000-0000-4000-8000-000000000001', 'a8200000-0000-4000-8000-000000000001'),
  ('a8300000-0000-4000-8000-000000000002', 'a8200000-0000-4000-8000-000000000001');
INSERT INTO gl_accounts (id, entity_id, number, qb_name, account_type) VALUES
  ('a8a00000-0000-4000-8000-000000000001', 'a8000000-0000-4000-8000-000000000001', '1000', 'Operating Cash', 'asset'),
  ('a8a00000-0000-4000-8000-000000000002', 'a8000000-0000-4000-8000-000000000001', '1499', 'Undeposited Funds', 'asset'),
  ('a8a00000-0000-4000-8000-000000000003', 'a8000000-0000-4000-8000-000000000001', '2200', 'Security Deposits Held', 'liability'),
  ('a8a00000-0000-4000-8000-000000000004', 'a8000000-0000-4000-8000-000000000001', '2300', 'Prepaid Rent', 'liability'),
  ('a8a00000-0000-4000-8000-000000000005', 'a8000000-0000-4000-8000-000000000001', '3000', 'Members'' Equity', 'equity'),
  ('a8a00000-0000-4000-8000-000000000006', 'a8000000-0000-4000-8000-000000000001', '4000', 'Rental Income', 'income'),
  ('a8a00000-0000-4000-8000-000000000007', 'a8000000-0000-4000-8000-000000000001', '4100', 'Late Fees', 'income'),
  ('a8a00000-0000-4000-8000-000000000008', 'a8000000-0000-4000-8000-000000000001', '2310', 'Other Liability', 'liability');

-- Pre-start (before 2026-10-01). L1: Sep rent 1,000; check 600; ACH 100 still processing (not counted)
-- → owes 400, no credit. L2: Sep rent 500; check 700 → credit 200. Tenant credits at the tie-out: 200.
INSERT INTO charges (id, lease_id, charge_date, due_date, type, amount) VALUES
  ('a8c00000-0000-4000-8000-000000000001', 'a8300000-0000-4000-8000-000000000001', '2026-09-01', '2026-09-01', 'rent', 1000.00),
  ('a8c00000-0000-4000-8000-000000000002', 'a8300000-0000-4000-8000-000000000002', '2026-09-01', '2026-09-01', 'rent', 500.00);
ALTER TABLE payments DISABLE TRIGGER payments_status_changed_at;
INSERT INTO payments (id, lease_id, payment_date, amount, method, stripe_status, status_changed_at) VALUES
  ('a8d00000-0000-4000-8000-000000000001', 'a8300000-0000-4000-8000-000000000001', '2026-09-05', 600.00, 'check', NULL, NULL),
  ('a8d00000-0000-4000-8000-000000000002', 'a8300000-0000-4000-8000-000000000001', '2026-09-28', 100.00, 'ach_stripe', 'processing', '2026-09-28 15:00Z'),
  ('a8d00000-0000-4000-8000-000000000003', 'a8300000-0000-4000-8000-000000000002', '2026-09-25', 700.00, 'check', NULL, NULL);
ALTER TABLE payments ENABLE TRIGGER payments_status_changed_at;

INSERT INTO gl_ar_accounts (entity_id, role, account_id, updated_by) VALUES
  ('a8000000-0000-4000-8000-000000000001', 'undeposited_funds', 'a8a00000-0000-4000-8000-000000000002', 'tester'),
  ('a8000000-0000-4000-8000-000000000001', 'security_deposit', 'a8a00000-0000-4000-8000-000000000003', 'tester'),
  ('a8000000-0000-4000-8000-000000000001', 'rent', 'a8a00000-0000-4000-8000-000000000006', 'tester'),
  ('a8000000-0000-4000-8000-000000000001', 'late_fee', 'a8a00000-0000-4000-8000-000000000007', 'tester');

-- C4: the cash tie-out needs prepaid_rent mapped, and tenant credits must equal its opening balance.
DO $$ BEGIN
  PERFORM gl_post_opening_balance('a8000000-0000-4000-8000-000000000001', '2026-10-01',
    '[{"account_id":"a8a00000-0000-4000-8000-000000000001","debit_cents":120000},{"account_id":"a8a00000-0000-4000-8000-000000000004","credit_cents":19999},{"account_id":"a8a00000-0000-4000-8000-000000000005","credit_cents":100001}]', 'tester');
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM pg_temp.expect_error($q$SELECT gl_confirm_ar_tieout('a8000000-0000-4000-8000-000000000001', 't')$q$, 'map an account to the prepaid_rent role');
  INSERT INTO gl_ar_accounts (entity_id, role, account_id, updated_by) VALUES ('a8000000-0000-4000-8000-000000000001', 'prepaid_rent', 'a8a00000-0000-4000-8000-000000000004', 'tester');
  PERFORM pg_temp.expect_error($q$SELECT gl_confirm_ar_tieout('a8000000-0000-4000-8000-000000000001', 't')$q$,
    'AR does not tie: the app shows 20000 cents of tenant credits as of 2026-09-30, the ledger''s prepaid rent account 19999 cents \(difference 1 cents\)');
  PERFORM gl_reverse_entry((SELECT id FROM gl_journal_entries WHERE entity_id = 'a8000000-0000-4000-8000-000000000001' AND source = 'opening_balance'), '2026-09-30', 'prepaid off by a cent', 'tester');
  PERFORM gl_post_opening_balance('a8000000-0000-4000-8000-000000000001', '2026-10-01',
    '[{"account_id":"a8a00000-0000-4000-8000-000000000001","debit_cents":120000},{"account_id":"a8a00000-0000-4000-8000-000000000004","credit_cents":20000},{"account_id":"a8a00000-0000-4000-8000-000000000005","credit_cents":100000}]', 'tester');
  SET CONSTRAINTS ALL IMMEDIATE;
  IF gl_confirm_ar_tieout('a8000000-0000-4000-8000-000000000001', 'tester') <> 20000 THEN RAISE EXCEPTION 'cash tie-out total'; END IF;
  -- C5: prepaid_rent is now fixed, like ar.
  PERFORM pg_temp.expect_error($q$UPDATE gl_ar_accounts SET account_id = 'a8a00000-0000-4000-8000-000000000008' WHERE entity_id = 'a8000000-0000-4000-8000-000000000001' AND role = 'prepaid_rent'$q$, 'fixed once the AR tie-out is confirmed');
  -- The accrual path refuses this entity, and the cash path refuses accrual entities.
  PERFORM pg_temp.expect_error($q$SELECT gl_post_ar_batch('a8000000-0000-4000-8000-000000000001', '2026-10-31', '[]', 't')$q$, 'is cash-basis; its AR posts through gl_post_ar_cash_batch');
  PERFORM pg_temp.expect_error($q$SELECT gl_post_ar_cash_batch('a7000000-0000-4000-8000-000000000001', '2026-10-31', '[]', 't')$q$, 'accrual-basis; post its AR with gl_post_ar_batch');
  RAISE NOTICE 'ok: C4 cash tie-out: prepaid_rent mapped, tenant credits tie to the cent, then fixed; each basis has its own path';
END $$;

-- October. L1: rent 1,000 (due 10-01), late fee 50 (10-06), the September ACH clears, check 1,200 on 10-10.
-- L2: rent 500 and a 300 security deposit, both due 10-01 (the deposit is paid first).
INSERT INTO charges (id, lease_id, charge_date, due_date, type, amount) VALUES
  ('a8c00000-0000-4000-8000-000000000011', 'a8300000-0000-4000-8000-000000000001', '2026-10-01', '2026-10-01', 'rent', 1000.00),
  ('a8c00000-0000-4000-8000-000000000012', 'a8300000-0000-4000-8000-000000000001', '2026-10-06', '2026-10-06', 'late_fee', 50.00),
  ('a8c00000-0000-4000-8000-000000000021', 'a8300000-0000-4000-8000-000000000002', '2026-10-01', '2026-10-01', 'rent', 500.00),
  ('a8c00000-0000-4000-8000-000000000022', 'a8300000-0000-4000-8000-000000000002', '2026-10-01', '2026-10-01', 'security_deposit', 300.00);
INSERT INTO payments (id, lease_id, payment_date, amount, method, stripe_status) VALUES
  ('a8d00000-0000-4000-8000-000000000011', 'a8300000-0000-4000-8000-000000000001', '2026-10-10', 1200.00, 'check', NULL);
UPDATE payments SET stripe_status = 'succeeded' WHERE id = 'a8d00000-0000-4000-8000-000000000002';

-- C3: cash cannot go in ahead of a charge live on its date.
DO $$ BEGIN
  PERFORM pg_temp.expect_error($q$SELECT gl_post_ar_cash_batch('a8000000-0000-4000-8000-000000000001', '2026-10-31',
    '[{"kind":"payment","source_id":"a8d00000-0000-4000-8000-000000000011"}]', 't')$q$, 'would post before a charge live on its date');
  PERFORM pg_temp.expect_error($q$SELECT gl_post_ar_cash_batch('a8000000-0000-4000-8000-000000000001', '2026-10-31',
    '[{"kind":"charge","source_id":"a8c00000-0000-4000-8000-000000000001"}]', 't')$q$, 'outside the ledger start date|before the ledger start date');
  PERFORM pg_temp.expect_error($q$SELECT gl_post_ar_cash_batch('a8000000-0000-4000-8000-000000000001', '2026-10-31',
    '[{"kind":"payment","source_id":"a8d00000-0000-4000-8000-000000000001"}]', 't')$q$, 'in the tie-out snapshot as received');
  RAISE NOTICE 'ok: C3 no cash ahead of a live charge; pre-start charges and counted payments never re-enter';
END $$;

SELECT gl_post_ar_cash_batch('a8000000-0000-4000-8000-000000000001', '2026-10-31',
  '[{"kind":"charge","source_id":"a8c00000-0000-4000-8000-000000000011"},{"kind":"charge","source_id":"a8c00000-0000-4000-8000-000000000021"},
    {"kind":"charge","source_id":"a8c00000-0000-4000-8000-000000000022"},{"kind":"payment","source_id":"a8d00000-0000-4000-8000-000000000002"},
    {"kind":"charge","source_id":"a8c00000-0000-4000-8000-000000000012"},{"kind":"payment","source_id":"a8d00000-0000-4000-8000-000000000011"}]', 'tester') AS n \gset
DO $$
DECLARE n_entries INT;
BEGIN
  -- L1: the cleared ACH pays September (+100 rent); the check pays September's last 300 and October's 900 (+1,200 rent).
  -- L2: its 200 credit goes to rent, then moves to the deposit when the deposit (same due date, paid first) arrives.
  IF pg_temp.bal('1499') <> 130000 OR pg_temp.bal('4000') <> -130000 OR pg_temp.bal('2200') <> -20000
     OR pg_temp.bal('2300') <> 0 OR pg_temp.bal('4100') <> 0 THEN
    RAISE EXCEPTION 'October balances: UF % rent % deposits % prepaid % late fees %', pg_temp.bal('1499'), pg_temp.bal('4000'), pg_temp.bal('2200'), pg_temp.bal('2300'), pg_temp.bal('4100');
  END IF;
  SELECT count(*) INTO n_entries FROM gl_ar_cash_entries x JOIN gl_ar_cash_events e ON e.id = x.event_id WHERE e.entity_id = 'a8000000-0000-4000-8000-000000000001';
  -- Entries: L2 rent (credit → rent), L2 deposit (rent → deposit), the ACH, the check. L1's charges change nothing.
  IF n_entries <> 4 OR (SELECT count(*) FROM gl_ar_cash_events WHERE entity_id = 'a8000000-0000-4000-8000-000000000001') <> 6 THEN
    RAISE EXCEPTION 'expected 6 events and 4 entries, got % entries', n_entries;
  END IF;
  IF (SELECT entry_date FROM gl_journal_entries j JOIN gl_ar_cash_entries x ON x.entry_id = j.id JOIN gl_ar_cash_events e ON e.id = x.event_id
       WHERE e.kind = 'payment' AND e.source_id = 'a8d00000-0000-4000-8000-000000000002') <> '2026-10-01' THEN
    RAISE EXCEPTION 'the September ACH that cleared after the tie-out should post on the start date';
  END IF;
  RAISE NOTICE 'ok: cash batch: oldest-first income, deposit before rent on one due date, credit applied, late ACH on the start date';
END $$;

-- A void of a PAID pre-start charge (Sep rent, voided 10-20): its 1,000 moves to October rent (+100),
-- the late fee (+50) and credit (+850). Then the ACH that cleared late is returned (today): credit −100.
UPDATE charges SET voided_at = '2026-10-20 15:00Z', void_reason = 'billed in error' WHERE id = 'a8c00000-0000-4000-8000-000000000001';
UPDATE payments SET stripe_status = 'returned' WHERE id = 'a8d00000-0000-4000-8000-000000000002';
SELECT gl_post_ar_cash_batch('a8000000-0000-4000-8000-000000000001', gl_today(),
  '[{"kind":"charge_void","source_id":"a8c00000-0000-4000-8000-000000000001"},{"kind":"payment_return","source_id":"a8d00000-0000-4000-8000-000000000002"}]', 'tester') AS n2 \gset
DO $$
DECLARE v DATE;
BEGIN
  IF pg_temp.bal('1499') <> 120000 OR pg_temp.bal('4000') <> -40000 OR pg_temp.bal('4100') <> -5000
     OR pg_temp.bal('2300') <> -75000 OR pg_temp.bal('2200') <> -20000 THEN
    RAISE EXCEPTION 'after void and return: UF % rent % late % prepaid % deposits %', pg_temp.bal('1499'), pg_temp.bal('4000'), pg_temp.bal('4100'), pg_temp.bal('2300'), pg_temp.bal('2200');
  END IF;
  SELECT e.event_date INTO v FROM gl_ar_cash_events e WHERE e.kind = 'charge_void' AND e.source_id = 'a8c00000-0000-4000-8000-000000000001';
  IF v <> '2026-10-20' THEN RAISE EXCEPTION 'void dated %', v; END IF;
  -- Invariant: the prepaid account equals the replay's credits, lease by lease.
  IF -pg_temp.bal('2300') <> (SELECT sum(a.cents) FROM (VALUES ('a8300000-0000-4000-8000-000000000001'::uuid), ('a8300000-0000-4000-8000-000000000002'::uuid)) l(id),
                                LATERAL gl_ar_cash_alloc(l.id, 9223372036854775807) a WHERE a.role = 'prepaid_rent') THEN
    RAISE EXCEPTION 'prepaid account and replay credits disagree';
  END IF;
  PERFORM pg_temp.expect_error($q$SELECT gl_post_ar_cash_batch('a8000000-0000-4000-8000-000000000001', gl_today(), '[{"kind":"charge_void","source_id":"a8c00000-0000-4000-8000-000000000001"}]', 't')$q$, 'gl_ar_cash_events_once|duplicate key');
  PERFORM pg_temp.expect_error($q$SELECT gl_post_ar_cash_batch('a8000000-0000-4000-8000-000000000001', gl_today(), '[{"kind":"charge_void","source_id":"a8c00000-0000-4000-8000-000000000011"}]', 't')$q$, 'not live in the replay, or is not voided');
  RAISE NOTICE 'ok: a paid charge''s void moves its cash on (oldest first, rest to credit); an ACH return takes cash back out; once each';
END $$;

-- Forgeries and guards.
INSERT INTO payments (id, lease_id, payment_date, amount, method, stripe_status) VALUES
  ('a8d00000-0000-4000-8000-000000000021', 'a8300000-0000-4000-8000-000000000002', '2026-11-02', 400.00, 'check', NULL);
CREATE FUNCTION pg_temp.forge(p_date DATE, p_entry BOOLEAN) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v UUID; e UUID;
BEGIN
  INSERT INTO gl_ar_cash_events (entity_id, lease_id, kind, source_id, event_date, posted_by, seq)
    VALUES ('a8000000-0000-4000-8000-000000000001', 'a8300000-0000-4000-8000-000000000002', 'payment', 'a8d00000-0000-4000-8000-000000000021', p_date, 'x', 1) RETURNING id INTO v;
  IF p_entry THEN  -- right amount, wrong split: all of it to rent
    INSERT INTO gl_journal_entries (entity_id, entry_date, memo, source, posted_by) VALUES ('a8000000-0000-4000-8000-000000000001', p_date, 'forged', 'ar_posting', 'x') RETURNING id INTO e;
    INSERT INTO gl_journal_lines (entry_id, entity_id, account_id, line_no, debit_cents, credit_cents) VALUES
      (e, 'a8000000-0000-4000-8000-000000000001', 'a8a00000-0000-4000-8000-000000000002', 1, 40000, 0),
      (e, 'a8000000-0000-4000-8000-000000000001', 'a8a00000-0000-4000-8000-000000000006', 2, 0, 40000);
    INSERT INTO gl_ar_cash_entries (event_id, entity_id, entry_id) VALUES (v, 'a8000000-0000-4000-8000-000000000001', e);
  END IF;
END $$;
CREATE FUNCTION pg_temp.extra_lines() RETURNS void LANGUAGE plpgsql AS $$
DECLARE e UUID;
BEGIN
  PERFORM gl_post_ar_cash_batch('a8000000-0000-4000-8000-000000000001', gl_today(), '[{"kind":"payment","source_id":"a8d00000-0000-4000-8000-000000000021"}]', 'tester');
  SELECT x.entry_id INTO e FROM gl_ar_cash_entries x JOIN gl_ar_cash_events v ON v.id = x.event_id WHERE v.source_id = 'a8d00000-0000-4000-8000-000000000021';
  INSERT INTO gl_journal_lines (entry_id, entity_id, account_id, line_no, debit_cents, credit_cents) VALUES
    (e, 'a8000000-0000-4000-8000-000000000001', 'a8a00000-0000-4000-8000-000000000002', 9, 500, 0),
    (e, 'a8000000-0000-4000-8000-000000000001', 'a8a00000-0000-4000-8000-000000000006', 10, 0, 500);
END $$;
DO $$
DECLARE s BIGINT;
BEGIN
  PERFORM pg_temp.expect_error($q$SELECT pg_temp.forge('2026-11-05', false)$q$, 'must be dated 2026-11-02');
  PERFORM pg_temp.expect_error($q$SELECT pg_temp.forge('2026-11-02', false)$q$, 'must post an ar_posting entry');
  PERFORM pg_temp.expect_error($q$SELECT pg_temp.forge('2026-11-02', true)$q$, 'must post exactly its allocation change');
  PERFORM pg_temp.expect_error('SELECT pg_temp.extra_lines()', 'must post exactly its allocation change');
  PERFORM pg_temp.expect_error($q$WITH e AS (INSERT INTO gl_journal_entries (entity_id, entry_date, memo, source, posted_by) VALUES ('a8000000-0000-4000-8000-000000000001', '2026-11-02', 'orphan', 'ar_posting', 'x') RETURNING id)
    INSERT INTO gl_journal_lines (entry_id, entity_id, account_id, line_no, debit_cents, credit_cents)
      SELECT id, 'a8000000-0000-4000-8000-000000000001', a, n, d, c FROM e, (VALUES ('a8a00000-0000-4000-8000-000000000002'::uuid, 1, 100, 0), ('a8a00000-0000-4000-8000-000000000006'::uuid, 2, 0, 100)) v(a, n, d, c)$q$, 'AR posting with no AR link');
  PERFORM pg_temp.expect_error($q$UPDATE gl_ar_cash_events SET event_date = '2026-10-21' WHERE kind = 'charge_void'$q$, 'cannot be changed|immutable|cannot be');
  PERFORM pg_temp.expect_error($q$DELETE FROM gl_ar_cash_entries$q$, 'cannot be changed|immutable|cannot be');
  -- C2: seq is the database's, whatever the caller sends.
  SELECT max(seq) INTO s FROM gl_ar_cash_events;
  IF s < 8 OR EXISTS (SELECT 1 FROM gl_ar_cash_events WHERE seq <= 1) THEN
    RAISE EXCEPTION 'seq should come from the sequence';
  END IF;
  -- C5: a held cash-basis charge's due date is fixed; voids and Stripe statuses final as in 0028.
  PERFORM pg_temp.expect_error($q$UPDATE charges SET due_date = '2026-09-15' WHERE id = 'a8c00000-0000-4000-8000-000000000011'$q$, 'its due date cannot change');
  PERFORM pg_temp.expect_error($q$UPDATE charges SET voided_at = NULL WHERE id = 'a8c00000-0000-4000-8000-000000000001'$q$, 'void cannot be undone');
  PERFORM pg_temp.expect_error($q$UPDATE payments SET stripe_status = 'succeeded' WHERE id = 'a8d00000-0000-4000-8000-000000000002'$q$, 'that status is final');
  PERFORM pg_temp.expect_error($q$UPDATE units SET property_id = 'a7100000-0000-4000-8000-000000000001' WHERE id = 'a8200000-0000-4000-8000-000000000001'$q$, 'cannot move to another LLC');
  -- Hand reversal of a cash AR entry is refused (0028 H1 covers both link tables).
  PERFORM pg_temp.expect_error($q$SELECT gl_reverse_entry((SELECT x.entry_id FROM gl_ar_cash_entries x JOIN gl_ar_cash_events e ON e.id = x.event_id WHERE e.kind = 'payment' AND e.source_id = 'a8d00000-0000-4000-8000-000000000011'), gl_today(), 'x', 't')$q$, 'reverses an AR posting');
  RAISE NOTICE 'ok: C1/C2/C5 forged dates, missing or wrong entries, extra lines, orphans, edits and hand reversals all refused';
END $$;

-- The real thing: L2's 400 check pays its deposit's last 100 and October rent's 300.
SELECT gl_post_ar_cash_batch('a8000000-0000-4000-8000-000000000001', gl_today(), '[{"kind":"payment","source_id":"a8d00000-0000-4000-8000-000000000021"}]', 'tester') AS n3 \gset
DO $$ BEGIN
  IF pg_temp.bal('2200') <> -30000 OR pg_temp.bal('4000') <> -70000 OR pg_temp.bal('1499') <> 160000 THEN
    RAISE EXCEPTION 'L2 check: deposits % rent % UF %', pg_temp.bal('2200'), pg_temp.bal('4000'), pg_temp.bal('1499');
  END IF;
  RAISE NOTICE 'ok: partial payment fills the deposit before rent, oldest due date first';
END $$;

-- Locked month: October is closed; a check dated 10-25, entered late, posts on 11-01.
SELECT gl_lock_period('a8000000-0000-4000-8000-000000000001', '2026-10-01', 'closer@example.test');
INSERT INTO payments (id, lease_id, payment_date, amount, method, stripe_status) VALUES
  ('a8d00000-0000-4000-8000-000000000031', 'a8300000-0000-4000-8000-000000000002', '2026-10-25', 50.00, 'check', NULL);
SELECT gl_post_ar_cash_batch('a8000000-0000-4000-8000-000000000001', gl_today(), '[{"kind":"payment","source_id":"a8d00000-0000-4000-8000-000000000031"}]', 'tester') AS n4 \gset
DO $$ BEGIN
  IF (SELECT event_date FROM gl_ar_cash_events WHERE kind = 'payment' AND source_id = 'a8d00000-0000-4000-8000-000000000031') <> '2026-11-01' THEN
    RAISE EXCEPTION 'a payment dated in a locked month should post on the first day of the next open month';
  END IF;
  RAISE NOTICE 'ok: locked-month cash posts on the first day of the next open month';
END $$;

-- Access.
DO $$
DECLARE t TEXT;
BEGIN
  IF has_function_privilege('anon', 'gl_post_ar_cash_batch(uuid, date, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'gl_ar_cash_alloc(uuid, bigint)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'gl_post_ar_cash_batch(uuid, date, jsonb, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'cash AR functions must be EXECUTE for service_role only';
  END IF;
  FOREACH t IN ARRAY ARRAY['gl_ar_cash_events', 'gl_ar_cash_entries'] LOOP
    IF has_table_privilege('anon', 'public.' || t, 'SELECT') OR has_table_privilege('service_role', 'public.' || t, 'UPDATE')
       OR has_table_privilege('service_role', 'public.' || t, 'DELETE') OR has_table_privilege('service_role', 'public.' || t, 'TRUNCATE') THEN
      RAISE EXCEPTION 'unexpected privilege on %', t;
    END IF;
  END LOOP;
  IF has_sequence_privilege('service_role', 'gl_ar_cash_events_seq', 'UPDATE') OR NOT has_sequence_privilege('service_role', 'gl_ar_cash_events_seq', 'USAGE') THEN
    RAISE EXCEPTION 'service_role may draw from the event sequence but not rewind it';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname LIKE 'gl\_%'
                AND NOT (coalesce(p.proconfig, '{}') @> ARRAY['search_path=public, pg_temp'])) THEN
    RAISE EXCEPTION 'a function lacks search_path = public, pg_temp';
  END IF;
  RAISE NOTICE 'ok: cash AR functions service_role only; events and entries insert-only; sequence cannot be rewound; search paths pinned';
END $$;
