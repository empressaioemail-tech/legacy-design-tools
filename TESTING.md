# Testing

How tests are organized and run across this monorepo, the rationale for each
strategy, and the procedures you'll need when the schema changes or you want
to wire CI.

This is the consolidated reference for both Sprint H01 Part 1 (unit + lib/db
schema integration) and Part 2 (orchestrator/queue, api-server routes,
frontend smoke tests, fixture-drift guard).

## TL;DR — running tests

```bash
# Whole repo (all workspace packages)
pnpm -r run test

# One package
pnpm --filter @workspace/db          run test
pnpm --filter @workspace/codes       run test
pnpm --filter @workspace/codes-sources run test
pnpm --filter @workspace/api-server  run test
pnpm --filter @workspace/design-tools run test

# Watch mode (lib/db only — others mirror the same script name)
pnpm --filter @workspace/db run test:watch

# Refresh the DDL fixture after a drizzle-kit push
pnpm --filter @workspace/db run test:fixture:schema
```

Required env for any test that hits Postgres (lib/db, lib/codes
orchestrator/queue, api-server): `DATABASE_URL` pointing at a database where
the schema has already been pushed. The integration tests do not push schema
themselves — they replay the committed fixture into a per-test schema.

`OPENAI_API_KEY` is optional. When unset, the orchestrator tests verify the
"insert atoms with `embedding=null`" branch via dependency injection rather
than a live API call. Fixture-drift test skips cleanly when `DATABASE_URL`
is unset.

## Where tests live

| Package | Path | Style | Env |
|---|---|---|---|
| `lib/db` | `src/__tests__/integration/*.test.ts` | Real PG schema | node |
| `lib/codes` | `src/*.test.ts` | Mixed: pure units + real PG (orchestrator/queue) | node |
| `lib/codes-sources` | `src/**/*.test.ts` | Pure units, fixture-driven | node |
| `lib/integrations-anthropic-ai` | (no tests; covered via `api-server/chat.test.ts`) | — | — |
| `artifacts/api-server` | `src/__tests__/*.test.ts` | Supertest + real PG, mocked LLM | node |
| `artifacts/design-tools` | `src/components/__tests__/*.test.tsx` | RTL smoke | happy-dom |

## Mock vs real schema — rationale

We mix both deliberately:

- **Pure units** (`lib/codes-sources`, `lib/codes/promptFormatter`): no DB at
  all. Inputs are plain objects; outputs are pure values. Fastest signal,
  highest density per file.
- **Real schema** (`lib/db`, `lib/codes` orchestrator/queue, api-server
  routes): Drizzle's chained-builder query API is painful to mock
  faithfully — every call site needs its own `vi.fn().mockReturnThis()`
  ladder. The result is a brittle test that proves the mock matches itself
  rather than that the SQL is correct. Replaying the real DDL into a
  short-lived schema and running real queries gives us actual SQL coverage,
  including pgvector behavior, FK cascades, and unique-constraint behavior.
- **Mocked LLM** (`api-server/chat.test.ts`): the Anthropic client is
  injected per-instance (see "Per-instance fetcher injection" below) so the
  test substitutes a deterministic SSE stream without monkey-patching
  globals.

## `withTestSchema` — the contract

Located at `lib/db/src/testing/index.ts`. Re-exported as the
`@workspace/db/testing` subpath so any workspace package can import it
without reaching into another package's `src/__tests__`.

```ts
import { withTestSchema, truncateAll } from "@workspace/db/testing";

await withTestSchema(async ({ db, schemaName }) => {
  // `db` is a Drizzle instance whose `search_path` is set to `schemaName`.
  // The schema has been freshly created from the committed DDL fixture and
  // will be dropped (with CASCADE) when the callback returns.
  ...
});
```

Contract:

1. Creates a uniquely named schema like `test_<unix_ms>_<rand>`.
2. Replays
   `lib/db/src/__tests__/__fixtures__/schema.sql.template`, with the
   `@@SCHEMA@@` sentinel rewritten to the new schema name. (See "Schema
   fixture refresh" below for why this template exists.)
3. Hands you a Drizzle instance bound to that schema's `search_path`.
4. On callback completion (success **or** error), `DROP SCHEMA … CASCADE`.
5. Reaper: orphaned `test_*` schemas older than 1 hour are cleaned up on
   the next run. (Tracked in TESTS_DEFERRED.md as "low-likelihood
   hardening item.")

## Truncate-between-tests pattern (api-server)

For test files where every test needs a clean DB but spinning up a fresh
schema per test would dominate runtime, we use one schema for the whole
file and `TRUNCATE … RESTART IDENTITY CASCADE` between tests:

```ts
// artifacts/api-server/src/__tests__/setup.ts
const TRUNCATE_TABLES = [
  "engagements",
  "snapshots",
  "sheets",
  "code_atom_fetch_queue",
  "code_atoms",
  "code_atom_sources",
];

beforeEach(async () => {
  await truncateAll(db, TRUNCATE_TABLES);
});
```

Rationale:

- One schema setup is ~300–400 ms. Per-test it would dominate a 5-test
  file. TRUNCATE is sub-10 ms.
- Explicit table list (no auto-discovery) keeps drift visible: when you add
  a table, the test file fails until you list it, which is the right
  prompt.
- `RESTART IDENTITY` resets serial/identity columns so test assertions on
  generated IDs don't depend on test ordering.
- `CASCADE` makes the order in the list irrelevant.

For `lib/codes` orchestrator + queue we instead use **fresh `withTestSchema`
per test** (~300 ms each). Those test files have ≤8 tests and the full
schema replay protects against subtle leakage across tests that mutate the
queue/atom tables in non-obvious ways. Net cost: ~2.4 s per file. Confirmed
acceptable per the sprint's "pause if >5×" guard — actual overhead landed
well under that threshold.

## Per-instance fetcher injection (Anthropic + OpenAI)

Both `lib/integrations-anthropic-ai` and `lib/codes/embeddings.ts` expose
factory functions that accept an optional `fetcher` (and other per-instance
options) so tests can pin a deterministic transport without mutating
globals or module-scoped singletons:

```ts
// TEST-ONLY: production callers should keep using the default singleton.
import { createAnthropicClient } from "@workspace/integrations-anthropic-ai";

const client = createAnthropicClient({
  fetcher: async (req) => {
    return new Response(deterministicSseBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  },
});
```

The bare `anthropic` and `embeddings` singleton exports are unchanged so
all existing production callers keep working with no edits. Sprint H01
Part 2 leaves those callers alone on purpose — see the final report for
the call sites and the case for migrating them in a future pass.

## Schema fixture refresh

The integration tests don't `drizzle-kit push` — they `psql -f` a captured
DDL template. Two scripts maintain it:

- `lib/db/scripts/refresh-schema-fixture.sh` — re-captures
  `lib/db/src/__tests__/__fixtures__/schema.sql.template` from the live
  database. Run after **any** `drizzle-kit push` that changes columns,
  tables, indexes, FKs, or constraints.
- `lib/db/scripts/check-fixture-drift.sh` — runs the same `pg_dump`
  pipeline and `diff`s against the committed fixture. Used by the
  fixture-drift integration test; if it fails, run the refresh script and
  commit the new fixture.

Both scripts:

1. `pg_dump --schema-only --no-owner --no-acl --no-comments --schema=public`.
2. Strip the `SET …` / `SELECT pg_catalog.set_config(…)` preamble lines.
3. Rewrite `public.` → `@@SCHEMA@@.` so the test harness can target a
   per-test schema name.
4. Restore `public.vector(…)` because pgvector's `vector` type lives in
   the `public` schema and must not be re-qualified.

The fixture is hand-readable on review — keeping it in version control
lets us notice schema changes during code review (you'd see a fixture
diff) instead of only at test-run time.

## Frontend tests (design-tools)

Vitest with happy-dom + React Testing Library. Smoke-test scope only —
end-to-end behavior is covered (today) via manual exercise of the running
app, not Playwright.

- `vitest.config.ts` declares `environment: "happy-dom"` and
  `setupFiles: ["./src/test-setup.ts"]`.
- `src/test-setup.ts` registers `@testing-library/jest-dom/vitest` matchers
  and runs `cleanup()` after each test.
- Tests live in `src/components/__tests__/`.

### `// @vitest-environment jsdom` override

happy-dom is the default because it's ~2× faster on cold start and handles
everything we use today. Some libraries (notably anything that relies on
`<canvas>` 2D rendering, `Range#getBoundingClientRect` on detached nodes,
or specific WebGL polyfills) want jsdom instead. To opt a single file
into jsdom without changing the project default, put this directive at
the **top** of the test file (before any imports):

```ts
// @vitest-environment jsdom

import { render } from "@testing-library/react";
// …
```

Vitest reads the directive from the leading comment block. If you try to
put it after imports it will be silently ignored. You'll also need to add
`jsdom` to the package's devDependencies; we don't ship it by default.

### Mocking workspace packages

Vite's transformer needs to be told to inline workspace TS sources before
`vi.mock` can intercept them; otherwise the mock silently no-ops. The
relevant section of `artifacts/design-tools/vitest.config.ts`:

```ts
test: {
  server: {
    deps: {
      inline: [
        "@workspace/portal-ui",
        "@workspace/api-client-react",
      ],
    },
  },
},
```

The api-server `vitest.config.ts` mirrors this for the workspace packages
its tests mock (notably `@workspace/codes-sources` for the orchestrator
fixture mock). When you add a new test that mocks a workspace package,
add that package to this list **and** declare it as a `devDependency` of
the package whose tests do the mocking — vite needs to be able to resolve
`vi.importActual` against an installed copy.

## CI — Replit pre-merge validation

The pre-merge gate is wired through Replit's **validation** mechanism,
not GitHub Actions. Three named validation commands are registered with
the workspace and run together on every `mark_task_complete` (and can
also be triggered manually). A failure in any one of them blocks the
merge.

| Name        | Command                                                 | What it covers                                            |
|-------------|---------------------------------------------------------|-----------------------------------------------------------|
| `typecheck` | `pnpm run typecheck`                                    | Composite-lib build + every leaf workspace `tsc --noEmit` |
| `test`      | `pnpm run test`                                         | All workspace Vitest suites                               |
| `e2e`       | `pnpm --filter @workspace/design-tools run test:e2e`    | Playwright suite under `artifacts/design-tools/e2e`       |

The `e2e` step is fully self-orchestrating:

- `playwright install chromium` (idempotent — fast no-op when the
  browser cache is warm) is baked into the `test:e2e` script.
- `playwright.config.ts` declares a `webServer` block that boots both
  the API Server (`PORT=8080`) and design-tools (`PORT=20295`,
  `BASE_PATH=/`) when they are not already responding through the
  shared proxy on `localhost:80`. `reuseExistingServer: true` means a
  developer who already has the workflows running pays no extra
  startup cost — it only spawns in CI.
- The Replit Nix sandbox does not put `libgbm.so.1` on the default
  loader path, so `playwright.config.ts` discovers the canonical
  `mesa-libgbm-*` store dir at config load and prepends it to
  `LD_LIBRARY_PATH` before Chromium launches. There is nothing to
  configure on the CI side.
- `DATABASE_URL` is taken from the Replit-managed environment; the
  test seeds and tears down its own engagement row directly through
  `@workspace/db`, so there is no other database setup step.

Wall-clock budget for a full validation run on a fresh sandbox:
typecheck ~30s, test ~60s, e2e ~35s (commands run in parallel, total
~2 min). The longest individual step in `e2e` is the API Server
`pnpm run dev` build; subsequent runs reuse the on-disk esbuild output
when it is already current.

To inspect the registered commands or trigger a manual run, use the
`validation` skill from the agent. They are *not* defined in
`.github/workflows/`; this repository has no GitHub Actions wiring.

## Test counts (Sprint H01 Part 2 baseline)

| Package | Files | Tests |
|---|---:|---:|
| `lib/db` | 2 | 9 |
| `lib/codes` | 7 | 80 |
| `lib/codes-sources` | 4 | 46 |
| `artifacts/api-server` | 5 | 29 |
| `artifacts/design-tools` | 5 | 18 |
| **Total** | **23** | **182** |

Refresh this table when adding a suite.
