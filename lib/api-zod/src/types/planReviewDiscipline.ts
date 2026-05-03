/**
 * Track 1 — `PlanReviewDiscipline` enum: the 7-value ICC-aligned
 * reviewer-certification vocabulary.
 *
 * This is **reviewer certification discipline**. It is NOT the same as
 * `submissions.discipline` (4-value: building/fire/zoning/civil — owned
 * by `lib/db/src/schema/submissions.ts`) and it is NOT the same as the
 * 7-value sheet-set department tokens in
 * `lib/portal-ui/src/styles/plan-review-disciplines.css`. Three vocabularies
 * coexist by design; do not collapse them.
 *
 * Surfaces that carry `PlanReviewDiscipline[]`:
 *   - `users.disciplines` (DB column; reviewer profile)
 *   - `submission_classifications.disciplines` (DB column; auto-classifier
 *     + reviewer correction)
 *   - The reviewer-queue / canned-findings "default-filter to my disciplines"
 *     query parameter
 *
 * CT mirrors this set into `lib/api-spec/openapi.yaml` so the regenerated
 * `api-client-react` surfaces the canonical TS type to FE consumers.
 * Keep the OpenAPI mirror in lock-step with the tuple below — they share
 * the source-of-truth role; this TS file is the canonical TS-side
 * declaration.
 */

import { z } from "zod";

export const PLAN_REVIEW_DISCIPLINE_VALUES = [
  "building",
  "electrical",
  "mechanical",
  "plumbing",
  "residential",
  "fire-life-safety",
  "accessibility",
] as const;

export type PlanReviewDiscipline = (typeof PLAN_REVIEW_DISCIPLINE_VALUES)[number];

export const PlanReviewDisciplineSchema = z.enum(PLAN_REVIEW_DISCIPLINE_VALUES);

export function isPlanReviewDiscipline(v: unknown): v is PlanReviewDiscipline {
  return (
    typeof v === "string" &&
    (PLAN_REVIEW_DISCIPLINE_VALUES as readonly string[]).includes(v)
  );
}
