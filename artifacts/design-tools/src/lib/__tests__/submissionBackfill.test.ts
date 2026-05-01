import { describe, expect, it } from "vitest";
import {
  SUBMISSION_BACKFILL_THRESHOLD_MS,
  backfillAnnotation,
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
