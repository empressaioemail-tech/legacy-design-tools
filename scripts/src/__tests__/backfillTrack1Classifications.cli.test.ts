/**
 * End-to-end CLI smoke test for the Track 1 classification backfill.
 *
 * Mirrors `backfillSheetCreatedEvents.cli.test.ts` — spawns `tsx`
 * against a withTestSchema database and asserts exit codes + stdout
 * shape so the operator-visible contract (bootstrap line, summary
 * line, dry-run preview, unknown-flag exit) cannot regress
 * silently.
 *
 * Why a CLI smoke alongside the in-process unit test
 * --------------------------------------------------
 * The unit test reaches `backfill()` and `parseArgs()` directly. The
 * actual entrypoint — what `pnpm --filter @workspace/scripts run
 * backfill:track1-classifications` invokes via `tsx` — is glue we
 * can't reach from a unit test:
 *   - `process.argv.slice(2)` parsing
 *   - the `process.env["CLASSIFICATION_LLM_MODE"]` set in `main()`
 *     before the LLM client lazy-resolves
 *   - the bootstrap log line
 *   - the trailing summary line
 *   - the `pool.end()` cleanup so the process actually exits
 *   - the non-zero exit on `parseArgs` failure
 *
 * Operators grep deploy logs for the bootstrap and summary line
 * formats, so the literal text is part of the contract — pinning
 * them here makes a future rename ("starting" → "begin") fail
 * loudly.
 */

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withTestSchema, type TestSchemaContext } from "@workspace/db/testing";

const __filename = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = resolve(dirname(__filename), "..", "..");
const TSX_BIN = resolve(SCRIPTS_DIR, "node_modules", ".bin", "tsx");
const SCRIPT_PATH = resolve(
  SCRIPTS_DIR,
  "src",
  "backfillTrack1Classifications.ts",
);

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

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

async function seedOneSubmission(ctx: TestSchemaContext): Promise<string> {
  const eng = await ctx.pool.query<{ id: string }>(
    `INSERT INTO engagements (name, name_lower, jurisdiction, address)
       VALUES ('CLI Track1 Smoke', 'cli track1 smoke', 'Bastrop, TX', '7 Way')
       RETURNING id`,
  );
  const sub = await ctx.pool.query<{ id: string }>(
    `INSERT INTO submissions
       (engagement_id, jurisdiction, jurisdiction_city, jurisdiction_state,
        submitted_at)
       VALUES ($1, 'Bastrop, TX', 'Bastrop', 'TX', NOW() - interval '7 days')
       RETURNING id`,
    [eng.rows[0]!.id],
  );
  return sub.rows[0]!.id;
}

describe("backfillTrack1Classifications CLI", () => {
  it("exits non-zero and prints a usage error on an unknown flag", async () => {
    await withTestSchema(async (ctx) => {
      const res = await runCli(["--bogus"], {
        DATABASE_URL: urlForSchema(ctx.schemaName),
      });
      expect(res.exitCode).not.toBe(0);
      expect(res.exitCode).not.toBeNull();
      expect(res.stderr).toMatch(/Unknown argument/);
      // Bootstrap line MUST NOT print — the parseArgs failure
      // happens before main() hits the console.log.
      expect(res.stdout).not.toMatch(
        /backfillTrack1Classifications: starting/,
      );
    });
  });

  it("exits non-zero when --anthropic is passed without --max-rows (Q5 budget guard)", async () => {
    await withTestSchema(async (ctx) => {
      const res = await runCli(["--anthropic"], {
        DATABASE_URL: urlForSchema(ctx.schemaName),
      });
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).toMatch(/--anthropic requires --max-rows/);
    });
  });

  it("runs cleanly to completion against a seeded fixture in mock mode", async () => {
    await withTestSchema(async (ctx) => {
      const submissionId = await seedOneSubmission(ctx);

      const res = await runCli([], {
        DATABASE_URL: urlForSchema(ctx.schemaName),
      });
      expect(res.exitCode).toBe(0);
      // Bootstrap line — operators search deploy logs for the
      // mode + maxRows tuple so they can confirm a real run vs a
      // dry-run vs an anthropic budgeted run.
      expect(res.stdout).toContain(
        "backfillTrack1Classifications: starting mode=mock maxRows=unbounded",
      );
      // Summary line — the totals matter; assert the prefix and
      // the classified count.
      expect(res.stdout).toContain("backfillTrack1Classifications: done");
      expect(res.stdout).toContain("classified: 1");

      // Side effect: a row landed AND the events were appended.
      const classifications = await ctx.pool.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM submission_classifications
           WHERE submission_id = $1`,
        [submissionId],
      );
      expect(Number(classifications.rows[0]!.c)).toBe(1);

      const events = await ctx.pool.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM atom_events
           WHERE event_type = 'submission.classified'
             AND entity_id = $1`,
        [submissionId],
      );
      expect(Number(events.rows[0]!.c)).toBe(1);
    });
  });

  it("--dry-run prints the preview line and does not mutate the DB", async () => {
    await withTestSchema(async (ctx) => {
      const submissionId = await seedOneSubmission(ctx);

      const res = await runCli(["--dry-run"], {
        DATABASE_URL: urlForSchema(ctx.schemaName),
      });
      expect(res.exitCode).toBe(0);
      // Bootstrap flips to (dry-run) suffix.
      expect(res.stdout).toContain(
        "backfillTrack1Classifications: starting (dry-run)",
      );
      // Per-row preview line.
      expect(res.stdout).toContain(
        `[dry-run] would classify submission ${submissionId} (mode=mock)`,
      );
      // No mutation.
      const classifications = await ctx.pool.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM submission_classifications`,
      );
      expect(Number(classifications.rows[0]!.c)).toBe(0);
      const events = await ctx.pool.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM atom_events
           WHERE event_type = 'submission.classified'`,
      );
      expect(Number(events.rows[0]!.c)).toBe(0);
    });
  });

  it("honors --max-rows N (1 of 3 candidates is processed)", async () => {
    await withTestSchema(async (ctx) => {
      // Seed 3 submissions; only 1 should be classified.
      await seedOneSubmission(ctx);
      await seedOneSubmission(ctx);
      await seedOneSubmission(ctx);

      const res = await runCli(["--max-rows", "1"], {
        DATABASE_URL: urlForSchema(ctx.schemaName),
      });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain(
        "backfillTrack1Classifications: starting mode=mock maxRows=1",
      );

      const classifications = await ctx.pool.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM submission_classifications`,
      );
      expect(Number(classifications.rows[0]!.c)).toBe(1);
    });
  });
});
