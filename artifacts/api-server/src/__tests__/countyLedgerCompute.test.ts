/**
 * Pure unit tests for L18 freshness stamps. No database.
 */
import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:5432/unused";
});

import { stampServedPayload, type CountyLedgerPayload } from "../countyLedgerCompute";

function emptyPayload(): CountyLedgerPayload {
  return {
    counties: [],
    manifestCells: [],
    railCapabilities: [],
    summary: {
      onboardedCount: 0,
      totalCounties: 0,
      staleCount: 0,
      rewarmUnsafeCount: 0,
      totalRails: 14,
      totalCells: 0,
      satisfiedCells: 0,
      satisfiedPresentCells: 0,
      satisfiedPresentPartialCells: 0,
      satisfiedAbsentCells: 0,
      texasCompletenessPct: 0,
    },
  };
}

describe("stampServedPayload", () => {
  it("adds computedAt, servedAt, and materializationAgeMs without mutating cells", () => {
    const payload = emptyPayload();
    const computedAt = new Date("2026-08-12T00:00:00.000Z");
    const servedAt = new Date("2026-08-14T12:00:00.000Z");
    const stamped = stampServedPayload(payload, computedAt, servedAt);
    expect(stamped.summary.computedAt).toBe("2026-08-12T00:00:00.000Z");
    expect(stamped.summary.servedAt).toBe("2026-08-14T12:00:00.000Z");
    expect(stamped.summary.materializationAgeMs).toBe(servedAt.getTime() - computedAt.getTime());
    expect(stamped.manifestCells).toEqual([]);
  });
});
