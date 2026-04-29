# Tests deferred to Sprint H01 Part 2

The following test suites were intentionally not written in Part 1. Each entry
describes what to test, why it was deferred, and the rough shape of the test.
Fold these into the Part 2 prompt.

## lib/codes — orchestrator and queue

### `lib/codes/src/orchestrator.test.ts`
Covers `orchestrator.ts` (currently 0% covered, 483 lines).

Why deferred: the orchestrator wires together every other piece (`getSource`,
`embedTexts`, `contentHash`, `JURISDICTIONS`, the queue) and then drives
Drizzle inserts. Either the test heavily mocks `@workspace/db` (a lot of
chained-builder ceremony per call site) or it runs against a real schema
(needs the `withTestSchema` helper from `lib/db`, which is in another
package). Both paths are doable — we chose to defer so Part 1 could focus on
units with high signal-to-noise.

Recommended approach for Part 2: real schema. Promote `withTestSchema` to a
shared `lib/db-testing` package (or re-export from `@workspace/db/testing`),
then have orchestrator tests run end-to-end against the test schema with
the source adapter stubbed via `getSource = vi.fn()`.

Cases to cover:
- happy path: TOC entry → queue row → fetch → atom insert + content_hash
- re-run on unchanged source: dedupe via content_hash, no duplicate atoms
- adapter throws on one section: queue row marked failed, others continue
- exponential backoff: failed row's `next_attempt_at` advances per `attempts`
- daily cap from `MunicodeDailyCapExceeded`: stops the pass cleanly, doesn't
  mark rows as permanently failed
- embedding failure (`OPENAI_API_KEY` missing): atoms still inserted with
  `embedding=null`, `embeddedAt=null`

### `lib/codes/src/queue.test.ts`
Covers `queue.ts` (currently 0% covered, 63 lines).

Why deferred: same reason — easier with a real schema than a heavily-mocked
Drizzle.

Cases to cover:
- `leaseNextBatch`: marks rows `in_progress`, sets `lease_expires_at`,
  returns the leased rows
- lease expiry: rows whose `lease_expires_at < now()` get re-leased
- per-jurisdiction scope: `leaseNextBatch({ jurisdictionKey: 'x' })` only
  pulls `x` rows, even if other jurisdictions have older pending rows
- `markCompleted` / `markFailed`: status transitions and `attempts` increment
- batch-size cap

## lib/codes — prompt formatting

### `lib/codes/src/promptFormatter.test.ts` (only if extracted)
Currently the only "prompt formatting" code lives inline in api-server route
handlers. There is no extracted pure function in `lib/codes` to test. If
Part 2 extracts one (recommended; would also DRY the chat assembly), add unit
tests at extraction time covering:
- citation insertion order matches retrieval order
- atoms truncated to a max char budget (token-budget aware)
- jurisdiction-locked: cross-jurisdiction atoms are filtered out
- atoms missing `sectionNumber` still render with a synthetic ref

## api-server — route integration

Out of scope for Part 1 by spec. Part 2 should add:
- `POST /api/code-atoms/refresh` — kicks orchestrator, returns counts
- `GET /api/code-atoms/jurisdictions` — listing, snapshot stats
- `POST /api/chat` — retrieval + LLM with mocked OpenAI; assert citations

These will need the same `withTestSchema` helper plus a Supertest harness
around the Express app.

## Frontend

Out of scope for Part 1. Part 2 candidates:
- Code Library tab: lists jurisdictions, search, atom detail drawer
- Chat panel: streams responses, renders citations, jurisdiction selector

## CI

Out of scope for Part 1. Part 2 should add a GitHub Actions workflow that:
- spins up Postgres 16 + pgvector via service container
- runs `pnpm install --frozen-lockfile`
- runs `pnpm typecheck && pnpm test`
- caches pnpm + vitest transform cache
- enforces a coverage floor (suggest 70% lines on `lib/codes` and
  `lib/codes-sources` excluding `index.ts` glue)

---

# Tests / hardening deferred to Sprint H01 Part 3 (or later)

## `withTestSchema` reaper hardening

Current behavior: on each call to `withTestSchema`, a one-shot reaper drops
any `test_*` schemas older than 1 hour before creating the new one. This is
best-effort — if the process is killed mid-test (SIGKILL, container OOM,
laptop lid close mid-debug), the in-progress schema leaks until the next
test run.

Why deferred: real-world likelihood is low for the solo-dev workflow we
have today. The failure mode is loss of a single in-progress test schema —
no production data risk, no test correctness risk (each test gets a fresh
unique schema name), and the next run cleans it up. Cost of a more robust
implementation (pg_advisory_lock + a separate reaper process, or a
lifecycle hook in vitest's globalTeardown) is not yet warranted.

Revisit if: we move to CI with parallel test runners (where a leaked
schema from job N could collide with job N+1 only by name, but disk
pressure on the dev DB could become real), or if we ever observe more
than a handful of orphan schemas accumulating.

## Fixture-rewriter exception list extension

Current: `refresh-schema-fixture.sh` and `check-fixture-drift.sh` strip
`pg_dump`'s `SET …` / `SELECT pg_catalog.set_config(…)` preamble and
rewrite `public.` → `@@SCHEMA@@.` (with a re-exception for
`public.vector(`). That is the entire transform.

If we ever introduce schema features that need additional rewrites — for
example, a Postgres extension whose types live in a non-public schema, a
`COMMENT ON` we want to keep, or a partitioned-table syntax `pg_dump`
emits with hard-coded schema qualifiers — extend the `sed` pipeline in
**both** scripts at the same time. They are intentionally kept in lockstep
(inline copies, not a sourced helper) so a divergence is loud at review
time. Track these as they come up; punt to Part 3 if the list grows
beyond two or three exceptions.

## EP-003: Migrate `chat.ts` from `anthropic` singleton to `createAnthropicClient()`

Migrate `artifacts/api-server/src/routes/chat.ts` from the `anthropic`
singleton to `createAnthropicClient()`. Low priority — `chat.test.ts`
already substitutes the SDK via `vi.mock`, so the testability gap is
covered. Stylistic consistency only. Migrate when `chat.ts` grows a
per-request configuration need (alternate base URL, request-scoped
logging, custom timeout). Single caller across the workspace.

## Frontend coverage beyond smoke

Part 2 covers `CitationChip`, `ClaudeChat`, `SheetGrid`, `SheetViewer`
with happy-dom + RTL smoke tests. Out of scope and deferred:

- Playwright end-to-end coverage of the Revit-snapshot → chat flow
- The Code Library tab (search, jurisdiction filter, atom detail drawer)
- The plan-review artifact (separate Vitest setup needed; pre-existing
  TS errors in its `mock.ts` should be cleared first)
- Streaming-ReadableStream test for `ClaudeChat.sendMessage` SSE
  consumption (currently exercised end-to-end via the api-server route
  test; no per-component test of the consumer)
