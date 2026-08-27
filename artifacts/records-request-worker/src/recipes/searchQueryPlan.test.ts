import { describe, expect, it } from "vitest";
import {
  buildSearchQueryPlan,
  parseSubdivisionLotBlockFromLegal,
} from "./searchQueryPlan.js";

describe("buildSearchQueryPlan", () => {
  it("plans owner, subdivision, and legal queries from enriched terms", () => {
    const plan = buildSearchQueryPlan({
      propId: "34161",
      ownerName: "JANE DOE",
      situsAddress: "905 PECAN ST",
      legalDescription: "LOT 12 BLK 3 PECAN GROVE SUBDIVISION",
      subdivision: null,
      block: null,
      lot: null,
    });
    expect(plan.map((q) => q.kind)).toEqual([
      "owner-name",
      "subdivision-lot-block",
      "legal-description",
    ]);
  });

  it("returns empty plan when no searchable fields", () => {
    expect(
      buildSearchQueryPlan({
        propId: "1",
        ownerName: null,
        situsAddress: null,
        legalDescription: null,
        subdivision: null,
        block: null,
        lot: null,
      }),
    ).toEqual([]);
  });
});

describe("parseSubdivisionLotBlockFromLegal", () => {
  it("extracts lot and block from legal text", () => {
    expect(
      parseSubdivisionLotBlockFromLegal("LOT 12 BLK 3 PECAN GROVE"),
    ).toEqual({
      lot: "12",
      block: "3",
      subdivision: null,
    });
  });
});
