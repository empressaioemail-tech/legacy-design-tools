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
 * Self-contained
 * --------------
 * The api-server's `classifySubmission` / `upsertAutoClassification`
 * helpers can't be imported from `@workspace/scripts` (api-server is
 * a deployable artifact, not a lib package; cross-artifact imports
 * fall outside `scripts/tsconfig.json`'s `include`). To stay in
 * lock-step with the live classifier, this script mirrors the same
 * model pin (`claude-sonnet-4-5`), system prompt, and JSON-response
 * parse rules. If the live classifier in
 * `artifacts/api-server/src/lib/classifySubmission.ts` evolves —
 * model pin, prompt, response shape — this file should be updated
 * to match.
 *
 * Idempotency
 * -----------
 * Safe to re-run. The selection query is a LEFT JOIN that already
 * excludes submissions with an existing classification row, and the
 * INSERT uses `ON CONFLICT DO NOTHING` as a second safety net for
 * concurrent inserts. Running the script twice yields zero new rows
 * on the second pass.
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
 *                   specific budget; running `--anthropic` without
 *                   `--max-rows` is a hard error in `parseArgs`.
 *                   Anthropic mode also requires the AI Integrations
 *                   env vars (`AI_INTEGRATIONS_ANTHROPIC_API_KEY`,
 *                   `AI_INTEGRATIONS_ANTHROPIC_BASE_URL`).
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

import { sql, eq, desc } from "drizzle-orm";
import {
  db as defaultDb,
  pool,
  submissions,
  snapshots,
  sheets,
  submissionClassifications,
} from "@workspace/db";
import {
  PostgresEventAnchoringService,
  type EventAnchoringService,
} from "@workspace/empressa-atom";
import {
  PLAN_REVIEW_DISCIPLINE_VALUES,
  isPlanReviewDiscipline,
  type PlanReviewDiscipline,
} from "@workspace/api-zod";

/** Stable system actor for backfilled classifications. Distinct from
 *  the live `classifier` actor used by the fire-and-forget hook so
 *  operators can grep deploy logs / atom_events for backfill writes
 *  without confusing them with real classifier runs. */
export const CLASSIFIER_BACKFILL_ACTOR_ID = "classifier-backfill";

/** Pinned model — kept in lock-step with `CLASSIFIER_ANTHROPIC_MODEL`
 *  in `artifacts/api-server/src/lib/classifySubmission.ts`. */
export const CLASSIFIER_ANTHROPIC_MODEL = "claude-sonnet-4-5";

/** Token budget mirrors the live classifier. */
export const CLASSIFIER_ANTHROPIC_MAX_TOKENS = 800;

/** Hard cap on the cover-sheet text we hand to the model — mirrors
 *  the live classifier. */
export const CLASSIFIER_PROMPT_TEXT_MAX_CHARS = 8000;

const CLASSIFIER_SYSTEM_PROMPT = [
  "You are a triage assistant for a building-department plan-review queue.",
  "Given the cover-sheet text and sheet metadata of an architectural plan",
  "submission, return a JSON object with exactly these keys:",
  '  "projectType"         (short kebab-case label, e.g. "commercial-tenant-improvement")',
  '  "disciplines"         (subset of: building, electrical, mechanical, plumbing,',
  "                         residential, fire-life-safety, accessibility)",
  '  "applicableCodeBooks" (array of code-book labels, e.g. ["IBC 2021","NEC 2020"])',
  '  "confidence"          (number between 0 and 1)',
  "Return ONLY the JSON object — no preamble, no markdown fences.",
].join(" ");

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

export interface ClassificationResult {
  projectType: string | null;
  disciplines: PlanReviewDiscipline[];
  applicableCodeBooks: string[];
  confidence: number | null;
}

const EMPTY_CLASSIFICATION: ClassificationResult = {
  projectType: null,
  disciplines: [],
  applicableCodeBooks: [],
  confidence: null,
};

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
 * Concatenate the latest snapshot's sheet metadata + extracted
 * `content_body` text for the engagement parented to this
 * submission. Mirrors `gatherClassifierInputText` in
 * `artifacts/api-server/src/lib/classifySubmission.ts`. Empty string
 * when the engagement has no snapshot or no sheets.
 */
async function gatherClassifierInputText(
  db: BackfillDb,
  submissionId: string,
): Promise<string> {
  const subRows = await db
    .select({ engagementId: submissions.engagementId })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1);
  const sub = subRows[0];
  if (!sub) return "";
  const snapRows = await db
    .select({ id: snapshots.id })
    .from(snapshots)
    .where(eq(snapshots.engagementId, sub.engagementId))
    .orderBy(desc(snapshots.receivedAt))
    .limit(1);
  const snap = snapRows[0];
  if (!snap) return "";
  const sheetRows = await db
    .select({
      sheetNumber: sheets.sheetNumber,
      sheetName: sheets.sheetName,
      contentBody: sheets.contentBody,
    })
    .from(sheets)
    .where(eq(sheets.snapshotId, snap.id))
    .orderBy(sheets.sortOrder);
  if (sheetRows.length === 0) return "";
  const parts: string[] = [];
  for (const r of sheetRows) {
    const header = `${r.sheetNumber} — ${r.sheetName}`;
    if (r.contentBody && r.contentBody.trim().length > 0) {
      parts.push(`${header}\n${r.contentBody.trim()}`);
    } else {
      parts.push(header);
    }
  }
  const joined = parts.join("\n\n---\n\n");
  return joined.length > CLASSIFIER_PROMPT_TEXT_MAX_CHARS
    ? joined.slice(0, CLASSIFIER_PROMPT_TEXT_MAX_CHARS)
    : joined;
}

/**
 * Parse the model's JSON response into a {@link ClassificationResult}.
 * Mirrors `parseClassificationResponse` in api-server's
 * `classifySubmission.ts`. Tolerates leading/trailing prose around
 * the JSON object; drops unknown disciplines silently; clamps
 * confidence to [0,1] (out-of-range → null).
 */
export function parseClassificationResponse(raw: string): ClassificationResult {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return EMPTY_CLASSIFICATION;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return EMPTY_CLASSIFICATION;
  }
  if (!parsed || typeof parsed !== "object") return EMPTY_CLASSIFICATION;
  const obj = parsed as Record<string, unknown>;
  const projectType =
    typeof obj["projectType"] === "string" && obj["projectType"].trim()
      ? (obj["projectType"] as string).trim()
      : null;
  const disciplinesRaw = Array.isArray(obj["disciplines"])
    ? (obj["disciplines"] as unknown[])
    : [];
  const disciplines: PlanReviewDiscipline[] = [];
  const seen = new Set<PlanReviewDiscipline>();
  for (const v of disciplinesRaw) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (!isPlanReviewDiscipline(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    disciplines.push(trimmed);
  }
  const codesRaw = Array.isArray(obj["applicableCodeBooks"])
    ? (obj["applicableCodeBooks"] as unknown[])
    : [];
  const applicableCodeBooks: string[] = [];
  for (const v of codesRaw) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    applicableCodeBooks.push(trimmed);
  }
  let confidence: number | null = null;
  if (
    typeof obj["confidence"] === "number" &&
    Number.isFinite(obj["confidence"])
  ) {
    const c = obj["confidence"] as number;
    if (c >= 0 && c <= 1) confidence = c;
  }
  return { projectType, disciplines, applicableCodeBooks, confidence };
}

/** Minimal subset of the Anthropic SDK shape this script needs. */
interface AnthropicLikeClient {
  messages: {
    create: (args: unknown) => Promise<{
      content: ReadonlyArray<{ type: string; text?: string }>;
    }>;
  };
}

/**
 * Run the classifier against a submission. Mock mode returns the
 * deterministic empty result; anthropic mode prompts Sonnet 4.5 and
 * parses the JSON response.
 *
 * In anthropic mode the AI Integrations env vars must be set; the
 * lazy `createAnthropicClient` call throws if they're not.
 */
async function classifyOne(
  db: BackfillDb,
  submissionId: string,
  anthropic: boolean,
  client: AnthropicLikeClient | null,
): Promise<ClassificationResult> {
  if (!anthropic || !client) return EMPTY_CLASSIFICATION;

  const inputText = await gatherClassifierInputText(db, submissionId);
  if (!inputText) return EMPTY_CLASSIFICATION;

  const response = await client.messages.create({
    model: CLASSIFIER_ANTHROPIC_MODEL,
    max_tokens: CLASSIFIER_ANTHROPIC_MAX_TOKENS,
    system: CLASSIFIER_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: inputText }],
      },
    ],
  });
  const text = response.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("\n")
    .trim();
  if (!text) return EMPTY_CLASSIFICATION;
  return parseClassificationResponse(text);
}

/**
 * Append the matched pair of events for a backfilled classification.
 * Anchored against the submission entity (`submission.classified`)
 * AND the classification entity (`submission-classification.set`) to
 * stay consistent with the live classifier's emit pattern. Best-
 * effort: a transient append failure is logged but does not roll
 * back the row insert (rows are the source of truth, events are the
 * audit trail — locked decision #5).
 */
async function emitBackfillEvents(
  history: EventAnchoringService,
  submissionId: string,
  result: ClassificationResult,
): Promise<void> {
  const payload: Record<string, unknown> = {
    projectType: result.projectType,
    disciplines: result.disciplines,
    applicableCodeBooks: result.applicableCodeBooks,
    confidence: result.confidence,
    source: "auto",
    backfilled: true,
  };
  const actor = {
    kind: "system" as const,
    id: CLASSIFIER_BACKFILL_ACTOR_ID,
  };
  try {
    await history.appendEvent({
      entityType: "submission-classification",
      entityId: `classification:${submissionId}`,
      eventType: "submission-classification.set",
      actor,
      payload,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `submission-classification.set append failed for ${submissionId}:`,
      err instanceof Error ? err.message : err,
    );
  }
  try {
    await history.appendEvent({
      entityType: "submission",
      entityId: submissionId,
      eventType: "submission.classified",
      actor,
      payload,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `submission.classified append failed for ${submissionId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Run the backfill. Caller is responsible for env preparation when
 * `--anthropic` is set (the AI Integrations env vars). Tests inject
 * a fake `EventAnchoringService` to assert on appended events
 * without touching `atom_events`; production constructs a
 * `PostgresEventAnchoringService` over the same `db` so the
 * classification events land alongside live ones.
 *
 * Anthropic client is also injectable for tests so the LLM call is
 * deterministic; production passes `null` and the function lazily
 * resolves the integration client when `opts.anthropic` is true.
 */
export async function backfill(
  opts: CliOptions,
  db: BackfillDb = defaultDb,
  history?: EventAnchoringService,
  anthropicClient?: AnthropicLikeClient | null,
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

  // Lazily construct the Anthropic client only when needed and only
  // if the caller didn't inject one. The integrations module's
  // top-level code throws if env vars are missing — defer the import
  // until we know we're on the anthropic branch.
  let client: AnthropicLikeClient | null = anthropicClient ?? null;
  if (opts.anthropic && client === null && !opts.dryRun) {
    const integrations = await import("@workspace/integrations-anthropic-ai");
    client = integrations.createAnthropicClient() as AnthropicLikeClient;
  }

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
      const result = await classifyOne(
        db,
        submissionId,
        opts.anthropic,
        client,
      );
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

      await emitBackfillEvents(anchoring, submissionId, result);

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
