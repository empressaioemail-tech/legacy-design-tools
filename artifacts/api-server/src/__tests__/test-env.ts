/**
 * Vitest setupFile: provision env vars BEFORE any test module's imports
 * resolve. Vitest evaluates setupFiles ahead of the test-file module graph,
 * so anything we set here is visible to top-level singletons (e.g. the
 * `anthropic` SDK client and lib/db's Pool) when they initialize on import.
 *
 * We deliberately:
 *   - point Anthropic at a bogus base URL so the singleton initializes
 *     without errors but any real outbound call fails fast (tests that
 *     exercise the route mock the module entirely);
 *   - clear OPENAI_API_KEY so the embeddings module's "no_api_key" branch
 *     is taken — keeps codes tests fully deterministic and offline;
 *   - keep DATABASE_URL untouched (the test schema lifecycle in setup.ts
 *     reads it via @workspace/db/testing).
 */

if (!process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL) {
  process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL = "http://anthropic.test.invalid";
}
if (!process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY = "test-key-not-real";
}

// Force the embeddings module's no-key branch in every test. We stash the
// original (if any) into SMOKE_OPENAI_API_KEY first so the Land Use smoke
// test can opt back in to real embeddings without other tests' offline
// invariants drifting. Without the stash, an operator running `pnpm test`
// with OPENAI_API_KEY in their env would silently take the vector path in
// every test that asserts the lexical-fallback shape.
if (process.env.OPENAI_API_KEY && !process.env.SMOKE_OPENAI_API_KEY) {
  process.env.SMOKE_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
}
delete process.env.OPENAI_API_KEY;

// Disable the queue worker's first-tick setTimeout in case any test imports
// app.ts directly. Tests that mount routes use buildTestApp() (which doesn't
// call startQueueWorker) so this is belt-and-suspenders.
process.env.CODE_ATOM_QUEUE_TICK_MS = "999999999";

// A04.7: pin the snapshot secret so tests can send the right header.
// snapshotSecret.ts caches the first value it sees at module load; without
// this, dev mode would generate a random per-process value that the test
// has no way to read.
process.env.SNAPSHOT_SECRET = "test-snapshot-secret";
