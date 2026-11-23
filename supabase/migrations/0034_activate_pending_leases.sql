-- 0034: activate_pending_leases() — lease abstraction Phase 7 (docs/plans/2026-11-10-lease-abstraction-auto-billing-plan.md).
--
-- Nothing in server/ ever moved a lease from 'pending' to 'active'. A future-dated lease (approve_lease_abstract,
-- 0033, creates it 'pending') therefore stayed pending forever, and monthly billing (which bills status 'active')
-- never billed it. A replacement tenant's lease could not simply be flipped either: the unit's prior lease is
-- still 'active' (0033 closes it out only once its end date has passed AT APPROVAL) and leases_active_unit_unique
-- allows one active lease per unit.
--
-- For every pending lease whose start_date has arrived by the activation date (start_date <= LEAST(p_today,
-- p_as_of)), in (unit, start_date) order. p_as_of lets the billing cron activate as of a billing month's first
-- day; whether a term has already ENDED is always judged against the real p_today:
--   - its term already ended (end_date < p_today)              → blocked 'term_already_ended' (never activated
--                                                                   blind; a human decides whether it ever ran)
--   - the unit has an ACTIVE lease whose end_date is on or
--     after this lease's start_date (terms overlap)            → blocked 'unit_has_active_lease'
--   - the unit has an ACTIVE lease that ended BEFORE this
--     lease's start_date                                       → that lease → 'expired', this one → 'active'
--   - no active lease on the unit                              → this one → 'active'
-- Activation marks the unit occupied. Charges, payments and the prior tenant's ledger are never touched.
-- Only a successor lease closes out an active lease: an active lease past its end date with NO successor is a
-- holdover decision the billing cron surfaces (past_end_date), never expired here.
--
-- p_dry_run = true decides every outcome the same way and writes nothing (monthly-billing ?dryRun=1). In a dry
-- run a second pending lease on the same unit is judged against the unit as it stands, not as the first
-- activation would leave it.
--
-- Concurrency: each unit row is locked FOR UPDATE before its leases are read, the same lock
-- approve_lease_abstract() (0033) takes first, so an approval and an activation on one unit serialize.
--
-- Also (plan §5a item 6): a concession of charge_type 'all' with kind 'fixed_amount' has no defined split
-- between rent and CAM; the billing engine already refuses it (invalid_row) and approval splits it. The CHECK
-- makes the table refuse it too.
--
-- Service role only. Re-runnable.

-- An earlier two-argument draft must never survive as an overload (a 2-arg call would be ambiguous).
DROP FUNCTION IF EXISTS activate_pending_leases(date, boolean);

CREATE OR REPLACE FUNCTION activate_pending_leases(p_today date, p_dry_run boolean DEFAULT false, p_as_of date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_l leases%ROWTYPE;
  v_prior leases%ROWTYPE;
  v_has_prior boolean;
  v_as_of date;
  v_activated jsonb := '[]'::jsonb;
  v_blocked jsonb := '[]'::jsonb;
BEGIN
  IF p_today IS NULL THEN
    RAISE EXCEPTION 'activate_pending_leases: p_today is required';
  END IF;
  v_as_of := LEAST(p_today, COALESCE(p_as_of, p_today));

  FOR v_id IN
    SELECT id FROM leases WHERE status = 'pending' AND start_date <= v_as_of ORDER BY unit_id, start_date, id
  LOOP
    SELECT * INTO v_l FROM leases WHERE id = v_id;
    PERFORM 1 FROM units WHERE id = v_l.unit_id FOR UPDATE;
    -- Re-read under the unit lock: a concurrent approval or activation may have changed it.
    SELECT * INTO v_l FROM leases WHERE id = v_id FOR UPDATE;
    IF NOT FOUND OR v_l.status <> 'pending' OR v_l.start_date > v_as_of THEN
      CONTINUE;
    END IF;

    IF v_l.end_date < p_today THEN
      v_blocked := v_blocked || jsonb_build_object('lease_id', v_l.id, 'unit_id', v_l.unit_id, 'reason', 'term_already_ended',
                                                   'start_date', v_l.start_date, 'end_date', v_l.end_date);
      CONTINUE;
    END IF;

    SELECT * INTO v_prior FROM leases
     WHERE unit_id = v_l.unit_id AND status = 'active' AND id <> v_l.id
     FOR UPDATE;
    v_has_prior := FOUND; -- captured now: the UPDATEs below reset FOUND
    IF v_has_prior AND v_prior.end_date >= v_l.start_date THEN
      v_blocked := v_blocked || jsonb_build_object('lease_id', v_l.id, 'unit_id', v_l.unit_id, 'reason', 'unit_has_active_lease',
                                                   'blocking_lease_id', v_prior.id, 'blocking_end_date', v_prior.end_date,
                                                   'start_date', v_l.start_date, 'end_date', v_l.end_date);
      CONTINUE;
    END IF;

    IF NOT p_dry_run THEN
      IF v_has_prior THEN
        UPDATE leases SET status = 'expired' WHERE id = v_prior.id;
      END IF;
      UPDATE leases SET status = 'active' WHERE id = v_l.id;
      UPDATE units SET status = 'occupied' WHERE id = v_l.unit_id;
    END IF;
    v_activated := v_activated || jsonb_build_object('lease_id', v_l.id, 'unit_id', v_l.unit_id, 'start_date', v_l.start_date,
                                                     'prior_lease_id', CASE WHEN v_has_prior THEN v_prior.id END);
  END LOOP;

  RETURN jsonb_build_object('activated', v_activated, 'blocked', v_blocked, 'dry_run', p_dry_run);
END;
$$;

REVOKE EXECUTE ON FUNCTION activate_pending_leases(date, boolean, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION activate_pending_leases(date, boolean, date) TO service_role;

-- sync_scheduled_lease_amounts(p_as_of): plan §5a item 2. Once a lease has schedule rows, billing reads the
-- schedule and leases.base_rent_monthly / cam_estimate_monthly are display only — but the rent_roll view (0004),
-- the UI and the portal still read them. This keeps them equal to the schedule as of p_as_of, for active and
-- pending leases only (history is never rewritten):
--   base_rent_monthly    ← the active rent row covering p_as_of (left alone when none covers it: billing flags
--                          that lease as schedule_gap)
--   cam_estimate_monthly ← ONLY for a lease whose CAM comes from cam_estimate recurring rows (rent-schedule.ts
--                          CAM single-source rule): the active row covering p_as_of, or 0 when none does
--                          (billing bills no CAM then). A lease with no active cam row bills this field, so it is
--                          never touched.
-- Called by the live monthly-billing run. Billing never reads these fields for a scheduled lease, so this
-- function cannot change any amount billed.
CREATE OR REPLACE FUNCTION sync_scheduled_lease_amounts(p_as_of date) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rent int;
  v_cam int;
BEGIN
  IF p_as_of IS NULL THEN
    RAISE EXCEPTION 'sync_scheduled_lease_amounts: p_as_of is required';
  END IF;

  UPDATE leases l SET base_rent_monthly = cur.base_rent_monthly
    FROM (SELECT DISTINCT ON (r.lease_id) r.lease_id, r.base_rent_monthly
            FROM lease_rent_schedule r
           WHERE r.superseded_at IS NULL AND p_as_of BETWEEN r.effective_start AND r.effective_end
           ORDER BY r.lease_id, r.effective_start DESC) cur
   WHERE l.id = cur.lease_id AND l.status IN ('active', 'pending')
     AND l.base_rent_monthly IS DISTINCT FROM cur.base_rent_monthly;
  GET DIAGNOSTICS v_rent = ROW_COUNT;

  UPDATE leases l SET cam_estimate_monthly = cur.amount
    FROM (SELECT h.lease_id,
                 COALESCE((SELECT c.amount_monthly FROM lease_recurring_charges c
                            WHERE c.lease_id = h.lease_id AND c.type = 'cam_estimate' AND c.superseded_at IS NULL
                              AND p_as_of BETWEEN c.effective_start AND c.effective_end
                            ORDER BY c.effective_start DESC LIMIT 1), 0) AS amount
            FROM (SELECT DISTINCT lease_id FROM lease_recurring_charges
                   WHERE type = 'cam_estimate' AND superseded_at IS NULL) h) cur
   WHERE l.id = cur.lease_id AND l.status IN ('active', 'pending')
     AND l.cam_estimate_monthly IS DISTINCT FROM cur.amount;
  GET DIAGNOSTICS v_cam = ROW_COUNT;

  RETURN jsonb_build_object('rent_updated', v_rent, 'cam_updated', v_cam);
END;
$$;

REVOKE EXECUTE ON FUNCTION sync_scheduled_lease_amounts(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION sync_scheduled_lease_amounts(date) TO service_role;

ALTER TABLE lease_concessions DROP CONSTRAINT IF EXISTS lease_concessions_all_not_fixed;
ALTER TABLE lease_concessions ADD CONSTRAINT lease_concessions_all_not_fixed
  CHECK (NOT (charge_type = 'all' AND kind = 'fixed_amount'));

-- Rollback:
--   DROP FUNCTION IF EXISTS activate_pending_leases(date, boolean, date);
--   DROP FUNCTION IF EXISTS sync_scheduled_lease_amounts(date);
--   ALTER TABLE lease_concessions DROP CONSTRAINT IF EXISTS lease_concessions_all_not_fixed;
