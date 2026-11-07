/**
 * P-85 / P-91 item 4 — BLOCK must match. The old pattern BLK(?:OCK)?
 * expands to BLK|BLKOCK and never matches the word BLOCK. Proven here
 * by running the retired pattern against the fixtures that failed it.
 */

import { describe, expect, it } from "vitest";
import {
  RETIRED_BLOCK_PATTERN,
  blockTermMissedByRetiredPattern,
  parseSubdivisionLotBlockFromLegal,
} from "./recordsSearchQueryPlan";

/** Retired pattern. Kept so the repair is proven by violation, not by reading. */
const RETIRED_BLOCK = RETIRED_BLOCK_PATTERN;

const BLOCK_WORD_FIXTURES = [
  "BLOCK 3",
  "BLOCK 12A",
  "PECAN GROVE BLOCK 3 LOT 5",
] as const;

describe("retired BLOCK pattern (violation)", () => {
  it("fails every fixture that spells BLOCK in full", () => {
    for (const legal of BLOCK_WORD_FIXTURES) {
      expect(RETIRED_BLOCK.test(legal), legal).toBe(false);
    }
  });

  it("still matches the abbreviated forms the old plan could see", () => {
    expect(RETIRED_BLOCK.exec("BLK 3")?.[1]).toBe("3");
    expect(RETIRED_BLOCK.exec("BLK. 3")?.[1]).toBe("3");
  });
});

describe("parseSubdivisionLotBlockFromLegal block", () => {
  it("extracts BLOCK as well as BLK", () => {
    expect(parseSubdivisionLotBlockFromLegal("BLOCK 3").block).toBe("3");
    expect(parseSubdivisionLotBlockFromLegal("BLOCK 12A").block).toBe("12A");
    expect(parseSubdivisionLotBlockFromLegal("PECAN GROVE BLOCK 3 LOT 5")).toEqual({
      lot: "5",
      block: "3",
      subdivision: null,
    });
    expect(parseSubdivisionLotBlockFromLegal("LOT 12 BLK 3 PECAN GROVE")).toEqual({
      lot: "12",
      block: "3",
      subdivision: null,
    });
    expect(parseSubdivisionLotBlockFromLegal("BLK. 3").block).toBe("3");
  });

  it("does not invent a block from BLKOCK", () => {
    expect(parseSubdivisionLotBlockFromLegal("BLKOCK 3").block).toBeNull();
  });

  it("flags issued-job candidates the retired pattern missed", () => {
    expect(blockTermMissedByRetiredPattern("PECAN GROVE BLOCK 3 LOT 5")).toBe(true);
    expect(blockTermMissedByRetiredPattern("LOT 12 BLK 3 PECAN GROVE")).toBe(false);
    expect(blockTermMissedByRetiredPattern(null)).toBe(false);
  });
});
