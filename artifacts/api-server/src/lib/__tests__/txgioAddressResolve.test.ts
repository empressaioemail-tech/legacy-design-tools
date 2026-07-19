/**
 * Unit tests for the F4d address normalizer — the pure logic that folds
 * a typed address to the canonical street line the store stores, so a
 * situs / full_addr match is robust to case, punctuation, street-type
 * spelling (Lane<->LN), directionals, and a trailing city/state/zip or
 * unit. No DB — the resolver's DB paths are covered in the integration
 * suite.
 */

import { describe, it, expect } from "vitest";
import { normalizeStreetLine } from "../txgioAddressNormalize";

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

  it("a comma-less full address keeps trailing locality tokens (documents the limit)", () => {
    // Without a comma we cannot tell the street line from the locality,
    // so the locality tokens remain. The situs-match query key therefore
    // won't equal the stored "6026 MARSH LN" — the resolver falls through
    // to the rooftop/geocode path rather than false-matching. This is a
    // known, safe limitation (the FE sends comma-delimited addresses).
    expect(normalizeStreetLine("6026 Marsh Lane Buda TX 78610")).toBe(
      "6026 MARSH LN BUDA TX 78610",
    );
  });
});
