-- Real-Postgres tests for 0028_gl_ar_posting.sql (B8 slice 3, accrual AR posting). Own session,
-- own fixtures (scripts/verify-gl-sql.sh). Rules A1–A6 are described in the migration header.
-- The ledger start date here is 2026-10-01 (a run's through date may not be in the future).

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

-- Fixtures: an accrual LLC with one property, unit and lease; a cash-basis LLC.
INSERT INTO gl_entities (id, name, accounting_basis) VALUES
  ('a7000000-0000-4000-8000-000000000001', 'AR Holdings LLC', 'accrual'),
  ('a7000000-0000-4000-8000-000000000002', 'AR Cash LLC', 'cash');
INSERT INTO properties (id, name) VALUES ('a7100000-0000-4000-8000-000000000001', 'Raytown Flex');
UPDATE properties SET gl_entity_id = 'a7000000-0000-4000-8000-000000000001' WHERE id = 'a7100000-0000-4000-8000-000000000001';
INSERT INTO units (id, property_id, suite) VALUES ('a7200000-0000-4000-8000-000000000001', 'a7100000-0000-4000-8000-000000000001', '3');
INSERT INTO leases (id, unit_id) VALUES ('a7300000-0000-4000-8000-000000000001', 'a7200000-0000-4000-8000-000000000001');
INSERT INTO gl_accounts (id, entity_id, number, qb_name, account_type) VALUES
  ('a7a00000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', '1000', 'Operating Cash', 'asset'),
  ('a7a00000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-000000000001', '1200', 'Accounts Receivable', 'asset'),
  ('a7a00000-0000-4000-8000-000000000003', 'a7000000-0000-4000-8000-000000000001', '1499', 'Undeposited Funds', 'asset'),
  ('a7a00000-0000-4000-8000-000000000004', 'a7000000-0000-4000-8000-000000000001', '2200', 'Security Deposits Held', 'liability'),
  ('a7a00000-0000-4000-8000-000000000005', 'a7000000-0000-4000-8000-000000000001', '3000', 'Members'' Equity', 'equity'),
  ('a7a00000-0000-4000-8000-000000000006', 'a7000000-0000-4000-8000-000000000001', '4000', 'Rental Income', 'income'),
  ('a7a00000-0000-4000-8000-000000000007', 'a7000000-0000-4000-8000-000000000001', '4100', 'Late Fees', 'income'),
  ('a7a00000-0000-4000-8000-000000000008', 'a7000000-0000-4000-8000-000000000001', '1250', 'Other Receivable', 'asset');

-- Pre-start activity (before 2026-10-01): rent 1,000.00; check 600.00; ACH 200.00 succeeded (counted);
-- ACH 100.00 still processing at the tie-out (not counted); a late fee voided in September (not counted).
INSERT INTO charges (id, lease_id, charge_date, type, amount) VALUES
  ('a7c00000-0000-4000-8000-000000000000', 'a7300000-0000-4000-8000-000000000001', '2026-09-01', 'rent', 1000.00);
INSERT INTO charges (id, lease_id, charge_date, type, amount, voided_at, void_reason) VALUES
  ('a7c00000-0000-4000-8000-0000000000ff', 'a7300000-0000-4000-8000-000000000001', '2026-09-10', 'late_fee', 50.00, '2026-09-12 15:00Z', 'waived');
-- (Fixture history: Stripe statuses set in September. The trigger stamps server time, so it is
-- bypassed here to backdate them.)
ALTER TABLE payments DISABLE TRIGGER payments_status_changed_at;
INSERT INTO payments (id, lease_id, payment_date, amount, method, stripe_status, status_changed_at) VALUES
  ('a7d00000-0000-4000-8000-000000000000', 'a7300000-0000-4000-8000-000000000001', '2026-09-05', 600.00, 'check', NULL, NULL),
  ('a7d00000-0000-4000-8000-000000000004', 'a7300000-0000-4000-8000-000000000001', '2026-09-20', 200.00, 'ach_stripe', 'succeeded', '2026-09-23 15:00Z'),
  ('a7d00000-0000-4000-8000-000000000001', 'a7300000-0000-4000-8000-000000000001', '2026-09-28', 100.00, 'ach_stripe', 'processing', '2026-09-28 15:00Z');
ALTER TABLE payments ENABLE TRIGGER payments_status_changed_at;

-- A1: account roles must have the right account type and be in the entity's chart.
DO $$ BEGIN
  PERFORM pg_temp.expect_error($q$INSERT INTO gl_ar_accounts (entity_id, role, account_id, updated_by) VALUES ('a7000000-0000-4000-8000-000000000001', 'rent', 'a7a00000-0000-4000-8000-000000000001', 't')$q$, 'the rent role needs an income account');
  PERFORM pg_temp.expect_error($q$INSERT INTO gl_ar_accounts (entity_id, role, account_id, updated_by) VALUES ('a7000000-0000-4000-8000-000000000001', 'security_deposit', 'a7a00000-0000-4000-8000-000000000006', 't')$q$, 'needs an liability account');
  PERFORM pg_temp.expect_error($q$INSERT INTO gl_ar_accounts (entity_id, role, account_id, updated_by) VALUES ('a7000000-0000-4000-8000-000000000002', 'ar', 'a7a00000-0000-4000-8000-000000000002', 't')$q$, 'gl_ar_accounts_account_fk|needs an asset account');
  RAISE NOTICE 'ok: A1 account roles require the right account type in the entity''s own chart';
END $$;
INSERT INTO gl_ar_accounts (entity_id, role, account_id, updated_by) VALUES
  ('a7000000-0000-4000-8000-000000000001', 'ar', 'a7a00000-0000-4000-8000-000000000002', 'tester'),
  ('a7000000-0000-4000-8000-000000000001', 'undeposited_funds', 'a7a00000-0000-4000-8000-000000000003', 'tester'),
  ('a7000000-0000-4000-8000-000000000001', 'security_deposit', 'a7a00000-0000-4000-8000-000000000004', 'tester'),
  ('a7000000-0000-4000-8000-000000000001', 'rent', 'a7a00000-0000-4000-8000-000000000006', 'tester'),
  ('a7000000-0000-4000-8000-000000000001', 'late_fee', 'a7a00000-0000-4000-8000-000000000007', 'tester');

-- A2: the tie-out needs an opening balance, and must tie to the cent (app open AR = 1000 - 600 - 200 = 200.00).
DO $$ BEGIN
  PERFORM pg_temp.expect_error($q$SELECT gl_confirm_ar_tieout('a7000000-0000-4000-8000-000000000001', 't')$q$, 'post the entity''s opening balance before');
  PERFORM pg_temp.expect_error($q$SELECT gl_confirm_ar_tieout('a7000000-0000-4000-8000-000000000002', 't')$q$, 'post the entity''s opening balance before');
  PERFORM gl_post_opening_balance('a7000000-0000-4000-8000-000000000001', '2026-10-01',
    '[{"account_id":"a7a00000-0000-4000-8000-000000000002","debit_cents":19999},{"account_id":"a7a00000-0000-4000-8000-000000000001","debit_cents":980001},{"account_id":"a7a00000-0000-4000-8000-000000000005","credit_cents":1000000}]', 'tester');
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM pg_temp.expect_error($q$SELECT gl_confirm_ar_tieout('a7000000-0000-4000-8000-000000000001', 't')$q$, 'AR does not tie: the app shows 20000 cents .* the ledger''s AR account 19999 cents \(difference 1 cents\)');
  PERFORM gl_reverse_entry((SELECT id FROM gl_journal_entries WHERE entity_id = 'a7000000-0000-4000-8000-000000000001' AND source = 'opening_balance'), '2026-09-30', 'AR off by a cent', 'tester');
  PERFORM gl_post_opening_balance('a7000000-0000-4000-8000-000000000001', '2026-10-01',
    '[{"account_id":"a7a00000-0000-4000-8000-000000000002","debit_cents":20000},{"account_id":"a7a00000-0000-4000-8000-000000000001","debit_cents":980000},{"account_id":"a7a00000-0000-4000-8000-000000000005","credit_cents":1000000}]', 'tester');
  SET CONSTRAINTS ALL IMMEDIATE;
  IF gl_confirm_ar_tieout('a7000000-0000-4000-8000-000000000001', 'tester') <> 20000 THEN RAISE EXCEPTION 'tie-out total'; END IF;
  PERFORM pg_temp.expect_error($q$SELECT gl_confirm_ar_tieout('a7000000-0000-4000-8000-000000000001', 't')$q$, 'already confirmed');
  IF (SELECT count(*) FROM gl_ar_tieout_items WHERE entity_id = 'a7000000-0000-4000-8000-000000000001') <> 5
     OR (SELECT count(*) FROM gl_ar_tieout_items WHERE entity_id = 'a7000000-0000-4000-8000-000000000001' AND counted) <> 3 THEN
    RAISE EXCEPTION 'tie-out snapshot should hold 5 pre-start items, 3 counted';
  END IF;
  RAISE NOTICE 'ok: A2 tie-out needs an opening balance, refuses a one-cent gap, snapshots counted items, confirms once';
END $$;

-- Post-start activity: rent 1,000.00 and a security deposit 2,000.00 on Oct 1; a check for 3,000.00 on Oct 3;
-- an ACH 500.00 on Oct 6; and the September ACH that was processing at the tie-out now succeeds.
INSERT INTO charges (id, lease_id, charge_date, type, amount) VALUES
  ('a7c00000-0000-4000-8000-000000000001', 'a7300000-0000-4000-8000-000000000001', '2026-10-01', 'rent', 1000.00),
  ('a7c00000-0000-4000-8000-000000000002', 'a7300000-0000-4000-8000-000000000001', '2026-10-01', 'security_deposit', 2000.00);
INSERT INTO payments (id, lease_id, payment_date, amount, method, stripe_status) VALUES
  ('a7d00000-0000-4000-8000-000000000002', 'a7300000-0000-4000-8000-000000000001', '2026-10-03', 3000.00, 'check', NULL),
  ('a7d00000-0000-4000-8000-000000000003', 'a7300000-0000-4000-8000-000000000001', '2026-10-06', 500.00, 'ach_stripe', 'succeeded');
UPDATE payments SET stripe_status = 'succeeded' WHERE id = 'a7d00000-0000-4000-8000-000000000001';

-- A4: run-level checks.
DO $$ BEGIN
  PERFORM pg_temp.expect_error($q$SELECT gl_post_ar_batch('a7000000-0000-4000-8000-000000000001', gl_today() + 1, '[]', 't')$q$, 'between the ledger start date and today');
  PERFORM pg_temp.expect_error($q$SELECT gl_post_ar_batch('a7000000-0000-4000-8000-000000000001', '2026-09-30', '[]', 't')$q$, 'between the ledger start date and today');
  PERFORM pg_temp.expect_error($q$SELECT gl_post_ar_batch('a7000000-0000-4000-8000-000000000002', gl_today(), '[]', 't')$q$, 'is cash-basis; its AR posts through gl_post_ar_cash_batch');
  PERFORM pg_temp.expect_error($q$SELECT gl_post_ar_batch('a7000000-0000-4000-8000-000000000001', '2026-10-31', '[{"kind":"charge","source_id":"a7c00000-0000-4000-8000-000000000000"}]', 't')$q$, 'dated before the ledger start date; its AR is in the opening balance|before the ledger start date');
  PERFORM pg_temp.expect_error($q$SELECT gl_post_ar_batch('a7000000-0000-4000-8000-000000000001', '2026-10-31', '[{"kind":"payment","source_id":"a7d00000-0000-4000-8000-000000000004"}]', 't')$q$, 'is in the opening balance');
  RAISE NOTICE 'ok: A4 through date bounded; cash-basis refused; pre-start charges and counted pre-start payments never post';
END $$;

-- The batch: the database builds every entry; the late ACH posts on the start date.
SELECT gl_post_ar_batch('a7000000-0000-4000-8000-000000000001', '2026-10-31',
  '[{"kind":"charge","source_id":"a7c00000-0000-4000-8000-000000000001"},{"kind":"charge","source_id":"a7c00000-0000-4000-8000-000000000002"},
    {"kind":"payment","source_id":"a7d00000-0000-4000-8000-000000000001"},{"kind":"payment","source_id":"a7d00000-0000-4000-8000-000000000002"},
    {"kind":"payment","source_id":"a7d00000-0000-4000-8000-000000000003"}]', 'tester') AS n \gset
DO $$
DECLARE bal RECORD;
BEGIN
  SELECT
    sum(CASE WHEN l.account_id = 'a7a00000-0000-4000-8000-000000000002' THEN l.debit_cents - l.credit_cents ELSE 0 END) AS ar,
    sum(CASE WHEN l.account_id = 'a7a00000-0000-4000-8000-000000000003' THEN l.debit_cents - l.credit_cents ELSE 0 END) AS uf,
    sum(CASE WHEN l.account_id = 'a7a00000-0000-4000-8000-000000000004' THEN l.credit_cents - l.debit_cents ELSE 0 END) AS dep,
    sum(CASE WHEN l.account_id = 'a7a00000-0000-4000-8000-000000000006' THEN l.credit_cents - l.debit_cents ELSE 0 END) AS rent
    INTO bal
    FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.entry_id WHERE e.entity_id = 'a7000000-0000-4000-8000-000000000001';
  -- AR: 200 opening + 1000 rent + 2000 deposit - 100 - 3000 - 500 = -400.00 (a tenant credit)
  IF bal.ar <> -40000 OR bal.uf <> 360000 OR bal.dep <> 200000 OR bal.rent <> 100000 THEN
    RAISE EXCEPTION 'unexpected balances after the batch: %', bal;
  END IF;
  IF (SELECT entry_date FROM gl_journal_entries e JOIN gl_ar_postings p ON p.entry_id = e.id WHERE p.source_id = 'a7d00000-0000-4000-8000-000000000001') <> '2026-10-01' THEN
    RAISE EXCEPTION 'the late-clearing September ACH should post on the start date';
  END IF;
  RAISE NOTICE 'ok: batch posts charges (deposit to the liability), payments to Undeposited Funds, late ACH on the start date';
END $$;

-- Each source posts at most once; postings and links cannot be faked or edited.
DO $$
DECLARE v UUID;
BEGIN
  PERFORM pg_temp.expect_error($q$SELECT gl_post_ar_batch('a7000000-0000-4000-8000-000000000001', '2026-10-31', '[{"kind":"charge","source_id":"a7c00000-0000-4000-8000-000000000001"}]', 't')$q$, 'gl_ar_postings_once|duplicate key');
  -- a hand-made manual entry cannot be linked as a charge posting (A3)
  v := gl_post_entry('a7000000-0000-4000-8000-000000000001', '2026-10-15', 'fake', 'manual', 't',
    '[{"account_id":"a7a00000-0000-4000-8000-000000000002","debit_cents":100},{"account_id":"a7a00000-0000-4000-8000-000000000006","credit_cents":100}]');
  SET CONSTRAINTS ALL IMMEDIATE;
  INSERT INTO charges (id, lease_id, charge_date, type, amount) VALUES ('a7c00000-0000-4000-8000-000000000009', 'a7300000-0000-4000-8000-000000000001', '2026-10-15', 'rent', 1.00);
  PERFORM pg_temp.expect_error(format($q$INSERT INTO gl_ar_postings (entity_id, kind, source_id, entry_id) VALUES ('a7000000-0000-4000-8000-000000000001', 'charge', 'a7c00000-0000-4000-8000-000000000009', %L)$q$, v), 'must be an ar_posting entry');
  -- an ar_posting entry with no link cannot commit (A4)
  PERFORM pg_temp.expect_error($q$WITH e AS (INSERT INTO gl_journal_entries (entity_id, entry_date, memo, source, posted_by) VALUES ('a7000000-0000-4000-8000-000000000001', '2026-10-15', 'orphan', 'ar_posting', 't') RETURNING id)
     INSERT INTO gl_journal_lines (entry_id, entity_id, account_id, line_no, debit_cents, credit_cents)
     SELECT id, 'a7000000-0000-4000-8000-000000000001'::uuid, 'a7a00000-0000-4000-8000-000000000002'::uuid, 1, 100::bigint, 0::bigint FROM e
     UNION ALL SELECT id, 'a7000000-0000-4000-8000-000000000001'::uuid, 'a7a00000-0000-4000-8000-000000000006'::uuid, 2, 0::bigint, 100::bigint FROM e$q$, 'AR posting with no AR link');
  -- a direct ar_posting entry with the WRONG amount, linked: refused at commit (A3)
  PERFORM pg_temp.expect_error($q$WITH e AS (INSERT INTO gl_journal_entries (entity_id, entry_date, memo, source, posted_by) VALUES ('a7000000-0000-4000-8000-000000000001', '2026-10-15', 'wrong', 'ar_posting', 't') RETURNING id),
     l AS (INSERT INTO gl_journal_lines (entry_id, entity_id, account_id, line_no, debit_cents, credit_cents)
       SELECT id, 'a7000000-0000-4000-8000-000000000001'::uuid, 'a7a00000-0000-4000-8000-000000000002'::uuid, 1, 99::bigint, 0::bigint FROM e
       UNION ALL SELECT id, 'a7000000-0000-4000-8000-000000000001'::uuid, 'a7a00000-0000-4000-8000-000000000006'::uuid, 2, 0::bigint, 99::bigint FROM e)
     INSERT INTO gl_ar_postings (entity_id, kind, source_id, entry_id) SELECT 'a7000000-0000-4000-8000-000000000001', 'charge', 'a7c00000-0000-4000-8000-000000000009', id FROM e$q$, 'must post exactly 100 cents');
  PERFORM pg_temp.expect_error($q$UPDATE gl_ar_postings SET source_id = gen_random_uuid()$q$, 'cannot be changed|immutable|cannot be');
  PERFORM pg_temp.expect_error($q$DELETE FROM gl_ar_tieouts$q$, 'cannot be changed|immutable|cannot be');
  RAISE NOTICE 'ok: A3/A4/A5 once per source; no faked links, orphan or wrong AR entries; links and tie-outs immutable';
END $$;

-- A6: what the ledger holds cannot change underneath it.
DO $$ BEGIN
  PERFORM pg_temp.expect_error($q$UPDATE charges SET amount = 1500 WHERE id = 'a7c00000-0000-4000-8000-000000000001'$q$, 'its amount, date, lease and type cannot change');
  PERFORM pg_temp.expect_error($q$UPDATE charges SET charge_date = '2026-08-01' WHERE id = 'a7c00000-0000-4000-8000-000000000000'$q$, 'cannot change');
  PERFORM pg_temp.expect_error($q$DELETE FROM payments WHERE id = 'a7d00000-0000-4000-8000-000000000002'$q$, 'cannot be deleted');
  UPDATE charges SET description = 'Oct rent, Ste 3' WHERE id = 'a7c00000-0000-4000-8000-000000000001';
  UPDATE charges SET amount = 2.00 WHERE id = 'a7c00000-0000-4000-8000-000000000009';  -- never posted: still editable
  PERFORM pg_temp.expect_error($q$UPDATE gl_ar_accounts SET account_id = 'a7a00000-0000-4000-8000-000000000008' WHERE entity_id = 'a7000000-0000-4000-8000-000000000001' AND role = 'ar'$q$, 'fixed once the AR tie-out is confirmed');
  PERFORM pg_temp.expect_error($q$UPDATE properties SET gl_entity_id = 'a7000000-0000-4000-8000-000000000002' WHERE id = 'a7100000-0000-4000-8000-000000000001'$q$, 'cannot move to another LLC');
  PERFORM pg_temp.expect_error($q$UPDATE properties SET gl_entity_id = NULL WHERE id = 'a7100000-0000-4000-8000-000000000001'$q$, 'cannot move to another LLC');
  UPDATE properties SET name = 'Raytown Flex Center' WHERE id = 'a7100000-0000-4000-8000-000000000001';
  RAISE NOTICE 'ok: A6 posted or tied-out charges/payments are fixed; others still editable; AR account and property LLC fixed once used';
END $$;

-- Voids and returns post as reversals (and pre-start ones as their own entries), each once.
UPDATE charges SET voided_at = '2026-10-20 15:00Z', void_reason = 'billed twice' WHERE id = 'a7c00000-0000-4000-8000-000000000001';
UPDATE charges SET voided_at = '2026-10-25 15:00Z', void_reason = 'September credit' WHERE id = 'a7c00000-0000-4000-8000-000000000000';
UPDATE payments SET stripe_status = 'returned' WHERE id = 'a7d00000-0000-4000-8000-000000000003';
UPDATE payments SET stripe_status = 'failed' WHERE id = 'a7d00000-0000-4000-8000-000000000004';
SELECT gl_post_ar_batch('a7000000-0000-4000-8000-000000000001', gl_today(),
  '[{"kind":"charge_void","source_id":"a7c00000-0000-4000-8000-000000000001"},{"kind":"charge_void_pre","source_id":"a7c00000-0000-4000-8000-000000000000"},
    {"kind":"payment_return","source_id":"a7d00000-0000-4000-8000-000000000003"},{"kind":"payment_return_pre","source_id":"a7d00000-0000-4000-8000-000000000004"}]', 'tester') AS n2 \gset
DO $$
DECLARE ar BIGINT; vd DATE;
BEGIN
  SELECT sum(l.debit_cents - l.credit_cents) INTO ar FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.entry_id
   WHERE e.entity_id = 'a7000000-0000-4000-8000-000000000001' AND l.account_id = 'a7a00000-0000-4000-8000-000000000002';
  -- -400 - 1000 (void Oct rent) - 1000 (void Sep rent) + 500 (ACH returned) + 200 (Sep ACH failed) = -1700.00,
  -- plus the 1.00 manual entry to AR made by the fake-link test above: -1699.00
  IF ar <> -169900 THEN RAISE EXCEPTION 'AR after voids and returns: %', ar; END IF;
  SELECT e.entry_date INTO vd FROM gl_journal_entries e JOIN gl_ar_postings p ON p.entry_id = e.id WHERE p.kind = 'charge_void' AND p.source_id = 'a7c00000-0000-4000-8000-000000000001';
  IF vd <> '2026-10-20' THEN RAISE EXCEPTION 'void should be dated by the void (US Central), got %', vd; END IF;
  PERFORM pg_temp.expect_error($q$SELECT gl_post_ar_batch('a7000000-0000-4000-8000-000000000001', gl_today(), '[{"kind":"charge_void","source_id":"a7c00000-0000-4000-8000-000000000001"}]', 't')$q$, 'gl_ar_postings_once|duplicate key');
  PERFORM pg_temp.expect_error($q$SELECT gl_post_ar_batch('a7000000-0000-4000-8000-000000000001', gl_today(), '[{"kind":"charge_void","source_id":"a7c00000-0000-4000-8000-000000000002"}]', 't')$q$, 'is not voided|must be the reversal');
  RAISE NOTICE 'ok: voids and returns post once, as reversals (pre-start ones as their own entries), dated by the event';
END $$;

-- REFUTE-6 regressions. A second LLC's property and unit to move things into.
INSERT INTO properties (id, name, gl_entity_id) VALUES ('a7100000-0000-4000-8000-000000000002', 'Cash LLC Bldg', 'a7000000-0000-4000-8000-000000000002');
INSERT INTO units (id, property_id, suite) VALUES ('a7200000-0000-4000-8000-000000000002', 'a7100000-0000-4000-8000-000000000002', '1');
INSERT INTO charges (id, lease_id, charge_date, type, amount) VALUES
  ('a7c00000-0000-4000-8000-000000000010', 'a7300000-0000-4000-8000-000000000001', '2026-10-15', 'rent', 100.00);

CREATE FUNCTION pg_temp.h2_attack() RETURNS void LANGUAGE plpgsql AS $$
DECLARE v UUID;
BEGIN
  PERFORM gl_post_ar_batch('a7000000-0000-4000-8000-000000000001', gl_today(), '[{"kind":"charge","source_id":"a7c00000-0000-4000-8000-000000000010"}]', 'tester');
  SELECT entry_id INTO v FROM gl_ar_postings WHERE kind = 'charge' AND source_id = 'a7c00000-0000-4000-8000-000000000010';
  INSERT INTO gl_journal_lines (entry_id, entity_id, account_id, line_no, debit_cents, credit_cents) VALUES
    (v, 'a7000000-0000-4000-8000-000000000001', 'a7a00000-0000-4000-8000-000000000002', 3, 50000, 0),
    (v, 'a7000000-0000-4000-8000-000000000001', 'a7a00000-0000-4000-8000-000000000006', 4, 0, 50000);
END $$;
CREATE FUNCTION pg_temp.l1_attack() RETURNS void LANGUAGE plpgsql AS $$
DECLARE v UUID;
BEGIN
  v := gl_reverse_entry((SELECT entry_id FROM gl_ar_postings WHERE kind = 'charge' AND source_id = 'a7c00000-0000-4000-8000-000000000002'), '2026-10-05', 'early void', 'tester');
  INSERT INTO gl_ar_postings (entity_id, kind, source_id, entry_id) VALUES ('a7000000-0000-4000-8000-000000000001', 'charge_void', 'a7c00000-0000-4000-8000-000000000002', v);
END $$;

DO $$
DECLARE pid UUID; t TIMESTAMPTZ;
BEGIN
  -- C1: the tied opening balance cannot be reversed; start date and basis are fixed.
  PERFORM pg_temp.expect_error($q$SELECT gl_reverse_entry((SELECT opening_entry_id FROM gl_ar_tieouts WHERE entity_id = 'a7000000-0000-4000-8000-000000000001'), '2026-09-30', 'x', 't')$q$, 'basis of the confirmed AR tie-out');
  PERFORM pg_temp.expect_error($q$UPDATE gl_entities SET ledger_start_date = '2026-12-01' WHERE id = 'a7000000-0000-4000-8000-000000000001'$q$, 'confirmed AR tie-out|cannot change');
  PERFORM pg_temp.expect_error($q$UPDATE gl_entities SET accounting_basis = 'cash' WHERE id = 'a7000000-0000-4000-8000-000000000001'$q$, 'start date and accounting basis cannot change');
  -- H1: an AR entry cannot be reversed by hand.
  PERFORM pg_temp.expect_error($q$SELECT gl_reverse_entry((SELECT entry_id FROM gl_ar_postings WHERE kind = 'charge' AND source_id = 'a7c00000-0000-4000-8000-000000000002'), '2026-10-05', 'x', 't')$q$, 'reverses an AR posting');
  -- H2: no extra lines on a verified AR entry, even in the posting transaction.
  PERFORM pg_temp.expect_error('SELECT pg_temp.h2_attack()', 'must post exactly');
  -- L1: a void's reversal must carry the void's date.
  UPDATE charges SET voided_at = '2026-11-02 15:00Z', void_reason = 'deposit waived' WHERE id = 'a7c00000-0000-4000-8000-000000000002';
  PERFORM pg_temp.expect_error('SELECT pg_temp.l1_attack()', 'must be dated 2026-11-02');
  -- H4: a unit or lease holding ledger AR cannot move to another LLC.
  PERFORM pg_temp.expect_error($q$UPDATE units SET property_id = 'a7100000-0000-4000-8000-000000000002' WHERE id = 'a7200000-0000-4000-8000-000000000001'$q$, 'unit''s AR is in the general ledger');
  PERFORM pg_temp.expect_error($q$UPDATE leases SET unit_id = 'a7200000-0000-4000-8000-000000000002' WHERE id = 'a7300000-0000-4000-8000-000000000001'$q$, 'lease''s AR is in the general ledger');
  -- H5: nor can the AR mapping be deleted.
  PERFORM pg_temp.expect_error($q$DELETE FROM gl_ar_accounts WHERE entity_id = 'a7000000-0000-4000-8000-000000000001' AND role = 'undeposited_funds'$q$, 'fixed once the AR tie-out is confirmed');
  -- M3: voids and terminal Stripe statuses are final once in the ledger.
  PERFORM pg_temp.expect_error($q$UPDATE charges SET voided_at = NULL WHERE id = 'a7c00000-0000-4000-8000-000000000001'$q$, 'void cannot be undone');
  PERFORM pg_temp.expect_error($q$UPDATE charges SET voided_at = NULL WHERE id = 'a7c00000-0000-4000-8000-0000000000ff'$q$, 'void cannot be undone');
  PERFORM pg_temp.expect_error($q$UPDATE payments SET stripe_status = 'succeeded' WHERE id = 'a7d00000-0000-4000-8000-000000000003'$q$, 'that status is final');
  -- M4: a payment's tie-out status is its status as of the day before the start date.
  IF NOT gl_payment_counted_as_of('ach_stripe', 'succeeded', '2026-09-30 22:00Z', '2026-09-30')        -- 5 pm Central on the 30th
     OR gl_payment_counted_as_of('ach_stripe', 'succeeded', '2026-10-01 06:00Z', '2026-09-30')        -- cleared Oct 1 Central
     OR NOT gl_payment_counted_as_of('ach_stripe', 'returned', '2026-10-05 15:00Z', '2026-09-30')     -- had cleared, returned later
     OR gl_payment_counted_as_of('ach_stripe', 'failed', '2026-10-05 15:00Z', '2026-09-30')
     OR gl_payment_counted_as_of('ach_stripe', 'returned', '2026-09-29 15:00Z', '2026-09-30')
     OR NOT gl_payment_counted_as_of('check', NULL, NULL, '2026-09-30') THEN
    RAISE EXCEPTION 'gl_payment_counted_as_of truth table';
  END IF;
  -- L3: the status time is the server's, on insert too.
  INSERT INTO payments (id, lease_id, payment_date, amount, method, stripe_status, status_changed_at) VALUES
    ('a7d00000-0000-4000-8000-000000000010', 'a7300000-0000-4000-8000-000000000001', '2026-11-03', 10.00, 'ach_stripe', 'processing', '2020-01-01Z')
    RETURNING status_changed_at INTO t;
  IF t < now() - interval '1 minute' THEN RAISE EXCEPTION 'status_changed_at should be stamped on insert, got %', t; END IF;
  RAISE NOTICE 'ok: REFUTE-6 C1 H1 H2 H4 H5 M3 M4 L1 L3 — tie-out basis fixed; no hand reversals, extra lines, LLC moves, un-voids; dates verified';
END $$;

-- REFUTE-6 H3: activity dated in a locked month posts on the first day of the next open month.
SELECT gl_lock_period('a7000000-0000-4000-8000-000000000001', '2026-10-01', 'closer@example.test');
SELECT gl_post_ar_batch('a7000000-0000-4000-8000-000000000001', gl_today(),
  '[{"kind":"charge","source_id":"a7c00000-0000-4000-8000-000000000010"},{"kind":"charge_void","source_id":"a7c00000-0000-4000-8000-000000000002"}]', 'tester') AS n3 \gset
DO $$
DECLARE d1 DATE; d2 DATE;
BEGIN
  SELECT e.entry_date INTO d1 FROM gl_journal_entries e JOIN gl_ar_postings p ON p.entry_id = e.id WHERE p.kind = 'charge' AND p.source_id = 'a7c00000-0000-4000-8000-000000000010';
  SELECT e.entry_date INTO d2 FROM gl_journal_entries e JOIN gl_ar_postings p ON p.entry_id = e.id WHERE p.kind = 'charge_void' AND p.source_id = 'a7c00000-0000-4000-8000-000000000002';
  IF d1 <> '2026-11-01' OR d2 <> '2026-11-02' THEN RAISE EXCEPTION 'locked-month charge should post 2026-11-01 (got %), the void 2026-11-02 (got %)', d1, d2; END IF;
  IF gl_first_open_date('a7000000-0000-4000-8000-000000000001', '2026-10-31') <> '2026-11-01'
     OR gl_first_open_date('a7000000-0000-4000-8000-000000000001', '2026-11-15') <> '2026-11-15' THEN
    RAISE EXCEPTION 'gl_first_open_date';
  END IF;
  RAISE NOTICE 'ok: REFUTE-6 H3 locked-month activity posts on the first day of the next open month';
END $$;

-- Access: write functions service_role only; tables closed to the API roles; journal-style privileges.
DO $$
DECLARE t TEXT;
BEGIN
  IF has_function_privilege('anon', 'gl_post_ar_batch(uuid, date, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'gl_confirm_ar_tieout(uuid, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'gl_post_ar_batch(uuid, date, jsonb, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'AR write functions must be EXECUTE for service_role only';
  END IF;
  FOREACH t IN ARRAY ARRAY['gl_ar_accounts', 'gl_ar_tieouts', 'gl_ar_tieout_items', 'gl_ar_postings'] LOOP
    IF has_table_privilege('anon', 'public.' || t, 'SELECT') OR has_table_privilege('service_role', 'public.' || t, 'TRIGGER')
       OR has_table_privilege('service_role', 'public.' || t, 'TRUNCATE') THEN
      RAISE EXCEPTION 'unexpected privilege on %', t;
    END IF;
  END LOOP;
  IF has_table_privilege('service_role', 'public.gl_ar_postings', 'UPDATE') OR has_table_privilege('service_role', 'public.gl_ar_postings', 'DELETE') THEN
    RAISE EXCEPTION 'gl_ar_postings must be insert-only for service_role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND (p.proname LIKE 'gl\_%' OR p.proname = 'payments_stamp_status_change')
                AND NOT (coalesce(p.proconfig, '{}') @> ARRAY['search_path=public, pg_temp'])) THEN
    RAISE EXCEPTION 'a function lacks search_path = public, pg_temp';
  END IF;
  RAISE NOTICE 'ok: AR functions service_role only; AR tables closed to API roles; postings insert-only; search paths pinned';
END $$;
