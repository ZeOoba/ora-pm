-- 0030: balance forward from QuickBooks — one opening-balance adjustment per lease.
--
-- Ratified 2026-11-13 ("Opening-balance adjustment"): payments are recorded in the app from now on,
-- but the app's charge history is not the tenant's true account (QuickBooks is). Each lease gets at
-- most one live balance forward:
--     amount = QuickBooks balance as of as_of − the app's balance as of as_of   (signed dollars;
--              positive = the tenant owes more than the app shows, negative = a credit)
-- so that from as_of on, ar_ledger.balance = the QuickBooks balance + the app's later activity.
-- Charges and payments stay pure (no fake rent, no fake payment), income reports are untouched,
-- and statements show it as one line, "Balance forward from prior system".
--
-- Money rules, enforced here (service_role SQL included):
--   B1. Written only through apply_balance_forwards(), which recomputes the app balance as of
--       as_of under a lock on each lease and refuses if it differs from what the preview showed.
--       It refuses a lease with an ACH payment still pending/processing on or before as_of (its
--       outcome would move the snapshot), a future as_of, or a lease that already has one.
--   B2. Insert-only. The one permitted change is voiding (void_balance_forward); no delete.
--   B3. While a live balance forward exists, the lease's charges and payments dated on or before
--       as_of are frozen: no insert, delete, or change of amount, date, lease, void state or
--       payment method. (That history is already inside the QuickBooks figure; a change would be
--       counted twice.) To correct it: void the balance forward, fix the history, import again.
--       Stripe status changes still flow (a later ACH return is a real event QuickBooks also books).
--   B4. GL: the native ledger's AR tie-out (0028/0029) does not count balance forwards yet. Until it
--       does, an LLC cannot be tied out while any of its leases has a live balance forward, and a
--       balance forward cannot be added to an LLC that is already tied out. It fails visibly.
--   B5. Concurrency: every writer locks the lease row (apply: FOR UPDATE; the B3 guard: FOR SHARE)
--       and runs in READ COMMITTED, so a charge or payment racing an import is either seen by the
--       import's recomputation or refused by the guard.
--
-- Rollback (nothing else depends on these objects):
--   DROP TRIGGER IF EXISTS balance_forward_guard ON charges; DROP TRIGGER IF EXISTS balance_forward_guard ON payments;
--   DROP TRIGGER IF EXISTS gl_ar_tieouts_no_balance_forward ON gl_ar_tieouts;
--   then re-run the ar_ledger definition from 0016_charges_void.sql, then DROP TABLE balance_forwards CASCADE
--   and DROP FUNCTION apply_balance_forwards, void_balance_forward, balance_forward_app_cents,
--   balance_forward_guard, balance_forward_immutable, gl_ar_tieout_no_balance_forward.

CREATE TABLE IF NOT EXISTS balance_forwards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id UUID NOT NULL REFERENCES leases(id),
  as_of DATE NOT NULL,
  qb_balance NUMERIC(12,2) NOT NULL,
  app_balance NUMERIC(12,2) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  qb_customer TEXT,
  source TEXT NOT NULL DEFAULT 'qb_ar_aging' CONSTRAINT balance_forwards_source_chk CHECK (source IN ('qb_ar_aging', 'manual')),
  source_ref TEXT,
  created_by TEXT NOT NULL CONSTRAINT balance_forwards_by_nonempty CHECK (btrim(created_by) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  voided_at TIMESTAMPTZ,
  voided_by TEXT,
  void_reason TEXT,
  CONSTRAINT balance_forwards_amount_is_difference CHECK (amount = qb_balance - app_balance),
  CONSTRAINT balance_forwards_amount_nonzero CHECK (amount <> 0),
  CONSTRAINT balance_forwards_void_complete CHECK (
    (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
    OR (voided_at IS NOT NULL AND btrim(coalesce(voided_by, '')) <> '' AND btrim(coalesce(void_reason, '')) <> ''))
);
CREATE UNIQUE INDEX IF NOT EXISTS balance_forwards_one_live_per_lease ON balance_forwards (lease_id) WHERE voided_at IS NULL;

ALTER TABLE balance_forwards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON balance_forwards FROM PUBLIC, anon, authenticated;
-- service_role reads it (ar_ledger, statements, the import page) and writes only via the functions.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON balance_forwards FROM service_role;
GRANT SELECT ON balance_forwards TO service_role;
-- ar_ledger is security_invoker, so a tenant JWT reading it (no such path today; see
-- server/db/client.ts) reads balance_forwards too: same tenant-own SELECT rule as charges (0004).
GRANT SELECT ON balance_forwards TO authenticated;
DROP POLICY IF EXISTS tenant_own_balance_forwards ON balance_forwards;
CREATE POLICY tenant_own_balance_forwards ON balance_forwards
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM leases l
      JOIN tenants t ON t.id = l.tenant_id
      WHERE l.id = balance_forwards.lease_id
      AND t.auth_user_id = auth.uid()
    )
  );

-- B2: insert-only apart from one void.
CREATE OR REPLACE FUNCTION balance_forward_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'bf: balance forwards cannot be deleted; void it instead' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'bf: balance forward % is already voided', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.lease_id, NEW.as_of, NEW.qb_balance, NEW.app_balance, NEW.amount, NEW.qb_customer, NEW.source, NEW.source_ref, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.lease_id, OLD.as_of, OLD.qb_balance, OLD.app_balance, OLD.amount, OLD.qb_customer, OLD.source, OLD.source_ref, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'bf: a balance forward can only be voided, not changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS balance_forwards_immutable ON balance_forwards;
CREATE TRIGGER balance_forwards_immutable BEFORE UPDATE OR DELETE ON balance_forwards
  FOR EACH ROW EXECUTE FUNCTION balance_forward_immutable();
DROP TRIGGER IF EXISTS balance_forwards_no_truncate ON balance_forwards;
CREATE TRIGGER balance_forwards_no_truncate BEFORE TRUNCATE ON balance_forwards
  FOR EACH STATEMENT EXECUTE FUNCTION balance_forward_immutable();

-- The app's balance for a lease as of a date, in cents: exactly ar_ledger's populations (0016:
-- non-voided charges; check/wire/other, or ACH once succeeded), cut at charge_date / payment_date.
CREATE OR REPLACE FUNCTION balance_forward_app_cents(p_lease_id UUID, p_as_of DATE) RETURNS BIGINT
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT (SELECT coalesce(sum(c.amount), 0) FROM charges c
            WHERE c.lease_id = p_lease_id AND c.voided_at IS NULL AND c.charge_date <= p_as_of) * 100
       - (SELECT coalesce(sum(p.amount), 0) FROM payments p
            WHERE p.lease_id = p_lease_id AND p.payment_date <= p_as_of
              AND (p.method IN ('check', 'wire', 'other') OR (p.method = 'ach_stripe' AND p.stripe_status = 'succeeded'))) * 100
$$;

-- B1. p_rows: [{ "lease_id", "qb_balance" (dollars), "expected_app_balance" (dollars, from the
-- preview), "qb_customer" (optional) }]. All or nothing. A row whose QuickBooks balance equals the
-- app balance needs no adjustment and is skipped. Returns the rows written.
CREATE OR REPLACE FUNCTION apply_balance_forwards(p_as_of DATE, p_source TEXT, p_source_ref TEXT, p_actor TEXT, p_rows JSONB)
  RETURNS SETOF balance_forwards
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r JSONB;
  v_lease UUID;
  v_qb NUMERIC;
  v_expected NUMERIC;
  v_app BIGINT;
  v_entity UUID;
  v_row balance_forwards%ROWTYPE;
  v_seen UUID[] := '{}';
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'bf: apply_balance_forwards must run in READ COMMITTED' USING ERRCODE = 'invalid_transaction_state';
  END IF;
  IF p_as_of IS NULL OR p_as_of > (pg_catalog.now() AT TIME ZONE 'America/Chicago')::date THEN
    RAISE EXCEPTION 'bf: balance forward date % is missing or in the future', p_as_of USING ERRCODE = 'check_violation';
  END IF;
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'bf: balance forwards need the importing user' USING ERRCODE = 'check_violation';
  END IF;
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' OR pg_catalog.jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'bf: no balance forward rows given' USING ERRCODE = 'check_violation';
  END IF;

  FOR r IN SELECT * FROM pg_catalog.jsonb_array_elements(p_rows) LOOP
    v_lease := (r->>'lease_id')::uuid;
    v_qb := (r->>'qb_balance')::numeric;
    v_expected := (r->>'expected_app_balance')::numeric;
    IF v_lease IS NULL OR v_qb IS NULL OR v_expected IS NULL THEN
      RAISE EXCEPTION 'bf: each row needs lease_id, qb_balance and expected_app_balance' USING ERRCODE = 'check_violation';
    END IF;
    IF v_qb <> pg_catalog.round(v_qb, 2) OR v_expected <> pg_catalog.round(v_expected, 2) THEN
      RAISE EXCEPTION 'bf: lease %: amounts must be whole cents', v_lease USING ERRCODE = 'check_violation';
    END IF;
    IF v_lease = ANY (v_seen) THEN
      RAISE EXCEPTION 'bf: lease % appears twice', v_lease USING ERRCODE = 'check_violation';
    END IF;
    v_seen := v_seen || v_lease;

    PERFORM 1 FROM leases WHERE id = v_lease FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'bf: lease % does not exist', v_lease USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM balance_forwards b WHERE b.lease_id = v_lease AND b.voided_at IS NULL) THEN
      RAISE EXCEPTION 'bf: lease % already has a balance forward; void it first', v_lease USING ERRCODE = 'unique_violation';
    END IF;
    v_entity := gl_lease_entity(v_lease);
    IF v_entity IS NOT NULL AND EXISTS (SELECT 1 FROM gl_ar_tieouts t WHERE t.entity_id = v_entity) THEN
      RAISE EXCEPTION 'bf: lease %: its LLC is already tied out in the ledger, which does not count balance forwards yet', v_lease
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM payments p WHERE p.lease_id = v_lease AND p.payment_date <= p_as_of
                 AND p.method = 'ach_stripe' AND p.stripe_status IN ('pending', 'processing')) THEN
      RAISE EXCEPTION 'bf: lease % has an ACH payment still pending on or before %; wait for it to settle', v_lease, p_as_of
        USING ERRCODE = 'check_violation';
    END IF;
    v_app := balance_forward_app_cents(v_lease, p_as_of);
    IF v_app <> pg_catalog.round(v_expected * 100) THEN
      RAISE EXCEPTION 'bf: lease %: the app balance as of % is now %, not % as previewed; preview again',
        v_lease, p_as_of, (v_app::numeric / 100), v_expected USING ERRCODE = 'serialization_failure';
    END IF;
    CONTINUE WHEN pg_catalog.round(v_qb * 100) = v_app;

    INSERT INTO balance_forwards (lease_id, as_of, qb_balance, app_balance, amount, qb_customer, source, source_ref, created_by)
      VALUES (v_lease, p_as_of, v_qb, v_app::numeric / 100, v_qb - v_app::numeric / 100, NULLIF(btrim(r->>'qb_customer'), ''),
              coalesce(p_source, 'qb_ar_aging'), NULLIF(btrim(p_source_ref), ''), btrim(p_actor))
      RETURNING * INTO v_row;
    RETURN NEXT v_row;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION void_balance_forward(p_id UUID, p_actor TEXT, p_reason TEXT) RETURNS balance_forwards
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row balance_forwards%ROWTYPE;
BEGIN
  UPDATE balance_forwards SET voided_at = pg_catalog.now(), voided_by = btrim(p_actor), void_reason = btrim(p_reason)
    WHERE id = p_id AND voided_at IS NULL
    RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bf: balance forward % does not exist or is already voided', p_id USING ERRCODE = 'no_data_found';
  END IF;
  RETURN v_row;
END $$;

-- B3 + B5: the history a live balance forward already contains is frozen.
CREATE OR REPLACE FUNCTION balance_forward_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old_lease UUID;
  v_new_lease UUID;
  v_old_date DATE;
  v_new_date DATE;
  v_cut DATE;
BEGIN
  IF TG_TABLE_NAME = 'charges' THEN
    IF TG_OP <> 'INSERT' THEN v_old_lease := OLD.lease_id; v_old_date := OLD.charge_date; END IF;
    IF TG_OP <> 'DELETE' THEN v_new_lease := NEW.lease_id; v_new_date := NEW.charge_date; END IF;
    IF TG_OP = 'UPDATE' AND (NEW.lease_id, NEW.charge_date, NEW.amount, NEW.voided_at IS NULL)
                            IS NOT DISTINCT FROM (OLD.lease_id, OLD.charge_date, OLD.amount, OLD.voided_at IS NULL) THEN
      RETURN NEW;
    END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN v_old_lease := OLD.lease_id; v_old_date := OLD.payment_date; END IF;
    IF TG_OP <> 'DELETE' THEN v_new_lease := NEW.lease_id; v_new_date := NEW.payment_date; END IF;
    IF TG_OP = 'UPDATE' AND (NEW.lease_id, NEW.payment_date, NEW.amount, NEW.method)
                            IS NOT DISTINCT FROM (OLD.lease_id, OLD.payment_date, OLD.amount, OLD.method) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'bf: changes to charges and payments must run in READ COMMITTED (balance forward guard)'
      USING ERRCODE = 'invalid_transaction_state';
  END IF;
  -- Wait out a concurrent import on the same lease, then read what it committed.
  PERFORM 1 FROM leases WHERE id IN (v_old_lease, v_new_lease) ORDER BY id FOR SHARE;
  FOR v_cut, v_old_lease, v_old_date IN
    SELECT b.as_of, x.lease, x.d FROM (VALUES (v_old_lease, v_old_date), (v_new_lease, v_new_date)) AS x(lease, d)
      JOIN balance_forwards b ON b.lease_id = x.lease AND b.voided_at IS NULL
     WHERE x.d <= b.as_of
  LOOP
    RAISE EXCEPTION 'bf: lease % has a balance forward from QuickBooks as of %; its % dated on or before then (%) cannot change. Void the balance forward first, then import again.',
      v_old_lease, v_cut, TG_TABLE_NAME, v_old_date USING ERRCODE = 'check_violation';
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS balance_forward_guard ON charges;
CREATE TRIGGER balance_forward_guard BEFORE INSERT OR UPDATE OR DELETE ON charges
  FOR EACH ROW EXECUTE FUNCTION balance_forward_guard();
DROP TRIGGER IF EXISTS balance_forward_guard ON payments;
CREATE TRIGGER balance_forward_guard BEFORE INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION balance_forward_guard();

-- B4: no AR tie-out while an LLC lease carries a live balance forward.
CREATE OR REPLACE FUNCTION gl_ar_tieout_no_balance_forward() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM balance_forwards b WHERE b.voided_at IS NULL AND gl_lease_entity(b.lease_id) = NEW.entity_id) THEN
    RAISE EXCEPTION 'gl: this LLC has leases with a balance forward from QuickBooks, which the AR tie-out does not count yet'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS gl_ar_tieouts_no_balance_forward ON gl_ar_tieouts;
CREATE TRIGGER gl_ar_tieouts_no_balance_forward BEFORE INSERT ON gl_ar_tieouts
  FOR EACH ROW EXECUTE FUNCTION gl_ar_tieout_no_balance_forward();

REVOKE EXECUTE ON FUNCTION apply_balance_forwards(DATE, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION void_balance_forward(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION balance_forward_app_cents(UUID, DATE) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION balance_forward_immutable() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION balance_forward_guard() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gl_ar_tieout_no_balance_forward() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_balance_forwards(DATE, TEXT, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION void_balance_forward(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION balance_forward_app_cents(UUID, DATE) TO service_role;

-- ar_ledger: 0016's definition plus the live balance forward. Two columns appended at the end
-- (CREATE OR REPLACE VIEW can only add columns there); balance now includes the balance forward.
-- total_charged and total_paid are unchanged (they still sum only charges and payments).
CREATE OR REPLACE VIEW ar_ledger WITH (security_invoker = true) AS
WITH charge_totals AS (
  SELECT lease_id, COALESCE(SUM(amount), 0) AS total_charged
  FROM charges
  WHERE voided_at IS NULL
  GROUP BY lease_id
),
payment_totals AS (
  SELECT lease_id,
    COALESCE(SUM(CASE
      WHEN method = 'ach_stripe' AND stripe_status = 'succeeded' THEN amount
      WHEN method IN ('check', 'wire', 'other') THEN amount
      ELSE 0
    END), 0) AS total_paid
  FROM payments
  GROUP BY lease_id
),
forwards AS (
  SELECT lease_id, amount AS balance_forward, as_of AS balance_forward_as_of
  FROM balance_forwards
  WHERE voided_at IS NULL
)
SELECT
  l.id AS lease_id,
  l.tenant_id,
  l.unit_id,
  t.name AS tenant_name,
  u.property_id,
  u.suite,
  COALESCE(ct.total_charged, 0) AS total_charged,
  COALESCE(pt.total_paid, 0) AS total_paid,
  COALESCE(ct.total_charged, 0) - COALESCE(pt.total_paid, 0) + COALESCE(bf.balance_forward, 0) AS balance,
  p.name AS property_name,
  COALESCE(bf.balance_forward, 0) AS balance_forward,
  bf.balance_forward_as_of
FROM leases l
JOIN tenants t ON t.id = l.tenant_id
JOIN units u ON u.id = l.unit_id
JOIN properties p ON p.id = u.property_id
LEFT JOIN charge_totals ct ON ct.lease_id = l.id
LEFT JOIN payment_totals pt ON pt.lease_id = l.id
LEFT JOIN forwards bf ON bf.lease_id = l.id;
ALTER VIEW ar_ledger SET (security_invoker = true);
