-- 0033: approve_lease_abstract() — lease abstraction Phase 4 (docs/plans/2026-11-10-lease-abstraction-auto-billing-plan.md §4.4).
--
-- One transaction turns a human-reviewed lease abstract into the PM records:
--   tenant (new, or an existing one whose BLANK party fields are filled) → lease → lease_abstracts (approved)
--   → lease_documents (the stored PDF) → rent schedule, escalation rule, concessions, recurring charges,
--   provisions + their notice dates, derived critical dates → move events → unit status.
-- Optionally it REPLACES the unit's prior tenant: the prior lease is end-dated the day the reviewer gives
-- (never extended), flipped to terminated/expired once that date has passed, and gets a move-out event.
-- The prior tenant's row, charges, payments and ledger are NEVER modified: overwriting the old tenant in
-- place would re-attribute its AR history to the new tenant. Charges already posted on the prior lease
-- for periods after its new end date are COUNTED and returned for human review, never voided here.
--
-- The caller (server/routes/intake.ts POST /lease/approve) has already re-validated every value
-- (lease-abstract.ts revalidateAbstract) and required every billing value to be confirmed. This function
-- owns what only the database can guarantee: atomicity, the per-unit lock, the one-active-lease-per-unit
-- rule, idempotency on (file hash, unit), and that every validation outcome is decided BEFORE the first
-- write (a RETURN after a write would commit a partial approval).
--
-- Outcomes (jsonb 'outcome'): approved · already_approved · unit_not_found · tenant_not_found ·
-- replace_not_found · replace_wrong_unit · replace_not_active · replace_bad_end_date · replace_historic ·
-- unit_occupied.
-- Malformed input RAISEs (the route answers 500; nothing is written).
--
-- Service role only (the 0024 posture). Re-runnable (CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION approve_lease_abstract(p jsonb) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_unit units%ROWTYPE;
  v_old leases%ROWTYPE;
  v_has_replace boolean;
  v_replace_end date;
  v_old_end date;
  v_start date;
  v_end date;
  v_today date;
  v_status text;
  v_tenant_id uuid;
  v_lease_id uuid;
  v_abs_id uuid;
  v_prov_id uuid;
  v_existing uuid;
  v_occupant uuid;
  v_item jsonb;
  v_after_end int := 0;
  v_t jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'approve_lease_abstract: payload must be a json object';
  END IF;
  v_start := (p->'lease'->>'start_date')::date;
  v_end := (p->'lease'->>'end_date')::date;
  v_today := (p->>'today')::date;
  v_t := p->'tenant';
  IF v_start IS NULL OR v_end IS NULL OR v_today IS NULL OR (p->>'unit_id') IS NULL OR v_t IS NULL
     OR (p->'abstract'->>'file_sha256') IS NULL OR (p->'abstract'->>'storage_path') IS NULL THEN
    RAISE EXCEPTION 'approve_lease_abstract: unit_id, today, tenant, lease.start_date, lease.end_date and abstract file are required';
  END IF;
  IF jsonb_array_length(COALESCE(p->'rent_schedule', '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'approve_lease_abstract: a rent schedule is required';
  END IF;

  -- ── (1) Lock the unit: approvals for one unit serialize here. ──────────────
  SELECT * INTO v_unit FROM units WHERE id = (p->>'unit_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'unit_not_found');
  END IF;

  -- ── (2) Idempotency: the same file already approved onto this unit. ────────
  SELECT la.lease_id INTO v_existing
    FROM lease_abstracts la JOIN leases l ON l.id = la.lease_id
   WHERE la.file_sha256 = p->'abstract'->>'file_sha256' AND la.kind = 'lease' AND la.status = 'approved'
     AND l.unit_id = v_unit.id
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'already_approved', 'lease_id', v_existing);
  END IF;

  -- ── (3) Validate everything BEFORE the first write. ───────────────────────
  IF v_t->>'mode' = 'existing' THEN
    v_tenant_id := (v_t->>'id')::uuid;
    PERFORM 1 FROM tenants WHERE id = v_tenant_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('outcome', 'tenant_not_found');
    END IF;
  ELSIF v_t->>'mode' = 'new' THEN
    IF btrim(COALESCE(v_t->>'name', '')) = '' THEN
      RAISE EXCEPTION 'approve_lease_abstract: a new tenant needs a name';
    END IF;
  ELSE
    RAISE EXCEPTION 'approve_lease_abstract: tenant.mode must be new or existing';
  END IF;

  v_has_replace := jsonb_typeof(p->'replace') = 'object';
  IF v_has_replace THEN
    v_replace_end := (p->'replace'->>'end_date')::date;
    SELECT * INTO v_old FROM leases WHERE id = (p->'replace'->>'lease_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('outcome', 'replace_not_found');
    END IF;
    IF v_old.unit_id <> v_unit.id THEN
      RETURN jsonb_build_object('outcome', 'replace_wrong_unit');
    END IF;
    IF v_old.status NOT IN ('active', 'pending') THEN
      RETURN jsonb_build_object('outcome', 'replace_not_active', 'status', v_old.status);
    END IF;
    -- The prior lease must end on or after its own start and strictly before the new lease starts.
    IF v_replace_end IS NULL OR v_replace_end < v_old.start_date OR v_replace_end >= v_start THEN
      RETURN jsonb_build_object('outcome', 'replace_bad_end_date', 'prior_start', v_old.start_date, 'new_start', v_start);
    END IF;
    -- Never EXTEND a prior lease (that would create billing); only shorten it.
    v_old_end := LEAST(v_old.end_date, v_replace_end);
  END IF;

  -- A lease already over (a historic upload) is recorded expired and never takes the unit's active slot.
  v_status := CASE WHEN v_start > v_today THEN 'pending' WHEN v_end < v_today THEN 'expired' ELSE 'active' END;
  -- A historic (already ended) upload never closes out the current tenant (REFUTE round 2 D8).
  IF v_has_replace AND v_status = 'expired' THEN
    RETURN jsonb_build_object('outcome', 'replace_historic');
  END IF;
  -- Any OTHER active or pending lease whose term overlaps this one blocks, whatever this lease's status
  -- (REFUTE D1: two pending leases on one unit both committed). The lease being replaced is excluded:
  -- it is end-dated before v_start below.
  SELECT id INTO v_occupant FROM leases
   WHERE unit_id = v_unit.id AND status IN ('active', 'pending') AND (NOT v_has_replace OR id <> v_old.id)
     AND start_date <= v_end AND end_date >= v_start
   LIMIT 1;
  IF v_occupant IS NULL AND v_status = 'active' THEN
    -- leases_active_unit_unique: one active lease per unit even when the terms do not overlap.
    SELECT id INTO v_occupant FROM leases
     WHERE unit_id = v_unit.id AND status = 'active' AND (NOT v_has_replace OR id <> v_old.id)
     LIMIT 1;
  END IF;
  IF v_occupant IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'unit_occupied', 'lease_id', v_occupant);
  END IF;

  -- ── (4) Writes. ────────────────────────────────────────────────────────────
  IF v_has_replace THEN
    UPDATE leases
       SET end_date = v_old_end,
           status = CASE WHEN v_old_end < v_today
                         THEN CASE WHEN v_old_end < v_old.end_date THEN 'terminated' ELSE 'expired' END
                         ELSE status END
     WHERE id = v_old.id;
    INSERT INTO lease_move_events (lease_id, event_type, effective_date, from_unit_id, notes)
    VALUES (v_old.id, 'move_out', v_old_end, v_unit.id, 'Replaced by a new tenant via lease upload');
    SELECT count(*) INTO v_after_end FROM charges
     WHERE lease_id = v_old.id AND voided_at IS NULL AND period_end > v_old_end; -- includes a straddling final month (REFUTE D5)
  END IF;

  IF v_t->>'mode' = 'new' THEN
    INSERT INTO tenants (name, contact_name, contact_email, contact_phone, notes,
                         legal_name, dba, entity_type, state_of_formation, notice_address, guarantor_name)
    VALUES (btrim(v_t->>'name'), v_t->>'contact_name', v_t->>'contact_email', v_t->>'contact_phone', v_t->>'notes',
            v_t->>'legal_name', v_t->>'dba', v_t->>'entity_type', v_t->>'state_of_formation',
            v_t->>'notice_address', v_t->>'guarantor_name')
    RETURNING id INTO v_tenant_id;
  ELSE
    -- An existing tenant (with AR history) only has BLANK party fields filled from the lease; a stated
    -- value is never overwritten (REFUTE D6: a wrong pick or renewal re-upload rewrote its notice address).
    UPDATE tenants SET
      legal_name = COALESCE(legal_name, v_t->>'legal_name'),
      dba = COALESCE(dba, v_t->>'dba'),
      entity_type = COALESCE(entity_type, v_t->>'entity_type'),
      state_of_formation = COALESCE(state_of_formation, v_t->>'state_of_formation'),
      notice_address = COALESCE(notice_address, v_t->>'notice_address'),
      guarantor_name = COALESCE(guarantor_name, v_t->>'guarantor_name')
    WHERE id = v_tenant_id;
  END IF;

  INSERT INTO leases (tenant_id, unit_id, start_date, end_date, status, rent_type, base_rent_monthly,
                      cam_estimate_monthly, security_deposit, expense_stop_amount, proportionate_share_pct,
                      base_year, notes)
  VALUES (v_tenant_id, v_unit.id, v_start, v_end, v_status,
          COALESCE(p->'lease'->>'rent_type', 'nnn'),
          (p->'lease'->>'base_rent_monthly')::numeric,
          COALESCE((p->'lease'->>'cam_estimate_monthly')::numeric, 0),
          COALESCE((p->'lease'->>'security_deposit')::numeric, 0),
          (p->'lease'->>'expense_stop_amount')::numeric,
          (p->'lease'->>'proportionate_share_pct')::numeric,
          (p->'lease'->>'base_year')::int,
          p->'lease'->>'notes')
  RETURNING id INTO v_lease_id;

  INSERT INTO lease_abstracts (lease_id, kind, status, storage_path, file_sha256, model, raw_fields, warnings,
                               approved_by, approved_at)
  VALUES (v_lease_id, 'lease', 'approved', p->'abstract'->>'storage_path', p->'abstract'->>'file_sha256',
          COALESCE(p->'abstract'->>'model', 'unknown'), COALESCE(p->'abstract'->'raw_fields', '{}'::jsonb),
          COALESCE(p->'abstract'->'warnings', '[]'::jsonb), p->'abstract'->>'approved_by', now())
  RETURNING id INTO v_abs_id;

  INSERT INTO lease_documents (lease_id, type, name, storage_path, uploaded_by)
  VALUES (v_lease_id, 'lease', COALESCE(p->'document'->>'name', 'Lease.pdf'), p->'abstract'->>'storage_path',
          p->'abstract'->>'approved_by');

  FOR v_item IN SELECT * FROM jsonb_array_elements(p->'rent_schedule') LOOP
    INSERT INTO lease_rent_schedule (lease_id, effective_start, effective_end, base_rent_monthly, rent_psf_annual, source, abstract_id, note)
    VALUES (v_lease_id, (v_item->>'effective_start')::date, (v_item->>'effective_end')::date,
            (v_item->>'base_rent_monthly')::numeric, (v_item->>'rent_psf_annual')::numeric, 'abstract', v_abs_id, v_item->>'note');
  END LOOP;

  IF jsonb_typeof(p->'escalation') = 'object' THEN
    v_item := p->'escalation';
    INSERT INTO lease_escalation_rules (lease_id, kind, value, cadence_months, first_adjustment_date, applies_until,
                                        cpi_floor, cpi_cap, source, abstract_id, clause_ref)
    VALUES (v_lease_id, v_item->>'kind', (v_item->>'value')::numeric, (v_item->>'cadence_months')::int,
            (v_item->>'first_adjustment_date')::date, (v_item->>'applies_until')::date,
            (v_item->>'cpi_floor')::numeric, (v_item->>'cpi_cap')::numeric, 'abstract', v_abs_id, v_item->>'clause_ref');
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p->'concessions', '[]'::jsonb)) LOOP
    INSERT INTO lease_concessions (lease_id, charge_type, period_start, period_end, kind, value, reason, clause_ref, source, abstract_id)
    VALUES (v_lease_id, v_item->>'charge_type', (v_item->>'period_start')::date, (v_item->>'period_end')::date,
            v_item->>'kind', (v_item->>'value')::numeric, v_item->>'reason', v_item->>'clause_ref', 'abstract', v_abs_id);
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p->'recurring_charges', '[]'::jsonb)) LOOP
    INSERT INTO lease_recurring_charges (lease_id, type, description, amount_monthly, effective_start, effective_end, clause_ref, source, abstract_id)
    VALUES (v_lease_id, v_item->>'type', v_item->>'description', (v_item->>'amount_monthly')::numeric,
            (v_item->>'effective_start')::date, (v_item->>'effective_end')::date, v_item->>'clause_ref', 'abstract', v_abs_id);
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p->'provisions', '[]'::jsonb)) LOOP
    INSERT INTO lease_provisions (lease_id, category, summary, verbatim_excerpt, page_ref, notice_deadline,
                                  exercise_window_start, exercise_window_end, source, abstract_id)
    VALUES (v_lease_id, v_item->>'category', v_item->>'summary', v_item->>'verbatim_excerpt', (v_item->>'page_ref')::int,
            (v_item->>'notice_deadline')::date, (v_item->>'exercise_window_start')::date, (v_item->>'exercise_window_end')::date,
            'abstract', v_abs_id)
    RETURNING id INTO v_prov_id;
    IF (v_item->>'notice_deadline') IS NOT NULL THEN
      INSERT INTO lease_critical_dates (lease_id, provision_id, critical_date, kind, description, source)
      VALUES (v_lease_id, v_prov_id, (v_item->>'notice_deadline')::date,
              CASE v_item->>'category'
                WHEN 'termination' THEN 'termination_notice'
                WHEN 'renewal_option' THEN 'option_notice'
                WHEN 'expansion' THEN 'option_notice'
                WHEN 'rofr_rofo' THEN 'option_notice'
                ELSE 'other' END,
              'Notice deadline: ' || (v_item->>'summary'), 'abstract');
    END IF;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p->'critical_dates', '[]'::jsonb)) LOOP
    INSERT INTO lease_critical_dates (lease_id, critical_date, kind, description, source)
    VALUES (v_lease_id, (v_item->>'critical_date')::date, v_item->>'kind', v_item->>'description', 'derived');
  END LOOP;

  INSERT INTO lease_move_events (lease_id, event_type, effective_date, to_unit_id, notes)
  VALUES (v_lease_id, 'move_in', v_start, v_unit.id, 'Lease approved from uploaded abstract');

  IF v_status = 'active' THEN
    UPDATE units SET status = 'occupied' WHERE id = v_unit.id;
  END IF;

  RETURN jsonb_build_object(
    'outcome', 'approved', 'lease_id', v_lease_id, 'tenant_id', v_tenant_id, 'abstract_id', v_abs_id,
    'status', v_status, 'prior_lease_id', CASE WHEN v_has_replace THEN v_old.id END,
    'prior_lease_end_date', v_old_end, 'prior_charges_after_end', v_after_end
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION approve_lease_abstract(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION approve_lease_abstract(jsonb) TO service_role;

-- Rollback: DROP FUNCTION IF EXISTS approve_lease_abstract(jsonb);
