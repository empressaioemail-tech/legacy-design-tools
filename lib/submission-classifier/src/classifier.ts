/**
 * Submission auto-classifier core (Track 1).
 *
 * Reads the latest snapshot's sheet rows for the engagement parented
 * to the given submission, gathers their metadata + extracted
 * `content_body` text, and asks the LLM (Claude Sonnet 4.5 in
 * production, deterministic mock in dev/CI) to emit:
 *   - `projectType`        — one short label (free text)
 *   - `disciplines`        — closed-set `PlanReviewDiscipline[]`
 *   - `applicableCodeBooks`— free-text array (e.g. "IBC 2021")
 *   - `confidence`         — 0..1
 *
 * Mock-mode behavior: returns `EMPTY_CLASSIFICATION` (empty
 * disciplines + codes, null project type and confidence) so dev / CI
 * rows are recognizably auto-tagged but never falsely confident.
 *
 * Failure handling: every LLM-call exception, parse error, or
 * input-gather throw collapses to `EMPTY_CLASSIFICATION` rather than
 * propagating, because the live caller is a fire-and-forget hook on
 * `submission.created` and the backfill is a one-shot operator
 * script — neither can afford a transient failure to cascade.
 */

import { eq, desc } from "drizzle-orm";
import {
  db as ProdDb,
  submissions,
  snapshots,
  sheets,
} from "@workspace/db";
import {
  type PlanReviewDiscipline,
  isPlanReviewDiscipline,
} from "@workspace/api-zod";
import {
  CLASSIFIER_ANTHROPIC_MAX_TOKENS,
  CLASSIFIER_ANTHROPIC_MODEL,
  CLASSIFIER_PROMPT_TEXT_MAX_CHARS,
  CLASSIFIER_SYSTEM_PROMPT,
} from "./constants";
import { getClassificationLlmClient } from "./llmClient";
import {
  EMPTY_CLASSIFICATION,
  type ClassificationResult,
  type ClassifierLogger,
} from "./types";

/** Minimal subset of the Anthropic SDK shape we depend on. */
interface AnthropicLikeClient {
  messages: {
    create: (args: unknown) => Promise<{
      content: ReadonlyArray<{ type: string; text?: string }>;
    }>;
  };
}

/**
 * Gather the cover-sheet text + sheet metadata for a submission. Reads
 * the most recent snapshot for the parent engagement and concatenates
 * sheet number/name + non-null `content_body` up to the prompt budget.
 */
export async function gatherClassifierInputText(
  submissionId: string,
  dbInstance: typeof ProdDb = ProdDb,
): Promise<string> {
  const subRows = await dbInstance
    .select({ engagementId: submissions.engagementId })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1);
  const sub = subRows[0];
  if (!sub) return "";
  const snapRows = await dbInstance
    .select({ id: snapshots.id })
    .from(snapshots)
    .where(eq(snapshots.engagementId, sub.engagementId))
    .orderBy(desc(snapshots.receivedAt))
    .limit(1);
  const snap = snapRows[0];
  if (!snap) return "";
  const sheetRows = await dbInstance
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
 * Run the classifier against a submission. Returns the deterministic
 * mock result when no Anthropic client is wired (default in dev/CI);
 * otherwise prompts the model and parses the JSON response. Failures
 * (network, parse, validation) collapse to the mock result so the
 * fire-and-forget pipeline never throws.
 */
export async function classifySubmission(
  submissionId: string,
  reqLog: ClassifierLogger,
  dbInstance: typeof ProdDb = ProdDb,
): Promise<ClassificationResult> {
  const client = (await getClassificationLlmClient()) as
    | AnthropicLikeClient
    | null;
  if (!client) {
    return EMPTY_CLASSIFICATION;
  }
  let inputText: string;
  try {
    inputText = await gatherClassifierInputText(submissionId, dbInstance);
  } catch (err) {
    reqLog.warn(
      { err, submissionId },
      "classifier input gather failed — falling back to empty classification",
    );
    return EMPTY_CLASSIFICATION;
  }
  if (!inputText) {
    return EMPTY_CLASSIFICATION;
  }

  let response: { content: ReadonlyArray<{ type: string; text?: string }> };
  try {
    response = await client.messages.create({
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
  } catch (err) {
    reqLog.warn(
      { err, submissionId },
      "classifier LLM call threw — falling back to empty classification",
    );
    return EMPTY_CLASSIFICATION;
  }

  const text = response.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("\n")
    .trim();
  if (!text) return EMPTY_CLASSIFICATION;

  return parseClassificationResponse(text, reqLog, submissionId);
}

/**
 * Parse the model's JSON response into a {@link ClassificationResult}.
 * Tolerates leading/trailing prose by greedily extracting the first
 * JSON object substring. Any value that fails the closed-set /
 * type / range check is dropped silently — a partial result is more
 * useful than a hard fail.
 */
export function parseClassificationResponse(
  raw: string,
  reqLog: ClassifierLogger,
  submissionId: string,
): ClassificationResult {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    reqLog.warn(
      { submissionId, raw: raw.slice(0, 200) },
      "classifier response had no JSON object — empty classification",
    );
    return EMPTY_CLASSIFICATION;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    reqLog.warn(
      { err, submissionId, raw: raw.slice(0, 200) },
      "classifier response was not valid JSON — empty classification",
    );
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
