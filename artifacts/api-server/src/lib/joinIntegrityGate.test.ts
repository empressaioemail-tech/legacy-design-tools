/**
 * Owner-match join-integrity gate — unit tests (pure, offline, no DB).
 *
 * Covers the load-bearing guarantees:
 *   1. FABRICATED collision (owners disagree)      -> verdict 'block'.
 *   2. REAL join (owners agree)                     -> verdict 'pass'.
 *   3. Owner-name normalization edge cases: "LAST, FIRST" vs "LAST FIRST",
 *      generational suffixes, entity suffixes, "PURVIS" vs "BREM" disagree.
 *   4. Empty / too-small / all-blank sample handling.
 *   5. The SQL join key mirrors the TS `normalizeForJoin` on the exact
 *      Williamson collision the fabrication came from.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeOwnerTokens,
  ownerLeadToken,
  ownersAgree,
  ownerMatchRate,
  evaluateJoinIntegrity,
  DEFAULT_MIN_OWNER_MATCH_RATE,
  MIN_INFORMATIVE_SAMPLE,
  normalizeForJoin,
  type OwnerPair,
} from "./joinIntegrityGate";

// ---------------------------------------------------------------------------
// Owner-name normalization.
// ---------------------------------------------------------------------------

describe("normalizeOwnerTokens", () => {
  it("uppercases, strips punctuation, and collapses whitespace", () => {
    expect(normalizeOwnerTokens("  smith,  john  q. ")).toEqual([
      "SMITH",
      "JOHN",
      "Q",
    ]);
  });

  it("reorders 'LAST, FIRST' so the surname leads", () => {
    expect(normalizeOwnerTokens("PURVIS, MICHAEL")).toEqual([
      "PURVIS",
      "MICHAEL",
    ]);
  });

  it("treats 'LAST FIRST' (no comma) as already surname-leading", () => {
    expect(normalizeOwnerTokens("PURVIS MICHAEL")).toEqual([
      "PURVIS",
      "MICHAEL",
    ]);
  });

  it("drops generational + entity noise tokens", () => {
    expect(normalizeOwnerTokens("SMITH JOHN JR")).toEqual(["SMITH", "JOHN"]);
    expect(normalizeOwnerTokens("ACME HOLDINGS LLC")).toEqual([
      "ACME",
      "HOLDINGS",
    ]);
    expect(normalizeOwnerTokens("THE PURVIS FAMILY TRUST")).toEqual([
      "PURVIS",
      "FAMILY",
    ]);
  });

  it("returns an empty array for blank / null / whitespace", () => {
    expect(normalizeOwnerTokens("")).toEqual([]);
    expect(normalizeOwnerTokens("   ")).toEqual([]);
    expect(normalizeOwnerTokens(null)).toEqual([]);
    expect(normalizeOwnerTokens(undefined)).toEqual([]);
  });
});

describe("ownerLeadToken", () => {
  it("is the surname across both formats", () => {
    expect(ownerLeadToken("PURVIS, MICHAEL")).toBe("PURVIS");
    expect(ownerLeadToken("PURVIS MICHAEL")).toBe("PURVIS");
  });
  it("is empty for an unusable name", () => {
    expect(ownerLeadToken("")).toBe("");
    expect(ownerLeadToken("JR")).toBe(""); // all-noise
  });
});

describe("ownersAgree", () => {
  it("agrees on identical surnames across format variants", () => {
    // "LAST, FIRST" vs "LAST FIRST JR" -> agree.
    expect(ownersAgree("SMITH, JOHN", "SMITH JOHN JR")).toBe(true);
  });

  it("agrees on entity names ignoring entity-type suffix", () => {
    expect(ownersAgree("ACME LLC", "ACME INC")).toBe(true);
  });

  it("DISAGREES on the live fabrication case: PURVIS vs BREM", () => {
    // The Williamson collision: R062578 (owner PURVIS) numerically collided
    // with cad row 62578 (owner BREM). The gate must catch this.
    expect(ownersAgree("PURVIS, MICHAEL", "BREM, WALTER")).toBe(false);
  });

  it("does not agree when either side is blank (uninformative, not evidence)", () => {
    expect(ownersAgree("", "SMITH")).toBe(false);
    expect(ownersAgree("SMITH", "")).toBe(false);
    expect(ownersAgree(null, null)).toBe(false);
  });

  it("does not let a short unrelated token prefix-match ('BR' vs 'BREM')", () => {
    expect(ownersAgree("BR", "BREM")).toBe(false);
  });

  it("absorbs minor truncation via >=4 char prefix agreement", () => {
    expect(ownersAgree("PURVIS", "PURVISON")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Owner-match rate.
// ---------------------------------------------------------------------------

describe("ownerMatchRate", () => {
  it("excludes uninformative (blank-owner) pairs from the denominator", () => {
    const pairs: OwnerPair[] = [
      { txgioOwner: "SMITH JOHN", cadOwner: "SMITH, JOHN" }, // agree
      { txgioOwner: "", cadOwner: "JONES" }, // uninformative
      { txgioOwner: "LEE ANN", cadOwner: null }, // uninformative
      { txgioOwner: "GARCIA MARIA", cadOwner: "GARCIA, MARIA" }, // agree
    ];
    const r = ownerMatchRate(pairs);
    expect(r.total).toBe(4);
    expect(r.sampled).toBe(2); // only the two informative pairs
    expect(r.agreed).toBe(2);
    expect(r.rate).toBe(1);
  });

  it("is rate 0 / sampled 0 for an empty sample", () => {
    const r = ownerMatchRate([]);
    expect(r).toEqual({ sampled: 0, agreed: 0, rate: 0, total: 0 });
  });
});

// ---------------------------------------------------------------------------
// The gate — fabricated collision blocks, real join passes.
// ---------------------------------------------------------------------------

/** Build N pairs that all agree (a real join). */
function realPairs(n: number): OwnerPair[] {
  const surnames = ["SMITH", "GARCIA", "PURVIS", "LEE", "NGUYEN", "OKAFOR"];
  return Array.from({ length: n }, (_, i) => {
    const s = surnames[i % surnames.length];
    return {
      txgioOwner: `${s} PERSON${i}`,
      cadOwner: `${s}, PERSON${i}`,
    };
  });
}

/** Build N pairs that all DISAGREE (a fabricated numeric-collision join). */
function fabricatedPairs(n: number): OwnerPair[] {
  const a = ["PURVIS", "GARCIA", "SMITH", "LEE"];
  const b = ["BREM", "OKAFOR", "WEISS", "TANAKA"];
  return Array.from({ length: n }, (_, i) => ({
    txgioOwner: `${a[i % a.length]} ${i}`,
    cadOwner: `${b[i % b.length]} ${i}`,
  }));
}

describe("evaluateJoinIntegrity", () => {
  it("BLOCKS a fabricated collision (owners disagree ~0%) — the Williamson/Hays failure", () => {
    const report = evaluateJoinIntegrity({
      county: "48491",
      facet: "land-use",
      sample: fabricatedPairs(200),
    });
    expect(report.verdict).toBe("block");
    expect(report.ownerMatchRate).toBe(0);
    expect(report.sampled).toBe(200);
    expect(report.reason).toMatch(/FABRICATED/);
  });

  it("PASSES a real join (owners agree ~100%) — a correct county like Bexar", () => {
    const report = evaluateJoinIntegrity({
      county: "48029",
      facet: "land-use",
      sample: realPairs(200),
    });
    expect(report.verdict).toBe("pass");
    expect(report.ownerMatchRate).toBe(1);
    expect(report.sampled).toBe(200);
  });

  it("blocks at just under threshold and passes at just over (0.5 boundary)", () => {
    // 100 pairs, exactly half agree -> rate 0.5 == threshold -> PASS (>=).
    const half: OwnerPair[] = [...realPairs(50), ...fabricatedPairs(50)];
    const atThreshold = evaluateJoinIntegrity({
      county: "48000",
      facet: "land-use",
      sample: half,
    });
    expect(atThreshold.ownerMatchRate).toBe(0.5);
    expect(atThreshold.verdict).toBe("pass");

    // 100 pairs, 49 agree -> rate 0.49 < 0.5 -> BLOCK.
    const below: OwnerPair[] = [...realPairs(49), ...fabricatedPairs(51)];
    const belowThreshold = evaluateJoinIntegrity({
      county: "48000",
      facet: "land-use",
      sample: below,
    });
    expect(belowThreshold.ownerMatchRate).toBeCloseTo(0.49, 5);
    expect(belowThreshold.verdict).toBe("block");
  });

  it("returns 'insufficient-sample' for an empty sample (never a false block)", () => {
    const report = evaluateJoinIntegrity({
      county: "48091",
      facet: "land-use",
      sample: [],
    });
    expect(report.verdict).toBe("insufficient-sample");
    expect(report.sampled).toBe(0);
  });

  it("returns 'insufficient-sample' when informative pairs are below the floor", () => {
    const report = evaluateJoinIntegrity({
      county: "48091",
      facet: "land-use",
      sample: fabricatedPairs(MIN_INFORMATIVE_SAMPLE - 1),
    });
    expect(report.sampled).toBe(MIN_INFORMATIVE_SAMPLE - 1);
    expect(report.verdict).toBe("insufficient-sample");
  });

  it("honors a custom threshold", () => {
    // 70% agreement: passes at default 0.5, blocks at a stricter 0.8.
    const sample: OwnerPair[] = [...realPairs(70), ...fabricatedPairs(30)];
    expect(
      evaluateJoinIntegrity({ county: "48000", facet: "land-use", sample })
        .verdict,
    ).toBe("pass");
    expect(
      evaluateJoinIntegrity({
        county: "48000",
        facet: "land-use",
        sample,
        minRate: 0.8,
      }).verdict,
    ).toBe("block");
  });

  it("exposes the default threshold as 0.5", () => {
    expect(DEFAULT_MIN_OWNER_MATCH_RATE).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// The SQL sample join key must mirror the TS normalizeForJoin on the exact
// collision the fabrication came from — proving the gate samples the SAME
// join the bake performs.
// ---------------------------------------------------------------------------

/**
 * Mirror of the SQL in `sampleJoinPairs` (post-#313, the R-strip removed):
 *   CASE WHEN trim(prop_id) ~ '^[0-9]+$'
 *        THEN regexp_replace(trim(prop_id), '^0+([0-9])', '\1')
 *        ELSE trim(prop_id) END
 * expressed in JS so the test asserts SQL and TS agree without a DB.
 */
function sqlNormalizeMirror(propId: string): string {
  const t = propId.trim();
  if (/^[0-9]+$/.test(t)) return t.replace(/^0+([0-9])/, "$1");
  return t;
}

describe("SQL join key mirrors normalizeForJoin (the collision oracle)", () => {
  it("an R-account id (R062578) is NO LONGER numeric-normalized — the fix that killed the collision", () => {
    // The fabrication came from stripping the leading R so 'R062578' became
    // '62578', which collided with an UNRELATED bare-numeric cad account. PR
    // #313 removed the R-strip: 'R062578' now stays non-numeric and simply does
    // not match any bare cad key (honest non-match). The SQL sample MUST mirror
    // that so the gate samples the SAME join the bake performs.
    expect(normalizeForJoin("R062578")).toBe("R062578");
    expect(sqlNormalizeMirror("R062578")).toBe("R062578");
  });

  it("the two normalizers agree across the representative id forms", () => {
    for (const id of ["R000009", "R123", "000123", "10001", "R0", "62578"]) {
      expect(sqlNormalizeMirror(id)).toBe(normalizeForJoin(id));
    }
  });

  it("bare-numeric ids still leading-zero normalize identically in both forms", () => {
    expect(normalizeForJoin("000123")).toBe("123");
    expect(sqlNormalizeMirror("000123")).toBe("123");
    expect(normalizeForJoin("62578")).toBe("62578");
    expect(sqlNormalizeMirror("62578")).toBe("62578");
  });
});
