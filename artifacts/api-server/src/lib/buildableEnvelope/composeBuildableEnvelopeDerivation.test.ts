/**
 * P-153 Step A. `composeBuildableEnvelopeDerivation`
 * (routes/brokeragePlaceBuildableEnvelope.ts) is an EXTRACTION of
 * `deriveLabelAndRespond`'s pure tail, not a rewrite: this test proves the
 * extracted function reproduces, byte for byte, the exact computation that
 * tail used to run inline (deriveBuildableEnvelope -> reconcileWithAtomEnvelope
 * -> the derivePath/provenanceNote/honesty/wireStatus formulas), by
 * independently re-running that SAME sequence of calls here and comparing.
 *
 * Fixture: derive.test.ts's own R-MD rectangular-lot + road-south fixture
 * (values copied verbatim, not reinvented), the one derive.test.ts's first
 * test ("road front + matched district -> geometry, confidence null")
 * already exercises for `deriveBuildableEnvelope` itself.
 *
 * Imports `composeBuildableEnvelopeDerivation` straight off this same
 * directory's `composeBuildableEnvelopeDerivation.ts` (where Step A moved
 * it, out of `routes/brokeragePlaceBuildableEnvelope.ts` — see that lib
 * file's own doc comment) rather than off the route file: the route file
 * re-exports the identical function, but importing it from there would
 * pull that route's whole `@workspace/db`-coupled import graph
 * (resolvePlace/txgioAddressResolve/brokerageTxParcels/txgioParcelStore)
 * into this test for no reason.
 */
import { describe, it, expect } from "vitest";
import type { SetbackTable } from "@workspace/adapters";
import { feetToMeters, type Ring } from "./geometry";
import { labelEdges } from "./edgeLabeling";
import { mapDistrict } from "./districtMapping";
import { deriveBuildableEnvelope } from "./derive";
import { reconcileWithAtomEnvelope } from "./reconcileAtomEnvelope";
import { DEPTH_WARM_PROMOTION_MARKER } from "./reconcileAtomEnvelope";
import {
  AREA_FIGURE_WITHHELD_DISCLOSURE,
  withholdUnverifiedAreaFigure,
} from "./reconcileAtomEnvelope";
import { SETBACK_CITATION_VINTAGE_UNREADABLE_NOTE } from "./setbackCitationVintage";
import { composeBuildableEnvelopeDerivation } from "./composeBuildableEnvelopeDerivation";

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
  ],
};

function roadSouthOf(): [number, number][] {
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  const roadLat = LAT0 - feetToMeters(120) / mPerDegLat;
  return [
    [LNG0 - 0.002, roadLat],
    [LNG0 + 0.002, roadLat],
  ];
}

describe("composeBuildableEnvelopeDerivation (P-153 Step A extraction)", () => {
  it("byte-identical to the pre-extraction inline computation, atom-chain absent", () => {
    const ring = rectRing();
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const district = mapDistrict(TABLE, "R-MD")!;

    // Independently re-run the EXACT sequence deriveLabelAndRespond used to
    // inline, before the extraction -- not derived from the function under
    // test. P-304 (2026-09-17) added one step to that sequence
    // (withholdUnverifiedAreaFigure); it is re-run here too, so this test
    // still proves the composition equals the inline sequence rather than
    // merely agreeing with itself.
    const rawDerivedExpected = deriveBuildableEnvelope({ ring, table: TABLE, district, labeling });
    const reconciledExpected = reconcileWithAtomEnvelope(rawDerivedExpected, null);
    expect(reconciledExpected).toBe(rawDerivedExpected); // no atom outcome -> unreconciled, same reference
    const derivedExpected = withholdUnverifiedAreaFigure(reconciledExpected, null);

    const wireStatusExpected =
      !derivedExpected.empty
        ? "ok"
        : derivedExpected.emptyKind === "consumed"
          ? "no-buildable-area"
          : derivedExpected.emptyKind === "clip-failed"
            ? "geometry-clip-failed"
            : "geometry-validation-failed";
    const derivePathExpected = "labelEdges+derive";
    const provenanceNoteExpected =
      "Setbacks from codified-ordinance (Test, TX, effective 1970-01-01). Geometry from labelEdges+derive (map/export parity).";
    const honestyExpected = {
      confidence: { value: 0, kind: "asserted" as const },
      dataVintage: new Date().toISOString().slice(0, 10),
      coverage: {
        degraded: true,
        reason: derivedExpected.approximate
          ? `${provenanceNoteExpected} Geometry approximate — verify with survey + city.`
          : provenanceNoteExpected,
      },
      source: {
        adapter: "brokerage:buildable-envelope:derive+codified-ordinance",
        citationIds: derivedExpected.citationUrl ? [derivedExpected.citationUrl] : [],
      },
    };

    const result = composeBuildableEnvelopeDerivation({
      ring,
      table: TABLE,
      district,
      labeling,
      atomChain: null,
      spineZoning: null,
      resolvedSourceKind: "codified-ordinance",
      resolvedSourceLabel: "Test, TX",
      resolvedEffectiveDate: "1970-01-01",
    });

    expect(result.derived).toEqual(derivedExpected);
    expect(result.wireStatus).toBe(wireStatusExpected);
    expect(result.derivePath).toBe(derivePathExpected);
    expect(result.honesty).toEqual(honestyExpected);

    // Sanity: this fixture is the real-geometry, non-approximate case (road
    // signal, no silent setbacks, non-empty inset) -- confirms the byte
    // comparison above is exercising the "ok" / non-approximate branch, not
    // vacuously passing on an empty/approximate result.
    expect(result.wireStatus).toBe("ok");
    expect(derivedExpected.approximate).toBe(false);
  });

  it("marks derivePath atom-reconciled and folds the atom's own area in when a VERIFIED atom buildable-area outcome disagrees with the derived one", () => {
    const ring = rectRing();
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const district = mapDistrict(TABLE, "R-MD")!;
    const atomChain = {
      buildableEnvelope: {
        // P-249: reconciliation is gated on verification, so the atom that
        // carries the disputed number must be a promoted one.
        depthWarmPromotion: DEPTH_WARM_PROMOTION_MARKER,
        outcome: { kind: "buildable", areaSqFt: 99_999 },
      },
    } as unknown as Parameters<typeof composeBuildableEnvelopeDerivation>[0]["atomChain"];

    const result = composeBuildableEnvelopeDerivation({
      ring,
      table: TABLE,
      district,
      labeling,
      atomChain,
      spineZoning: null,
      resolvedSourceKind: "codified-ordinance",
      resolvedSourceLabel: "Test, TX",
      resolvedEffectiveDate: "1970-01-01",
    });

    expect(result.derivePath).toBe("labelEdges+derive+atom-reconciled");
    expect(result.derived.geojson.features[0]?.properties.buildableAreaSqFt).toBe(99_999);
    expect(result.honesty.coverage.reason).toContain(
      "Buildable area reconciled against the property atom chain",
    );
  });

  it("P-249: an UNVERIFIED atom's disagreeing number changes nothing and is not marked reconciled", () => {
    const ring = rectRing();
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const district = mapDistrict(TABLE, "R-MD")!;
    const atomChain = {
      buildableEnvelope: { outcome: { kind: "buildable", areaSqFt: 99_999 } },
    } as unknown as Parameters<typeof composeBuildableEnvelopeDerivation>[0]["atomChain"];

    const args = {
      ring,
      table: TABLE,
      district,
      labeling,
      spineZoning: null,
      resolvedSourceKind: "codified-ordinance" as const,
      resolvedSourceLabel: "Test, TX",
      resolvedEffectiveDate: "1970-01-01",
    };

    const withAtom = composeBuildableEnvelopeDerivation({ ...args, atomChain });
    const withoutAtom = composeBuildableEnvelopeDerivation({ ...args, atomChain: null });

    // The atom is carried on the wire and read, but an unverified number is not
    // a finding this route may fold in (A-180) — so the served derivation is
    // identical to the one with no atom at all, and the path does not claim a
    // reconciliation that did not happen.
    expect(withAtom.derived).toEqual(withoutAtom.derived);
    expect(withAtom.derivePath).toBe("labelEdges+derive");
    expect(withAtom.wireStatus).toBe(withoutAtom.wireStatus);
    expect(withAtom.honesty.coverage.reason).not.toContain(
      "reconciled against the property atom chain",
    );

    // P-304 (2026-09-17): the equality above now includes the WITHHOLDING —
    // with no verified atom both payloads serve no figure at all.
    expect(withAtom.derived.geojson.features[0]?.properties).not.toHaveProperty(
      "buildableAreaSqFt",
    );
    expect(withoutAtom.derived.geojson.features[0]?.properties).not.toHaveProperty(
      "buildableAreaPct",
    );
  });

  // -------------------------------------------------------------------------
  // P-304 (2026-09-17) — "area figure no longer reaches anonymous callers".
  //
  // A-180: only a ground-truth VERIFIED envelope atom entitles a caller to a
  // buildable-area figure. The envelope polygon is still drawn without one
  // (the shape the instruments imply), but the number is withheld, and the
  // withheld state is ABSENCE — never a zero, never a substituted re-derivation
  // of our own ring, never the unverified atom's own number.
  // -------------------------------------------------------------------------
  const P304_BASE_ARGS = {
    table: TABLE,
    spineZoning: null,
    resolvedSourceKind: "codified-ordinance" as const,
    resolvedSourceLabel: "Test, TX",
    resolvedEffectiveDate: "1970-01-01",
  };

  it("P-304: with no verified atom the area figure is withheld, the polygon still draws, and the disclosure says why", () => {
    const ring = rectRing();
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const district = mapDistrict(TABLE, "R-MD")!;

    const result = composeBuildableEnvelopeDerivation({
      ...P304_BASE_ARGS,
      ring,
      district,
      labeling,
      atomChain: null,
    });

    // The pre-change leak, restated as the thing that must NOT happen: a
    // figure on a parcel with no verified atom. (Live evidence before the
    // change: anonymous POST /api/brokerage/v1/place/buildable-envelope on
    // 629 Sturgeon Dr, San Marcos returned buildableAreaSqFt=5022,
    // buildableAreaPct=58.3 with derivePath "labelEdges+derive" — i.e. no
    // reconciliation, no verified atom.)
    const props = result.derived.geojson.features[0]!.properties;
    expect("buildableAreaSqFt" in props).toBe(false);
    expect("buildableAreaPct" in props).toBe(false);
    // Not a zero dressed as a measurement either: the keys are gone, not 0.
    expect(props.buildableAreaSqFt).toBeUndefined();

    // The draw is untouched — withholding a figure must not withhold geometry.
    expect(result.derived.empty).toBe(false);
    expect(result.derived.geojson.features[0]!.geometry).not.toBeNull();
    expect(result.wireStatus).toBe("ok");
    expect(result.derivePath).toBe("labelEdges+derive");

    // A reader is told WHY the figure is missing, not left to guess.
    //
    // P-270 (OPS-24 X11): this payload owes a reader a SECOND fact as well.
    // This fixture's table cites a URL (`citation_url` on every district) and
    // carries no `effectiveDate`, so its vintage is declared too. Both
    // sentences, in order: the withholding fact is unchanged, it is simply no
    // longer the whole story. Asserted as the exact pair rather than a
    // `toContain`, so a transformer that starts DROPPING the declaration fails
    // here instead of passing on the withholding sentence alone.
    expect(props.disclosure).toBe(
      `${AREA_FIGURE_WITHHELD_DISCLOSURE} ${SETBACK_CITATION_VINTAGE_UNREADABLE_NOTE}`,
    );
    expect(props.citationVintage?.note).toBe(SETBACK_CITATION_VINTAGE_UNREADABLE_NOTE);

    // The LOT area is a measured fact (a county appraisal figure) and is not
    // withdrawn with the modelled figure.
    expect(props.parcelAreaSqFt).toBeGreaterThan(0);
  });

  it("P-304: an UNVERIFIED atom's area number is withheld too — never quoted in its place", () => {
    const ring = rectRing();
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const district = mapDistrict(TABLE, "R-MD")!;
    const atomChain = {
      buildableEnvelope: { outcome: { kind: "buildable", areaSqFt: 99_999 } },
    } as unknown as Parameters<typeof composeBuildableEnvelopeDerivation>[0]["atomChain"];

    const result = composeBuildableEnvelopeDerivation({
      ...P304_BASE_ARGS,
      ring,
      district,
      labeling,
      atomChain,
    });
    const props = result.derived.geojson.features[0]!.properties;

    expect("buildableAreaSqFt" in props).toBe(false);
    expect("buildableAreaPct" in props).toBe(false);
    // The strongest form of the assertion: the unverified number appears
    // nowhere in the served properties block (the figure surface) at all.
    expect(JSON.stringify(props)).not.toContain("99999");
    expect(result.derivePath).toBe("labelEdges+derive");
  });

  it("P-304: a VERIFIED (depth-warm promoted) atom keeps its figure — the entitlement survives the change", () => {
    const ring = rectRing();
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const district = mapDistrict(TABLE, "R-MD")!;
    const atomChain = {
      buildableEnvelope: {
        depthWarmPromotion: DEPTH_WARM_PROMOTION_MARKER,
        outcome: { kind: "buildable", areaSqFt: 99_999 },
      },
    } as unknown as Parameters<typeof composeBuildableEnvelopeDerivation>[0]["atomChain"];

    const result = composeBuildableEnvelopeDerivation({
      ...P304_BASE_ARGS,
      ring,
      district,
      labeling,
      atomChain,
    });
    const props = result.derived.geojson.features[0]!.properties;

    expect(props.buildableAreaSqFt).toBe(99_999);
    expect(props.buildableAreaPct).toBeGreaterThan(0);
    expect(props.disclosure).not.toBe(AREA_FIGURE_WITHHELD_DISCLOSURE);
    expect(result.derivePath).toBe("labelEdges+derive+atom-reconciled");
  });

  it("P-304: the withholding predicate is P-249's — a version-shifted marker or near-miss citation does NOT restore the figure", () => {
    const ring = rectRing();
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const district = mapDistrict(TABLE, "R-MD")!;

    const cases: Array<{ wire: Record<string, unknown>; verified: boolean }> = [
      // Version-shifted marker: NOT the promoted marker -> unverified.
      {
        wire: {
          depthWarmPromotion: "depth-warm-promoted-v2",
          outcome: { kind: "buildable", areaSqFt: 99_999 },
        },
        verified: false,
      },
      // Near-miss citation (`verify`, not `verified`) -> unverified.
      {
        wire: {
          sourceCitation: "https://x/depth-warm-verify",
          outcome: { kind: "buildable", areaSqFt: 99_999 },
        },
        verified: false,
      },
      // The documented citation fallback ("depth-warm-verified") -> verified,
      // so the entitled figure prints (same rule as hauska-map's
      // isDepthWarmPromoted, which this predicate must not disagree with).
      {
        wire: {
          sourceCitation: "https://x/depth-warm-verified-report",
          outcome: { kind: "buildable", areaSqFt: 99_999 },
        },
        verified: true,
      },
    ];

    for (const { wire, verified } of cases) {
      const atomChain = { buildableEnvelope: wire } as unknown as Parameters<
        typeof composeBuildableEnvelopeDerivation
      >[0]["atomChain"];
      const result = composeBuildableEnvelopeDerivation({
        ...P304_BASE_ARGS,
        ring,
        district,
        labeling,
        atomChain,
      });
      const props = result.derived.geojson.features[0]!.properties;
      if (verified) {
        expect(props.buildableAreaSqFt).toBe(99_999);
      } else {
        expect("buildableAreaSqFt" in props).toBe(false);
        expect("buildableAreaPct" in props).toBe(false);
      }
    }
  });
});
