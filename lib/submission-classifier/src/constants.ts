/**
 * Pinned constants for the submission-classifier (Track 1).
 *
 * These values control the LLM call shape. Changing any of them is a
 * **behavior change** the team should review together — model pin
 * affects cost + latency; max-tokens affects truncation; the system
 * prompt is the contract the model is held to and the parser
 * (`parseClassificationResponse`) was tested against.
 */

import { CLASSIFIER_ACTOR_ID } from "@workspace/server-actor-ids";

/** Hard cap on the cover-sheet text we hand to the model. */
export const CLASSIFIER_PROMPT_TEXT_MAX_CHARS = 8000;

/** Pinned model — mirrors finding-engine / sheet-content-extractor. */
export const CLASSIFIER_ANTHROPIC_MODEL = "claude-sonnet-4-5";

/** Token budget for the classifier response. */
export const CLASSIFIER_ANTHROPIC_MAX_TOKENS = 800;

/**
 * System prompt the model is held to. Changes here MUST be reflected
 * in `parseClassificationResponse` if they alter the expected JSON
 * shape — the parser's closed-set + range checks define the
 * "tolerance" surface around what the model emits.
 */
export const CLASSIFIER_SYSTEM_PROMPT = [
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

/**
 * Stable system actor for auto-classifier writes (the live
 * `submission.created` trigger path). Backfill operators use a
 * different actor (`classifier-backfill`) when they want deploy-log
 * greps to distinguish historical writes from live ones.
 */
export const CLASSIFIER_AUTO_ACTOR = {
  kind: "system" as const,
  id: CLASSIFIER_ACTOR_ID,
};
