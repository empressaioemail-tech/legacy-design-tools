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
    // test.
    const rawDerivedExpected = deriveBuildableEnvelope({ ring, table: TABLE, district, labeling });
    const derivedExpected = reconcileWithAtomEnvelope(rawDerivedExpected, null);
    expect(derivedExpected).toBe(rawDerivedExpected); // no atom outcome -> unreconciled, same reference

    const wireStatusExpected =
      !derivedExpected.empty
        ? "ok"
        : derivedExpected.emptyKind === "consumed"
          ? "no-buildable-area"
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

  it("marks derivePath atom-reconciled and folds the atom's own area in when an atom buildable-area outcome disagrees with the derived one", () => {
    const ring = rectRing();
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const district = mapDistrict(TABLE, "R-MD")!;
    const atomChain = {
      buildableEnvelope: { outcome: { kind: "buildable", areaSqFt: 99_999 } },
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
});
