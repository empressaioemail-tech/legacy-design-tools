/**
 * Unit tests for the F4d address normalizer — the pure logic that folds
 * a typed address to the canonical street line the store stores, so a
 * situs / full_addr match is robust to case, punctuation, street-type
 * spelling (Lane<->LN), directionals, and a trailing city/state/zip or
 * unit. No DB — the resolver's DB paths are covered in the integration
 * suite.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeStreetLine,
  normalizeStreetLineCandidates,
} from "../txgioAddressNormalize";

describe("normalizeStreetLine", () => {
  it("reduces a full typed address to the stored street line", () => {
    // The bug case: typed full address -> the store's '6026 MARSH LN'.
    expect(normalizeStreetLine("6026 Marsh Ln, Buda, TX 78610")).toBe(
      "6026 MARSH LN",
    );
  });

  it("canonicalizes street-type spelling to the store's abbreviation", () => {
    expect(normalizeStreetLine("6026 Marsh Lane")).toBe("6026 MARSH LN");
    expect(normalizeStreetLine("512 Main Street")).toBe("512 MAIN ST");
    expect(normalizeStreetLine("599 Creekside Trail, Kyle, TX")).toBe(
      "599 CREEKSIDE TRL",
    );
    expect(normalizeStreetLine("1 Aztec Drive")).toBe("1 AZTEC DR");
  });

  it("canonicalizes directionals and folds case/punctuation/whitespace", () => {
    expect(normalizeStreetLine("2701 S. IH 35")).toBe("2701 S IH 35");
    expect(normalizeStreetLine("100  North   Loop")).toBe("100 N LOOP");
  });

  it("drops a trailing unit/suite designator", () => {
    expect(normalizeStreetLine("6026 Marsh Ln Apt 2")).toBe("6026 MARSH LN");
    expect(normalizeStreetLine("6026 Marsh Ln #5")).toBe("6026 MARSH LN");
    expect(normalizeStreetLine("6026 Marsh Ln, Unit B, Buda TX")).toBe(
      "6026 MARSH LN",
    );
  });

  it("returns null for un-matchable inputs (no house number / empty situs)", () => {
    // The empty ", ," situs rows in the store must never match.
    expect(normalizeStreetLine(", ,")).toBeNull();
    expect(normalizeStreetLine("")).toBeNull();
    // A bare street with no number is not a house-level match key.
    expect(normalizeStreetLine("Marsh Ln")).toBeNull();
    // A number alone is not enough.
    expect(normalizeStreetLine("6026")).toBeNull();
  });

  it("makes comma-delimited typed and stored forms compare equal (the join invariant)", () => {
    // Stored situs carries city/state; a typed query may abbreviate or
    // spell out the street type. With the conventional comma delimiter
    // (what the FE sends and what situs stores), all reduce to one key.
    const stored = normalizeStreetLine("6026 MARSH LN, BUDA, TX 78610");
    const typedAbbrev = normalizeStreetLine("6026 Marsh Ln, Buda, TX 78610");
    const typedSpelledComma = normalizeStreetLine(
      "6026 Marsh Lane, Buda, TX 78610",
    );
    expect(stored).toBe("6026 MARSH LN");
    expect(typedAbbrev).toBe(stored);
    expect(typedSpelledComma).toBe(stored);
  });

  it("normalizeStreetLine keeps the locality for a comma-less full address (primary key only)", () => {
    // `normalizeStreetLine` returns just the PRIMARY key — the first-comma
    // segment. A comma-less full address has no comma, so the whole string
    // is the primary key and the locality remains. The F4f comma-less fix
    // lives in `normalizeStreetLineCandidates` (below), which the resolver
    // uses; the primary key stays byte-identical to the stored-side /
    // index expression so no reindex is needed.
    expect(normalizeStreetLine("6026 Marsh Lane Buda TX 78610")).toBe(
      "6026 MARSH LN BUDA TX 78610",
    );
  });
});

describe("normalizeStreetLineCandidates (F4f comma-less query key)", () => {
  it("strips a comma-less <city> <state> <zip> tail to the stored street line", () => {
    // THE HEADLINE CASE. The FE typically sends a comma-LESS full address.
    // Candidates must INCLUDE the stored street line "576 SAGE THRASHER
    // CIR" so the situs lookup (unique prop id 190180 in Hays) resolves.
    const cands = normalizeStreetLineCandidates(
      "576 Sage Thrasher Cir Dripping Springs TX 78620",
    );
    expect(cands).toContain("576 SAGE THRASHER CIR");
    // Primary (whole-string) key comes first; the stripped street line is
    // one of the candidates. Over-/under-stripped candidates are harmless
    // (they match nothing in the store).
    expect(cands[0]).toBe("576 SAGE THRASHER CIR DRIPPING SPRINGS TX 78620");
  });

  it("keeps the comma-delimited form working (single primary candidate)", () => {
    // A comma-delimited address already isolates the street line via the
    // first-comma split, so there is exactly ONE candidate and it equals
    // the stored street line — identical to the pre-F4f behavior.
    expect(
      normalizeStreetLineCandidates("576 Sage Thrasher Cir, Dripping Springs, TX 78620"),
    ).toEqual(["576 SAGE THRASHER CIR"]);
    expect(
      normalizeStreetLineCandidates("6026 Marsh Ln, Buda, TX 78610"),
    ).toEqual(["6026 MARSH LN"]);
  });

  it("comma-less 6026 Marsh Ln reduces to the stored street line", () => {
    const cands = normalizeStreetLineCandidates("6026 Marsh Ln Buda TX 78610");
    expect(cands).toContain("6026 MARSH LN");
  });

  it("a bare street line (no state/zip tail) yields ONLY the primary key (no over-strip)", () => {
    // No <state><zip> anchor -> we must NOT strip trailing tokens, or a
    // real street name would be truncated. "6026 Marsh Ln" stays whole.
    expect(normalizeStreetLineCandidates("6026 Marsh Ln")).toEqual([
      "6026 MARSH LN",
    ]);
    // A longer bare street with no tail is likewise untouched.
    expect(normalizeStreetLineCandidates("8135 Bracken Creek Rd")).toEqual([
      "8135 BRACKEN CREEK RD",
    ]);
  });

  it("handles a city whose name ends in a street-type word (Garden Ridge)", () => {
    // "GARDEN RIDGE" ends in RIDGE, which IS in the street-type abbr map.
    // A 'cut at the last street-type suffix' rule would produce the WRONG
    // key "8135 BRACKEN CREEK RDG". The drop-N-from-the-<state><zip>-anchor
    // rule instead ENUMERATES the city drop, so the correct stored street
    // line "8135 BRACKEN CREEK RD" is among the candidates.
    const cands = normalizeStreetLineCandidates(
      "8135 Bracken Creek Rd Garden Ridge TX 78266",
    );
    expect(cands).toContain("8135 BRACKEN CREEK RD");
    // Never emit the mis-cut "...CREEK RDG" (RIDGE from the city folded in).
    expect(cands).not.toContain("8135 BRACKEN CREEK RDG");
  });

  it("comma-less highway address enumerates the real street line (stays declinable)", () => {
    // "13341 W US 290" has no street-type suffix at all; the drop-N rule
    // still yields it as a candidate so the resolver sees the (ambiguous,
    // many-prop-id) situs and DECLINES rather than false-resolving.
    const cands = normalizeStreetLineCandidates(
      "13341 W US 290 Dripping Springs TX 78620",
    );
    expect(cands).toContain("13341 W US 290");
  });

  it("returns [] for un-matchable inputs (no house number / empty)", () => {
    expect(normalizeStreetLineCandidates(", ,")).toEqual([]);
    expect(normalizeStreetLineCandidates("")).toEqual([]);
    expect(normalizeStreetLineCandidates("Marsh Ln")).toEqual([]);
  });

  it("does not over-strip below number + one street token", () => {
    // "100 Main St TX 78610" -> anchor strips "TX 78610"; dropping the
    // single remaining locality-less tail cannot go below 2 tokens, so we
    // keep the street line and never emit a bare house number.
    const cands = normalizeStreetLineCandidates("100 Main St TX 78610");
    expect(cands).toContain("100 MAIN ST");
    expect(cands.every((c) => c.split(" ").length >= 2)).toBe(true);
  });
});
