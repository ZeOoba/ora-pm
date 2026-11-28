## Summary

<!-- What changed and why. -->

## Deploy order

<!--
Merging to main deploys the code (CI → Cloudflare). Migrations are NOT applied by the merge: they go
through the "DB Migrate (manual)" workflow. Pick ONE option and delete the rest.
-->

- [ ] **No migration.** Merge deploys everything.
- [ ] **Migration first, then merge.** The new code reads something the migration adds (a column, a
      function, a constraint), so code without it fails. Run DB Migrate, then merge straight away.
- [ ] **Merge first, then migration.** The migration depends on code being live, or removes something
      the old code still uses.
- [ ] **Either order.** The migration is additive and nothing in this PR depends on it.

**Window between the two steps:** <!-- What breaks or double-posts if the second step is late? "None" is a valid answer. -->

**Billing timing:** monthly billing runs on the 1st (plus the off-host backup trigger the same day). A PR
that touches billing, autopay, schedules or charges merges well clear of the 1st, never in the days before it.

**After applying:** <!-- The verification to run, e.g. a Part of scripts/verify-rls.sql, or "n/a". -->

## Verification

<!-- Tests run, and for a change to a money path: the Refute-Reviewed / Refute-Skip trailer (check:refute). -->
