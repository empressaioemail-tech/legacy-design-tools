/**
 * Reviewer-discipline label + dept-token maps for the seven ICC-aligned
 * `PlanReviewDiscipline` values. Track 1 — see the dispatch addendum
 * D1 for the canonical decision.
 *
 * IMPORTANT: this file does NOT own the `PlanReviewDiscipline` enum —
 * the source-of-truth lives in `@workspace/api-zod` and BE/CT will
 * land it as part of Track 1 Pass A. Until that contract change
 * lands, the enum is scaffolded locally here so the FE can compile;
 * the swap to `import { PlanReviewDiscipline } from "@workspace/api-zod"`
 * is its own commit (commit 6 — `feat(plan-review): wire Track 1
 * surfaces to live API`).
 */

// SCAFFOLD — replace with `import { PlanReviewDiscipline } from "@workspace/api-zod"`
// once CT lands the regenerated zod schemas. The seven values + their
// ordering match the addendum D1 list verbatim.
export type PlanReviewDiscipline =
  | "building"
  | "electrical"
  | "mechanical"
  | "plumbing"
  | "residential"
  | "fire-life-safety"
  | "accessibility";

export const PLAN_REVIEW_DISCIPLINES: ReadonlyArray<PlanReviewDiscipline> = [
  "building",
  "electrical",
  "mechanical",
  "plumbing",
  "residential",
  "fire-life-safety",
  "accessibility",
] as const;

/**
 * Display labels for the chip-bar / badge / banner copy. Spelled out
 * per the addendum (e.g. `fire-life-safety` reads as "Fire/Life Safety").
 */
export const PLAN_REVIEW_DISCIPLINE_LABELS: Record<
  PlanReviewDiscipline,
  string
> = {
  building: "Building",
  electrical: "Electrical",
  mechanical: "Mechanical",
  plumbing: "Plumbing",
  residential: "Residential",
  "fire-life-safety": "Fire/Life Safety",
  accessibility: "Accessibility",
};

/**
 * Map each reviewer discipline to the closest existing dept-* CSS
 * token from `lib/portal-ui/src/styles/plan-review-disciplines.css` so
 * the badge can render the right palette without us having to add
 * seven new CSS rules in this slice. A future sprint may introduce
 * dedicated reviewer-discipline tokens; not Track 1.
 *
 * Decisions per the addendum D1:
 *  - building / residential / accessibility → architectural (orange)
 *  - electrical / mechanical / plumbing     → mep (purple)
 *  - fire-life-safety                        → fire-life-safety (red)
 */
export const PLAN_REVIEW_DISCIPLINE_DEPT_TOKEN: Record<
  PlanReviewDiscipline,
  string
> = {
  building: "dept-architectural",
  residential: "dept-architectural",
  accessibility: "dept-architectural",
  electrical: "dept-mep",
  mechanical: "dept-mep",
  plumbing: "dept-mep",
  "fire-life-safety": "dept-fire-life-safety",
};

/**
 * Type-guard for unknown strings off the wire. Used when reading a
 * persisted localStorage value (which may be from an older build) so
 * we drop unknown disciplines silently rather than blowing up.
 */
export function isPlanReviewDiscipline(
  value: unknown,
): value is PlanReviewDiscipline {
  return (
    typeof value === "string" &&
    (PLAN_REVIEW_DISCIPLINES as ReadonlyArray<string>).includes(value)
  );
}
