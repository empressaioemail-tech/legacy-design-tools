/**
 * Boundary-envelope atom program item 2: the route must never silently serve
 * a live-derived buildable area that disagrees with the property atom
 * chain's own computed outcome. See reconcileAtomEnvelope.ts header and
 * doc_repo _decisions/2026-09-06_boundary_envelope_atom_program_scope.md.
 */

import { describe, it, expect, vi } from "vitest";
import type { SetbackTable } from "@workspace/adapters";
import { feetToMeters, insetPerEdge, type Ring } from "./geometry";
import { labelEdges } from "./edgeLabeling";
import { mapDistrict } from "./districtMapping";
import { deriveBuildableEnvelope } from "./derive";
import {
  AREA_FIGURE_WITHHELD_DISCLOSURE,
  DEPTH_WARM_PROMOTION_MARKER,
  isEnvelopeAtomVerified,
  reconcileWithAtomEnvelope,
  withholdUnverifiedAreaFigure,
} from "./reconcileAtomEnvelope";
import { SETBACK_CITATION_VINTAGE_UNREADABLE_NOTE } from "./setbackCitationVintage";

// Partial mock so the validation-failed fixture can force a gate rejection
// (unreachable with honest inputs); every other test runs the real insetPerEdge.
// Mirrors derive.test.ts's own established pattern for this exact need.
vi.mock("./geometry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./geometry")>();
  return { ...actual, insetPerEdge: vi.fn(actual.insetPerEdge) };
});

const LNG0 = -97.31;
const LAT0 = 30.11;

function rectRing(wFt = 100, hFt = 200): Ring {
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  const mPerDegLng = mPerDegLat * Math.cos((LAT0 * Math.PI) / 180);
  const halfW = feetToMeters(wFt) / 2 / mPerDegLng;
  const halfH = feetToMeters(hFt) / 2 / mPerDegLat;
  return [
    [LNG0 - halfW, LAT0 - halfH],
    [LNG0 + halfW, LAT0 - halfH],
    [LNG0 + halfW, LAT0 + halfH],
    [LNG0 - halfW, LAT0 + halfH],
    [LNG0 - halfW, LAT0 - halfH],
  ];
}

function roadSouthOf(): [number, number][] {
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  const roadLat = LAT0 - feetToMeters(120) / mPerDegLat;
  return [
    [LNG0 - 0.002, roadLat],
    [LNG0 + 0.002, roadLat],
  ];
}

const TABLE: SetbackTable = {
  jurisdictionKey: "test-tx",
  jurisdictionDisplayName: "Test, TX",
  districts: [
    {
      district_name: "R-MD Residential Medium Density",
      front_ft: 25,
      rear_ft: 20,
      side_ft: 7.5,
      side_corner_ft: 15,
      max_height_ft: 35,
      max_lot_coverage_pct: 40,
      max_impervious_pct: 55,
      citation_url: "https://library.municode.com/tx/test",
    },
    {
      district_name: "R-LD Residential Low Density",
      front_ft: 30,
      rear_ft: 25,
      side_ft: 10,
      side_corner_ft: 20,
      max_height_ft: 35,
      max_lot_coverage_pct: 35,
      max_impervious_pct: 50,
      citation_url: "https://library.municode.com/tx/test",
    },
  ],
};

function buildableFixture() {
  const ring = rectRing();
  const labeling = labelEdges({ ring, road: roadSouthOf() })!;
  const district = mapDistrict(TABLE, "R-MD")!;
  return deriveBuildableEnvelope({ ring, table: TABLE, district, labeling });
}

function consumedFixture() {
  const ring = rectRing(40, 40);
  const labeling = labelEdges({ ring, road: roadSouthOf() })!;
  const district = mapDistrict(TABLE, "R-LD")!;
  return deriveBuildableEnvelope({ ring, table: TABLE, district, labeling });
}

function validationFailedFixture() {
  const ring = rectRing();
  const labeling = labelEdges({ ring, road: roadSouthOf() })!;
  const district = mapDistrict(TABLE, "R-MD")!;
  vi.mocked(insetPerEdge).mockReturnValueOnce({
    ring: null,
    areaSqFt: 0,
    parcelAreaSqFt: 20_000,
    empty: true,
    emptyReason: "geometry validation failed (inset overlaps forbidden setback strips)",
    emptyKind: "validation-failed",
  });
  return deriveBuildableEnvelope({ ring, table: TABLE, district, labeling });
}

describe("reconcileWithAtomEnvelope", () => {
  it("returns the same reference when there is no atom outcome", () => {
    const derived = buildableFixture();
    expect(reconcileWithAtomEnvelope(derived, null)).toBe(derived);
    expect(reconcileWithAtomEnvelope(derived, { kind: undefined })).toBe(derived);
  });

  it("returns the same reference when the atom's buildable area already agrees", () => {
    const derived = buildableFixture();
    const atomArea = derived.geojson.features[0]!.properties.buildableAreaSqFt;
    expect(reconcileWithAtomEnvelope(derived, { kind: "buildable", areaSqFt: atomArea })).toBe(
      derived,
    );
  });

  it("overrides a disagreeing buildable area with a VERIFIED atom's number, keeping the drawn geometry", () => {
    const derived = buildableFixture();
    const localArea = derived.geojson.features[0]!.properties.buildableAreaSqFt!;
    const atomArea = localArea + 1_500; // demonstrated defect: two disagreeing numbers
    const res = reconcileWithAtomEnvelope(
      derived,
      { kind: "buildable", areaSqFt: atomArea },
      { depthWarmPromotion: DEPTH_WARM_PROMOTION_MARKER },
    );

    expect(res).not.toBe(derived);
    expect(res.empty).toBe(false);
    expect(res.emptyKind).toBeUndefined();
    const feat = res.geojson.features[0]!;
    expect(feat.geometry).not.toBeNull();
    expect(feat.geometry).toBe(derived.geojson.features[0]!.geometry);
    expect(feat.properties.buildableAreaSqFt).toBe(Math.round(atomArea));
    expect(feat.properties.buildableAreaSqFt).not.toBe(localArea);
    expect(feat.properties.disclosure).toMatch(/property atom chain/i);
    // maxFootprintSqFt stays capped by lot coverage, not just re-echoing the atom area.
    const coverageCap =
      (feat.properties.maxLotCoveragePct! / 100) * feat.properties.parcelAreaSqFt;
    expect(feat.properties.maxFootprintSqFt).toBe(
      Math.round(Math.min(atomArea, coverageCap)),
    );
  });

  it("serves a VERIFIED atom's buildable area without a drawn shape when local geometry produced none", () => {
    const derived = consumedFixture();
    expect(derived.empty).toBe(true);
    expect(derived.geojson.features[0]!.geometry).toBeNull();

    const res = reconcileWithAtomEnvelope(
      derived,
      { kind: "buildable", areaSqFt: 4_200 },
      { depthWarmPromotion: DEPTH_WARM_PROMOTION_MARKER },
    );

    expect(res.empty).toBe(false);
    expect(res.geojson.features[0]!.geometry).toBeNull();
    expect(res.geojson.features[0]!.properties.buildableAreaSqFt).toBe(4_200);
    expect(res.geojson.features[0]!.properties.disclosure).toMatch(
      /local map geometry unavailable/i,
    );
  });

  it("overrides a disagreeing local buildable result to a VERIFIED atom's no-buildable-area finding", () => {
    const derived = buildableFixture();
    const res = reconcileWithAtomEnvelope(
      derived,
      {
        kind: "no-buildable-area",
        reason: "Setbacks consume the lot per engine calculation.",
      },
      { depthWarmPromotion: DEPTH_WARM_PROMOTION_MARKER },
    );

    expect(res.empty).toBe(true);
    expect(res.emptyKind).toBe("consumed");
    const props = res.geojson.features[0]!.properties;
    expect(res.geojson.features[0]!.geometry).toBeNull();
    expect(props.buildableAreaSqFt).toBe(0);
    expect(props.emptyReason).toMatch(/engine calculation/i);
  });

  it("returns the same reference when both sides already agree on no-buildable-area", () => {
    const derived = consumedFixture();
    const res = reconcileWithAtomEnvelope(derived, {
      kind: "no-buildable-area",
      reason: "irrelevant — already agrees",
    });
    expect(res).toBe(derived);
  });

  it("never overrides a validation-failed decline, regardless of the atom's outcome", () => {
    const derived = validationFailedFixture();
    expect(derived.emptyKind).toBe("validation-failed");

    const res = reconcileWithAtomEnvelope(derived, { kind: "buildable", areaSqFt: 5_000 });
    expect(res).toBe(derived);

    const res2 = reconcileWithAtomEnvelope(derived, {
      kind: "no-buildable-area",
      reason: "x",
    });
    expect(res2).toBe(derived);
  });

  it("ignores a provisional-front-edge outcome (no usable area) and keeps the live result", () => {
    const derived = buildableFixture();
    const res = reconcileWithAtomEnvelope(derived, {
      kind: "provisional-front-edge",
      reason: "front edge ambiguous",
    });
    expect(res).toBe(derived);
  });

  describe("P-214: a raw hauska-engine mechanical-verify diagnostic must never reach a customer string", () => {
    // Live 48021:8723767, 2026-09-15 — the exact `outcome.reason` served by
    // the property atom chain for this parcel (honest-decline-promote.ts's
    // `verifyReasons.slice(0, 3).join("; ")`). Fails on the pre-fix code:
    // it clobbers a good, currently-computed envelope with a false
    // no-buildable-area/0-sqft result and prints this raw text as the
    // customer-facing disclosure.
    const LIVE_R32_DIAGNOSTIC =
      "edge 1: R32 35.02831192164916ft != expected 5ft for role side; " +
      "edge 4: R32 53.60964475445567ft != expected 25ft for role rear";

    it("keeps a good live-derived envelope instead of clobbering it with the engine's stale cert failure", () => {
      const derived = buildableFixture();
      expect(derived.empty).toBe(false);

      const res = reconcileWithAtomEnvelope(derived, {
        kind: "no-buildable-area",
        reason: LIVE_R32_DIAGNOSTIC,
      });

      // The defect: pre-fix, this became empty/consumed/0 sqft, discarding a
      // real, currently-computed envelope over a stale engine diagnostic.
      expect(res).toBe(derived);
      expect(res.empty).toBe(false);
    });

    it("never prints the raw diagnostic when the live pass has nothing to fall back on either", () => {
      // Hand-built rather than derived: exercises the string-sanitization
      // half of the fix independent of the "keep the live envelope" half
      // above, for a local result that is empty but not already "consumed"
      // (so it is not intercepted by the pre-existing top-of-function guard
      // that never touches a "validation-failed" local result at all).
      const derived: ReturnType<typeof buildableFixture> = {
        geojson: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: null,
              properties: {
                kind: "buildable-envelope",
                approximate: true,
                notSurveyGrade: true,
                disclosure: "placeholder",
                setbacks: { front_ft: 30, side_ft: 10, rear_ft: 30, district: "SF-1" },
                edgeSignal: "road",
                edgeNote: "",
                districtNote: "",
                parcelAreaSqFt: 10_000,
                buildableAreaSqFt: 0,
                buildableAreaPct: 0,
                maxLotCoveragePct: null,
                maxHeightFt: null,
                maxFootprintSqFt: null,
                citationUrl: "https://example.test",
              },
            },
          ],
        },
        confidence: null,
        approximate: true,
        empty: true,
        citationUrl: "https://example.test",
        district: "SF-1",
      };

      const res = reconcileWithAtomEnvelope(derived, {
        kind: "no-buildable-area",
        reason: LIVE_R32_DIAGNOSTIC,
      });

      expect(res).not.toBe(derived);
      expect(res.emptyKind).toBe("validation-failed");
      const props = res.geojson.features[0]!.properties;
      // No internal identifier (R32), no unrounded float, no assertion
      // syntax (!=) anywhere in what the customer is shown.
      expect(props.disclosure).not.toMatch(/R32/);
      expect(props.disclosure).not.toMatch(/!=/);
      expect(props.disclosure).not.toMatch(/\d+\.\d{4,}/);
      expect(props.emptyReason).not.toMatch(/R32/);
      expect(props.emptyReason).not.toMatch(/!=/);
    });

    it("still serves a genuine, human-authored engine reason unchanged (falsifier: must not over-fire)", () => {
      const derived = buildableFixture();
      const res = reconcileWithAtomEnvelope(
        derived,
        {
          kind: "no-buildable-area",
          reason: "Setbacks consume the lot per engine calculation.",
        },
        { depthWarmPromotion: DEPTH_WARM_PROMOTION_MARKER },
      );
      expect(res.emptyKind).toBe("consumed");
      expect(res.geojson.features[0]!.properties.emptyReason).toMatch(
        /engine calculation/i,
      );
    });
  });

  describe("P-249: an UNVERIFIED no-buildable-area atom may not empty a live envelope", () => {
    // The atom's own reason text decides NOTHING here — the reason-less zero
    // (the common shape), "unzoned", and a human-authored engine sentence all
    // take the same path, because all of them are shape-only computations by
    // an atom that never passed depth-warm promotion.
    for (const reason of [
      null,
      "unzoned",
      "Setbacks consume the lot per engine calculation.",
      "edge 1: R32 35.02831192164916ft != expected 5ft for role side",
    ] as const) {
      it(`keeps the live-derived envelope for reason ${JSON.stringify(reason)}`, () => {
        const derived = buildableFixture();
        expect(derived.empty).toBe(false);

        const res = reconcileWithAtomEnvelope(derived, {
          kind: "no-buildable-area",
          ...(reason == null ? {} : { reason }),
        });

        expect(res).toBe(derived);
        expect(res.empty).toBe(false);
        // The live pass's own numbers survive untouched.
        expect(res.geojson.features[0]!.properties.buildableAreaSqFt).toBeGreaterThan(0);
      });

      it(`keeps the live-derived envelope when the promotion is declared as not promoted (${JSON.stringify(reason)})`, () => {
        const derived = buildableFixture();
        const res = reconcileWithAtomEnvelope(
          derived,
          { kind: "no-buildable-area", ...(reason == null ? {} : { reason }) },
          { depthWarmPromotion: null, sourceCitation: null },
        );
        expect(res).toBe(derived);
      });
    }

    it("still lets a VERIFIED zero out (the verified atom is authoritative, not advisory)", () => {
      const res = reconcileWithAtomEnvelope(
        buildableFixture(),
        { kind: "no-buildable-area", reason: "unzoned" },
        { depthWarmPromotion: DEPTH_WARM_PROMOTION_MARKER },
      );
      expect(res.empty).toBe(true);
      expect(res.emptyKind).toBe("consumed");
      expect(res.geojson.features[0]!.geometry).toBeNull();
    });

    it("withholds an unverified BUILDABLE figure too — an unverified number is no more load-bearing than an unverified zero", () => {
      const derived = buildableFixture();
      const localArea = derived.geojson.features[0]!.properties.buildableAreaSqFt!;
      const res = reconcileWithAtomEnvelope(derived, {
        kind: "buildable",
        areaSqFt: localArea + 1_500,
      });
      expect(res).toBe(derived);
      expect(res.geojson.features[0]!.properties.buildableAreaSqFt).toBe(localArea);
    });

    it("reconciles nothing when the verification fields are absent from the wire", () => {
      // Fail-closed: an older wire with no promotion fields reads as unverified.
      const derived = buildableFixture();
      const res = reconcileWithAtomEnvelope(
        derived,
        { kind: "buildable", areaSqFt: 1 },
        { depthWarmPromotion: undefined, sourceCitation: undefined },
      );
      expect(res).toBe(derived);
    });

    it("verification predicate: promotion marker, source citation, or neither", () => {
      expect(isEnvelopeAtomVerified({ depthWarmPromotion: DEPTH_WARM_PROMOTION_MARKER })).toBe(true);
      // EXACT match, deliberately — no trimming, no case folding. The shared
      // fixture's `near-miss-marker-token` case says the same thing from the
      // other side: a lookalike spelling is NOT verification.
      expect(isEnvelopeAtomVerified({ depthWarmPromotion: "depth-warm-promoted-v2" })).toBe(false);
      expect(isEnvelopeAtomVerified({ depthWarmPromotion: " depth-warm-promoted-v1 " })).toBe(false);
      expect(isEnvelopeAtomVerified({ sourceCitation: "county assessor 2026-08-30" })).toBe(false);
      expect(
        isEnvelopeAtomVerified({ sourceCitation: "cert/depth-warm-verified/2026-09-02" }),
      ).toBe(true);
      expect(isEnvelopeAtomVerified({ sourceCitation: "cert/depth-warm-verify/2026-09-02" })).toBe(
        false,
      );
      expect(isEnvelopeAtomVerified({ depthWarmPromotion: "warm" })).toBe(false);
      expect(isEnvelopeAtomVerified({ depthWarmPromotion: "" })).toBe(false);
      expect(isEnvelopeAtomVerified({ sourceCitation: "" })).toBe(false);
      expect(isEnvelopeAtomVerified(null)).toBe(false);
      expect(isEnvelopeAtomVerified(undefined)).toBe(false);
    });
  });
});

/**
 * P-270 (OPS-24 scope X11) — the vintage declaration must survive the
 * transformers between `derive.ts` and the wire.
 *
 * WHY THIS FILE NEEDS ITS OWN P-270 CASE. `derive.ts` composes the citation's
 * declaration and appends its sentence to the disclosure. Both functions in
 * this module then REWRITE the disclosure — the reconcile branches substitute
 * the atom chain's own sentence, and `withholdUnverifiedAreaFigure` substitutes
 * the withholding disclosure on every parcel without a verified atom (P-304),
 * which is the COMMON path, not an edge case. Before this lane each of those
 * rewriters silently dropped the sentence `derive.ts` had just added: the row
 * survived on `props` (carried by the spread) while the disclosure no longer
 * admitted the vintage, i.e. two fields on one payload disagreeing about the
 * same citation. These tests pin BOTH halves so a future rewriter that drops
 * one fails here.
 *
 * The fixtures inherit `TABLE`, which cites a URL and carries no
 * `effectiveDate` — the shipped shape, and the reason the declaration fires.
 */
describe("P-270 — the citation vintage declaration survives the envelope transformers", () => {
  it("the RECONCILE branch that rewrites the disclosure keeps the sentence, taken from the row", () => {
    const res = reconcileWithAtomEnvelope(
      buildableFixture(),
      { kind: "buildable", areaSqFt: 5_000 },
      { depthWarmPromotion: DEPTH_WARM_PROMOTION_MARKER },
    );
    const props = res.geojson.features[0]!.properties;
    // The atom chain's sentence is still the one that leads...
    expect(props.disclosure).toContain("Buildable area from the property atom chain");
    // ...and the declaration is still stated, from the ONE module.
    expect(props.disclosure!.endsWith(SETBACK_CITATION_VINTAGE_UNREADABLE_NOTE)).toBe(true);
    expect(props.citationVintage?.note).toBe(SETBACK_CITATION_VINTAGE_UNREADABLE_NOTE);
  });

  it("the NO-BUILDABLE-AREA branch keeps the sentence too — an empty envelope still serves its citation", () => {
    const res = reconcileWithAtomEnvelope(
      buildableFixture(),
      { kind: "no-buildable-area", reason: "unzoned" },
      { depthWarmPromotion: DEPTH_WARM_PROMOTION_MARKER },
    );
    const props = res.geojson.features[0]!.properties;
    expect(res.empty).toBe(true);
    expect(props.disclosure).toContain("No buildable area");
    expect(props.disclosure!.endsWith(SETBACK_CITATION_VINTAGE_UNREADABLE_NOTE)).toBe(true);
    expect(props.citationVintage?.note).toBe(SETBACK_CITATION_VINTAGE_UNREADABLE_NOTE);
  });

  it("THE COMMON PATH: withholding the area figure replaces the disclosure and must not take the sentence with it", () => {
    // P-304 withholds on every parcel without a verified atom, so this is the
    // substitution most live payloads go through.
    const res = withholdUnverifiedAreaFigure(buildableFixture(), null);
    const props = res.geojson.features[0]!.properties;
    expect(props.disclosure).toBe(
      `${AREA_FIGURE_WITHHELD_DISCLOSURE} ${SETBACK_CITATION_VINTAGE_UNREADABLE_NOTE}`,
    );
    expect(props.citationVintage?.note).toBe(SETBACK_CITATION_VINTAGE_UNREADABLE_NOTE);
  });

  it("carries no vintage into a payload whose envelope declares none (the agreeing control, through the withhold path)", () => {
    // A table whose own `effectiveDate` IS readable, so `derive.ts` composes no
    // row and appends nothing. The transformer must then be byte-identical to
    // the pre-lane behaviour rather than appending a sentence for a vintage it
    // does not dispute.
    const dated = { ...TABLE, effectiveDate: "2026-04-14" } as SetbackTable;
    const ring = rectRing();
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const derived = deriveBuildableEnvelope({
      ring,
      table: dated,
      district: mapDistrict(dated, "R-MD")!,
      labeling,
    });
    expect(derived.citationEffectiveDate).toBe("2026-04-14");

    const res = withholdUnverifiedAreaFigure(derived, null);
    expect(res.geojson.features[0]!.properties.disclosure).toBe(AREA_FIGURE_WITHHELD_DISCLOSURE);
    expect(res.geojson.features[0]!.properties.citationVintage).toBeUndefined();
  });

  it("a payload that declares nothing is returned UNCHANGED by every transformer (no row, no rewrite)", () => {
    const dated = { ...TABLE, effectiveDate: "2026-04-14" } as SetbackTable;
    const ring = rectRing();
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const derived = deriveBuildableEnvelope({
      ring,
      table: dated,
      district: mapDistrict(dated, "R-MD")!,
      labeling,
    });
    const baseDisclosure = derived.geojson.features[0]!.properties.disclosure;
    const reconciled = reconcileWithAtomEnvelope(
      derived,
      { kind: "buildable", areaSqFt: 5_000 },
      { depthWarmPromotion: DEPTH_WARM_PROMOTION_MARKER },
    );
    // The reconcile branch's own sentence, with nothing appended after it —
    // the declaration-free payload gains no words from this lane.
    expect(reconciled.geojson.features[0]!.properties.disclosure).not.toContain("vintage unknown");
    expect(baseDisclosure).not.toContain("vintage unknown");
  });
});
