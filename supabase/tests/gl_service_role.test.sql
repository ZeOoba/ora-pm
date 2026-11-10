-- REFUTE pass 3: attacks a direct service_role caller could make with Supabase's default grants.
-- Runs as its OWN psql session after gl_core.test.sql (scripts/verify-gl-sql.sh), and F1 runs
-- FIRST: plpgsql caches each trigger's table lookups per session, so a shadow created after the
-- guards have already run once in a session would not exercise the attack.
-- Depends on fixtures created by gl_core.test.sql (entity e…01, accounts a…01/a…02, period 2026-07).
SET ROLE service_role;

-- F1: a temp table named like a ledger table must not stand in for it in the guards' lookups.
DO $$
DECLARE v UUID := 'f1000000-0000-4000-8000-000000000001';
BEGIN
  BEGIN
    CREATE TEMP TABLE gl_journal_lines (entry_id uuid, debit_cents bigint, credit_cents bigint, line_no int, account_id uuid);
    INSERT INTO pg_temp.gl_journal_lines VALUES (v, 5, 0, 1, NULL), (v, 0, 5, 2, NULL);
    INSERT INTO public.gl_journal_entries (id, entity_id, entry_date, memo, source, posted_by)
      VALUES (v, 'e0000000-0000-4000-8000-000000000001', '2026-11-05', 'F1 unbalanced', 'manual', 'x');
    INSERT INTO public.gl_journal_lines (entry_id, entity_id, account_id, line_no, debit_cents)
      VALUES (v, 'e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 1, 100000000);
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'F1: a temp-table shadow let an unbalanced entry through';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%is not balanced (lines=1, debits=100000000%' THEN RAISE; END IF;
  END;
  -- and structurally: every gl_ function pins pg_temp LAST
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'gl\_%'
       AND NOT (coalesce(p.proconfig, '{}') @> ARRAY['search_path=public, pg_temp'])) THEN
    RAISE EXCEPTION 'F1: a gl_ function lacks search_path = public, pg_temp';
  END IF;
  RAISE NOTICE 'ok: F1 temp tables cannot shadow the ledger tables; every gl_ function pins pg_temp last';
END $$;

-- the API's own role can still post normally
DO $$ BEGIN
  PERFORM gl_post_entry('e0000000-0000-4000-8000-000000000001', '2026-11-09', 'as service_role', 'manual', 'tester',
    '[{"account_id":"a0000000-0000-4000-8000-000000000001","debit_cents":250},{"account_id":"a0000000-0000-4000-8000-000000000002","credit_cents":250}]');
  RAISE NOTICE 'ok: service_role posts through gl_post_entry';
END $$;

-- F2: service_role cannot attach triggers to (or truncate) ledger tables; the API roles have no access.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['gl_entities', 'gl_accounts', 'gl_periods', 'gl_journal_entries', 'gl_journal_lines'] LOOP
    BEGIN
      EXECUTE format('CREATE TRIGGER zz_attacker BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION gl_reject_change()', t);
      RAISE EXCEPTION 'F2: service_role could create a trigger on %', t;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    IF has_table_privilege('service_role', 'public.' || t, 'TRUNCATE') OR has_table_privilege('service_role', 'public.' || t, 'REFERENCES')
       OR has_table_privilege('anon', 'public.' || t, 'SELECT') OR has_table_privilege('authenticated', 'public.' || t, 'INSERT') THEN
      RAISE EXCEPTION 'F2: unexpected privilege remains on %', t;
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['gl_journal_entries', 'gl_journal_lines'] LOOP
    IF has_table_privilege('service_role', 'public.' || t, 'UPDATE') OR has_table_privilege('service_role', 'public.' || t, 'DELETE') THEN
      RAISE EXCEPTION 'R5 N1: service_role keeps UPDATE/DELETE on %', t;
    END IF;
    BEGIN
      EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', t);
      RAISE EXCEPTION 'R5 N1: service_role could LOCK TABLE %', t;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
  RAISE NOTICE 'ok: F2 no TRIGGER/TRUNCATE/REFERENCES for service_role; no table access for anon/authenticated; journal is insert-only';
END $$;

-- F3: lock audit fields cannot be forged: open rows carry none, and the DB stamps locked_at.
DO $$
DECLARE v_at TIMESTAMPTZ;
BEGIN
  BEGIN
    UPDATE gl_periods SET locked_at = '1999-01-01' WHERE entity_id = 'e0000000-0000-4000-8000-000000000001' AND period_start = '2026-07-01';
    RAISE EXCEPTION 'F3: an open period took a locked_at';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%gl_periods_lock_pair%' THEN RAISE; END IF;
  END;
  UPDATE gl_periods SET status = 'locked', locked_at = '1999-01-01', locked_by = 'approver'
   WHERE entity_id = 'e0000000-0000-4000-8000-000000000001' AND period_start = '2026-07-01';
  SELECT locked_at INTO v_at FROM gl_periods WHERE entity_id = 'e0000000-0000-4000-8000-000000000001' AND period_start = '2026-07-01';
  IF v_at < now() - interval '1 minute' THEN
    RAISE EXCEPTION 'F3: locked_at was taken from the caller (%)', v_at;
  END IF;
  RAISE NOTICE 'ok: F3 open periods carry no lock fields; locked_at is stamped by the database';
END $$;

RESET ROLE;

