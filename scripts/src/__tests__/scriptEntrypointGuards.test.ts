/**
 * Entrypoint-guard smoke tests for the one-shot scripts in
 * `scripts/src/` — Task #336.
 *
 * Why this exists
 * ---------------
 * `sweepOrphanAvatars.ts` was patched in Task #312 with a regex-based
 * entrypoint guard so the script body could be imported by an
 * integration test without auto-running the CLI (which would call
 * `process.exit()` mid-test and abort Vitest). This task applies the
 * same pattern to `backfillSheetCreatedEvents.ts` and
 * `smokeConverter.ts`.
 *
 * The risk we're guarding against is subtle: a future refactor could
 * accidentally drop the `if (invokedAsEntrypoint)` check (or inline
 * the wrong filename in the regex) and the only symptom would be
 * that any test importing these modules silently kills the runner.
 * That failure mode reads as a flake, not a test failure, so the
 * regression would be hard to bisect.
 *
 * The test below pins three things per guarded script:
 *   1. The module is importable from a Vitest worker (i.e. it does
 *      NOT auto-invoke `main()` purely as a side effect of `import`).
 *   2. `process.exit` is not called at any point during the import
 *      — the canonical symptom of a missing or wrong guard.
 *   3. A name from the script body is reachable on the imported
 *      module record, proving the body is now testable in isolation
 *      without spinning up the CLI.
 *
 * `smokeConverter` is checked unconditionally — it has no DB
 * dependency and its `main()` would `process.exit(2)` immediately on
 * the missing `CONVERTER_URL` env var, which is exactly the failure
 * we want the guard to suppress.
 *
 * `backfillSheetCreatedEvents` transitively imports `@workspace/db`,
 * which throws at module load when neither `DATABASE_URL` nor
 * `TEST_DATABASE_URL` is set. So that half of the suite is gated on
 * the same env-var presence the rest of the script tests use; when
 * neither is set the case is rendered as skipped (visible in the
 * Vitest reporter) rather than silently dropped.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

const HAS_DB_URL = Boolean(
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
);
const describeIfDb = describe.skipIf(!HAS_DB_URL);

describe("script entrypoint guards — Task #336", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("smokeConverter does not auto-run main() when imported", async () => {
    // Sentinel: if the guard is missing, `main()` runs at import
    // time, finds CONVERTER_URL unset, and calls `process.exit(2)`.
    // We replace `process.exit` with a throwing stub so an
    // accidental invocation surfaces as a clear assertion failure
    // rather than tearing the worker down. The throw is wrapped in
    // a type cast because `process.exit` is typed `(code?) => never`
    // and TypeScript needs to see the stub's return type as `never`
    // too.
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(
          `process.exit(${String(code)}) called during smokeConverter import — ` +
            `the entrypoint guard is missing or broken`,
        );
      }) as (code?: number) => never);

    const mod = await import("../smokeConverter");

    expect(exitSpy).not.toHaveBeenCalled();
    // `main` is exported specifically so a test (this one, and
    // future fixture-led ones) can prove the body is reachable by
    // name without going through the CLI. If a refactor un-exports
    // it, this test fails loudly.
    expect(typeof mod.main).toBe("function");
  });

  describeIfDb("backfillSheetCreatedEvents", () => {
    it("does not auto-run main() when imported", async () => {
      // Same shape as the smokeConverter case. `@workspace/db`
      // requires `DATABASE_URL`; the suite-level skipIf already
      // gated us on that, but mirror the forward used elsewhere in
      // the script-tests so a CI that only sets `TEST_DATABASE_URL`
      // doesn't crash on the import below.
      process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;

      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(((code?: number) => {
          throw new Error(
            `process.exit(${String(code)}) called during ` +
              `backfillSheetCreatedEvents import — the entrypoint ` +
              `guard is missing or broken`,
          );
        }) as (code?: number) => never);

      const mod = await import("../backfillSheetCreatedEvents");

      expect(exitSpy).not.toHaveBeenCalled();
      // `backfill` and `parseArgs` are the names the unit and
      // integration tests already reach for. Pinning them here
      // guards against a refactor that un-exports either while
      // changing the guard.
      expect(typeof mod.backfill).toBe("function");
      expect(typeof mod.parseArgs).toBe("function");
    });
  });
});
