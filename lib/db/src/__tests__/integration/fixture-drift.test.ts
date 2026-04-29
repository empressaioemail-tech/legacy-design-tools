/**
 * Fixture-drift guard.
 *
 * Runs `lib/db/scripts/check-fixture-drift.sh`, which dumps the live schema
 * via the same pg_dump+sed pipeline as `refresh-schema-fixture.sh` and diffs
 * the result against the committed
 * `lib/db/src/__tests__/__fixtures__/schema.sql.template`.
 *
 * Skips if `DATABASE_URL` is not set — the rest of the integration suite
 * needs that env var anyway, so this is safe in lint/CI-without-DB contexts.
 *
 * If this test fails: someone changed the live DB schema (drizzle-kit push)
 * without re-running `pnpm --filter @workspace/db run test:fixture:schema`.
 * The diff is included in the script's output so the failing CI log shows
 * exactly what drifted.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SCRIPT_PATH = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "scripts",
  "check-fixture-drift.sh",
);

describe("schema fixture drift", () => {
  it.skipIf(!process.env.DATABASE_URL)(
    "the committed schema fixture matches what pg_dump emits for the live DB",
    () => {
      const result = spawnSync("bash", [SCRIPT_PATH], {
        env: process.env,
        encoding: "utf8",
        // Surfacing 5 MB is overkill for a schema dump but cheap.
        maxBuffer: 5 * 1024 * 1024,
      });

      if (result.status !== 0) {
        // Rebuild the assertion message so the diff is visible in vitest output.
        throw new Error(
          `Fixture drift detected (exit ${result.status}).\n` +
            `STDOUT:\n${result.stdout}\n` +
            `STDERR:\n${result.stderr}`,
        );
      }

      expect(result.status).toBe(0);
    },
    30_000,
  );
});
