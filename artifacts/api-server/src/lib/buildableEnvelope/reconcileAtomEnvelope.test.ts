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
import { reconcileWithAtomEnvelope } from "./reconcileAtomEnvelope";

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

  it("overrides a disagreeing buildable area with the atom's number, keeping the drawn geometry", () => {
    const derived = buildableFixture();
    const localArea = derived.geojson.features[0]!.properties.buildableAreaSqFt;
    const atomArea = localArea + 1_500; // demonstrated defect: two disagreeing numbers
    const res = reconcileWithAtomEnvelope(derived, { kind: "buildable", areaSqFt: atomArea });

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

  it("serves the atom's buildable area without a drawn shape when local geometry produced none", () => {
    const derived = consumedFixture();
    expect(derived.empty).toBe(true);
    expect(derived.geojson.features[0]!.geometry).toBeNull();

    const res = reconcileWithAtomEnvelope(derived, { kind: "buildable", areaSqFt: 4_200 });

    expect(res.empty).toBe(false);
    expect(res.geojson.features[0]!.geometry).toBeNull();
    expect(res.geojson.features[0]!.properties.buildableAreaSqFt).toBe(4_200);
    expect(res.geojson.features[0]!.properties.disclosure).toMatch(
      /local map geometry unavailable/i,
    );
  });

  it("overrides a disagreeing local buildable result to the atom's no-buildable-area finding", () => {
    const derived = buildableFixture();
    const res = reconcileWithAtomEnvelope(derived, {
      kind: "no-buildable-area",
      reason: "Setbacks consume the lot per engine calculation.",
    });

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
});
