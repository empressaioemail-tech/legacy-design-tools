/**
 * Submission auto-classifier (Track 1).
 *
 * Reads the latest snapshot's sheet rows for the engagement parented to
 * the given submission, gathers their metadata + extracted
 * `content_body` text, and asks the LLM (Claude Sonnet 4.5 in
 * production, deterministic mock in dev/CI) to emit:
 *   - `projectType`        — one short label (free text)
 *   - `disciplines`        — closed-set `PlanReviewDiscipline[]`
 *   - `applicableCodeBooks`— free-text array (e.g. "IBC 2021")
 *   - `confidence`         — 0..1
 *
 * Persists the result via `upsertSubmissionClassification` (auto path) or
 * `reclassifySubmission` (reviewer path) — both functions emit the
 * appropriate atom-events as a side-effect.
 *
 * Mock-mode behavior: returns a deterministic classification with empty
 * disciplines + codes and `confidence = null`, so dev/CI rows are
 * recognizably auto-tagged but never falsely confident.
 */

import { eq, desc } from "drizzle-orm";
import {
  db as ProdDb,
  submissions,
  snapshots,
  sheets,
  submissionClassifications,
  type SubmissionClassification,
} from "@workspace/db";
import {
  PLAN_REVIEW_DISCIPLINE_VALUES,
  type PlanReviewDiscipline,
  isPlanReviewDiscipline,
} from "@workspace/api-zod";
import type { EventAnchoringService } from "@workspace/empressa-atom";
import type { logger as Logger } from "./logger";
import { getClassificationLlmClient } from "./classificationLlmClient";
import {
  classificationAtomId,
  SUBMISSION_CLASSIFICATION_EVENT_TYPES,
} from "../atoms/submission-classification.atom";
import { CLASSIFIER_ACTOR_ID } from "@workspace/server-actor-ids";

/** Hard cap on the cover-sheet text we hand to the model. */
export const CLASSIFIER_PROMPT_TEXT_MAX_CHARS = 8000;

/** Pinned model — mirrors finding-engine / sheet-content-extractor. */
export const CLASSIFIER_ANTHROPIC_MODEL = "claude-sonnet-4-5";

/** Token budget for the classifier response. */
export const CLASSIFIER_ANTHROPIC_MAX_TOKENS = 800;

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

/** Minimal subset of the Anthropic SDK shape we depend on. */
interface AnthropicLikeClient {
  messages: {
    create: (args: unknown) => Promise<{
      content: ReadonlyArray<{ type: string; text?: string }>;
    }>;
  };
}

/** Stable system actor for auto-classifier writes. */
export const CLASSIFIER_AUTO_ACTOR = {
  kind: "system" as const,
  id: CLASSIFIER_ACTOR_ID,
};

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
  reqLog: typeof Logger,
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
  reqLog: typeof Logger,
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
  if (typeof obj["confidence"] === "number" && Number.isFinite(obj["confidence"])) {
    const c = obj["confidence"] as number;
    if (c >= 0 && c <= 1) confidence = c;
  }
  return { projectType, disciplines, applicableCodeBooks, confidence };
}

/**
 * Persist the auto-classifier's output. Idempotent: if a row already
 * exists for the submission, this is a no-op (the auto pass should not
 * overwrite a reviewer correction that already landed). Returns the
 * resulting row, or `null` if no write happened (existing reviewer
 * row preserved).
 *
 * Emits two events on a write:
 *   - `submission-classification.set` against the classification atom
 *   - `submission.classified` against the submission entity
 */
export async function upsertAutoClassification(
  submissionId: string,
  result: ClassificationResult,
  history: EventAnchoringService,
  reqLog: typeof Logger,
  dbInstance: typeof ProdDb = ProdDb,
): Promise<SubmissionClassification | null> {
  const existing = await dbInstance
    .select()
    .from(submissionClassifications)
    .where(eq(submissionClassifications.submissionId, submissionId))
    .limit(1);
  if (existing[0]) {
    reqLog.info(
      { submissionId, source: existing[0].source },
      "auto classification skipped — row already exists",
    );
    return null;
  }
  const now = new Date();
  const [row] = await dbInstance
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
    .returning();
  if (!row) {
    throw new Error("submission_classifications insert returned no row");
  }
  await emitClassificationEvents(history, {
    submissionId,
    classificationAtomId: classificationAtomId(submissionId),
    eventName: "submission.classified",
    actor: CLASSIFIER_AUTO_ACTOR,
    payload: {
      projectType: row.projectType,
      disciplines: row.disciplines,
      applicableCodeBooks: row.applicableCodeBooks,
      confidence: row.confidence == null ? null : Number(row.confidence),
      source: row.source,
    },
    reqLog,
  });
  return row;
}

/**
 * Emit the matched pair of events for a classification write:
 *   - `submission-classification.set` on the classification atom
 *   - `submission.classified` OR `submission.reclassified` on the
 *      submission entity (caller picks via `eventName`).
 */
export async function emitClassificationEvents(
  history: EventAnchoringService,
  params: {
    submissionId: string;
    classificationAtomId: string;
    eventName: "submission.classified" | "submission.reclassified";
    actor: { kind: "user" | "agent" | "system"; id: string };
    payload: Record<string, unknown>;
    reqLog: typeof Logger;
  },
): Promise<void> {
  try {
    await history.appendEvent({
      entityType: "submission-classification",
      entityId: params.classificationAtomId,
      eventType: SUBMISSION_CLASSIFICATION_EVENT_TYPES[0],
      actor: params.actor,
      payload: params.payload,
    });
  } catch (err) {
    params.reqLog.error(
      { err, submissionId: params.submissionId },
      "submission-classification.set event append failed",
    );
  }
  try {
    await history.appendEvent({
      entityType: "submission",
      entityId: params.submissionId,
      eventType: params.eventName,
      actor: params.actor,
      payload: params.payload,
    });
  } catch (err) {
    params.reqLog.error(
      { err, submissionId: params.submissionId, eventName: params.eventName },
      "submission lifecycle event append failed",
    );
  }
}
