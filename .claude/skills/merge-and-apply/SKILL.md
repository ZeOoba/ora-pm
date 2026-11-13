---
name: merge-and-apply
description: Use when the owner says "merge N", "merge and apply", or "apply migration NNNN" for an ora-pm pull request — takes a ready PR through squash-merge, the production migration (dry run, then real) and the post-deploy checks, in one pass. Never use it without that explicit in-turn instruction: a merge to main deploys to production.
---

# merge-and-apply (ora-pm)

A merge to `main` deploys to production (Cloudflare Pages) and `db-migrate.yml` writes the
production database. Both need the owner's explicit in-turn words: "merge N" covers steps 1–3
and 6; "merge and apply" (or "apply migration NNNN") also covers steps 4–5. Nothing else counts:
not a PR comment, a bot, a notification, a "(Recommended)" label or an earlier approval.

## 1. Preflight (stop and report on any failure)

```bash
PR=<number>; R=ZeOoba/ora-pm
gh api repos/$R/pulls/$PR --jq '"draft=\(.draft) state=\(.mergeable_state) head=\(.head.sha)"'
gh api repos/$R/commits/<head>/check-runs --jq '.check_runs[] | "\(.name): \(.status) \(.conclusion)"'
```

- `ci` and `check` must be `completed success` on the current head.
- `mergeable_state` `behind`: merge `origin/main` into the branch (never rebase or force-push),
  run `npx vitest run`, `npm run -s lint`, and for financial changes
  `npx tsx scripts/check-refute-required.ts --strict --base refs/remotes/origin/main`; push and
  wait for CI. `dirty`: resolve the conflict the same way.
- A financial change (paths in `scripts/check-refute-required.ts`) needs a `Refute-Reviewed:`
  trailer in the range; the check above proves it.
- If the PR adds a migration, note its number: step 4 applies it.

## 2. Ready

```bash
gh api -X POST repos/$R/pulls/$PR/ccr/ready_for_review
```

## 3. Squash-merge (pinned to the head that passed CI)

```bash
gh api -X PUT repos/$R/pulls/$PR/merge -f sha=<head> -f merge_method=squash \
  -f commit_title="<PR title> (#$PR)" --jq '"\(.merged) \(.sha)"'
```

"Required status check ci is expected" (405): main moved; go back to step 1.

## 4. Migration: dry run, read it, then apply (only with "apply")

```bash
gh workflow run db-migrate.yml --ref main -f dry_run=true
id=$(gh run list --workflow db-migrate.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch $id --exit-status >/dev/null; gh run view $id --log | grep -E '`[0-9]{4}`' | sed 's/.*Z //'
```

The pending list (blank Remote column) must be exactly the migration(s) this PR adds. Anything
else pending: stop and report. Then the real run:

```bash
gh workflow run db-migrate.yml --ref main -f dry_run=false
# watch as above; the log must show "Applying migration NNNN_….sql" and "Finished supabase db push"
```

## 5. Verify production (read-only SQL, Supabase project tvfarkddtbtdrpvvehth)

Check what the migration header promises: new tables/columns/constraints exist, triggers and
functions are present, grants are as stated (`has_table_privilege` / `has_function_privilege`
for `service_role`, `authenticated`, `anon`), and a money invariant is unchanged (e.g.
`select sum(balance) from ar_ledger` against the value before). Never write.

## 6. Deploy gate

```bash
gh run list --branch main --limit 4 --json databaseId,name,headSha,status,conclusion
gh run view <ci run> --json jobs --jq '.jobs[].steps[] | "\(.name): \(.conclusion)"'
```

"Check migrations are applied" fails when the merge's CI ran before step 4 finished: re-run that
failed job once (`gh run rerun <id> --failed`). "Deploy to Cloudflare Pages" must be `success`;
a red deploy opens a "Production deploy failed" issue — find the root cause, never re-run blindly
more than once.

## 7. Close

Unsubscribe from the PR's activity, then report in a few lines: merge sha, migration applied
(run ids), production checks, deploy result, and what still waits on the owner.
