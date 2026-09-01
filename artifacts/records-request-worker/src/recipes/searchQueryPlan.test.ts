import { describe, expect, it } from "vitest";
import {
  buildSearchQueryPlan,
  normalizeOwnerNameForClerkSearch,
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

  it("strips leading THE from owner-name clerk query", () => {
    const plan = buildSearchQueryPlan({
      propId: "34161",
      ownerName: "THE DIOCESE OF AUSTIN",
      situsAddress: null,
      legalDescription: null,
      subdivision: null,
      block: null,
      lot: null,
    });
    expect(plan).toEqual([
      {
        kind: "owner-name",
        query: "DIOCESE OF AUSTIN",
        captureLabel: "owner-name-results",
      },
    ]);
  });
});

describe("normalizeOwnerNameForClerkSearch", () => {
  it("removes leading THE", () => {
    expect(normalizeOwnerNameForClerkSearch("THE DIOCESE OF AUSTIN")).toBe(
      "DIOCESE OF AUSTIN",
    );
  });

  it("leaves names without THE unchanged", () => {
    expect(normalizeOwnerNameForClerkSearch("JANE DOE")).toBe("JANE DOE");
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

  it("extracts BLOCK in full — the retired BLK(?:OCK)? pattern cannot", () => {
    const retired = /\bBLK(?:OCK)?\.?\s+(\d+[A-Z]?)\b/i;
    expect(retired.test("BLOCK 3")).toBe(false);
    expect(retired.test("PECAN GROVE BLOCK 3 LOT 5")).toBe(false);
    expect(parseSubdivisionLotBlockFromLegal("BLOCK 3").block).toBe("3");
    expect(parseSubdivisionLotBlockFromLegal("BLOCK 12A").block).toBe("12A");
    expect(
      parseSubdivisionLotBlockFromLegal("PECAN GROVE BLOCK 3 LOT 5"),
    ).toEqual({
      lot: "5",
      block: "3",
      subdivision: null,
    });
  });

  it("extracts BLOCK (not only BLK) from Bastrop Building Block legals", () => {
    expect(
      parseSubdivisionLotBlockFromLegal(
        "Building Block, BLOCK 13 E W ST, ACRES 0.485",
      ),
    ).toEqual({
      lot: null,
      block: "13",
      subdivision: null,
    });
    expect(
      parseSubdivisionLotBlockFromLegal("BUILDING BLOCK 49 E W ST, ACRES 1.280"),
    ).toEqual({
      lot: null,
      block: "49",
      subdivision: null,
    });
  });

  it("does not treat letter-only blocks as digit blocks", () => {
    expect(
      parseSubdivisionLotBlockFromLegal("Riverside Grove BLOCK A LOT 27"),
    ).toEqual({
      lot: "27",
      block: null,
      subdivision: null,
    });
  });
});
