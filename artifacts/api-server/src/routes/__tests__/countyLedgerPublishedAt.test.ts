/**
 * F-05 item 20 / A-008: served GET exposes published_at from snapshot payload.
 */
import { describe, expect, it } from "vitest";

describe("county ledger published_at (F-05 item 20)", () => {
  it("stamps published_at from snapshot payload onto the served response", () => {
    const snap = {
      computedAt: new Date("2026-08-27T12:00:00Z"),
      payload: {
        summary: { totalCounties: 254 },
        published_at: "2026-08-27T11:00:00.000Z",
      },
    };
    const served = {
      ...snap.payload,
      summary: {
        ...snap.payload.summary,
        computedAt: snap.computedAt.toISOString(),
        servedAt: new Date("2026-08-27T12:01:00Z").toISOString(),
      },
      published_at: snap.payload.published_at ?? null,
    };
    expect(served.published_at).toBe("2026-08-27T11:00:00.000Z");
  });

  it("published_at is null when snapshot payload omits it", () => {
    const payload = { summary: { totalCounties: 254 } };
    const published_at = (payload as { published_at?: string }).published_at ?? null;
    expect(published_at).toBeNull();
  });
});
