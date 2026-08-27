import { describe, expect, it } from "vitest";
import { deriveRunCostFromScope } from "./runCost.js";

describe("deriveRunCostFromScope", () => {
  it("derives all five cost fields from acquisition metadata", () => {
    const cost = deriveRunCostFromScope({
      computeMs: 12_000,
      terminalStatus: "complete",
      scopeSearched: {
        instrumentCount: 2,
        acquisition: {
          acquired: 2,
          purchaseCostCents: 700,
          pendingHumanCount: 1,
          methods: { capture: 2 },
        },
        indexHits: [{ recordingRef: "a" }, { recordingRef: "b" }],
      },
    });

    expect(cost.imageFeesCents).toBe(700);
    expect(cost.computeCents).toBe(12);
    expect(cost.instrumentCount).toBe(2);
    expect(cost.humanMinutes).toBe(5);
    expect(cost.totalCents).toBe(712);
    expect(cost.derivedAt).toMatch(/^\d{4}-/);
  });

  it("estimates human minutes on needs-human without pending count", () => {
    const cost = deriveRunCostFromScope({
      terminalStatus: "needs-human",
      scopeSearched: {
        mode: "index-search",
        missingInput: "ownerName",
      },
    });

    expect(cost.humanMinutes).toBe(5);
    expect(cost.instrumentCount).toBe(0);
    expect(cost.imageFeesCents).toBe(0);
  });

  it("reads projected purchase cost when acquisition block is absent", () => {
    const cost = deriveRunCostFromScope({
      terminalStatus: "awaiting-purchase-approval",
      scopeSearched: {
        projectedPurchaseCostCents: 6000,
        acquisition: {
          acquired: 0,
          purchaseCostCents: 6000,
          pendingHumanCount: 0,
          pendingPurchaseCount: 20,
        },
      },
    });

    expect(cost.imageFeesCents).toBe(6000);
    expect(cost.totalCents).toBe(6000);
  });
});
