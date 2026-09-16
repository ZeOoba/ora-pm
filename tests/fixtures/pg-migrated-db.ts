// Compatibility re-export. PR #38 (OI-082) and PR #42 (OI-278) each extracted the
// live-SQL migration loader out of tests/db/appsec-migration-0011.test.ts in
// parallel. tests/fixtures/migrations.ts is the single implementation: it is a
// strict superset of the former copy here (adds $$-aware splitting, the DO-block
// skip and the btrim() stub that 0014/0016 need; identical otherwise), so every
// suite applies migrations with the same loader and cannot drift.
export * from './migrations'
