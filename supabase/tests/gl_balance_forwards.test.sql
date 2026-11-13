-- Real-Postgres tests for 0032_gl_balance_forwards.sql (rules BF1–BF8 in the migration header). Own
-- session, own fixtures (scripts/verify-gl-sql.sh). Ledger start 2026-10-01, so the tie-out is as of
-- 2026-09-30 and every balance forward here is imported as of that day, before the tie-out.
-- Amounts in comments are dollars; balances and checks are cents.

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

CREATE OR REPLACE FUNCTION pg_temp.eq(label TEXT, got NUMERIC, want NUMERIC) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF got IS DISTINCT FROM want THEN RAISE EXCEPTION '%: got %, want %', label, got, want; END IF;
END;
$$;

-- Balance (debit − credit) of an entity's account, by number.
CREATE OR REPLACE FUNCTION pg_temp.bal(p_entity UUID, p_number TEXT) RETURNS BIGINT LANGUAGE sql AS $$
  SELECT coalesce(sum(l.debit_cents - l.credit_cents), 0)::bigint
    FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.entry_id JOIN gl_accounts a ON a.id = l.account_id
   WHERE e.entity_id = p_entity AND a.number = p_number
$$;

-- Allocation of one lease at replay seq 0, by role.
CREATE OR REPLACE FUNCTION pg_temp.alloc0(p_lease UUID, p_role TEXT) RETURNS BIGINT LANGUAGE sql AS $$
  SELECT coalesce(sum(a.cents), 0)::bigint FROM gl_ar_cash_alloc(p_lease, 0) a WHERE a.role = p_role
$$;

GRANT SELECT ON properties, units, tenants, leases, charges, payments TO service_role;

-- ── Fixtures ────────────────────────────────────────────────────────────────────────────────────
-- Entities: CB (cash), AC (accrual), CB3 (cash, start 2026-09-01), OTHER (no tie-out, to move into).
INSERT INTO gl_entities (id, name, accounting_basis) VALUES
  ('c3200000-0000-4000-8000-0000000000cb', 'BF Cash LLC', 'cash'),
  ('c3200000-0000-4000-8000-0000000000ac', 'BF Accrual LLC', 'accrual'),
  ('c3200000-0000-4000-8000-0000000000c3', 'BF Late LLC', 'cash'),
  ('c3200000-0000-4000-8000-0000000000ff', 'BF Other LLC', 'cash');
INSERT INTO tenants (id, name) VALUES ('c3240000-0000-4000-8000-000000000001', 'BF Tenant');
INSERT INTO properties (id, name) VALUES
  ('c3210000-0000-4000-8000-0000000000cb', 'BF Cash Park'), ('c3210000-0000-4000-8000-0000000000ac', 'BF Accrual Park'),
  ('c3210000-0000-4000-8000-0000000000c3', 'BF Late Park'), ('c3210000-0000-4000-8000-0000000000ff', 'BF Other Park');
UPDATE properties SET gl_entity_id = ('c3200000-0000-4000-8000-0000000000' || right(id::text, 2))::uuid WHERE id::text LIKE 'c3210000%';
INSERT INTO units (id, property_id, suite) VALUES
  ('c3220000-0000-4000-8000-0000000000cb', 'c3210000-0000-4000-8000-0000000000cb', 'A'),
  ('c3220000-0000-4000-8000-0000000000ac', 'c3210000-0000-4000-8000-0000000000ac', 'A'),
  ('c3220000-0000-4000-8000-0000000000c3', 'c3210000-0000-4000-8000-0000000000c3', 'A'),
  ('c3220000-0000-4000-8000-0000000000ff', 'c3210000-0000-4000-8000-0000000000ff', 'A');
-- Leases: L1–L5 cash (CB), L6–L7 accrual (AC), L8 late (CB3).
INSERT INTO leases (id, unit_id, tenant_id)
  SELECT ('c3230000-0000-4000-8000-00000000000' || n)::uuid,
         CASE WHEN n <= 5 THEN 'c3220000-0000-4000-8000-0000000000cb' WHEN n <= 7 THEN 'c3220000-0000-4000-8000-0000000000ac' ELSE 'c3220000-0000-4000-8000-0000000000c3' END::uuid,
         'c3240000-0000-4000-8000-000000000001'
    FROM generate_series(1, 8) n;

-- Charts.
INSERT INTO gl_accounts (id, entity_id, number, qb_name, account_type)
  SELECT ('c32a0000-0000-4000-8000-0000000' || e.suffix || a.n)::uuid, ('c3200000-0000-4000-8000-0000000000' || e.suffix)::uuid, a.number, a.name, a.t
    FROM (VALUES ('cb'), ('ac'), ('c3'), ('ff')) e(suffix),
         (VALUES ('001', '1000', 'Operating Cash', 'asset'), ('002', '1100', 'Accounts Receivable', 'asset'), ('003', '1499', 'Undeposited Funds', 'asset'),
                 ('004', '2200', 'Security Deposits Held', 'liability'), ('005', '2300', 'Prepaid Rent', 'liability'), ('006', '3000', 'Members'' Equity', 'equity'),
                 ('007', '4000', 'Rental Income', 'income'), ('008', '4900', 'Prior-System Receivables', 'income')) a(n, number, name, t);

-- ── Pre-start history (September) and the QuickBooks balances as of 2026-09-30 ─────────────────
-- CB  L1: rent 1,000 (due 09-01), check 600            → app 400;   QuickBooks 900  → +500
--     L2: check 200                                     → app −200;  QuickBooks −500 → −300
--     L3: deposit 1,500 (due 09-30), check 1,000        → app 500;   QuickBooks 1,500 → +1,000
--     L4: nothing                                       → app 0;     QuickBooks 250  → +250
-- AC  L6: rent 1,000, check 1,000                       → app 0;     QuickBooks 750  → +750
--     L7: rent 500                                      → app 500;   QuickBooks 200  → −300
-- CB3 L8: nothing                                       → app 0;     QuickBooks 100  → +100
INSERT INTO charges (id, lease_id, charge_date, due_date, type, amount) VALUES
  ('c32c0000-0000-4000-8000-000000000001', 'c3230000-0000-4000-8000-000000000001', '2026-09-01', '2026-09-01', 'rent', 1000),
  ('c32c0000-0000-4000-8000-000000000003', 'c3230000-0000-4000-8000-000000000003', '2026-09-15', '2026-09-30', 'security_deposit', 1500),
  ('c32c0000-0000-4000-8000-000000000006', 'c3230000-0000-4000-8000-000000000006', '2026-09-01', '2026-09-01', 'rent', 1000),
  ('c32c0000-0000-4000-8000-000000000007', 'c3230000-0000-4000-8000-000000000007', '2026-09-01', '2026-09-01', 'rent', 500);
INSERT INTO payments (id, lease_id, payment_date, amount, method) VALUES
  ('c32d0000-0000-4000-8000-000000000001', 'c3230000-0000-4000-8000-000000000001', '2026-09-05', 600, 'check'),
  ('c32d0000-0000-4000-8000-000000000002', 'c3230000-0000-4000-8000-000000000002', '2026-09-10', 200, 'check'),
  ('c32d0000-0000-4000-8000-000000000003', 'c3230000-0000-4000-8000-000000000003', '2026-09-20', 1000, 'check'),
  ('c32d0000-0000-4000-8000-000000000006', 'c3230000-0000-4000-8000-000000000006', '2026-09-03', 1000, 'check');
SELECT count(*) FROM apply_balance_forwards('2026-09-30', 'manual', NULL, 'tester', '[
  {"lease_id":"c3230000-0000-4000-8000-000000000001","qb_balance":900,"expected_app_balance":400},
  {"lease_id":"c3230000-0000-4000-8000-000000000002","qb_balance":-500,"expected_app_balance":-200},
  {"lease_id":"c3230000-0000-4000-8000-000000000003","qb_balance":1500,"expected_app_balance":500},
  {"lease_id":"c3230000-0000-4000-8000-000000000004","qb_balance":250,"expected_app_balance":0},
  {"lease_id":"c3230000-0000-4000-8000-000000000006","qb_balance":750,"expected_app_balance":0},
  {"lease_id":"c3230000-0000-4000-8000-000000000007","qb_balance":200,"expected_app_balance":500},
  {"lease_id":"c3230000-0000-4000-8000-000000000008","qb_balance":100,"expected_app_balance":0}]');
SELECT pg_temp.eq('balance forwards applied', (SELECT count(*) FROM balance_forwards WHERE lease_id::text LIKE 'c3230000%' AND voided_at IS NULL), 7);

-- ── Accrual: the forwards count in open AR (BF1, BF4), nothing posts for them ────────────────────
INSERT INTO gl_ar_accounts (entity_id, role, account_id, updated_by) VALUES
  ('c3200000-0000-4000-8000-0000000000ac', 'ar', 'c32a0000-0000-4000-8000-0000000ac002', 'tester'),
  ('c3200000-0000-4000-8000-0000000000ac', 'undeposited_funds', 'c32a0000-0000-4000-8000-0000000ac003', 'tester'),
  ('c3200000-0000-4000-8000-0000000000ac', 'rent', 'c32a0000-0000-4000-8000-0000000ac007', 'tester');
DO $$ BEGIN
  -- App AR = 0 + 750 + 500 − 300 = 950. An opening AR of 500 (forwards left out) does not tie.
  PERFORM gl_post_opening_balance('c3200000-0000-4000-8000-0000000000ac', '2026-10-01',
    '[{"account_id":"c32a0000-0000-4000-8000-0000000ac002","debit_cents":50000},{"account_id":"c32a0000-0000-4000-8000-0000000ac006","credit_cents":50000}]', 'tester');
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM pg_temp.expect_error($q$SELECT gl_confirm_ar_tieout('c3200000-0000-4000-8000-0000000000ac', 't')$q$, 'AR does not tie: the app shows 95000 cents of open AR.*difference 45000 cents');
  PERFORM gl_reverse_entry((SELECT id FROM gl_journal_entries WHERE entity_id = 'c3200000-0000-4000-8000-0000000000ac' AND source = 'opening_balance'), '2026-09-30', 'forwards left out', 'tester');
  PERFORM gl_post_opening_balance('c3200000-0000-4000-8000-0000000000ac', '2026-10-01',
    '[{"account_id":"c32a0000-0000-4000-8000-0000000ac002","debit_cents":95000},{"account_id":"c32a0000-0000-4000-8000-0000000ac006","credit_cents":95000}]', 'tester');
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM pg_temp.eq('accrual tie-out total', gl_confirm_ar_tieout('c3200000-0000-4000-8000-0000000000ac', 'tester'), 95000);
  SET CONSTRAINTS ALL IMMEDIATE;
  -- The snapshot holds both forwards, signed and counted.
  PERFORM pg_temp.eq('accrual +forward item', (SELECT i.cents FROM gl_ar_tieout_items i JOIN balance_forwards b ON b.id = i.source_id
    WHERE i.kind = 'balance_forward' AND b.lease_id = 'c3230000-0000-4000-8000-000000000006' AND i.counted), 75000);
  PERFORM pg_temp.eq('accrual −forward item', (SELECT i.cents FROM gl_ar_tieout_items i JOIN balance_forwards b ON b.id = i.source_id
    WHERE i.kind = 'balance_forward' AND b.lease_id = 'c3230000-0000-4000-8000-000000000007' AND i.counted), -30000);
  -- BF6: counted forwards cannot be voided (the function, and a direct UPDATE as the owner).
  PERFORM pg_temp.expect_error($q$SELECT void_balance_forward((SELECT id FROM balance_forwards WHERE lease_id = 'c3230000-0000-4000-8000-000000000006'), 't', 'x')$q$,
    'counted in the ledger''s AR tie-out and cannot be voided');
  PERFORM pg_temp.expect_error($q$UPDATE balance_forwards SET voided_at = now(), voided_by = 't', void_reason = 'x' WHERE lease_id = 'c3230000-0000-4000-8000-000000000007'$q$,
    'counted in the ledger''s AR tie-out and cannot be voided');
  -- BF5: a lease whose only footprint is... (L6 has charges too) cannot leave its LLC.
  PERFORM pg_temp.expect_error($q$UPDATE leases SET unit_id = 'c3220000-0000-4000-8000-0000000000ff' WHERE id = 'c3230000-0000-4000-8000-000000000007'$q$,
    'cannot move to another LLC');
  -- Nothing posts for a forward: an empty October batch posts nothing.
  PERFORM pg_temp.eq('accrual: empty batch', gl_post_ar_batch('c3200000-0000-4000-8000-0000000000ac', '2026-10-31', '[]', 'tester'), 0);
  RAISE NOTICE 'ok: accrual tie-out counts balance forwards (signed); counted ones are frozen and hold their lease';
END $$;

-- ── Cash: the forwards in the tie-out and the replay (BF2–BF4) ───────────────────────────────────
INSERT INTO gl_ar_accounts (entity_id, role, account_id, updated_by) VALUES
  ('c3200000-0000-4000-8000-0000000000cb', 'undeposited_funds', 'c32a0000-0000-4000-8000-0000000cb003', 'tester'),
  ('c3200000-0000-4000-8000-0000000000cb', 'security_deposit', 'c32a0000-0000-4000-8000-0000000cb004', 'tester'),
  ('c3200000-0000-4000-8000-0000000000cb', 'prepaid_rent', 'c32a0000-0000-4000-8000-0000000cb005', 'tester');
DO $$ BEGIN
  -- Tenant credits: L2 only (200 cash + 300 credit forward) = 500. Without the forwards it would be 200.
  -- Deposits: L3's 1,000 of cash fills its 1,500 deposit before the +1,000 forward due the same day.
  PERFORM gl_post_opening_balance('c3200000-0000-4000-8000-0000000000cb', '2026-10-01',
    '[{"account_id":"c32a0000-0000-4000-8000-0000000cb001","debit_cents":120000},{"account_id":"c32a0000-0000-4000-8000-0000000cb005","credit_cents":20000},{"account_id":"c32a0000-0000-4000-8000-0000000cb004","credit_cents":100000}]', 'tester');
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM pg_temp.expect_error($q$SELECT gl_confirm_ar_tieout('c3200000-0000-4000-8000-0000000000cb', 't')$q$,
    'AR does not tie: the app shows 50000 cents of tenant credits.*difference 30000 cents');
  PERFORM gl_reverse_entry((SELECT id FROM gl_journal_entries WHERE entity_id = 'c3200000-0000-4000-8000-0000000000cb' AND source = 'opening_balance'), '2026-09-30', 'credit forward left out', 'tester');
  -- Deposits at 0 (the forward-before-deposit reading). First, BF2: a positive forward needs
  -- balance_forward or rent mapped (checked before the deposits).
  PERFORM gl_post_opening_balance('c3200000-0000-4000-8000-0000000000cb', '2026-10-01',
    '[{"account_id":"c32a0000-0000-4000-8000-0000000cb001","debit_cents":50000},{"account_id":"c32a0000-0000-4000-8000-0000000cb005","credit_cents":50000}]', 'tester');
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM pg_temp.expect_error($q$SELECT gl_confirm_ar_tieout('c3200000-0000-4000-8000-0000000000cb', 't')$q$,
    'map an account to the balance_forward role \(or the rent role, its default\)');
  INSERT INTO gl_ar_accounts (entity_id, role, account_id, updated_by) VALUES ('c3200000-0000-4000-8000-0000000000cb', 'rent', 'c32a0000-0000-4000-8000-0000000cb007', 'tester');
  PERFORM pg_temp.expect_error($q$SELECT gl_confirm_ar_tieout('c3200000-0000-4000-8000-0000000000cb', 't')$q$, 'deposits do not tie.*100000 cents of paid security deposits');
  PERFORM gl_reverse_entry((SELECT id FROM gl_journal_entries WHERE entity_id = 'c3200000-0000-4000-8000-0000000000cb' AND source = 'opening_balance'
    AND NOT EXISTS (SELECT 1 FROM gl_journal_entries r WHERE r.reverses_entry_id = gl_journal_entries.id)), '2026-09-30', 'deposits left out', 'tester');
  PERFORM gl_post_opening_balance('c3200000-0000-4000-8000-0000000000cb', '2026-10-01',
    '[{"account_id":"c32a0000-0000-4000-8000-0000000cb001","debit_cents":150000},{"account_id":"c32a0000-0000-4000-8000-0000000cb005","credit_cents":50000},{"account_id":"c32a0000-0000-4000-8000-0000000cb004","credit_cents":100000}]', 'tester');
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM pg_temp.eq('cash tie-out total', gl_confirm_ar_tieout('c3200000-0000-4000-8000-0000000000cb', 'tester'), 50000);
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE NOTICE 'ok: cash tie-out counts credit forwards in tenant credits, deposits fill before a forward due the same day, rent fallback required';
END $$;

-- BF3: the replay's starting point.
SELECT pg_temp.eq('L1 rent at seq 0', pg_temp.alloc0('c3230000-0000-4000-8000-000000000001', 'rent'), 60000);
SELECT pg_temp.eq('L1 forward at seq 0', pg_temp.alloc0('c3230000-0000-4000-8000-000000000001', 'balance_forward'), 0);
SELECT pg_temp.eq('L2 credit at seq 0', pg_temp.alloc0('c3230000-0000-4000-8000-000000000002', 'prepaid_rent'), 50000);
SELECT pg_temp.eq('L3 deposit at seq 0', pg_temp.alloc0('c3230000-0000-4000-8000-000000000003', 'security_deposit'), 100000);
SELECT pg_temp.eq('L3 forward at seq 0', pg_temp.alloc0('c3230000-0000-4000-8000-000000000003', 'balance_forward'), 0);
SELECT pg_temp.eq('L4 forward at seq 0', pg_temp.alloc0('c3230000-0000-4000-8000-000000000004', 'balance_forward'), 0);
SELECT pg_temp.eq('priority of a forward', gl_ar_cash_priority('balance_forward'), 0);
-- The forward row carries its own id; a lease without one allocates exactly as before (no extra row).
SELECT pg_temp.eq('L1 forward row id', (SELECT count(*) FROM gl_ar_cash_alloc('c3230000-0000-4000-8000-000000000001', 0) a
  JOIN balance_forwards b ON b.id = a.charge_id WHERE a.role = 'balance_forward'), 1);
SELECT pg_temp.eq('L5 rows', (SELECT count(*) FROM gl_ar_cash_alloc('c3230000-0000-4000-8000-000000000005', 0)), 1);

DO $$ BEGIN
  -- BF2: on a tied-out cash LLC the balance_forward role stays on its rent fallback.
  PERFORM pg_temp.expect_error($q$INSERT INTO gl_ar_accounts (entity_id, role, account_id, updated_by)
    VALUES ('c3200000-0000-4000-8000-0000000000cb', 'balance_forward', 'c32a0000-0000-4000-8000-0000000cb008', 't')$q$, 'balance_forward account is fixed once the AR tie-out');
  -- BF7: no new forwards for a tied-out LLC.
  PERFORM pg_temp.expect_error($q$SELECT * FROM apply_balance_forwards('2026-09-30', 'manual', NULL, 't',
    '[{"lease_id":"c3230000-0000-4000-8000-000000000005","qb_balance":10,"expected_app_balance":0}]')$q$, 'already tied out in the ledger; a balance forward must be imported before');
  -- BF6 / BF5 on the cash side: L4's only footprint is its forward.
  PERFORM pg_temp.expect_error($q$SELECT void_balance_forward((SELECT id FROM balance_forwards WHERE lease_id = 'c3230000-0000-4000-8000-000000000001'), 't', 'x')$q$, 'cannot be voided');
  PERFORM pg_temp.expect_error($q$UPDATE leases SET unit_id = 'c3220000-0000-4000-8000-0000000000ff' WHERE id = 'c3230000-0000-4000-8000-000000000004'$q$, 'cannot move to another LLC');
  RAISE NOTICE 'ok: cash: role fixed to rent fallback, no new forwards, counted ones frozen and hold their lease';
END $$;

-- October cash. L1: rent 1,000 (due 10-01), check 1,200 on 10-05. L3: checks 500 (10-05) and 1,000 (10-06).
INSERT INTO charges (id, lease_id, charge_date, due_date, type, amount) VALUES
  ('c32c0000-0000-4000-8000-000000000011', 'c3230000-0000-4000-8000-000000000001', '2026-10-01', '2026-10-01', 'rent', 1000);
INSERT INTO payments (id, lease_id, payment_date, amount, method) VALUES
  ('c32d0000-0000-4000-8000-000000000011', 'c3230000-0000-4000-8000-000000000001', '2026-10-05', 1200, 'check'),
  ('c32d0000-0000-4000-8000-000000000031', 'c3230000-0000-4000-8000-000000000003', '2026-10-05', 500, 'check'),
  ('c32d0000-0000-4000-8000-000000000032', 'c3230000-0000-4000-8000-000000000003', '2026-10-06', 1000, 'check');
SELECT gl_post_ar_cash_batch('c3200000-0000-4000-8000-0000000000cb', '2026-10-31',
  '[{"kind":"charge","source_id":"c32c0000-0000-4000-8000-000000000011"},{"kind":"payment","source_id":"c32d0000-0000-4000-8000-000000000011"},
    {"kind":"payment","source_id":"c32d0000-0000-4000-8000-000000000031"},{"kind":"payment","source_id":"c32d0000-0000-4000-8000-000000000032"}]', 'tester');
DO $$
DECLARE v_lines INT;
BEGIN
  -- L1's 1,200: Sep rent's last 400, the 500 forward, October rent 300; all to Rental Income (the
  -- forward falls back to rent), so the entry is two lines. L3's 500 finishes the deposit; its
  -- 1,000 pays the forward (rent fallback).
  PERFORM pg_temp.eq('UF', pg_temp.bal('c3200000-0000-4000-8000-0000000000cb', '1499'), 270000);
  PERFORM pg_temp.eq('rent income', pg_temp.bal('c3200000-0000-4000-8000-0000000000cb', '4000'), -220000);
  PERFORM pg_temp.eq('deposits', pg_temp.bal('c3200000-0000-4000-8000-0000000000cb', '2200'), -150000);
  PERFORM pg_temp.eq('prepaid', pg_temp.bal('c3200000-0000-4000-8000-0000000000cb', '2300'), -50000);
  PERFORM pg_temp.eq('no forward account used', pg_temp.bal('c3200000-0000-4000-8000-0000000000cb', '4900'), 0);
  SELECT count(*) INTO v_lines FROM gl_journal_lines l JOIN gl_ar_cash_entries x ON x.entry_id = l.entry_id JOIN gl_ar_cash_events e ON e.id = x.event_id
   WHERE e.kind = 'payment' AND e.source_id = 'c32d0000-0000-4000-8000-000000000011';
  PERFORM pg_temp.eq('L1 payment entry lines', v_lines, 2);
  PERFORM pg_temp.eq('L1 forward paid', (SELECT a.cents FROM gl_ar_cash_alloc('c3230000-0000-4000-8000-000000000001', (SELECT max(seq) FROM gl_ar_cash_events)) a WHERE a.role = 'balance_forward'), 50000);
  RAISE NOTICE 'ok: October cash pays the forward after older app charges, before later ones; income to rent by default';
END $$;

-- ── BF7: a forward dated after the tie-out date refuses it ─────────────────────────────────────
INSERT INTO gl_ar_accounts (entity_id, role, account_id, updated_by) VALUES
  ('c3200000-0000-4000-8000-0000000000c3', 'undeposited_funds', 'c32a0000-0000-4000-8000-0000000c3003', 'tester'),
  ('c3200000-0000-4000-8000-0000000000c3', 'prepaid_rent', 'c32a0000-0000-4000-8000-0000000c3005', 'tester'),
  ('c3200000-0000-4000-8000-0000000000c3', 'rent', 'c32a0000-0000-4000-8000-0000000c3007', 'tester');
DO $$ BEGIN
  PERFORM gl_post_opening_balance('c3200000-0000-4000-8000-0000000000c3', '2026-09-01',
    '[{"account_id":"c32a0000-0000-4000-8000-0000000c3001","debit_cents":100},{"account_id":"c32a0000-0000-4000-8000-0000000c3006","credit_cents":100}]', 'tester');
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM pg_temp.expect_error($q$SELECT gl_confirm_ar_tieout('c3200000-0000-4000-8000-0000000000c3', 't')$q$,
    'balance forward from QuickBooks dated 2026-09-30, after the AR tie-out date 2026-08-31');
  RAISE NOTICE 'ok: BF7 a forward dated after the tie-out date refuses the tie-out';
END $$;

-- ── BF2: balance_forward mapped to its own income account before the tie-out (CB2) ───────────────
INSERT INTO gl_entities (id, name, accounting_basis) VALUES ('c3200000-0000-4000-8000-0000000000c2', 'BF Mapped LLC', 'cash');
INSERT INTO properties (id, name, gl_entity_id) VALUES ('c3210000-0000-4000-8000-0000000000c2', 'BF Mapped Park', 'c3200000-0000-4000-8000-0000000000c2');
INSERT INTO units (id, property_id, suite) VALUES ('c3220000-0000-4000-8000-0000000000c2', 'c3210000-0000-4000-8000-0000000000c2', 'A');
INSERT INTO leases (id, unit_id, tenant_id) VALUES ('c3230000-0000-4000-8000-000000000009', 'c3220000-0000-4000-8000-0000000000c2', 'c3240000-0000-4000-8000-000000000001');
INSERT INTO gl_accounts (id, entity_id, number, qb_name, account_type)
  SELECT ('c32a0000-0000-4000-8000-0000000c2' || a.n)::uuid, 'c3200000-0000-4000-8000-0000000000c2', a.number, a.name, a.t
    FROM (VALUES ('001', '1000', 'Operating Cash', 'asset'), ('003', '1499', 'Undeposited Funds', 'asset'), ('005', '2300', 'Prepaid Rent', 'liability'),
                 ('006', '3000', 'Members'' Equity', 'equity'), ('007', '4000', 'Rental Income', 'income'), ('008', '4900', 'Prior-System Receivables', 'income')) a(n, number, name, t);
INSERT INTO charges (id, lease_id, charge_date, due_date, type, amount) VALUES
  ('c32c0000-0000-4000-8000-000000000009', 'c3230000-0000-4000-8000-000000000009', '2026-09-01', '2026-09-01', 'rent', 1000);
INSERT INTO payments (id, lease_id, payment_date, amount, method) VALUES
  ('c32d0000-0000-4000-8000-000000000009', 'c3230000-0000-4000-8000-000000000009', '2026-09-05', 600, 'check');
SELECT count(*) FROM apply_balance_forwards('2026-09-30', 'manual', NULL, 'tester',
  '[{"lease_id":"c3230000-0000-4000-8000-000000000009","qb_balance":900,"expected_app_balance":400}]');
INSERT INTO gl_ar_accounts (entity_id, role, account_id, updated_by) VALUES
  ('c3200000-0000-4000-8000-0000000000c2', 'undeposited_funds', 'c32a0000-0000-4000-8000-0000000c2003', 'tester'),
  ('c3200000-0000-4000-8000-0000000000c2', 'prepaid_rent', 'c32a0000-0000-4000-8000-0000000c2005', 'tester'),
  ('c3200000-0000-4000-8000-0000000000c2', 'rent', 'c32a0000-0000-4000-8000-0000000c2007', 'tester'),
  ('c3200000-0000-4000-8000-0000000000c2', 'balance_forward', 'c32a0000-0000-4000-8000-0000000c2008', 'tester');
DO $$ BEGIN
  -- The role must be income.
  PERFORM pg_temp.expect_error($q$UPDATE gl_ar_accounts SET account_id = 'c32a0000-0000-4000-8000-0000000c2005' WHERE entity_id = 'c3200000-0000-4000-8000-0000000000c2' AND role = 'balance_forward'$q$,
    'the balance_forward role needs an income account');
  PERFORM gl_post_opening_balance('c3200000-0000-4000-8000-0000000000c2', '2026-10-01',
    '[{"account_id":"c32a0000-0000-4000-8000-0000000c2001","debit_cents":100},{"account_id":"c32a0000-0000-4000-8000-0000000c2006","credit_cents":100}]', 'tester');
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM pg_temp.eq('CB2 tie-out', gl_confirm_ar_tieout('c3200000-0000-4000-8000-0000000000c2', 'tester'), 0);
  SET CONSTRAINTS ALL IMMEDIATE;
  -- And now it is fixed (REFUTE-7 M4).
  PERFORM pg_temp.expect_error($q$UPDATE gl_ar_accounts SET account_id = 'c32a0000-0000-4000-8000-0000000c2007' WHERE entity_id = 'c3200000-0000-4000-8000-0000000000c2' AND role = 'balance_forward'$q$,
    'fixed once the AR tie-out is confirmed');
END $$;
INSERT INTO charges (id, lease_id, charge_date, due_date, type, amount) VALUES
  ('c32c0000-0000-4000-8000-000000000019', 'c3230000-0000-4000-8000-000000000009', '2026-10-01', '2026-10-01', 'rent', 1000);
INSERT INTO payments (id, lease_id, payment_date, amount, method) VALUES
  ('c32d0000-0000-4000-8000-000000000019', 'c3230000-0000-4000-8000-000000000009', '2026-10-05', 1200, 'check');
SELECT gl_post_ar_cash_batch('c3200000-0000-4000-8000-0000000000c2', '2026-10-31',
  '[{"kind":"charge","source_id":"c32c0000-0000-4000-8000-000000000019"},{"kind":"payment","source_id":"c32d0000-0000-4000-8000-000000000019"}]', 'tester');
DO $$
DECLARE v_lines INT;
BEGIN
  PERFORM pg_temp.eq('CB2 rent', pg_temp.bal('c3200000-0000-4000-8000-0000000000c2', '4000'), -70000);
  PERFORM pg_temp.eq('CB2 forward income', pg_temp.bal('c3200000-0000-4000-8000-0000000000c2', '4900'), -50000);
  SELECT count(*) INTO v_lines FROM gl_journal_lines l JOIN gl_ar_cash_entries x ON x.entry_id = l.entry_id JOIN gl_ar_cash_events e ON e.id = x.event_id
   WHERE e.kind = 'payment' AND e.source_id = 'c32d0000-0000-4000-8000-000000000019';
  PERFORM pg_temp.eq('CB2 payment entry lines', v_lines, 3);
  RAISE NOTICE 'ok: BF2 a mapped balance_forward account takes the forward''s income; rent takes the rest';
END $$;

-- ── REFUTE-9 F1: items inside a forward count by the state the forward measured ─────────────────
-- Accrual AF. Lease A: rent 1,000 (09-01) and an 'other' 300 (09-10) voided on 10-05 — after the
-- tie-out date but before the import — so the forward (QB 1,200 − app 1,000 = +200) already
-- excludes it. Lease B: rent 1,000 and an ACH of 1,000 dated 09-29 that settled after the tie-out
-- date; the forward (QB 150 − app 0 = +150) already counts it. Open AR at the tie-out: 1,200 + 150.
INSERT INTO gl_entities (id, name, accounting_basis) VALUES ('c3200000-0000-4000-8000-0000000000af', 'BF Settled LLC', 'accrual');
INSERT INTO properties (id, name, gl_entity_id) VALUES ('c3210000-0000-4000-8000-0000000000af', 'BF Settled Park', 'c3200000-0000-4000-8000-0000000000af');
INSERT INTO units (id, property_id, suite) VALUES ('c3220000-0000-4000-8000-0000000000af', 'c3210000-0000-4000-8000-0000000000af', 'A');
INSERT INTO leases (id, unit_id, tenant_id) VALUES
  ('c3230000-0000-4000-8000-0000000000a1', 'c3220000-0000-4000-8000-0000000000af', 'c3240000-0000-4000-8000-000000000001'),
  ('c3230000-0000-4000-8000-0000000000b1', 'c3220000-0000-4000-8000-0000000000af', 'c3240000-0000-4000-8000-000000000001');
INSERT INTO gl_accounts (id, entity_id, number, qb_name, account_type) VALUES
  ('c32a0000-0000-4000-8000-0000000af002', 'c3200000-0000-4000-8000-0000000000af', '1100', 'Accounts Receivable', 'asset'),
  ('c32a0000-0000-4000-8000-0000000af003', 'c3200000-0000-4000-8000-0000000000af', '1499', 'Undeposited Funds', 'asset'),
  ('c32a0000-0000-4000-8000-0000000af006', 'c3200000-0000-4000-8000-0000000000af', '3000', 'Members'' Equity', 'equity'),
  ('c32a0000-0000-4000-8000-0000000af007', 'c3200000-0000-4000-8000-0000000000af', '4000', 'Rental Income', 'income');
INSERT INTO gl_ar_accounts (entity_id, role, account_id, updated_by) VALUES
  ('c3200000-0000-4000-8000-0000000000af', 'ar', 'c32a0000-0000-4000-8000-0000000af002', 'tester'),
  ('c3200000-0000-4000-8000-0000000000af', 'undeposited_funds', 'c32a0000-0000-4000-8000-0000000af003', 'tester'),
  ('c3200000-0000-4000-8000-0000000000af', 'rent', 'c32a0000-0000-4000-8000-0000000af007', 'tester');
INSERT INTO charges (id, lease_id, charge_date, due_date, type, amount, voided_at, void_reason) VALUES
  ('c32c0000-0000-4000-8000-0000000000a1', 'c3230000-0000-4000-8000-0000000000a1', '2026-09-01', '2026-09-01', 'rent', 1000, NULL, NULL),
  ('c32c0000-0000-4000-8000-0000000000a2', 'c3230000-0000-4000-8000-0000000000a1', '2026-09-10', '2026-09-10', 'other', 300, '2026-10-05 15:00Z', 'billed in error'),
  ('c32c0000-0000-4000-8000-0000000000b1', 'c3230000-0000-4000-8000-0000000000b1', '2026-09-01', '2026-09-01', 'rent', 1000, NULL, NULL);
INSERT INTO payments (id, lease_id, payment_date, amount, method, stripe_status) VALUES
  ('c32d0000-0000-4000-8000-0000000000b1', 'c3230000-0000-4000-8000-0000000000b1', '2026-09-29', 1000, 'ach_stripe', 'processing');
UPDATE payments SET stripe_status = 'succeeded' WHERE id = 'c32d0000-0000-4000-8000-0000000000b1';  -- settles after the tie-out date
SELECT count(*) FROM apply_balance_forwards('2026-09-30', 'manual', NULL, 'tester', '[
  {"lease_id":"c3230000-0000-4000-8000-0000000000a1","qb_balance":1200,"expected_app_balance":1000},
  {"lease_id":"c3230000-0000-4000-8000-0000000000b1","qb_balance":150,"expected_app_balance":0}]');
DO $$ BEGIN
  PERFORM gl_post_opening_balance('c3200000-0000-4000-8000-0000000000af', '2026-10-01',
    '[{"account_id":"c32a0000-0000-4000-8000-0000000af002","debit_cents":135000},{"account_id":"c32a0000-0000-4000-8000-0000000af006","credit_cents":135000}]', 'tester');
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM pg_temp.eq('F1 tie-out = QuickBooks', gl_confirm_ar_tieout('c3200000-0000-4000-8000-0000000000af', 'tester'), 135000);
  SET CONSTRAINTS ALL IMMEDIATE;
  -- The voided charge is not counted (no void can post for it later); the late ACH is.
  PERFORM pg_temp.eq('F1 voided charge not counted', (SELECT counted::int FROM gl_ar_tieout_items WHERE source_id = 'c32c0000-0000-4000-8000-0000000000a2'), 0);
  PERFORM pg_temp.eq('F1 late ACH counted', (SELECT counted::int FROM gl_ar_tieout_items WHERE source_id = 'c32d0000-0000-4000-8000-0000000000b1'), 1);
  PERFORM pg_temp.eq('F1 nothing to post for them', gl_post_ar_batch('c3200000-0000-4000-8000-0000000000af', '2026-10-31', '[]', 'tester'), 0);
  PERFORM pg_temp.expect_error($q$SELECT gl_post_ar_batch('c3200000-0000-4000-8000-0000000000af', '2026-10-31',
    '[{"kind":"charge_void_pre","source_id":"c32c0000-0000-4000-8000-0000000000a2"}]', 't')$q$, '.');
  RAISE NOTICE 'ok: REFUTE-9 F1 items inside a forward count as the forward measured them; nothing double-counts';
END $$;

-- ── REFUTE-9 F3 / F7 / F9 ──────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  -- F3: even the table owner cannot add a forward to a tied-out LLC.
  PERFORM pg_temp.expect_error($q$INSERT INTO balance_forwards (lease_id, as_of, qb_balance, app_balance, amount, created_by)
    VALUES ('c3230000-0000-4000-8000-000000000005', '2026-09-30', 10, 0, 10, 't')$q$, 'already tied out in the ledger');
  -- F9: the freeze message for a counted forward's history says it is final.
  PERFORM pg_temp.expect_error($q$INSERT INTO payments (lease_id, payment_date, amount, method) VALUES ('c3230000-0000-4000-8000-000000000001', '2026-09-15', 5, 'check')$q$,
    'counted at its AR tie-out; its payments dated on or before then \(2026-09-15\) are frozen for good');
  RAISE NOTICE 'ok: REFUTE-9 F3 no forward into a tied-out LLC by any writer; F9 frozen-for-good message';
END $$;
-- F7: a void outside READ COMMITTED is refused.
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT pg_temp.expect_error($q$SELECT void_balance_forward((SELECT id FROM balance_forwards WHERE lease_id = 'c3230000-0000-4000-8000-000000000008'), 't', 'x')$q$, 'must run in READ COMMITTED');
ROLLBACK;

-- ── Grants: the new function bodies keep the 0028–0030 privileges ──────────────────────────────
DO $$ BEGIN
  IF has_function_privilege('authenticated', 'gl_ar_cash_alloc(uuid,bigint)', 'execute')
     OR has_function_privilege('authenticated', 'void_balance_forward(uuid,text,text)', 'execute')
     OR has_function_privilege('anon', 'apply_balance_forwards(date,text,text,text,jsonb)', 'execute') THEN
    RAISE EXCEPTION 'a replaced function became callable by anon/authenticated';
  END IF;
  RAISE NOTICE 'ok: replaced functions keep their grants';
END $$;

SELECT 'gl_balance_forwards: all checks passed';
