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

/**
 * Reviewer-facing filter modes for the engagement timeline of past
 * submissions. Task #124. The values double as the URL-param values
 * so a deep link survives a page refresh.
 *
 * - `all` — no filter, every row is shown (the default).
 * - `backfilled` — only rows whose jurisdiction reply was backfilled
 *   (the user picked a past `respondedAt`, recorded later).
 * - `live` — only rows whose reply was recorded close to the actual
 *   reply time (no backfill annotation). Pending rows (no reply at
 *   all) are excluded so the filter answers "show me live replies"
 *   rather than "everything that isn't backfilled".
 */
export type BackfillFilter = "all" | "backfilled" | "live";

/**
 * URL search-param key used to persist the engagement timeline's
 * backfill filter (Task #124). Pinned as a constant so the page,
 * the tests, and any future deep-link helpers stay in lock-step.
 *
 * Named `reply` rather than `backfill` because the chips read as
 * "Backfilled replies / Live replies / All replies" — the param
 * mirrors what the user is filtering rather than the implementation
 * detail.
 */
export const BACKFILL_FILTER_QUERY_PARAM = "reply";

/**
 * Coerce an arbitrary URL-param value into a known {@link BackfillFilter}.
 * Unknown / missing values resolve to `"all"` so a stale or
 * hand-edited link can't push the timeline into an undefined state.
 */
export function parseBackfillFilter(
  raw: string | null | undefined,
): BackfillFilter {
  if (raw === "backfilled" || raw === "live" || raw === "all") return raw;
  return "all";
}

/**
 * True when this row's reply meets the threshold for being treated
 * as a backfill (see {@link backfillAnnotation}). Returns `false`
 * for pending rows, missing timestamps, and live recordings — i.e.
 * it's `true` exactly when the row would render the "backfilled on
 * <date>" annotation.
 */
export function isBackfilledResponse(
  respondedAt: string | null | undefined,
  responseRecordedAt: string | null | undefined,
): boolean {
  return backfillAnnotation(respondedAt, responseRecordedAt) !== null;
}

/**
 * Decide whether a given submission row should be visible under the
 * active {@link BackfillFilter}. Defined as a pure helper so the
 * filtering rules are unit-tested in one place rather than re-derived
 * inline in the timeline component.
 *
 * Pending rows (no `respondedAt`) are intentionally hidden from both
 * the `backfilled` and `live` modes — the chips read as "show me
 * <kind> replies", and a row with no reply yet is neither.
 */
export function matchesBackfillFilter(
  filter: BackfillFilter,
  respondedAt: string | null | undefined,
  responseRecordedAt: string | null | undefined,
): boolean {
  if (filter === "all") return true;
  const backfilled = isBackfilledResponse(respondedAt, responseRecordedAt);
  if (filter === "backfilled") return backfilled;
  // `live` — must have a reply, and that reply must not be flagged
  // as backfilled.
  return respondedAt != null && !backfilled;
}

/**
 * Bucket counts of jurisdiction replies on the engagement timeline,
 * surfaced as a glanceable "live · backfilled · pending" tally above
 * the list (Task #136). The three buckets partition the rows the same
 * way the chip filter does, so the summary line and the chips can
 * never disagree:
 *
 * - `pending` — no `respondedAt` yet (matches the `pending` row
 *   rendering and is excluded from both `live` and `backfilled`
 *   chips).
 * - `backfilled` — `isBackfilledResponse` is true (matches the chip
 *   and the inline "backfilled on <date>" annotation).
 * - `live` — has a `respondedAt` and is not flagged as backfilled
 *   (matches the `live` chip; legacy rows missing
 *   `responseRecordedAt` count as live, same as the chip filter).
 */
export type BackfillTallies = {
  live: number;
  backfilled: number;
  pending: number;
};

/**
 * Summarize an array of submission-shaped rows into the three
 * timeline buckets. Pure helper so the tally line, the chip filter,
 * and the inline annotation share one source of truth — see
 * {@link BackfillTallies}.
 *
 * Accepts a structurally-typed row so callers can pass either the
 * raw API row or a `{ respondedAt, responseRecordedAt }` projection
 * built from the local optimistic mirror without an extra adapter.
 */
export function summarizeBackfillTallies(
  rows: ReadonlyArray<{
    respondedAt: string | null | undefined;
    responseRecordedAt: string | null | undefined;
  }>,
): BackfillTallies {
  let live = 0;
  let backfilled = 0;
  let pending = 0;
  for (const row of rows) {
    if (row.respondedAt == null) {
      pending += 1;
    } else if (isBackfilledResponse(row.respondedAt, row.responseRecordedAt)) {
      backfilled += 1;
    } else {
      live += 1;
    }
  }
  return { live, backfilled, pending };
}

/**
 * Render the tally as the compact summary line shown above the
 * timeline (e.g. `"3 live · 2 backfilled · 1 pending"`). Centralised
 * so the wording — including the middle-dot separator and the
 * always-three-buckets shape (zeroes are kept rather than hidden so
 * the line doesn't visually shift between renders) — is pinned by
 * its unit test rather than re-derived inline in the page.
 */
export function formatBackfillTally(tallies: BackfillTallies): string {
  return `${tallies.live} live · ${tallies.backfilled} backfilled · ${tallies.pending} pending`;
}
