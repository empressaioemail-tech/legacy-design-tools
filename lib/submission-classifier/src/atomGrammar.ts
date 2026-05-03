/**
 * Identity grammar + event vocabulary for the
 * `submission-classification` atom (Track 1).
 *
 * Extracted from the api-server's
 * `atoms/submission-classification.atom.ts` so the backfill script
 * (and any future consumer that emits a `submission-classification.set`
 * event) can write the same atom-id format and event types without
 * importing the atom-registry registration code.
 *
 * The atom registration itself stays in api-server — it carries the
 * `contextSummary` resolver shape that empressa-atom expects, and
 * that's tightly bound to the api-server's atom registry. This file
 * exposes only the small constants downstream callers need.
 */

/**
 * Prefixed entityId grammar — `classification:{submissionId}`.
 * Mirrors the `finding:{submissionId}:{rowUuid}` convention used by
 * the finding atom.
 */
export function classificationAtomId(submissionId: string): string {
  return `classification:${submissionId}`;
}

/** Inverse: parse `classification:{uuid}` → uuid. Returns null on miss. */
export function submissionIdFromClassificationAtomId(
  atomId: string,
): string | null {
  const prefix = "classification:";
  if (!atomId.startsWith(prefix)) return null;
  const rest = atomId.slice(prefix.length);
  if (!rest) return null;
  return rest;
}

/**
 * Event vocabulary the `submission-classification` atom is allowed
 * to emit on its own chain. Single entry today
 * (`submission-classification.set`), exposed as a tuple so callers
 * use indexed access for the event-type literal — keeps a future
 * rename a compile error rather than a silent string-typo.
 */
export const SUBMISSION_CLASSIFICATION_EVENT_TYPES = [
  "submission-classification.set",
] as const;

export type SubmissionClassificationEventType =
  (typeof SUBMISSION_CLASSIFICATION_EVENT_TYPES)[number];
