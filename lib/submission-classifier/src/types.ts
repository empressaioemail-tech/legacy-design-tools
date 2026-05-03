/**
 * Public types for the submission-classifier (Track 1).
 *
 * These are extracted from the api-server's prior
 * `lib/classifySubmission.ts` so both the live auto-trigger and the
 * historical-inbox backfill script can consume the same shape
 * without drift.
 */

import type { PlanReviewDiscipline } from "@workspace/api-zod";

/**
 * Result of one classification pass.
 *
 *   - `projectType`        — short kebab-case label produced by the
 *                            model (free text). `null` on the
 *                            mock-mode / parse-error / no-input path.
 *   - `disciplines`        — closed-set `PlanReviewDiscipline[]`. The
 *                            parser drops unknown values silently so
 *                            a partial result is still useful.
 *   - `applicableCodeBooks`— free-form code-book labels (e.g.
 *                            `"IBC 2021"`, `"NEC 2020"`). Empty array
 *                            when the model omitted them.
 *   - `confidence`         — 0..1. `null` when the model omitted the
 *                            field or returned an out-of-range value.
 */
export interface ClassificationResult {
  projectType: string | null;
  disciplines: PlanReviewDiscipline[];
  applicableCodeBooks: string[];
  confidence: number | null;
}

/**
 * The deterministic fallback returned when the classifier has no
 * Anthropic client wired (mock mode), no input text, an LLM-call
 * failure, or a parse error. Exposed as a constant so callers
 * (the backfill script in particular) can short-circuit safely.
 */
export const EMPTY_CLASSIFICATION: ClassificationResult = {
  projectType: null,
  disciplines: [],
  applicableCodeBooks: [],
  confidence: null,
};

/**
 * Minimal logger shape the classifier uses. Pino satisfies this
 * structurally; tests can pass `console`-shaped objects too. Keeping
 * the interface narrow lets the lib avoid a hard dep on the
 * api-server's pino instance.
 */
export interface ClassifierLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}
