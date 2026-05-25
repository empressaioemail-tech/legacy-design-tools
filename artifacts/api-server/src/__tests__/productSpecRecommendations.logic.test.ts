import { describe, it, expect } from "vitest";
import { parseProductSpecRecommendationsJson } from "../lib/productSpecRecommendations.logic";

describe("parseProductSpecRecommendationsJson", () => {
  it("parses valid rows and drops invalid ESR numbers", () => {
    const rows = parseProductSpecRecommendationsJson([
      {
        product: { name: "ZIP System", manufacturer: "Huber" },
        esrNumber: "ESR-1474",
        reasoning: "Wall sheathing",
        sheetHint: "A-301",
      },
      {
        product: { name: "Bad", manufacturer: "X" },
        esrNumber: "not-esr",
        reasoning: "skip me",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.esrNumber).toBe("ESR-1474");
    expect(rows[0]!.sheetHint).toBe("A-301");
  });

  it("returns empty for non-array input", () => {
    expect(parseProductSpecRecommendationsJson({})).toEqual([]);
  });
});
