-- 0024: B8 slice 1 — record each ledger account's QuickBooks Desktop account type.
--
-- The chart-of-accounts importer (server/lib/qb-iif-accounts.ts, POST /api/gl/entities/:id/
-- accounts/qb-iif) reads each LLC's QB chart from an IIF export. QB's type (BANK, AR, OCASSET,
-- FIXASSET, OASSET, AP, CCARD, OCLIAB, LTLIAB, EQUITY, INC, EXINC, COGS, EXP, EXEXP) is finer than
-- the ledger's five account_type values: later slices need it (bank import must know which
-- accounts are BANK; balance sheets tie to QB line for line by type).
--
-- Money rule (DB-enforced, direct SQL included): when qb_account_type is set it must agree with
-- account_type, so an account can never be filed as a QB bank account yet post as an expense.
-- NULL stays allowed for accounts created before this slice or by the JSON accounts API.
--
-- ORDERING: purely additive (one nullable column + one CHECK). Requires 0023. Re-runnable:
-- ADD COLUMN IF NOT EXISTS, and DROP CONSTRAINT IF EXISTS + ADD for the check.
-- Privileges: unchanged (column privileges follow 0023's table grants and revokes).

ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS qb_account_type TEXT;

ALTER TABLE gl_accounts DROP CONSTRAINT IF EXISTS gl_accounts_qb_type_check;
ALTER TABLE gl_accounts ADD CONSTRAINT gl_accounts_qb_type_check CHECK (
  qb_account_type IS NULL
  OR (qb_account_type IN ('BANK', 'AR', 'OCASSET', 'FIXASSET', 'OASSET') AND account_type = 'asset')
  OR (qb_account_type IN ('AP', 'CCARD', 'OCLIAB', 'LTLIAB') AND account_type = 'liability')
  OR (qb_account_type = 'EQUITY' AND account_type = 'equity')
  OR (qb_account_type IN ('INC', 'EXINC') AND account_type = 'income')
  OR (qb_account_type IN ('COGS', 'EXP', 'EXEXP') AND account_type = 'expense')
);

COMMENT ON COLUMN gl_accounts.qb_account_type IS 'B8: QuickBooks Desktop ACCNTTYPE (BANK, AR, OCASSET, ...); must agree with account_type (gl_accounts_qb_type_check). NULL = not imported from QB.';
