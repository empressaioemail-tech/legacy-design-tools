import { describe, expect, it } from "vitest";
import {
  BACKFILL_FILTER_QUERY_PARAM,
  SUBMISSION_BACKFILL_THRESHOLD_MS,
  backfillAnnotation,
  isBackfilledResponse,
  matchesBackfillFilter,
  parseBackfillFilter,
} from "../submissionBackfill";

/**
 * Pin the threshold and the rendered copy so a future product tweak
 * (loosening the window, changing the wording) is a single-edit
 * change rather than a hunt across the timeline UI. Task #106.
 */
describe("backfillAnnotation", () => {
  it("pins the threshold at one hour", () => {
    // The threshold is the load-bearing constant — if a future change
    // wants to loosen or tighten the window, this test forces it to
    // be an explicit decision rather than an accidental drift.
    expect(SUBMISSION_BACKFILL_THRESHOLD_MS).toBe(60 * 60 * 1000);
  });

  it("returns null when the recorded time is within the threshold (live recording)", () => {
    // 30 minutes between reply and recording — below the 1-hour
    // threshold, so the row should render as a live recording with
    // no extra annotation.
    const respondedAt = "2026-04-15T10:00:00.000Z";
    const responseRecordedAt = "2026-04-15T10:30:00.000Z";
    expect(backfillAnnotation(respondedAt, responseRecordedAt)).toBeNull();
  });

  it("returns null at exactly the threshold (boundary is exclusive of the annotation)", () => {
    // Exactly 1 hour apart — still treated as live so a server clock
    // sync hiccup at the boundary doesn't flip the row to backfilled.
    const respondedAt = "2026-04-15T10:00:00.000Z";
    const responseRecordedAt = "2026-04-15T11:00:00.000Z";
    expect(backfillAnnotation(respondedAt, responseRecordedAt)).toBeNull();
  });

  it("returns null when the recorded time is earlier than the reply (clock skew, future-dated)", () => {
    // Defensive: a later sister task pins server-side rejection of
    // future-dated `respondedAt`, but if a row somehow has one, we
    // should still not render a misleading "backfilled in the past"
    // annotation.
    const respondedAt = "2026-04-15T12:00:00.000Z";
    const responseRecordedAt = "2026-04-15T10:00:00.000Z";
    expect(backfillAnnotation(respondedAt, responseRecordedAt)).toBeNull();
  });

  it("renders 'backfilled on <date>' when the gap exceeds the threshold", () => {
    // Reply landed last Tuesday, recorded into the system this
    // morning — 5 days apart, well beyond the threshold.
    const respondedAt = "2026-04-10T14:30:00.000Z";
    const responseRecordedAt = "2026-04-15T09:00:00.000Z";
    const annotation = backfillAnnotation(respondedAt, responseRecordedAt);
    // Pin the rendered copy. The date is locale-formatted via
    // `toLocaleDateString()` so we just assert the prefix and that
    // the recorded date string appears verbatim — that way the test
    // is timezone-independent without skipping the copy assertion.
    const expectedDate = new Date(responseRecordedAt).toLocaleDateString();
    expect(annotation).toBe(`backfilled on ${expectedDate}`);
  });

  it("returns null when either timestamp is missing (pending row, pre-Task-#106 row)", () => {
    expect(backfillAnnotation(null, "2026-04-15T09:00:00.000Z")).toBeNull();
    expect(backfillAnnotation("2026-04-15T09:00:00.000Z", null)).toBeNull();
    expect(backfillAnnotation(null, null)).toBeNull();
    expect(backfillAnnotation(undefined, undefined)).toBeNull();
  });

  it("returns null when either timestamp is unparseable", () => {
    expect(backfillAnnotation("not-a-date", "2026-04-15T09:00:00.000Z")).toBeNull();
    expect(backfillAnnotation("2026-04-15T09:00:00.000Z", "not-a-date")).toBeNull();
  });
});

/**
 * Pin the URL-param key, parser, and the three filter modes so the
 * engagement-timeline backfill chips (Task #124) keep filtering in
 * sync with the visible "backfilled on" annotation. If a future
 * change loosens the threshold, both `backfillAnnotation` and the
 * `live`/`backfilled` modes must move together — these tests catch
 * any drift between the two.
 */
describe("backfill filter (Task #124)", () => {
  // Three reference rows, sized off the same threshold the
  // annotation tests above use:
  //   - `pendingRow` has neither a respondedAt nor a responseRecordedAt.
  //   - `liveRow` was recorded 30 minutes after the reply (within the
  //     1-hour threshold, so it renders without a backfill annotation).
  //   - `backfilledRow` was recorded 5 days after the reply (well past
  //     the threshold, so it would render the annotation).
  const pendingRow = { respondedAt: null, responseRecordedAt: null };
  const liveRow = {
    respondedAt: "2026-04-15T10:00:00.000Z",
    responseRecordedAt: "2026-04-15T10:30:00.000Z",
  };
  const backfilledRow = {
    respondedAt: "2026-04-10T14:30:00.000Z",
    responseRecordedAt: "2026-04-15T09:00:00.000Z",
  };

  it("pins the URL-param key", () => {
    // The chip's URL persistence key is part of the deep-link
    // contract; renaming it would silently break bookmarks.
    expect(BACKFILL_FILTER_QUERY_PARAM).toBe("reply");
  });

  describe("parseBackfillFilter", () => {
    it("accepts each known mode verbatim", () => {
      expect(parseBackfillFilter("all")).toBe("all");
      expect(parseBackfillFilter("backfilled")).toBe("backfilled");
      expect(parseBackfillFilter("live")).toBe("live");
    });

    it("falls back to 'all' for missing or unknown values", () => {
      expect(parseBackfillFilter(null)).toBe("all");
      expect(parseBackfillFilter(undefined)).toBe("all");
      expect(parseBackfillFilter("")).toBe("all");
      expect(parseBackfillFilter("BACKFILLED")).toBe("all");
      expect(parseBackfillFilter("anything-else")).toBe("all");
    });
  });

  describe("isBackfilledResponse", () => {
    it("agrees with backfillAnnotation on every row shape", () => {
      // The chip filter and the inline annotation must answer the
      // same question — pin the equivalence so a future tweak to one
      // doesn't silently drift away from the other.
      for (const row of [pendingRow, liveRow, backfilledRow]) {
        expect(
          isBackfilledResponse(row.respondedAt, row.responseRecordedAt),
        ).toBe(
          backfillAnnotation(row.respondedAt, row.responseRecordedAt) !== null,
        );
      }
      expect(isBackfilledResponse(pendingRow.respondedAt, pendingRow.responseRecordedAt)).toBe(false);
      expect(isBackfilledResponse(liveRow.respondedAt, liveRow.responseRecordedAt)).toBe(false);
      expect(isBackfilledResponse(backfilledRow.respondedAt, backfilledRow.responseRecordedAt)).toBe(true);
    });
  });

  describe("matchesBackfillFilter", () => {
    it("'all' shows every row regardless of reply state", () => {
      // 'all' is the default — every row in the timeline must pass
      // through, including pending rows that have no reply yet.
      for (const row of [pendingRow, liveRow, backfilledRow]) {
        expect(
          matchesBackfillFilter(
            "all",
            row.respondedAt,
            row.responseRecordedAt,
          ),
        ).toBe(true);
      }
    });

    it("'backfilled' shows only rows past the backfill threshold", () => {
      expect(
        matchesBackfillFilter(
          "backfilled",
          pendingRow.respondedAt,
          pendingRow.responseRecordedAt,
        ),
      ).toBe(false);
      expect(
        matchesBackfillFilter(
          "backfilled",
          liveRow.respondedAt,
          liveRow.responseRecordedAt,
        ),
      ).toBe(false);
      expect(
        matchesBackfillFilter(
          "backfilled",
          backfilledRow.respondedAt,
          backfilledRow.responseRecordedAt,
        ),
      ).toBe(true);
    });

    it("'live' shows only rows whose reply was recorded close to the actual reply", () => {
      // Pending rows must be excluded — 'live' answers the
      // affirmative question "show me live replies" rather than the
      // negative "everything that isn't backfilled".
      expect(
        matchesBackfillFilter(
          "live",
          pendingRow.respondedAt,
          pendingRow.responseRecordedAt,
        ),
      ).toBe(false);
      expect(
        matchesBackfillFilter(
          "live",
          liveRow.respondedAt,
          liveRow.responseRecordedAt,
        ),
      ).toBe(true);
      expect(
        matchesBackfillFilter(
          "live",
          backfilledRow.respondedAt,
          backfilledRow.responseRecordedAt,
        ),
      ).toBe(false);
    });

    it("treats a row with respondedAt but no responseRecordedAt as live (pre-Task-#106 history)", () => {
      // Older rows recorded before Task #106 shipped don't carry a
      // `responseRecordedAt`. Treating them as live (rather than
      // backfilled) preserves the inline annotation's behaviour and
      // avoids a phantom "backfilled" badge on legacy data.
      const legacyRow = {
        respondedAt: "2025-12-01T10:00:00.000Z",
        responseRecordedAt: null,
      };
      expect(
        matchesBackfillFilter(
          "live",
          legacyRow.respondedAt,
          legacyRow.responseRecordedAt,
        ),
      ).toBe(true);
      expect(
        matchesBackfillFilter(
          "backfilled",
          legacyRow.respondedAt,
          legacyRow.responseRecordedAt,
        ),
      ).toBe(false);
    });
  });
});
