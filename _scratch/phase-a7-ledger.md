# Phase A7 — county_facet_coverage performance fields

Workstream: extend `county_facet_coverage` ledger with performance fields
(recipe_version, cert_state, last_rewarm_at, last_refresh_at, staleness_flag,
rewarm_unsafe, cost_usd, onboarded). Additive only.

## GROUND-TRUTH (2026-08-02, verified this session)

- Shared clone `P:\legacy-design-tools` main was BEHIND origin/main (missing
  #373 fleet-memory commit at least). Fresh clone used instead, per dispatch
  instructions anyway (worktree contention).
- `.cursor/rules/fleet-memory.mdc` does NOT exist on origin/main tip in a
  fresh clone at the repo root `.cursor/rules/` path — it lives at
  `P:\tmp\fleet-memory-legacy-design-tools\.cursor\rules\fleet-memory.mdc`
  (a worktree off a branch `chore/install-fleet-memory`). Confirmed via
  `git log --oneline -3` on fresh clone: `fae3a05 chore: install
  fleet-memory Cursor rule (durable build-memory reach) (#373)` IS on main.
  Re-check: need to verify post-clone whether the file exists in fresh
  clone at `.cursor/rules/fleet-memory.mdc` (see below).
- Migrations are plain numbered SQL files in `lib/db/drizzle/*.sql`, latest
  on main before this work = `0063_pe_property_unlocks_and_chat_counts.sql`.
  No drizzle-kit journal meta dir present (project doesn't use drizzle-kit
  generate; applies via `lib/db/scripts/migrate-prod.mjs` tracker-table
  runner in CI, per that file's own doc comment).
- `county_facet_coverage` schema TS: `lib/db/src/schema/countyFacetCoverage.ts`.
  Original migration: `lib/db/drizzle/0060_county_facet_coverage.sql`.
- Hardcoded-list trap locations found via full-repo grep (case-insensitive,
  `county_facet_coverage` / `countyFacetCoverage`), EXCLUDING node_modules
  and other agents' `.claude/worktrees/*`:
  1. `lib/db/src/schema/countyFacetCoverage.ts` — the drizzle table def (edit: add columns).
  2. `lib/db/src/schema/index.ts` — barrel re-export, `export * from "./countyFacetCoverage"` — NO edit needed (already re-exports everything).
  3. `lib/db/drizzle/0060_county_facet_coverage.sql` — original migration, DO NOT touch (historical).
  4. `lib/db/src/__tests__/integration/schema.integration.test.ts` — full-table-list assertion test. `county_facet_coverage` already appears in the alphabetical table-name array; this test only checks table EXISTENCE not column shape, so no edit needed for new nullable columns (verified by reading test body).
  5. `lib/db/src/__tests__/__fixtures__/schema.sql.template` — the CRITICAL fixture: pg_dump-style DDL replayed to build ephemeral test schemas (see `lib/db/src/testing/index.ts` withTestSchema). MUST hand-edit to add the new columns to the `CREATE TABLE @@SCHEMA@@.county_facet_coverage (...)` block, matching what `pg_dump --schema-only` + the repo's sed pipeline would emit (see `lib/db/scripts/refresh-schema-fixture.sh`).
  6. `artifacts/api-server/src/countyCoverageScoreCli.ts` — raw INSERT with explicit column list; does NOT need edit since additive/nullable columns aren't referenced by name in the existing INSERT (verified: existing statement lists only the pre-existing columns).
  7. `artifacts/api-server/src/lib/joinIntegrityGate.ts` — SELECT with explicit column list off this table; does NOT need edit for same reason (additive-only, doesn't touch existing SELECT column list).
  8. `artifacts/api-server/src/lib/joinNormalize.ts` — comment-only references.
- `TRUNCATE_TABLES` in `artifacts/api-server/src/__tests__/setup.ts` does
  NOT include `county_facet_coverage` (confirmed: not in list; it's written
  only by the standalone CLI scorer, not by api-server routes under test).
  No edit needed there.
- `fixture-drift.test.ts` (`lib/db/src/__tests__/integration/fixture-drift.test.ts`)
  is `it.skipIf(!process.env.DATABASE_URL)` — skips without a live DB. Cannot
  exercise this locally without a pushed Postgres; hand-edited the fixture to
  match what the refresh script would produce instead.
- No `COTALITY_ADAPTER_KEYS`-style eligibility list references
  `county_facet_coverage` — grep confirmed zero hits combining that pattern
  with this table.

## GROUND-TRUTH (2026-08-02, verification results)

- `npx tsc -b lib/db` from repo root: EXIT 0, clean, no diagnostics.
- `pnpm run typecheck` (full repo, all 7 typecheck-carrying packages
  including `artifacts/api-server`): all green, no errors.
- Local Postgres: no live instance available (Docker Desktop service present
  but won't start non-interactively; native PG18 install present but
  `initdb` into a scratch data dir was PERMISSION DENIED by the sandbox).
  This IS the documented local-env caveat — proceeded to baseline-compare
  instead of forcing infra.
- Baseline-compare method: fresh clone of origin/main at
  `P:\tmp\baseline-check-a7` (git SHA `fae3a05`, same as this branch's
  parent), `pnpm install --frozen-lockfile`, ran identical suites.
  - `lib/db` vitest (no DATABASE_URL): baseline = 12 failed / 2 passed / 1
    skipped (15 total, 4 files: 2 failed / 1 passed / 1 skipped). Branch =
    15 failed / 2 passed / 1 skipped (18 total; same 4 files, same
    fail/pass/skip file split) — the +3 failed tests are exactly the 3 new
    tests I added, ALL failing for the identical
    "TEST_DATABASE_URL or DATABASE_URL must be set" reason, not a new
    failure mode.
  - `artifacts/api-server` vitest (no DATABASE_URL): baseline = 144 failed
    files / 79 passed / 1 skipped (224 files); 697 passed / 1 skipped (698
    tests); 1 top-level error. Branch = IDENTICAL: 144 failed / 79 passed /
    1 skipped (224); 697 passed / 1 skipped (698); 1 error. Byte-for-byte
    match — zero new breakage introduced by this change.
  - `drizzleMigrationNames.test.ts` (auto-discovers migration files, no DB
    needed): 2/2 PASS on branch — confirms `0064_...sql` has a unique,
    valid `NNNN_` prefix with no collision.
  - `fixture-drift.test.ts`: `it.skipIf(!DATABASE_URL)` — correctly SKIPPED
    both on branch and baseline (cannot exercise without a live DB pushed
    to the new schema; hand-edited `schema.sql.template` to match what
    `refresh-schema-fixture.sh`'s pg_dump+sed pipeline would emit for an
    additive `ALTER TABLE ... ADD COLUMN` + one new named CHECK constraint,
    following pg_dump's physical-column-order + alphabetical-constraint-name
    conventions).
- CI is authoritative per dispatch instructions; this local pass is the
  strongest verification achievable without a live Postgres in this sandbox.

## DONE

Schema TS edit, migration file, fixture template edit, new shape/structure
tests, full verification pass (tsc -b, full typecheck, baseline-diff on
vitest). Ready for PR.
