import { describe, it, expect } from "vitest";
import { evaluateSmartFileFreshness } from "../atoms/smart-file.contract";

describe("smart-file STALE indicator", () => {
  it("fires when computedAt is backdated beyond threshold", () => {
    const servedAt = new Date().toISOString();
    const computedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const freshness = evaluateSmartFileFreshness({
      computedAt,
      servedAt,
      stalenessThresholdSeconds: 30 * 24 * 60 * 60,
    });
    expect(freshness.isStale).toBe(true);
  });

  it("stays silent when computedAt is recent", () => {
    const now = new Date().toISOString();
    const freshness = evaluateSmartFileFreshness({
      computedAt: now,
      servedAt: now,
      stalenessThresholdSeconds: 30 * 24 * 60 * 60,
    });
    expect(freshness.isStale).toBe(false);
  });
});
