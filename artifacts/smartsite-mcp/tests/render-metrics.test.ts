import { describe, expect, it } from "vitest";
import {
  recordMapRenderEvent,
  resetMapRenderMetricsForTests,
  snapshotMapRenderMetrics,
} from "../src/render-metrics.js";

describe("map render metrics (P-446)", () => {
  it("increments reason codes per host", () => {
    resetMapRenderMetricsForTests();
    recordMapRenderEvent("seat-a", "find_parcel", "no_map", "map_wiring_failed");
    recordMapRenderEvent("seat-a", "find_parcel", "card", "ok");
    const snap = snapshotMapRenderMetrics();
    expect(snap["seat-a"]?.total).toBe(2);
    expect(snap["seat-a"]?.byReason["map_wiring_failed"]).toBe(1);
    expect(snap["seat-a"]?.byOutcome.card).toBe(1);
  });
});
