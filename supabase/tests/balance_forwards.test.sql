-- Real-Postgres tests for 0030_balance_forwards.sql (rules B1–B5 in the migration header). Own
-- session, own fixtures (scripts/verify-gl-sql.sh). Amounts in dollars.

CREATE OR REPLACE FUNCTION pg_temp.expect_error(sql TEXT, pattern TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM !~ pattern THEN
      RAISE EXCEPTION 'expected error matching /%/ but got: %  [sql: %]', pattern, SQLERRM, sql;
    END IF;
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

-- Fixtures: one property (no ledger entity), one tenant, three leases.
INSERT INTO properties (id, name) VALUES ('b0100000-0000-4000-8000-000000000001', 'Fishel Flex');
INSERT INTO units (id, property_id, suite) VALUES ('b0200000-0000-4000-8000-000000000001', 'b0100000-0000-4000-8000-000000000001', 'A');
INSERT INTO tenants (id, name) VALUES ('b0400000-0000-4000-8000-000000000001', 'Pool Supply Co');
INSERT INTO leases (id, unit_id, tenant_id) VALUES
  ('b0300000-0000-4000-8000-000000000001', 'b0200000-0000-4000-8000-000000000001', 'b0400000-0000-4000-8000-000000000001'),
  ('b0300000-0000-4000-8000-000000000002', 'b0200000-0000-4000-8000-000000000001', 'b0400000-0000-4000-8000-000000000001'),
  ('b0300000-0000-4000-8000-000000000003', 'b0200000-0000-4000-8000-000000000001', 'b0400000-0000-4000-8000-000000000001');
-- L1: rent 1,000 on May, Jun, Jul 1; check 800 on May 10. App balance as of Jun 30 = 1,200.
INSERT INTO charges (id, lease_id, charge_date, due_date, type, amount) VALUES
  ('b0c00000-0000-4000-8000-000000000001', 'b0300000-0000-4000-8000-000000000001', '2026-05-01', '2026-05-01', 'rent', 1000),
  ('b0c00000-0000-4000-8000-000000000002', 'b0300000-0000-4000-8000-000000000001', '2026-06-01', '2026-06-01', 'rent', 1000),
  ('b0c00000-0000-4000-8000-000000000003', 'b0300000-0000-4000-8000-000000000001', '2026-07-01', '2026-07-01', 'rent', 1000);
INSERT INTO payments (id, lease_id, payment_date, amount, method, stripe_status) VALUES
  ('b0d00000-0000-4000-8000-000000000001', 'b0300000-0000-4000-8000-000000000001', '2026-05-10', 800, 'check', NULL),
-- L2: an ACH dated before the cut-off, still processing; another awaiting action (REFUTE-8 R5).
  ('b0d00000-0000-4000-8000-000000000002', 'b0300000-0000-4000-8000-000000000002', '2026-06-20', 50, 'ach_stripe', 'processing'),
  ('b0d00000-0000-4000-8000-000000000003', 'b0300000-0000-4000-8000-000000000002', '2026-06-21', 50, 'ach_stripe', 'requires_action');

SELECT pg_temp.eq('app cents as of', balance_forward_app_cents('b0300000-0000-4000-8000-000000000001', '2026-06-30'), 120000);

-- B1: the preview's app balance must still hold; whole cents; no future date; no empty batch; no duplicates.
SELECT pg_temp.expect_error($$SELECT * FROM apply_balance_forwards('2026-06-30', 'qb_ar_aging', 'aging.csv', 'tester',
  '[{"lease_id":"b0300000-0000-4000-8000-000000000001","qb_balance":1500,"expected_app_balance":1100}]')$$, 'now 1200.* not 1100 as previewed');
SELECT pg_temp.expect_error($$SELECT * FROM apply_balance_forwards('2026-06-30', 'qb_ar_aging', NULL, 'tester',
  '[{"lease_id":"b0300000-0000-4000-8000-000000000001","qb_balance":1500.005,"expected_app_balance":1200}]')$$, 'whole cents');
SELECT pg_temp.expect_error($$SELECT * FROM apply_balance_forwards('2099-01-01', 'qb_ar_aging', NULL, 'tester',
  '[{"lease_id":"b0300000-0000-4000-8000-000000000001","qb_balance":1500,"expected_app_balance":1200}]')$$, 'must be before today');
-- REFUTE-8 R2: today itself is refused too (same-day activity must stay open).
SELECT pg_temp.expect_error(pg_catalog.format($q$SELECT * FROM apply_balance_forwards(%L, 'qb_ar_aging', NULL, 'tester',
  '[{"lease_id":"b0300000-0000-4000-8000-000000000003","qb_balance":1,"expected_app_balance":0}]')$q$, (now() AT TIME ZONE 'America/Chicago')::date), 'must be before today');
SELECT pg_temp.expect_error($$SELECT * FROM apply_balance_forwards('2026-06-30', 'qb_ar_aging', NULL, 'tester', '[]')$$, 'no balance forward rows');
SELECT pg_temp.expect_error($$SELECT * FROM apply_balance_forwards('2026-06-30', 'qb_ar_aging', NULL, ' ',
  '[{"lease_id":"b0300000-0000-4000-8000-000000000001","qb_balance":1500,"expected_app_balance":1200}]')$$, 'importing user');
SELECT pg_temp.expect_error($$SELECT * FROM apply_balance_forwards('2026-06-30', 'qb_ar_aging', NULL, 'tester',
  '[{"lease_id":"b0300000-0000-4000-8000-000000000001","qb_balance":1500,"expected_app_balance":1200},
    {"lease_id":"b0300000-0000-4000-8000-000000000001","qb_balance":1500,"expected_app_balance":1200}]')$$, 'appears twice');
SELECT pg_temp.expect_error($$SELECT * FROM apply_balance_forwards('2026-06-30', 'qb_ar_aging', NULL, 'tester',
  '[{"lease_id":"b0300000-0000-4000-8000-000000000002","qb_balance":0,"expected_app_balance":0}]')$$, 'still pending');
-- All or nothing: a good row followed by a stale one writes neither.
SELECT pg_temp.expect_error($$SELECT * FROM apply_balance_forwards('2026-06-30', 'qb_ar_aging', NULL, 'tester',
  '[{"lease_id":"b0300000-0000-4000-8000-000000000003","qb_balance":75,"expected_app_balance":0},
    {"lease_id":"b0300000-0000-4000-8000-000000000001","qb_balance":1500,"expected_app_balance":999}]')$$, 'as previewed');
SELECT pg_temp.eq('nothing written', (SELECT count(*) FROM balance_forwards), 0);

-- A row with no difference is skipped; L1 gets +300 (QuickBooks 1,500 vs app 1,200).
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM apply_balance_forwards('2026-06-30', 'qb_ar_aging', 'aging.csv', 'tester',
    '[{"lease_id":"b0300000-0000-4000-8000-000000000003","qb_balance":0,"expected_app_balance":0,"qb_customer":"Nobody"},
      {"lease_id":"b0300000-0000-4000-8000-000000000001","qb_balance":1500,"expected_app_balance":1200,"qb_customer":"Pool Supply Co"}]');
  IF n <> 1 THEN RAISE EXCEPTION 'expected 1 row written, got %', n; END IF;
END $$;
SELECT pg_temp.eq('bf amount', (SELECT amount FROM balance_forwards WHERE lease_id = 'b0300000-0000-4000-8000-000000000001'), 300);
SELECT pg_temp.eq('bf app snapshot', (SELECT app_balance FROM balance_forwards WHERE lease_id = 'b0300000-0000-4000-8000-000000000001'), 1200);
-- ar_ledger: 3,000 charged − 800 paid + 300 = 2,500; totals unchanged.
SELECT pg_temp.eq('ledger balance', (SELECT balance FROM ar_ledger WHERE lease_id = 'b0300000-0000-4000-8000-000000000001'), 2500);
SELECT pg_temp.eq('ledger charged', (SELECT total_charged FROM ar_ledger WHERE lease_id = 'b0300000-0000-4000-8000-000000000001'), 3000);
SELECT pg_temp.eq('ledger bf', (SELECT balance_forward FROM ar_ledger WHERE lease_id = 'b0300000-0000-4000-8000-000000000001'), 300);
SELECT pg_temp.eq('ledger no bf', (SELECT balance_forward FROM ar_ledger WHERE lease_id = 'b0300000-0000-4000-8000-000000000003'), 0);
SELECT pg_temp.expect_error($$SELECT * FROM apply_balance_forwards('2026-06-30', 'qb_ar_aging', NULL, 'tester',
  '[{"lease_id":"b0300000-0000-4000-8000-000000000001","qb_balance":1500,"expected_app_balance":1200}]')$$, 'already has a balance forward');

-- B3: history on or before as_of is frozen; after it is not.
SELECT pg_temp.expect_error($$INSERT INTO charges (lease_id, charge_date, due_date, type, amount) VALUES ('b0300000-0000-4000-8000-000000000001', '2026-06-30', '2026-06-30', 'other', 5)$$, 'balance forward from QuickBooks as of 2026-06-30');
SELECT pg_temp.expect_error($$INSERT INTO payments (lease_id, payment_date, amount, method) VALUES ('b0300000-0000-4000-8000-000000000001', '2026-06-15', 5, 'check')$$, 'cannot change');
SELECT pg_temp.expect_error($$UPDATE charges SET amount = 900 WHERE id = 'b0c00000-0000-4000-8000-000000000001'$$, 'cannot change');
SELECT pg_temp.expect_error($$UPDATE charges SET voided_at = now(), void_reason = 'x' WHERE id = 'b0c00000-0000-4000-8000-000000000001'$$, 'cannot change');
SELECT pg_temp.expect_error($$UPDATE charges SET charge_date = '2026-06-30' WHERE id = 'b0c00000-0000-4000-8000-000000000003'$$, 'cannot change');
SELECT pg_temp.expect_error($$DELETE FROM payments WHERE id = 'b0d00000-0000-4000-8000-000000000001'$$, 'cannot change');
SELECT pg_temp.expect_error($$UPDATE payments SET method = 'wire' WHERE id = 'b0d00000-0000-4000-8000-000000000001'$$, 'cannot change');
-- Moving a pre-cut-off charge to another lease is a change on the old lease too.
SELECT pg_temp.expect_error($$UPDATE charges SET lease_id = 'b0300000-0000-4000-8000-000000000003' WHERE id = 'b0c00000-0000-4000-8000-000000000002'$$, 'cannot change');
-- REFUTE-8 R1: a billing re-run re-sending an existing charge (same idempotency key) is not refused.
UPDATE charges SET idempotency_key = 'rent_L1_2026_06' WHERE id = 'b0c00000-0000-4000-8000-000000000002';
INSERT INTO charges (lease_id, charge_date, due_date, type, amount, idempotency_key)
  VALUES ('b0300000-0000-4000-8000-000000000001', '2026-06-01', '2026-06-01', 'rent', 1000, 'rent_L1_2026_06') ON CONFLICT (idempotency_key) DO NOTHING;
SELECT pg_temp.expect_error($$INSERT INTO charges (lease_id, charge_date, due_date, type, amount, idempotency_key)
  VALUES ('b0300000-0000-4000-8000-000000000001', '2026-06-01', '2026-06-01', 'rent', 1000, 'rent_L1_2026_06_new') ON CONFLICT (idempotency_key) DO NOTHING$$, 'cannot change');
-- … and ON CONFLICT DO UPDATE of a frozen row is still checked.
SELECT pg_temp.expect_error($$INSERT INTO charges (lease_id, charge_date, due_date, type, amount, idempotency_key)
  VALUES ('b0300000-0000-4000-8000-000000000001', '2026-06-01', '2026-06-01', 'rent', 1, 'rent_L1_2026_06') ON CONFLICT (idempotency_key) DO UPDATE SET amount = EXCLUDED.amount$$, 'cannot change');
SELECT pg_temp.eq('June rent unchanged', (SELECT amount FROM charges WHERE idempotency_key = 'rent_L1_2026_06'), 1000);
-- R4: TRUNCATE is refused while a balance forward is live.
SELECT pg_temp.expect_error($$TRUNCATE charges CASCADE$$, 'cannot be truncated');
SELECT pg_temp.expect_error($$TRUNCATE payments$$, 'cannot be truncated');
-- Allowed: non-money edits to frozen rows, and anything dated after as_of, and other leases.
UPDATE charges SET description = 'May rent', due_date = '2026-05-05' WHERE id = 'b0c00000-0000-4000-8000-000000000001';
INSERT INTO charges (lease_id, charge_date, due_date, type, amount) VALUES ('b0300000-0000-4000-8000-000000000001', '2026-07-15', '2026-07-15', 'other', 5);
INSERT INTO payments (lease_id, payment_date, amount, method) VALUES ('b0300000-0000-4000-8000-000000000001', '2026-07-01', 5, 'check');
INSERT INTO charges (lease_id, charge_date, due_date, type, amount) VALUES ('b0300000-0000-4000-8000-000000000003', '2026-06-01', '2026-06-01', 'rent', 10);
SELECT pg_temp.eq('ledger after later activity', (SELECT balance FROM ar_ledger WHERE lease_id = 'b0300000-0000-4000-8000-000000000001'), 2500);
-- B5: a guarded write outside READ COMMITTED is refused.
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT pg_temp.expect_error($$INSERT INTO charges (lease_id, charge_date, due_date, type, amount) VALUES ('b0300000-0000-4000-8000-000000000003', '2026-08-01', '2026-08-01', 'rent', 10)$$, 'READ COMMITTED');
SELECT pg_temp.expect_error($$SELECT * FROM apply_balance_forwards('2026-06-30', 'qb_ar_aging', NULL, 'tester',
  '[{"lease_id":"b0300000-0000-4000-8000-000000000003","qb_balance":0,"expected_app_balance":10}]')$$, 'READ COMMITTED');
ROLLBACK;

-- B2: insert-only, voidable once; service_role cannot write the table directly.
SELECT pg_temp.expect_error($$UPDATE balance_forwards SET amount = 1 WHERE lease_id = 'b0300000-0000-4000-8000-000000000001'$$, 'only be voided');
SELECT pg_temp.expect_error($$DELETE FROM balance_forwards$$, 'cannot be deleted');
SELECT pg_temp.expect_error($$TRUNCATE balance_forwards$$, 'cannot be deleted');
-- The stub app tables predate the verify script's default grants; Supabase grants them to service_role.
GRANT SELECT ON properties, units, tenants, leases, charges, payments TO service_role;
SET ROLE service_role;
SELECT pg_temp.expect_error($$INSERT INTO balance_forwards (lease_id, as_of, qb_balance, app_balance, amount, created_by) VALUES ('b0300000-0000-4000-8000-000000000003', '2026-06-30', 5, 0, 5, 'x')$$, 'permission denied');
SELECT pg_temp.expect_error($$UPDATE balance_forwards SET voided_at = now()$$, 'permission denied');
SELECT pg_temp.eq('service_role reads ar_ledger', (SELECT balance FROM ar_ledger WHERE lease_id = 'b0300000-0000-4000-8000-000000000001'), 2500);
SELECT pg_temp.expect_error($$SELECT void_balance_forward((SELECT id FROM balance_forwards LIMIT 1), 'tester', ' ')$$, 'balance_forwards_void_complete');
SELECT void_balance_forward((SELECT id FROM balance_forwards WHERE lease_id = 'b0300000-0000-4000-8000-000000000001'), 'tester', 'wrong QuickBooks figure');
RESET ROLE;
SELECT pg_temp.expect_error($$SELECT void_balance_forward((SELECT id FROM balance_forwards LIMIT 1), 'tester', 'again')$$, 'already voided');
SELECT pg_temp.eq('ledger after void', (SELECT balance FROM ar_ledger WHERE lease_id = 'b0300000-0000-4000-8000-000000000001'), 2200);
-- Once voided the history thaws, and the lease can be imported again.
INSERT INTO charges (lease_id, charge_date, due_date, type, amount) VALUES ('b0300000-0000-4000-8000-000000000001', '2026-06-30', '2026-06-30', 'other', 5);
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM apply_balance_forwards('2026-06-30', 'manual', NULL, 'tester',
    '[{"lease_id":"b0300000-0000-4000-8000-000000000001","qb_balance":1000,"expected_app_balance":1205}]');
  IF n <> 1 THEN RAISE EXCEPTION 'expected re-import, got %', n; END IF;
END $$;
SELECT pg_temp.eq('re-imported credit', (SELECT amount FROM balance_forwards WHERE lease_id = 'b0300000-0000-4000-8000-000000000001' AND voided_at IS NULL), -205);

-- B4' (0032 BF7): the ledger's AR tie-out counts balance forwards, but refuses one dated after it.
INSERT INTO gl_entities (id, name, accounting_basis) VALUES ('b0e00000-0000-4000-8000-000000000001', 'Fishel LLC', 'cash');
UPDATE properties SET gl_entity_id = 'b0e00000-0000-4000-8000-000000000001' WHERE id = 'b0100000-0000-4000-8000-000000000001';
SELECT pg_temp.expect_error($$INSERT INTO gl_ar_tieouts (entity_id, as_of, app_ar_cents, gl_ar_cents, opening_entry_id, confirmed_by)
  VALUES ('b0e00000-0000-4000-8000-000000000001', '2026-05-31', 0, 0, gen_random_uuid(), 'tester')$$, 'dated 2026-06-30, after the AR tie-out date 2026-05-31');
-- REFUTE-8 R3: a lease with a live balance forward cannot be moved into a tied-out LLC — by its
-- property, its unit, or the lease itself.
DO $$
DECLARE v_ent UUID; v_unit UUID;
BEGIN
  SELECT t.entity_id INTO v_ent FROM gl_ar_tieouts t LIMIT 1;
  SELECT u.id INTO v_unit FROM units u JOIN properties p ON p.id = u.property_id WHERE p.gl_entity_id = v_ent LIMIT 1;
  IF v_ent IS NULL OR v_unit IS NULL THEN RAISE EXCEPTION 'fixture missing: no tied-out LLC unit'; END IF;
  PERFORM pg_temp.expect_error(pg_catalog.format($q$UPDATE properties SET gl_entity_id = %L WHERE id = 'b0100000-0000-4000-8000-000000000001'$q$, v_ent), 'cannot move into an LLC already tied out');
  PERFORM pg_temp.expect_error(pg_catalog.format($q$UPDATE leases SET unit_id = %L WHERE id = 'b0300000-0000-4000-8000-000000000001'$q$, v_unit), 'cannot move into an LLC already tied out');
  PERFORM pg_temp.expect_error(pg_catalog.format($q$UPDATE units SET property_id = (SELECT property_id FROM units WHERE id = %L) WHERE id = 'b0200000-0000-4000-8000-000000000001'$q$, v_unit), 'cannot move into an LLC already tied out');
END $$;
-- …and an LLC already tied out (fixtures from gl_ar_posting.test.sql) refuses a new balance forward.
DO $$
DECLARE v_lease UUID; v_app NUMERIC;
BEGIN
  SELECT l.id INTO v_lease FROM leases l JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
    JOIN gl_ar_tieouts t ON t.entity_id = p.gl_entity_id LIMIT 1;
  IF v_lease IS NULL THEN RAISE EXCEPTION 'fixture missing: no tied-out LLC lease (gl_ar_posting.test.sql must run first)'; END IF;
  v_app := balance_forward_app_cents(v_lease, '2026-06-30')::numeric / 100;
  PERFORM pg_temp.expect_error(pg_catalog.format($q$SELECT * FROM apply_balance_forwards('2026-06-30', 'qb_ar_aging', NULL, 'tester',
    '[{"lease_id":"%s","qb_balance":%s,"expected_app_balance":%s}]')$q$, v_lease, v_app + 1, v_app), 'already tied out');
END $$;

SELECT 'balance_forwards: all checks passed';
