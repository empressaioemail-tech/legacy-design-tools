/**
 * Helpers for surfacing whether a jurisdiction reply on a submission
 * was backfilled (the user picked a past `respondedAt`) versus
 * recorded live (the server stamped the response moments after the
 * jurisdiction actually replied). Task #106.
 *
 * The threshold and the rendered copy are both pinned by a unit test
 * so a future product tweak (loosening the window, changing the
 * wording) is a single-edit change rather than a "grep across the
 * timeline UI" hunt.
 */

/**
 * Minimum gap between the user-picked `respondedAt` and the
 * server-stamped `responseRecordedAt` before the row is treated as a
 * backfill. One hour is well past any reasonable clock skew or
 * "reviewer replied a few minutes ago, you typed it in just now"
 * round-trip, while still being tight enough to flag a same-day
 * backfill (e.g. recording at 5pm a reply that came in at 9am).
 */
export const SUBMISSION_BACKFILL_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * Return a small "backfilled on <date>" annotation when the recorded
 * time is meaningfully later than the reply time, or `null` when the
 * two are close enough to treat as a live recording (no annotation
 * needed).
 *
 * Returns `null` if either timestamp is missing or unparseable so
 * pre-Task-#106 rows (no `responseRecordedAt`) and pending
 * submissions (no `respondedAt`) render unchanged.
 *
 * The recorded date is formatted via `toLocaleDateString()` rather
 * than `toLocaleString()` so the annotation stays compact in a row
 * that already shows the relative reply time.
 */
export function backfillAnnotation(
  respondedAt: string | null | undefined,
  responseRecordedAt: string | null | undefined,
): string | null {
  if (!respondedAt || !responseRecordedAt) return null;
  const respondedMs = new Date(respondedAt).getTime();
  const recordedMs = new Date(responseRecordedAt).getTime();
  if (Number.isNaN(respondedMs) || Number.isNaN(recordedMs)) return null;
  if (recordedMs - respondedMs <= SUBMISSION_BACKFILL_THRESHOLD_MS) {
    return null;
  }
  const recordedDate = new Date(responseRecordedAt).toLocaleDateString();
  return `backfilled on ${recordedDate}`;
}
