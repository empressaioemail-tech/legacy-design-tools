/**
 * End-to-end CLI smoke test for the `sheet.created` history-event
 * backfill script.
 *
 * Why this exists (Task #335)
 * ---------------------------
 * `backfillSheetCreatedEvents.test.ts` (and the integration suite
 * under `__tests__/integration/`) already cover `backfill()` and
 * `parseArgs()` as in-process functions, but the actual entrypoint
 * — what `pnpm --filter @workspace/scripts run backfill:sheet-created`
 * invokes via `tsx` — is glue code we can't reach from a unit test:
 *
 *   - `process.argv.slice(2)` parsing
 *   - the bootstrap `console.log("backfillSheetCreatedEvents: starting…")` line
 *   - the trailing `backfillSheetCreatedEvents: done` summary line
 *   - the non-zero exit on `parseArgs` failure (the throw that
 *     escapes `main()` becomes an unhandled rejection that aborts
 *     the process — this contract is invisible to a unit test)
 *   - the `pool.end()` cleanup so the process actually exits
 *
 * The sister `parcel_briefings.generation_id` script is already
 * wired into `scripts/post-merge.sh`; this script is the obvious
 * next candidate. A regression in any of the above would either
 * thrash `atom_events` on every merge, hang the post-merge step
 * until a CI timeout, or — worst case — silently mutate production
 * after a typo on the CLI (e.g. `--dryrun` instead of `--dry-run`
 * looking like a clean real run that wrote synthetic events). The
 * unit tests can't catch any of these. So we spawn the real CLI
 * against a `withTestSchema` database and assert exit codes and
 * stdout/stderr.
 *
 * Strategy
 * --------
 * Mirrors `backfillBriefingGenerationIds.cli.test.ts`:
 * - Spin up a fresh schema with `withTestSchema`.
 * - Override `DATABASE_URL` for the spawned child to point at that
 *   schema (via the `?options=-c search_path=…` trick the testing
 *   helper already uses internally).
 * - Run the script via `tsx` with the same argv shape post-merge
 *   would use, capture stdout/stderr/exit code, and assert.
 *
 * The bootstrap and summary lines are asserted with explicit text
 * so a future formatting change ("starting" → "begin" or "done" →
 * "finished") fails this test loudly. Operators grep these lines in
 * deploy logs, so the format is part of the contract.
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
  "backfillSheetCreatedEvents.ts",
);

const TINY_PNG = Buffer.from([0]);

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
 * for `@workspace/db` and `@workspace/empressa-atom`.
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

interface SeedResult {
  legacySheetId: string;
  legacySheetNumber: string;
  legacySheetName: string;
}

/**
 * Seed one engagement / snapshot / legacy sheet so the script has
 * exactly one row to backfill. Kept intentionally smaller than the
 * integration-suite fixture (which exercises the legacy/tracked/
 * updated-only split) — the CLI smoke test only needs to prove the
 * end-to-end pipe works, not re-cover the heuristic surface.
 *
 * Duplicated rather than shared with the integration test so the
 * smoke test stays self-contained — if the integration seed shifts
 * to cover a different scenario, the smoke-test contract on the
 * CLI's stdout shouldn't drift with it.
 */
async function seedOneLegacySheet(ctx: TestSchemaContext): Promise<SeedResult> {
  const eng = await ctx.pool.query<{ id: string }>(
    `INSERT INTO engagements (name, name_lower, jurisdiction, address)
       VALUES ('CLI Sheet Smoke', 'cli sheet smoke', 'Moab, UT', '7 Sheet Way')
       RETURNING id`,
  );
  const engagementId = eng.rows[0].id;

  const snap = await ctx.pool.query<{ id: string }>(
    `INSERT INTO snapshots (engagement_id, project_name, payload)
       VALUES ($1, 'CLI Sheet Snapshot', '{}'::jsonb)
       RETURNING id`,
    [engagementId],
  );
  const snapshotId = snap.rows[0].id;

  const sheetNumber = "A100";
  const sheetName = "Legacy Smoke Sheet";
  const legacy = await ctx.pool.query<{ id: string }>(
    `INSERT INTO sheets
       (snapshot_id, engagement_id, sheet_number, sheet_name,
        thumbnail_png, thumbnail_width, thumbnail_height,
        full_png, full_width, full_height, sort_order, created_at)
       VALUES ($1, $2, $3, $4,
               $5, 1, 1, $5, 1, 1, 0, NOW() - interval '30 days')
       RETURNING id`,
    [snapshotId, engagementId, sheetNumber, sheetName, TINY_PNG],
  );
  return {
    legacySheetId: legacy.rows[0].id,
    legacySheetNumber: sheetNumber,
    legacySheetName: sheetName,
  };
}

describe("backfillSheetCreatedEvents CLI — Task #335", () => {
  it("exits non-zero and prints a usage error on an unknown flag", async () => {
    await withTestSchema(async (ctx) => {
      const res = await runCli(["--bogus"], {
        DATABASE_URL: urlForSchema(ctx.schemaName),
      });
      // `parseArgs` throws synchronously inside `main()`; that
      // rejection escapes `void main()` and Node aborts the process
      // with a non-zero exit. We assert "non-zero" rather than
      // "exactly 1" so a future move to wrap parseArgs in a
      // try/catch with `process.exit(2)` wouldn't break the
      // contract that bad args are loud, not silent.
      expect(res.exitCode).not.toBe(0);
      expect(res.exitCode).not.toBeNull();
      // Belt-and-braces: the operator should see *why* it failed in
      // the deploy log, not just a bare exit code. The message
      // surfaces via Node's unhandled-rejection report on stderr.
      expect(res.stderr).toMatch(/Unknown argument/);
      // And we MUST NOT have printed the bootstrap line, because
      // we should have rejected before reaching the backfill call.
      expect(res.stdout).not.toMatch(/backfillSheetCreatedEvents: starting/);
    });
  });

  it("runs cleanly to completion against a seeded fixture", async () => {
    await withTestSchema(async (ctx) => {
      const seeded = await seedOneLegacySheet(ctx);

      const res = await runCli([], {
        DATABASE_URL: urlForSchema(ctx.schemaName),
      });
      expect(res.exitCode).toBe(0);
      // Bootstrap line — operators search deploy logs for this to
      // confirm the post-merge step ran. Pinned without the
      // "(dry-run)" suffix to assert the real-run branch.
      expect(res.stdout).toContain("backfillSheetCreatedEvents: starting");
      expect(res.stdout).not.toContain(
        "backfillSheetCreatedEvents: starting (dry-run)",
      );
      // Trailing summary line is the contract operators read to
      // know the run succeeded. The exact totals are asserted via
      // the side-effect query below; here we just pin the prefix
      // so a rename ("done" → "finished") fails loudly.
      expect(res.stdout).toContain("backfillSheetCreatedEvents: done");

      // Side effect: the synthetic `sheet.created` actually got
      // appended. This guards against a future refactor that prints
      // a clean summary while silently failing to mutate (e.g.
      // forgetting to await the append).
      const after = await ctx.pool.query<{ c: string }>(
        `SELECT COUNT(*)::text c FROM atom_events
           WHERE entity_type = 'sheet'
             AND entity_id = $1
             AND event_type = 'sheet.created'`,
        [seeded.legacySheetId],
      );
      expect(Number(after.rows[0].c)).toBe(1);
    });
  });

  it("prints the dry-run preview line and does not mutate atom_events", async () => {
    await withTestSchema(async (ctx) => {
      const seeded = await seedOneLegacySheet(ctx);

      const beforeCount = await ctx.pool.query<{ c: string }>(
        `SELECT COUNT(*)::text c FROM atom_events`,
      );

      const res = await runCli(["--dry-run"], {
        DATABASE_URL: urlForSchema(ctx.schemaName),
      });
      expect(res.exitCode).toBe(0);

      // Bootstrap line flips to include the "(dry-run)" suffix —
      // pinned because operators sometimes diff dry-run output
      // across deploys to spot churn, and changing the marker
      // would break those scripts.
      expect(res.stdout).toContain(
        "backfillSheetCreatedEvents: starting (dry-run)",
      );
      // Per-row preview line. Format:
      //   `[dry-run] would append sheet.created for sheet <id> ` +
      //   `(<number> — "<name>") at <iso>`
      // We assert the id/number/name fragments so a refactor that
      // drops any of them (or swaps the em-dash for a hyphen) would
      // fail loudly — operators eyeball this line to confirm what
      // they're about to commit to.
      expect(res.stdout).toContain(
        `[dry-run] would append sheet.created for sheet ${seeded.legacySheetId} ` +
          `(${seeded.legacySheetNumber} — "${seeded.legacySheetName}") at `,
      );
      // Trailing summary line is identical in shape between real
      // and dry runs.
      expect(res.stdout).toContain("backfillSheetCreatedEvents: done");

      // Side effect MUST NOT have happened: the dry-run branch only
      // reads. If a future change accidentally falls through into
      // the append branch this assertion catches it.
      const afterCount = await ctx.pool.query<{ c: string }>(
        `SELECT COUNT(*)::text c FROM atom_events`,
      );
      expect(afterCount.rows[0].c).toBe(beforeCount.rows[0].c);
    });
  });
});
