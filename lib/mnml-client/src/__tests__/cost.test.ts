/**
 * Unit tests for the pure cost-estimate helpers.
 *
 * Coverage:
 *   - estimateRenderCost for each domain kind (still / elevation-set / video)
 *   - Breakdown shape (single-entry array, kind / count / creditsPerCall / subtotal)
 *   - Cost arithmetic matches Spec 54 v2 §4 (3 cr archdiff, 10 cr video)
 *   - Elevation-set fan-out math (4 × 3 = 12)
 *   - actualDebitedCredits for partial-trigger scenarios (0 / 1 / 2 / 4 successes)
 *   - actualDebitedCredits rejects negative triggeredCount
 *   - RENDER_COST_CREDITS export shape (single source of truth)
 */

import { describe, expect, it } from "vitest";
import {
  RENDER_COST_CREDITS,
  actualDebitedCredits,
  estimateRenderCost,
} from "../cost";

describe("RENDER_COST_CREDITS", () => {
  it("exposes the Spec 54 v2 §4 static table", () => {
    expect(RENDER_COST_CREDITS).toEqual({
      archdiffusion: 3,
      video: 10,
    });
  });
});

describe("estimateRenderCost — domain kinds", () => {
  it("still → 1 archdiffusion × 3 = 3 credits", () => {
    const e = estimateRenderCost({ kind: "still" });
    expect(e.credits).toBe(3);
    expect(e.breakdown).toEqual([
      { kind: "archdiffusion", count: 1, creditsPerCall: 3, subtotal: 3 },
    ]);
  });

  it("elevation-set → 4 archdiffusion × 3 = 12 credits", () => {
    const e = estimateRenderCost({ kind: "elevation-set" });
    expect(e.credits).toBe(12);
    expect(e.breakdown).toEqual([
      { kind: "archdiffusion", count: 4, creditsPerCall: 3, subtotal: 12 },
    ]);
  });

  it("video → 1 video-ai × 10 = 10 credits", () => {
    const e = estimateRenderCost({ kind: "video" });
    expect(e.credits).toBe(10);
    expect(e.breakdown).toEqual([
      { kind: "video", count: 1, creditsPerCall: 10, subtotal: 10 },
    ]);
  });

  it("breakdown is always a single-entry array in V1-4 (one wire kind per kickoff)", () => {
    expect(estimateRenderCost({ kind: "still" }).breakdown).toHaveLength(1);
    expect(estimateRenderCost({ kind: "elevation-set" }).breakdown).toHaveLength(1);
    expect(estimateRenderCost({ kind: "video" }).breakdown).toHaveLength(1);
  });

  it("subtotal === creditsPerCall × count in every breakdown entry", () => {
    for (const kind of ["still", "elevation-set", "video"] as const) {
      const e = estimateRenderCost({ kind });
      for (const entry of e.breakdown) {
        expect(entry.subtotal).toBe(entry.creditsPerCall * entry.count);
      }
    }
  });

  it("credits === sum of breakdown subtotals", () => {
    for (const kind of ["still", "elevation-set", "video"] as const) {
      const e = estimateRenderCost({ kind });
      const sum = e.breakdown.reduce((acc, b) => acc + b.subtotal, 0);
      expect(e.credits).toBe(sum);
    }
  });
});

describe("actualDebitedCredits — elevation-set partial-debit", () => {
  it("0 successful triggers → 0 credits consumed", () => {
    expect(
      actualDebitedCredits({ kind: "elevation-set", triggeredCount: 0 }),
    ).toEqual({ creditsConsumed: 0 });
  });

  it("1 of 4 elevation-set children triggered → 3 credits consumed", () => {
    expect(
      actualDebitedCredits({ kind: "elevation-set", triggeredCount: 1 }),
    ).toEqual({ creditsConsumed: 3 });
  });

  it("2 of 4 elevation-set children triggered → 6 credits consumed (partial-debit case)", () => {
    expect(
      actualDebitedCredits({ kind: "elevation-set", triggeredCount: 2 }),
    ).toEqual({ creditsConsumed: 6 });
  });

  it("4 of 4 elevation-set children triggered → 12 credits consumed (full debit)", () => {
    expect(
      actualDebitedCredits({ kind: "elevation-set", triggeredCount: 4 }),
    ).toEqual({ creditsConsumed: 12 });
  });

  it("video kind uses the video price (10/call)", () => {
    expect(
      actualDebitedCredits({ kind: "video", triggeredCount: 1 }),
    ).toEqual({ creditsConsumed: 10 });
  });

  it("still kind uses the archdiffusion price (3/call)", () => {
    expect(
      actualDebitedCredits({ kind: "still", triggeredCount: 1 }),
    ).toEqual({ creditsConsumed: 3 });
  });

  it("rejects negative triggeredCount with RangeError", () => {
    expect(() =>
      actualDebitedCredits({ kind: "still", triggeredCount: -1 }),
    ).toThrow(RangeError);
  });
});
