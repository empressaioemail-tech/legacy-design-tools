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

  it("extracts letter-only blocks (P-113 widening — 2026-08-31 audit exclusion_letterBlockNoDigit: 7 jobs, 4 parcels, disposition held-parser-not-declined, 'letter-only is a real designation the capture group refuses')", () => {
    // Minimal literal cases named in the P-113 dispatch itself.
    expect(parseSubdivisionLotBlockFromLegal("BLOCK A").block).not.toBeNull();
    expect(parseSubdivisionLotBlockFromLegal("BLOCK A").block).toBe("A");
    expect(parseSubdivisionLotBlockFromLegal("BLK D").block).not.toBeNull();
    expect(parseSubdivisionLotBlockFromLegal("BLK D").block).toBe("D");

    // The real stored legalDescription text for all 4 held letter-only-block
    // parcels, verbatim from _inbox/2026-08-31_p85_block_job_audit.json
    // exclusion_letterBlockNoDigit (source authority: cortex-prod SQL read,
    // not a fabricated fixture).
    expect(
      parseSubdivisionLotBlockFromLegal("LOT 2 BLK D WALNUT RIDGE I"),
    ).toEqual({ lot: "2", block: "D", subdivision: null }); // apn:48453:500996

    const riverside = parseSubdivisionLotBlockFromLegal(
      "RIVERSIDE GROVE SUBDIVISION PHASE 1, BLOCK A, LOT 27",
    );
    expect(riverside.block).toBe("A"); // apn:48021:81886
    expect(riverside.lot).toBe("27");

    const sixCreeks = parseSubdivisionLotBlockFromLegal(
      "6 CREEKS PHASE 1 SECTION 10, BLOCK F, Lot 30, 18671 SQUARE FEET",
    );
    expect(sixCreeks.block).toBe("F"); // apn:48209:168686
    expect(sixCreeks.lot).toBe("30");

    expect(
      parseSubdivisionLotBlockFromLegal("MELBOURNE HTS Lot 6 Block D Acres .186"),
    ).toEqual({ lot: "6", block: "D", subdivision: null }); // apn:48309:181849
  });

  it("still parses digit blocks correctly alongside the widened letter-only capture (no regression)", () => {
    expect(
      parseSubdivisionLotBlockFromLegal("Building Block, BLOCK 13 E W ST, ACRES 0.485"),
    ).toEqual({ lot: null, block: "13", subdivision: null });
    expect(parseSubdivisionLotBlockFromLegal("BLOCK 12A").block).toBe("12A");
  });
});
