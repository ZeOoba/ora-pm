-- REFUTE pass 4: attacks that need things outside Supabase's PG16 defaults, or a non-default
-- isolation level. Runs as its OWN psql session (scripts/verify-gl-sql.sh) so no trigger plan is
-- cached when the shadow function is created. Depends on fixtures from gl_core.test.sql
-- (entity e…01 with September 2026 locked; accounts a…01/a…02 with posted lines).

-- Worst case: a project whose public schema still grants CREATE (pre-PG15 clusters, or an
-- explicit grant). The ledger must hold even then.
GRANT CREATE ON SCHEMA public TO service_role;
SET ROLE service_role;

-- REFUTE-5 F1: a public ->>(jsonb, jsonb) is an exact match for `jsonb ->> 'literal'` (the literal
-- is untyped) and would capture every key lookup in gl_post_entry. Runs first: no plan cached yet.
CREATE FUNCTION public.r5_dos(jsonb, jsonb) RETURNS text LANGUAGE sql AS $$ SELECT 'x' $$;
CREATE OPERATOR public.->> (LEFTARG = jsonb, RIGHTARG = jsonb, FUNCTION = public.r5_dos);
DO $$ BEGIN
  PERFORM gl_post_entry('e0000000-0000-4000-8000-000000000001', '2026-11-09', 'R5 F1 with ->> shadow', 'manual', 'tester',
    '[{"account_id":"a0000000-0000-4000-8000-000000000001","debit_cents":321,"memo":" m "},{"account_id":"a0000000-0000-4000-8000-000000000002","credit_cents":321}]');
  IF NOT EXISTS (SELECT 1 FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.entry_id
                  WHERE e.memo = 'R5 F1 with ->> shadow' AND l.debit_cents = 321 AND l.memo = 'm') THEN
    RAISE EXCEPTION 'R5 F1: posting with a ->> shadow did not record the right line';
  END IF;
  RAISE NOTICE 'ok: R5 F1 a public ->>(jsonb, jsonb) cannot capture gl_post_entry''s key lookups';
END $$;
DROP OPERATOR public.->> (jsonb, jsonb);
DROP FUNCTION public.r5_dos(jsonb, jsonb);

-- F1: a public date_trunc(text, date) is an EXACT match for date_trunc('month', <date>) and would
-- beat pg_catalog's timestamp/timestamptz overloads. This one claims every date is in 2099.
CREATE FUNCTION public.date_trunc(text, date) RETURNS timestamp LANGUAGE sql AS $$ SELECT timestamp '2099-12-01' $$;

DO $$ BEGIN
  BEGIN
    PERFORM gl_post_entry('e0000000-0000-4000-8000-000000000001', '2026-09-15', 'F1 into locked Sept', 'manual', 'tester',
      '[{"account_id":"a0000000-0000-4000-8000-000000000001","debit_cents":100},{"account_id":"a0000000-0000-4000-8000-000000000002","credit_cents":100}]');
    RAISE EXCEPTION 'F1: a shadowed date_trunc let a posting into a locked month';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%period 2026-09-01 is locked%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM gl_lock_period('e0000000-0000-4000-8000-000000000001', '2027-03-01', 'attacker');
    RAISE EXCEPTION 'F1: a shadowed date_trunc let a future month be locked';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%has ended%' THEN RAISE; END IF;
  END;
  -- normal posting still works with the shadow present
  PERFORM gl_post_entry('e0000000-0000-4000-8000-000000000001', '2026-11-09', 'F1 normal', 'manual', 'tester',
    '[{"account_id":"a0000000-0000-4000-8000-000000000001","debit_cents":100},{"account_id":"a0000000-0000-4000-8000-000000000002","credit_cents":100}]');
  IF NOT EXISTS (SELECT 1 FROM gl_periods WHERE period_start = '2026-11-01' AND entity_id = 'e0000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'F1: posting used the shadowed month';
  END IF;
  RAISE NOTICE 'ok: F1 a public date_trunc shadow cannot move a posting or a lock to another month';
END $$;

DROP FUNCTION public.date_trunc(text, date);

-- F2: reclassification is refused outside READ COMMITTED, where the guard's EXISTS could read a
-- snapshot taken before a concurrent posting committed.
BEGIN ISOLATION LEVEL REPEATABLE READ;
DO $$ BEGIN
  BEGIN
    UPDATE gl_accounts SET account_type = 'asset' WHERE id = 'a0000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'F2: account type changed under REPEATABLE READ';
  EXCEPTION WHEN restrict_violation THEN
    IF SQLERRM NOT LIKE '%READ COMMITTED%' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE gl_entities SET accounting_basis = 'cash' WHERE id = 'e0000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'F2: accounting basis changed under REPEATABLE READ';
  EXCEPTION WHEN restrict_violation THEN
    IF SQLERRM NOT LIKE '%READ COMMITTED%' THEN RAISE; END IF;
  END;
  -- harmless edits (rename) stay allowed at any isolation level
  UPDATE gl_accounts SET qb_name = qb_name WHERE id = 'a0000000-0000-4000-8000-000000000002';
  RAISE NOTICE 'ok: F2 account type / entity basis changes refused outside READ COMMITTED';
END $$;
COMMIT;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM service_role;
