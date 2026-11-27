-- 0035: lease_recurring_charges.charge_code — a stable identity for each recurring 'other' charge.
--
-- Monthly billing (server/lib/rent-schedule.ts) keys an 'other' line's idempotency key
-- (auto:<lease>:<period>:other:<suffix>) on a suffix. Until now that suffix was a slug of the DESCRIPTION
-- (lowercased, punctuation collapsed, cut at 40 characters), which failed two ways:
--   - an amendment that rewords the description changed the key, so a month already billed could bill again;
--   - two distinct charges whose descriptions differ only by case or punctuation, or share their first 40
--     characters, got the same key, and the lease failed closed (recurring_overlap) and did not bill.
-- The row id is not usable either: it changes when a row is superseded and re-entered (plan §5a item 4).
--
-- From here the suffix is charge_code:
--   - EXISTING 'other' rows are backfilled with exactly the legacy slug (legacy_other_charge_key below, the SQL
--     twin of otherKey() in rent-schedule.ts, parity pinned by tests/db/recurring-charge-code-0035.test.ts).
--     Every month already billed therefore keeps its key, and the first run after deploy cannot double-bill.
--   - A NEW 'other' row with no code (trigger below) inherits the code of the most recently superseded 'other'
--     row on the same lease with the same legacy slug, so a row superseded and re-entered under the same
--     description keeps its key (plan §5a item 4). Otherwise it gets its own id: unique, so no two charges collide.
--   - A row that REPLACES a superseded one under a REWORDED description must copy the superseded row's
--     charge_code explicitly; nothing can infer that link. A writer supersedes the old row FIRST, then inserts
--     the replacement (inheritance reads only superseded rows). No writer supersedes rows yet (0033 only inserts).
--
-- Deploy order: apply 0035 (DB Migrate) FIRST, then merge the code at once, with no abstract approval and no
-- billing run in between, and never in the days before the 1st. Code before the column exists fails closed
-- (cron's schedule read errors, so nothing posts and autopay defers). A row inserted after 0035 but billed by the
-- OLD code is keyed on its slug, while the new code keys it on its id, so a re-run of that period would post it
-- again.
-- Non-'other' rows key on their type and carry no code.
--
-- Safe on existing data: the backfill touches only 'other' rows with no code; the new exclusion guard is added
-- only after checking no two active same-code rows overlap, and otherwise the migration raises (nothing
-- changes) — such a lease cannot bill today anyway (recurring_overlap). Re-runnable.

-- The legacy description slug, frozen. JavaScript's String.prototype.toLowerCase (locale-independent) maps
-- exactly two non-ASCII code points to ASCII letters: U+0130 'İ' → 'i' + U+0307, and U+212A KELVIN SIGN → 'k'.
-- Every other non-ASCII character becomes a separator, so ASCII-only case folding here matches it exactly.
-- Bracket classes are spelled out (no a-z ranges) so the result cannot depend on the database collation.
CREATE OR REPLACE FUNCTION legacy_other_charge_key(p_description text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(NULLIF(rtrim(left(btrim(regexp_replace(
           translate(replace(p_description, chr(304), 'i' || chr(775)),
                     'ABCDEFGHIJKLMNOPQRSTUVWXYZ' || chr(8490),
                     'abcdefghijklmnopqrstuvwxyzk'),
           '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-'), 40), '-'), ''), 'unnamed')
$$;
REVOKE EXECUTE ON FUNCTION legacy_other_charge_key(text) FROM PUBLIC, anon, authenticated;
-- The default-code trigger calls it while the writer's INSERT runs (approve_lease_abstract is SECURITY INVOKER,
-- executed by service_role), so the service role must be able to execute it.
GRANT EXECUTE ON FUNCTION legacy_other_charge_key(text) TO service_role;

ALTER TABLE lease_recurring_charges ADD COLUMN IF NOT EXISTS charge_code TEXT;
COMMENT ON COLUMN lease_recurring_charges.charge_code IS
  'Stable identity of an ''other'' charge: the idempotency-key suffix monthly billing uses. A row that replaces a superseded row under a reworded description must copy its charge_code (same description: inherited by trigger). NULL for non-''other'' types (they key on type).';

UPDATE lease_recurring_charges
   SET charge_code = legacy_other_charge_key(description)
 WHERE type = 'other' AND charge_code IS NULL;

CREATE OR REPLACE FUNCTION lease_recurring_charges_default_code() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.type = 'other' AND NEW.charge_code IS NULL THEN
      SELECT p.charge_code INTO NEW.charge_code
        FROM lease_recurring_charges p
       WHERE p.lease_id = NEW.lease_id AND p.type = 'other' AND p.superseded_at IS NOT NULL
         AND p.charge_code IS NOT NULL
         AND legacy_other_charge_key(p.description) = legacy_other_charge_key(NEW.description)
       ORDER BY p.superseded_at DESC, p.id
       LIMIT 1;
      NEW.charge_code := COALESCE(NEW.charge_code, NEW.id::text);
    END IF;
  -- A code, once set, never changes: months already billed carry it in their idempotency keys, so a new
  -- code would bill them again. (Setting it to NULL on an 'other' row is refused by the CHECK below.)
  ELSIF OLD.charge_code IS NOT NULL AND NEW.charge_code IS DISTINCT FROM OLD.charge_code THEN
    RAISE EXCEPTION 'lease_recurring_charges.charge_code is immutable once set (row %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION lease_recurring_charges_default_code() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS lease_recurring_charges_default_code ON lease_recurring_charges;
CREATE TRIGGER lease_recurring_charges_default_code
  BEFORE INSERT OR UPDATE OF charge_code ON lease_recurring_charges
  FOR EACH ROW EXECUTE FUNCTION lease_recurring_charges_default_code();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lease_recurring_charges_other_code_present') THEN
    ALTER TABLE lease_recurring_charges ADD CONSTRAINT lease_recurring_charges_other_code_present
      CHECK (type <> 'other' OR charge_code IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lease_recurring_charges_code_format') THEN
    ALTER TABLE lease_recurring_charges ADD CONSTRAINT lease_recurring_charges_code_format
      CHECK (charge_code IS NULL OR charge_code ~ '^[abcdefghijklmnopqrstuvwxyz0123456789-]{1,64}$');
  END IF;
  -- Two active rows of one charge over the same day are a double bill; the engine already fails closed on
  -- them (recurring_overlap), this stops them being written.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lease_recurring_charges_other_code_no_overlap') THEN
    IF EXISTS (
      SELECT 1 FROM lease_recurring_charges a JOIN lease_recurring_charges b
        ON a.lease_id = b.lease_id AND a.id < b.id AND a.charge_code = b.charge_code
       WHERE a.type = 'other' AND b.type = 'other' AND a.superseded_at IS NULL AND b.superseded_at IS NULL
         AND daterange(a.effective_start, a.effective_end, '[]') && daterange(b.effective_start, b.effective_end, '[]')
    ) THEN
      RAISE EXCEPTION '0035: active ''other'' recurring charges on one lease share a legacy key over the same days; supersede or re-date one of each pair, then re-run (no change was made)';
    END IF;
    ALTER TABLE lease_recurring_charges ADD CONSTRAINT lease_recurring_charges_other_code_no_overlap
      EXCLUDE USING gist (lease_id WITH =, charge_code WITH =, daterange(effective_start, effective_end, '[]') WITH &&)
      WHERE (type = 'other' AND superseded_at IS NULL);
  END IF;
END
$$;

-- Rollback (manual; only together with reverting the rent-schedule.ts keying, or 'other' rows stop billing):
-- ALTER TABLE lease_recurring_charges DROP CONSTRAINT IF EXISTS lease_recurring_charges_other_code_no_overlap,
--   DROP CONSTRAINT IF EXISTS lease_recurring_charges_code_format, DROP CONSTRAINT IF EXISTS lease_recurring_charges_other_code_present;
-- DROP TRIGGER IF EXISTS lease_recurring_charges_default_code ON lease_recurring_charges;
-- DROP FUNCTION IF EXISTS lease_recurring_charges_default_code();
-- ALTER TABLE lease_recurring_charges DROP COLUMN IF EXISTS charge_code;
-- DROP FUNCTION IF EXISTS legacy_other_charge_key(text);
