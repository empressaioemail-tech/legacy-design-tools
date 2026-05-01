/**
 * End-to-end CLI smoke test for the parcel_briefings.generation_id
 * backfill script.
 *
 * Why this exists (Task #315)
 * ---------------------------
 * `backfillBriefingGenerationIds.test.ts` already covers `backfill()`
 * and `parseArgs()` as in-process functions, but the actual entrypoint
 * — what `pnpm --filter @workspace/scripts run backfill:briefing-
 * generation-ids` invokes via `tsx` — is glue code we can't reach
 * from a unit test:
 *
 *   - `process.argv.slice(2)` parsing
 *   - the bootstrap `console.log("Backfilling … (dryRun=…)")` line
 *   - the trailing `Done. scanned=… matched=… unmatched=…` summary line
 *   - the `process.exitCode = 1` failure path in `main().catch`
 *   - `pool.end()` cleanup so the process actually exits
 *
 * Post-merge wires this script into every deploy
 * (`scripts/post-merge.sh`), so a regression in any of the above
 * would either thrash the column on every merge, hang the post-merge
 * step until a CI timeout, or — worst case — silently mutate
 * production after a typo on the CLI. The unit tests can't catch any
 * of these. So we spawn the real CLI against a `withTestSchema`
 * database and assert exit codes and stdout.
 *
 * Strategy
 * --------
 * - Spin up a fresh schema with `withTestSchema`.
 * - Override `DATABASE_URL` for the spawned child to point at that
 *   schema (via the `?options=-c search_path=…` trick the testing
 *   helper already uses internally).
 * - Run the script via `tsx` with the same argv shape post-merge
 *   uses, capture stdout/stderr/exit code, and assert.
 *
 * The dry-run summary line is asserted as a regex with explicit
 * counts so a future formatting change ("Done." → "Finished." or
 * "scanned=" → "rows=") fails this test loudly. Operators grep these
 * lines in deploy logs, so the format is part of the contract.
 */

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withTestSchema, type TestSchemaContext } from "@workspace/db/testing";

const __filename = fileURLToPath(import.meta.url);
// __tests__/ → src/ → scripts/
const SCRIPTS_DIR = resolve(dirname(__filename), "..", "..");
const TSX_BIN = resolve(SCRIPTS_DIR, "node_modules", ".bin", "tsx");
const SCRIPT_PATH = resolve(
  SCRIPTS_DIR,
  "src",
  "backfillBriefingGenerationIds.ts",
);

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the backfill script as a real subprocess and capture its
 * output. We spawn `tsx` directly (rather than going through
 * `pnpm exec`) because pnpm adds ~2-3s of startup overhead per
 * invocation that compounds across the suite. Using the workspace's
 * own `node_modules/.bin/tsx` keeps node_modules resolution intact
 * for `@workspace/db`.
 *
 * The child inherits `process.env` so `PATH`, `NODE_ENV`, etc.
 * remain available, but `DATABASE_URL` is overridden to point at the
 * caller's test schema. Caller passes the override via `env`.
 */
function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<CliResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(TSX_BIN, [SCRIPT_PATH, ...args], {
      cwd: SCRIPTS_DIR,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({ exitCode: code, stdout, stderr });
    });
  });
}

/**
 * Build a `DATABASE_URL` whose connections land in the given test
 * schema. Mirrors the `?options=-c search_path=…` trick that
 * `createTestSchema` uses for its own pool: any unqualified table
 * reference in the script's SQL resolves inside the test schema
 * rather than `public`.
 */
function urlForSchema(schemaName: string): string {
  const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      "TEST_DATABASE_URL or DATABASE_URL must be set to run the CLI smoke test",
    );
  }
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schemaName},public`);
  return url.toString();
}

/**
 * Seed the same one-engagement / one-job / one-briefing fixture the
 * unit-test happy-path uses. Duplicated rather than shared so the
 * smoke test stays self-contained — if the unit-test seed shifts to
 * cover a different scenario, the smoke-test contract on the CLI's
 * stdout shouldn't drift with it.
 */
async function seedOneMatchableBriefing(ctx: TestSchemaContext): Promise<{
  briefingId: string;
  jobId: string;
}> {
  const eng = await ctx.pool.query<{ id: string }>(
    `INSERT INTO engagements (name, name_lower, jurisdiction, address)
       VALUES ('CLI Smoke', 'cli smoke', 'Moab, UT', '5 Smoke Way')
       RETURNING id`,
  );
  const engagementId = eng.rows[0].id;
  const briefing = await ctx.pool.query<{ id: string }>(
    `INSERT INTO parcel_briefings
       (engagement_id, section_a, generated_at, generated_by)
       VALUES ($1, 'body', NOW() - interval '7 seconds',
               'system:briefing-engine')
       RETURNING id`,
    [engagementId],
  );
  const briefingId = briefing.rows[0].id;
  const job = await ctx.pool.query<{ id: string }>(
    `INSERT INTO briefing_generation_jobs
       (engagement_id, briefing_id, state, started_at, completed_at)
       VALUES ($1, $2, 'completed', NOW() - interval '10 seconds',
               NOW() - interval '5 seconds')
       RETURNING id`,
    [engagementId, briefingId],
  );
  return { briefingId, jobId: job.rows[0].id };
}

describe("backfillBriefingGenerationIds CLI — Task #315", () => {
  it("exits non-zero and prints a usage error on an unknown flag", async () => {
    await withTestSchema(async (ctx) => {
      const res = await runCli(["--bogus"], {
        DATABASE_URL: urlForSchema(ctx.schemaName),
      });
      // The script's `main().catch` handler sets exitCode = 1 when
      // parseArgs throws on an unknown flag. We assert "non-zero"
      // rather than "exactly 1" so a future move to e.g.
      // `process.exit(2)` for the bad-args case wouldn't break the
      // contract that bad args are loud, not silent.
      expect(res.exitCode).not.toBe(0);
      expect(res.exitCode).not.toBeNull();
      // Belt-and-braces: the operator should see *why* it failed in
      // the deploy log, not just a bare exit code.
      expect(res.stderr).toMatch(/Unknown argument/);
      // And we MUST NOT have printed the "Backfilling …" bootstrap
      // line, because we should have rejected before reaching the
      // backfill call.
      expect(res.stdout).not.toMatch(/Backfilling parcel_briefings/);
    });
  });

  it("runs cleanly to completion against a seeded fixture", async () => {
    await withTestSchema(async (ctx) => {
      const { briefingId, jobId } = await seedOneMatchableBriefing(ctx);

      const res = await runCli([], {
        DATABASE_URL: urlForSchema(ctx.schemaName),
      });
      expect(res.exitCode).toBe(0);
      // Bootstrap line — operators search deploy logs for this to
      // confirm the post-merge step ran.
      expect(res.stdout).toContain(
        "Backfilling parcel_briefings.generation_id (dryRun=false)",
      );
      // Trailing summary line is the contract operators read to
      // know the run succeeded and how much it touched.
      expect(res.stdout).toMatch(
        /Done\. scanned=1 matched=1 unmatched=0 \(unmatched rows stay NULL/,
      );

      // Side effect: the column actually got stamped. This guards
      // against a future refactor that prints a clean summary while
      // silently failing to mutate (e.g. forgetting to await the
      // UPDATE).
      const after = await ctx.pool.query<{ generation_id: string | null }>(
        `SELECT generation_id FROM parcel_briefings WHERE id = $1`,
        [briefingId],
      );
      expect(after.rows[0].generation_id).toBe(jobId);
    });
  });

  it("prints the dry-run preview lines and stable summary without mutating", async () => {
    await withTestSchema(async (ctx) => {
      const { briefingId, jobId } = await seedOneMatchableBriefing(ctx);

      const res = await runCli(["--dry-run"], {
        DATABASE_URL: urlForSchema(ctx.schemaName),
      });
      expect(res.exitCode).toBe(0);

      // Bootstrap line flips to dryRun=true — pinned because operators
      // sometimes diff dry-run output across deploys to spot churn,
      // and changing the prefix would break those scripts.
      expect(res.stdout).toContain(
        "Backfilling parcel_briefings.generation_id (dryRun=true)",
      );
      // Per-row preview line. Format:
      //   `[dry-run] briefing <uuid> → <uuid>`
      // We assert the exact briefing→job pair so a refactor that
      // swaps the arrow direction or drops the briefing id would
      // fail loudly.
      expect(res.stdout).toContain(`[dry-run] briefing ${briefingId} → ${jobId}`);
      // Trailing summary line is identical in shape between real
      // and dry runs — the dry-run path returns the same scanned/
      // matched/unmatched tuple.
      expect(res.stdout).toMatch(
        /Done\. scanned=1 matched=1 unmatched=0 \(unmatched rows stay NULL/,
      );

      // Side effect MUST NOT have happened: the dry-run branch only
      // reads. If a future change accidentally falls through into the
      // UPDATE branch, this assertion catches it.
      const after = await ctx.pool.query<{ generation_id: string | null }>(
        `SELECT generation_id FROM parcel_briefings WHERE id = $1`,
        [briefingId],
      );
      expect(after.rows[0].generation_id).toBeNull();
    });
  });
});
