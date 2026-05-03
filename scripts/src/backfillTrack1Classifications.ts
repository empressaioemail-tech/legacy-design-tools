/**
 * Backfill Track 1 submission classifications for submissions that
 * predate the auto-classifier hook.
 *
 * Why
 * ---
 * The Track 1 auto-classifier fires on `submission.created` going
 * forward (see api-server's
 * `autoTriggerClassificationOnSubmissionCreated`). Rows already in
 * the `submissions` table at the time the feature shipped have no
 * row in `submission_classifications` and surface an empty triage
 * strip on the reviewer Inbox — the FE renders no classification
 * chips, project type, or applicable-code-books badge.
 *
 * This one-shot script iterates every submission with no
 * classification row, classifies it (mock by default; `--anthropic`
 * opts into Claude Sonnet 4.5 for a budgeted run), inserts a row,
 * and emits the matched `submission.classified` +
 * `submission-classification.set` events as a side-effect — so each
 * backfilled submission's per-submission timeline gains a real
 * ingest entry.
 *
 * Shared logic
 * ------------
 * The classifier itself (model pin, system prompt, JSON parse rules,
 * `gatherClassifierInputText`, `parseClassificationResponse`,
 * `classifySubmission`, `emitClassificationEvents`,
 * `setClassificationLlmClient`) lives in
 * `@workspace/submission-classifier` so the live auto-trigger and
 * this backfill stay in lock-step. Pre-extraction this script
 * mirrored ~80 lines of classifier logic inline; that duplication
 * has been removed.
 *
 * What stays inline
 * -----------------
 *   - `--anthropic` / `--max-rows` CLI parsing + Q5 budget guard.
 *   - The `LEFT JOIN`-based candidate selection (oldest-first).
 *   - The `ON CONFLICT DO NOTHING` row insert (concurrent-safe).
 *   - The distinct `classifier-backfill` system actor + the
 *     `backfilled: true` payload flag — operators want deploy-log
 *     greps to distinguish historical writes from live classifier
 *     runs, and that's a behavior the live classifier doesn't carry.
 *
 * Idempotency
 * -----------
 * Safe to re-run. The selection query LEFT-JOINs against
 * `submission_classifications` and excludes already-classified rows;
 * the INSERT additionally uses `ON CONFLICT DO NOTHING` as a safety
 * net for concurrent inserts.
 *
 * Modes
 * -----
 *   - `--dry-run`   Preview which rows would be touched without
 *                   writing. Hard-skips the LLM call AND the DB
 *                   write AND the event emit.
 *   - `--anthropic` Use Claude Sonnet 4.5 (the same pinned model the
 *                   fire-and-forget hook uses) instead of the
 *                   deterministic mock classifier. REQUIRES
 *                   `--max-rows N` so the operator opts in to a
 *                   specific budget. The shared classifier resolves
 *                   the Anthropic client from `CLASSIFICATION_LLM_MODE`
 *                   (set by `main()` before the first call) and the
 *                   AI Integrations env vars.
 *   - `--max-rows N` Cap the number of submissions processed in one
 *                   run. Default 0 = unbounded (mock mode only).
 *                   Required when `--anthropic` is set.
 *
 * Usage
 * -----
 *   pnpm --filter @workspace/scripts run backfill:track1-classifications
 *   pnpm --filter @workspace/scripts run backfill:track1-classifications -- --dry-run
 *   pnpm --filter @workspace/scripts run backfill:track1-classifications -- --max-rows 100
 *   pnpm --filter @workspace/scripts run backfill:track1-classifications -- --anthropic --max-rows 50
 *
 * Empressa runs the script manually after Track 1 merges; not part
 * of the deploy pipeline.
 *
 * Exit code
 * ---------
 * Non-zero if any per-row classification or upsert throws so a
 * partial completion is visible in the operator's deploy log.
 */

import { sql } from "drizzle-orm";
import {
  db as defaultDb,
  pool,
  submissionClassifications,
} from "@workspace/db";
import {
  PostgresEventAnchoringService,
  type EventAnchoringService,
} from "@workspace/empressa-atom";
import { PLAN_REVIEW_DISCIPLINE_VALUES } from "@workspace/api-zod";
import {
  classificationAtomId,
  classifySubmission,
  emitClassificationEvents,
  EMPTY_CLASSIFICATION,
  type ClassificationResult,
  type ClassifierLogger,
} from "@workspace/submission-classifier";

/** Stable system actor for backfilled classifications. Distinct from
 *  the live `classifier` actor used by the fire-and-forget hook so
 *  operators can grep deploy logs / atom_events for backfill writes
 *  without confusing them with real classifier runs. */
export const CLASSIFIER_BACKFILL_ACTOR_ID = "classifier-backfill";

export interface CliOptions {
  dryRun: boolean;
  anthropic: boolean;
  /** 0 = unbounded; only allowed in mock mode (the parseArgs guard
   *  enforces this — anthropic always requires `--max-rows`). */
  maxRows: number;
}

/**
 * Parse the script's argv. Mirrors the strict policy used by the
 * sibling backfill scripts: unknown flags throw rather than silently
 * no-oping, because a typo on the deploy console (`--dryrun` instead
 * of `--dry-run`) must not look like a clean real run that wrote
 * synthetic classifications.
 *
 * Strict guards (BE follow-up — Q5):
 *   - `--anthropic` requires `--max-rows N`. The operator is forced
 *     to opt in to a specific budget; we never silently fan out a
 *     1000-row LLM run.
 *   - `--max-rows N` must be a positive integer. The default
 *     `--max-rows 0` ("unbounded") is the in-code default, NOT a
 *     legal CLI value — operators who omit the flag get unbounded
 *     mock mode; operators who want a cap type a real number.
 */
export function parseArgs(argv: string[]): CliOptions {
  let dryRun = false;
  let anthropic = false;
  let maxRows = 0;

  const known = new Set(["--dry-run", "--anthropic", "--max-rows"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (a === "--anthropic") {
      anthropic = true;
      continue;
    }
    if (a === "--max-rows") {
      const next = argv[i + 1];
      if (typeof next !== "string") {
        throw new Error(
          `--max-rows requires an integer argument (e.g. --max-rows 50).`,
        );
      }
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n < 1 || String(n) !== next.trim()) {
        throw new Error(
          `--max-rows must be a positive integer; got "${next}".`,
        );
      }
      maxRows = n;
      i++;
      continue;
    }
    if (!known.has(a)) {
      throw new Error(
        `Unknown argument(s): ${a}. ` +
          `Usage: backfill:track1-classifications [--dry-run] [--anthropic --max-rows N | --max-rows N]`,
      );
    }
  }

  if (anthropic && maxRows === 0) {
    throw new Error(
      "--anthropic requires --max-rows N. The operator must opt in to a " +
        "specific budget; running anthropic mode without a row cap could " +
        "fan out an unbounded LLM run.",
    );
  }

  return { dryRun, anthropic, maxRows };
}

export interface BackfillSummary {
  totalCandidates: number;
  classified: number;
  skipped: number;
  failed: number;
}

/** Drizzle db surface this script needs — same convention as the
 *  sibling backfill scripts. */
export type BackfillDb = typeof defaultDb;

/**
 * Find the ids of submissions that have no classification row.
 * `LIMIT` is applied when the caller passed `--max-rows N`; default
 * (0) is unbounded and only legal in mock mode (the parseArgs guard
 * enforces this). Ordered by `submitted_at` so a budgeted run picks
 * up the oldest unclassified rows first — operators usually want to
 * fill the historic Inbox tail before the most recent submissions.
 */
async function fetchUnclassifiedSubmissionIds(
  db: BackfillDb,
  maxRows: number,
): Promise<string[]> {
  const limitClause = maxRows > 0 ? sql`LIMIT ${maxRows}` : sql``;
  const result = await db.execute<{ id: string }>(
    sql`SELECT s.id
        FROM submissions s
        LEFT JOIN submission_classifications c ON c.submission_id = s.id
        WHERE c.submission_id IS NULL
        ORDER BY s.submitted_at
        ${limitClause}`,
  );
  const out: string[] = [];
  for (const row of result.rows) {
    if (typeof row.id === "string") out.push(row.id);
  }
  return out;
}

/**
 * Stable script-side logger. The classifier lib's functions accept a
 * `ClassifierLogger`; the backfill writes its operator-visible lines
 * via `console.log` directly (script convention) but still passes a
 * minimal `info`/`warn`/`error` shim into the lib so its internal
 * warn lines surface on stderr if anything goes wrong.
 */
const SCRIPT_LOGGER: ClassifierLogger = {
  info: (obj, msg) => {
    if (msg) {
      // eslint-disable-next-line no-console
      console.log(msg, obj);
    }
  },
  warn: (obj, msg) => {
    // eslint-disable-next-line no-console
    console.warn(msg ?? "warning", obj);
  },
  error: (obj, msg) => {
    // eslint-disable-next-line no-console
    console.error(msg ?? "error", obj);
  },
};

/**
 * Run the backfill. Caller is responsible for env preparation when
 * `--anthropic` is set: `main()` sets `CLASSIFICATION_LLM_MODE`
 * before this is invoked so the shared classifier's cached client
 * resolves to the correct mode on first call.
 *
 * Tests inject a fake `EventAnchoringService` via the `history`
 * parameter to assert on appended events without touching
 * `atom_events`; production constructs a `PostgresEventAnchoringService`
 * over the same `db` so the classification events land alongside
 * live ones.
 *
 * Tests that want to exercise anthropic mode use
 * `setClassificationLlmClient(testClient)` from
 * `@workspace/submission-classifier` (the cached-singleton pattern
 * the rest of the codebase uses), rather than per-call injection.
 */
export async function backfill(
  opts: CliOptions,
  db: BackfillDb = defaultDb,
  history?: EventAnchoringService,
): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    totalCandidates: 0,
    classified: 0,
    skipped: 0,
    failed: 0,
  };

  const candidateIds = await fetchUnclassifiedSubmissionIds(db, opts.maxRows);
  summary.totalCandidates = candidateIds.length;

  const anchoring: EventAnchoringService =
    history ??
    new PostgresEventAnchoringService(
      db as unknown as ConstructorParameters<
        typeof PostgresEventAnchoringService
      >[0],
    );

  for (const submissionId of candidateIds) {
    if (opts.dryRun) {
      summary.classified++;
      // eslint-disable-next-line no-console
      console.log(
        `[dry-run] would classify submission ${submissionId} ` +
          `(mode=${opts.anthropic ? "anthropic" : "mock"})`,
      );
      continue;
    }
    try {
      // The shared classifier resolves the Anthropic client (or
      // null in mock mode) via its cached singleton. `main()` set
      // `CLASSIFICATION_LLM_MODE` before we got here.
      const result: ClassificationResult = opts.anthropic
        ? await classifySubmission(submissionId, SCRIPT_LOGGER, db)
        : EMPTY_CLASSIFICATION;
      const now = new Date();
      const inserted = await db
        .insert(submissionClassifications)
        .values({
          submissionId,
          projectType: result.projectType,
          disciplines: result.disciplines,
          applicableCodeBooks: result.applicableCodeBooks,
          confidence:
            result.confidence == null ? null : String(result.confidence),
          source: "auto",
          classifiedBy: null,
          classifiedAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: submissionClassifications.submissionId,
        })
        .returning({ submissionId: submissionClassifications.submissionId });

      if (inserted.length === 0) {
        // Concurrent insert raced past the LEFT-JOIN filter — the
        // ON CONFLICT DO NOTHING is the safety net.
        summary.skipped++;
        // eslint-disable-next-line no-console
        console.log(
          `skipped submission ${submissionId} — classification row ` +
            `already exists (concurrent insert)`,
        );
        continue;
      }

      // Use the shared `emitClassificationEvents` so the event-emit
      // path is identical to the live classifier — but with the
      // distinct `classifier-backfill` actor and the `backfilled: true`
      // payload flag that operators rely on for deploy-log triage.
      await emitClassificationEvents(anchoring, {
        submissionId,
        classificationAtomId: classificationAtomId(submissionId),
        eventName: "submission.classified",
        actor: {
          kind: "system",
          id: CLASSIFIER_BACKFILL_ACTOR_ID,
        },
        payload: {
          projectType: result.projectType,
          disciplines: result.disciplines,
          applicableCodeBooks: result.applicableCodeBooks,
          confidence: result.confidence,
          source: "auto",
          backfilled: true,
        },
        reqLog: SCRIPT_LOGGER,
      });

      summary.classified++;
      // eslint-disable-next-line no-console
      console.log(
        `classified submission ${submissionId} ` +
          `disciplines=[${result.disciplines.join(",")}] ` +
          `projectType=${result.projectType ?? "null"} ` +
          `confidence=${result.confidence ?? "null"}`,
      );
    } catch (err) {
      summary.failed++;
      // eslint-disable-next-line no-console
      console.error(
        `failed to classify submission ${submissionId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return summary;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  // Set the LLM-mode env BEFORE any code path that lazily resolves
  // the classifier client. `getClassificationLlmClient()` (from the
  // shared lib) caches its mode on first call; the lazy import sees
  // this env value when the cache initialises.
  process.env["CLASSIFICATION_LLM_MODE"] = opts.anthropic ? "anthropic" : "mock";
  // eslint-disable-next-line no-console
  console.log(
    `backfillTrack1Classifications: starting${opts.dryRun ? " (dry-run)" : ""} ` +
      `mode=${opts.anthropic ? "anthropic" : "mock"} ` +
      `maxRows=${opts.maxRows === 0 ? "unbounded" : opts.maxRows}`,
  );
  let exitCode = 0;
  try {
    const summary = await backfill(opts);
    // eslint-disable-next-line no-console
    console.log("backfillTrack1Classifications: done", summary);
    if (summary.failed > 0) exitCode = 1;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("backfillTrack1Classifications: fatal error", err);
    exitCode = 1;
  } finally {
    // Drizzle's `db` holds a long-lived `pg.Pool`; tsx will hang on
    // the open sockets if we don't close it explicitly.
    await pool.end().catch(() => {
      /* best-effort */
    });
  }
  process.exit(exitCode);
}

// Only invoke `main()` when this module is executed as the script's
// entrypoint. Without this guard, importing the module from tests
// would run the CLI, hit `process.exit()` inside Vitest, and abort
// the test runner. Mirrors the regex check in the sibling backfill
// scripts (and `sweepOrphanAvatars.ts`).
const invokedAsEntrypoint =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /backfillTrack1Classifications\.(ts|js|mjs|cjs)$/.test(process.argv[1]);

if (invokedAsEntrypoint) {
  void main();
}

// Re-export the closed-set discipline tuple for tests that want to
// assert against the classifier's accepted vocabulary without re-
// importing from `@workspace/api-zod`.
export { PLAN_REVIEW_DISCIPLINE_VALUES };
