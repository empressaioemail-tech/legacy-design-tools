/**
 * PROVENANCE CONTRACT TESTS.
 *
 * The point of a canonical format is that a reader can recover the counting
 * rule from a stored row. That is only true if format and parse are a
 * round-trip and if the parser REFUSES anything it did not write, rather than
 * returning a half-populated object that reads like a measurement.
 */

import { describe, it, expect } from "vitest";
import {
  RAIL_SCORE_PROVENANCE_VERSION,
  formatRailScoreProvenance,
  parseRailScoreProvenance,
} from "./provenance";

describe("round-trip", () => {
  it("recovers every field", () => {
    const p = {
      rail: "geometry",
      kind: "atom-count-over-parcel-features",
      numerator: 529,
      denominator: 538,
      denominatorKind: "txgio-parcel-distinct-feature-index",
      detail: "atoms:entity_type=parcel-node,table=txgio_parcel",
    };
    const parsed = parseRailScoreProvenance(formatRailScoreProvenance(p));
    expect(parsed).toEqual(p);
  });

  it("round-trips a null numerator and denominator as null, not zero", () => {
    // A county with no denominator is NOT a county with a denominator of
    // zero: one fails closed to not-yet, the other would divide.
    const p = {
      rail: "flood",
      kind: "atom-count-over-parcel-features",
      numerator: null,
      denominator: null,
      denominatorKind: "none",
      detail: null,
    };
    const parsed = parseRailScoreProvenance(formatRailScoreProvenance(p));
    expect(parsed?.numerator).toBeNull();
    expect(parsed?.denominator).toBeNull();
  });

  it("keeps '=' inside a detail value intact (the detail is itself key=value text)", () => {
    const s = formatRailScoreProvenance({
      rail: "owner",
      kind: "atom-count-over-parcel-features",
      numerator: 1,
      denominator: 2,
      denominatorKind: "txgio-parcel-distinct-feature-index",
      detail: "atoms:entity_type=owner-fact,table=txgio_parcel",
    });
    expect(parseRailScoreProvenance(s)?.detail).toBe(
      "atoms:entity_type=owner-fact,table=txgio_parcel",
    );
  });
});

describe("field order is stable", () => {
  it("emits the fixed order so two identical scores produce identical strings", () => {
    // The provenance string participates in the value diff that decides
    // whether a cell moved. An unstable field order would report every cell
    // as changed on every run.
    const s = formatRailScoreProvenance({
      rail: "flood",
      kind: "atom-count-over-parcel-features",
      numerator: 10,
      denominator: 20,
      denominatorKind: "txgio-parcel-distinct-feature-index",
    });
    expect(s).toBe(
      `scorer=${RAIL_SCORE_PROVENANCE_VERSION};rail=flood;kind=atom-count-over-parcel-features;num=10;den=20;denKind=txgio-parcel-distinct-feature-index`,
    );
  });
});

describe("the parser refuses what it did not write", () => {
  it("returns null for the legacy artifact_path format", () => {
    // The live ledger is full of these. Reporting one as a parsed
    // measurement would invent a denominator that was never recorded.
    expect(
      parseRailScoreProvenance("atoms:entity_type=parcel-node,countyFips=48001"),
    ).toBeNull();
  });

  it("returns null for the ad-hoc geometry denominator string", () => {
    expect(
      parseRailScoreProvenance(
        "atoms:entity_type=parcel-node,countyFips=48001;denom=accounted;rawFeatures=43894;accountedFeatures=31676;foldedExtraFeatures=12218",
      ),
    ).toBeNull();
  });

  it("returns null for empty, null and undefined", () => {
    expect(parseRailScoreProvenance("")).toBeNull();
    expect(parseRailScoreProvenance(null)).toBeNull();
    expect(parseRailScoreProvenance(undefined)).toBeNull();
  });

  it("returns null for a different version rather than guessing", () => {
    expect(
      parseRailScoreProvenance(
        "scorer=99;rail=flood;kind=x;num=1;den=2;denKind=y",
      ),
    ).toBeNull();
  });

  it("returns null when a required field is missing", () => {
    expect(
      parseRailScoreProvenance(`scorer=${RAIL_SCORE_PROVENANCE_VERSION};rail=flood;num=1;den=2`),
    ).toBeNull();
  });
});

describe("values that would corrupt the format are rejected loudly", () => {
  it("throws rather than silently escaping a separator in detail", () => {
    expect(() =>
      formatRailScoreProvenance({
        rail: "flood",
        kind: "atom-count-over-parcel-features",
        numerator: 1,
        denominator: 2,
        denominatorKind: "txgio-parcel-distinct-feature-index",
        detail: "a;b",
      }),
    ).toThrow(/may not contain/);
  });
});
