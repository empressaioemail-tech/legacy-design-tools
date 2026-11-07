/**
 * Texas ETJ acquisition unit tests (feat/p241-etj-acquisition, P-241).
 *
 * Covers the three things that can silently produce a wrong answer here:
 *   1. the register's own integrity — a combined layer with no membership
 *      predicate would ingest city limits as ETJ;
 *   2. the resolver's three-valued disposition, in particular that `absent`
 *      and `unresolved` never collapse;
 *   3. the parser's identity and ring-label rules, including the declines.
 */

import { describe, expect, it } from "vitest";
import {
  ETJ_REGISTRY,
  cityLimitsOnlyEntries,
  etjRegistryEntry,
  etjSourceEntries,
  etjPredicateMustBeSelective,
  etjWhereClause,
} from "../boundary/etjRegistry";
import {
  buildEtjBoundaryIndex,
  resolveEtj,
  resolveEtjAtPoint,
  resolveEtjByIncorporation,
  type EtjIncorporationSettlement,
  type EtjSourceCoverageEntry,
} from "../boundary/containment";
import { incorporationSettlesEtj } from "../boundary/cityLimitsFact";
import {
  etjFactFromContainment,
  unmeasuredEtjFact,
  usableEtjQueryPoint,
} from "../boundary/etjFact";
import {
  normalizeEtjBoundaryFeature,
  readObjectId,
  readRingLabel,
} from "../boundary/etjParse";
import { newCounters } from "../types";
import type { GeoJsonGeometry } from "../txgio/geo";

/** A closed square around a point, ~1 km on a side. */
function squareAround(lng: number, lat: number, deg = 0.01): GeoJsonGeometry {
  return {
    type: "Polygon",
    coordinates: [
      [
        [lng - deg, lat - deg],
        [lng + deg, lat - deg],
        [lng + deg, lat + deg],
        [lng - deg, lat + deg],
        [lng - deg, lat - deg],
      ],
    ],
  };
}

function coverageEntry(
  over: Partial<EtjSourceCoverageEntry> & { cityKey: string },
): EtjSourceCoverageEntry {
  return {
    cityName: over.cityKey,
    cityGeoId: null,
    mode: "etj_layer",
    hasEtjRings: true,
    bbox: null,
    ...over,
  };
}

describe("etj register — integrity", () => {
  it("has a unique key per city", () => {
    const keys = ETJ_REGISTRY.map((e) => e.cityKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(ETJ_REGISTRY.length);
  });

  it("splits into publishers with rings and enumerated publishers without", () => {
    expect(etjSourceEntries().length + cityLimitsOnlyEntries().length).toBe(
      ETJ_REGISTRY.length,
    );
    // 20 of the footprint's 23 wired cities publish a queryable ETJ layer; the
    // other 3 are enumerated and recorded as publishing none of their own.
    expect(etjSourceEntries().length).toBe(20);
    expect(cityLimitsOnlyEntries().length).toBe(3);
  });

  it("never marks a combined layer as having no membership predicate", () => {
    // The load-bearing invariant: Austin, New Braunfels, Kyle, Cibolo and
    // Bastrop carry city limits and ETJ in ONE layer. Without a predicate the
    // ingest would take every polygon in the layer as ETJ, including the city
    // limits.
    for (const entry of ETJ_REGISTRY) {
      if (entry.mode === "combined") {
        expect(entry.etjMembership, entry.cityKey).not.toBeNull();
        expect(entry.etjMembership!.values.length, entry.cityKey).toBeGreaterThan(0);
        expect(entry.layerCarriesCityLimits, entry.cityKey).toBe(true);
      }
      if (entry.mode === "city_limits_only") {
        expect(entry.layerUrl, entry.cityKey).toBeNull();
        expect(entry.etjMembership, entry.cityKey).toBeNull();
      }
      if (entry.mode === "etj_layer") {
        expect(entry.layerUrl, entry.cityKey).not.toBeNull();
      }
    }
  });

  it("requires a predicate on every layer that names more than one city", () => {
    // A multi-city layer without a predicate ingests a neighbouring city's ETJ
    // as this city's. Elgin's is a six-city Bastrop layer; Killeen's ETJ is
    // published only inside Belton's seventeen-city regional layer.
    for (const entry of ETJ_REGISTRY) {
      if ((entry.layerJurisdictions ?? 1) > 1) {
        expect(entry.etjMembership, entry.cityKey).not.toBeNull();
        expect(etjPredicateMustBeSelective(entry), entry.cityKey).toBe(true);
      }
      if (entry.etjMembership === null && entry.layerUrl !== null) {
        expect(entry.layerJurisdictions, entry.cityKey).toBe(1);
      }
    }
  });

  it("acquires Killeen's ETJ from the regional layer that actually carries it", () => {
    const killeen = etjRegistryEntry("killeen-tx")!;
    expect(killeen.layerUrl).toContain("Admin_Boundaries/FeatureServer/3");
    expect(etjWhereClause(killeen)).toBe("CITY_NAME IN ('KILLEEN')");
    // Its own host publishes city limits only; that URL is kept for the record.
    expect(killeen.cityLimitsLayerUrl).toContain("killeengis.killeentexas.gov");
  });

  it("quotes string predicates and leaves numeric ones bare", () => {
    const austin = etjRegistryEntry("austin-tx")!;
    expect(etjWhereClause(austin)).toBe(
      "JURISDICTION_TYPE IN ('2MILE','5MIL','2MILE_AG')",
    );
    const newBraunfels = etjRegistryEntry("new-braunfels-tx")!;
    expect(etjWhereClause(newBraunfels)).toBe("BoundaryType IN (1)");
    const georgetown = etjRegistryEntry("georgetown-tx")!;
    expect(etjWhereClause(georgetown)).toBe("1=1");
    const bastrop = etjRegistryEntry("bastrop-city-tx")!;
    expect(etjWhereClause(bastrop)).toBe("juris IN ('ETJ')");
    const elgin = etjRegistryEntry("elgin-tx")!;
    expect(etjWhereClause(elgin)).toBe("etj IN ('Elgin ETJ')");
  });

  it("excludes limited-purpose annexation from the ETJ predicate", () => {
    // LTD is annexation: inside the city, not outside it. Austin's own layer
    // labels it "AUSTIN LTD" and New Braunfels numbers it 2.
    const austin = etjRegistryEntry("austin-tx")!;
    expect(austin.etjMembership!.values).not.toContain("LTD");
    const newBraunfels = etjRegistryEntry("new-braunfels-tx")!;
    expect(newBraunfels.etjMembership!.values).not.toContain(2);
  });

  it("round-trips a lookup and misses cleanly", () => {
    expect(etjRegistryEntry("seguin-tx")?.cityName).toBe("Seguin");
    expect(etjRegistryEntry("houston-tx")).toBeNull();
  });
});

describe("etj containment — three-valued disposition", () => {
  const austinRing = {
    etjId: "austin-tx:22",
    cityKey: "austin-tx",
    cityName: "Austin",
    ringLabel: "AUSTIN 2 MILE ETJ",
    geometry: squareAround(-97.855113, 30.352812),
    sourceCitation: "https://example.test/austin/0",
    // P-359: a row with no served status is REFUSED, not assumed testable. The
    // publisher's own drawing is what `verbatim` names.
    servedStatus: "verbatim" as const,
  };

  it("reports present with the publisher's own ring label", () => {
    const result = resolveEtjAtPoint(
      -97.855113,
      30.352812,
      buildEtjBoundaryIndex([austinRing]),
      [
        coverageEntry({
          cityKey: "austin-tx",
          cityName: "Austin",
          bbox: {
            westLng: -98.02,
            southLat: 30.03,
            eastLng: -97.47,
            northLat: 30.53,
          },
        }),
      ],
      { cityName: "Austin", geoId: "4805000" },
    );
    expect(result.status).toBe("present");
    if (result.status !== "present") throw new Error("unreachable");
    expect(result.cityKey).toBe("austin-tx");
    expect(result.ringLabel).toBe("AUSTIN 2 MILE ETJ");
    expect(result.etjId).toBe("austin-tx:22");
    expect(result.sourceCitation).toBe("https://example.test/austin/0");
  });

  it("reports absent when a publisher's own extent covers the point and no ring does", () => {
    const result = resolveEtjAtPoint(
      -97.7,
      30.42,
      buildEtjBoundaryIndex([austinRing]),
      [
        coverageEntry({
          cityKey: "austin-tx",
          cityName: "Austin",
          bbox: {
            westLng: -98.02,
            southLat: 30.03,
            eastLng: -97.47,
            northLat: 30.53,
          },
        }),
      ],
      { cityName: "Austin", geoId: "4805000" },
    );
    expect(result.status).toBe("absent");
    if (result.status !== "absent") throw new Error("unreachable");
    expect(result.coveredBy).toEqual(["austin-tx"]);
    expect(result.ringsConsulted).toBe(1);
    expect(result.basis).toContain("verified absent");
  });

  it("reports unresolved — never absent — when nothing has been acquired", () => {
    const result = resolveEtjAtPoint(
      -97.855113,
      30.352812,
      buildEtjBoundaryIndex([]),
      [],
    );
    expect(result.status).toBe("unresolved");
    expect(result.basis).toContain("unmeasured");
  });

  it("reports unresolved and names the mode when the city publishes no ETJ layer", () => {
    // Round Rock's own coordinates fall INSIDE the box of Austin's published
    // ETJ extent, so a box-only rule would answer "absent" — a confirmed
    // absence of ETJ in a city that publishes no ETJ at all. The containing
    // city's own register row has to win.
    const result = resolveEtjAtPoint(
      -97.67769,
      30.50827,
      buildEtjBoundaryIndex([austinRing]),
      [
        coverageEntry({
          cityKey: "round-rock-tx",
          cityName: "Round Rock",
          cityGeoId: "4863500",
          mode: "city_limits_only",
          hasEtjRings: false,
        }),
        coverageEntry({
          cityKey: "austin-tx",
          cityName: "Austin",
          bbox: {
            westLng: -98.02,
            southLat: 30.03,
            eastLng: -97.47,
            northLat: 30.53,
          },
        }),
      ],
      { cityName: "Round Rock", geoId: "4863500" },
    );
    expect(result.status).toBe("unresolved");
    if (result.status !== "unresolved") throw new Error("unreachable");
    expect(result.basis).toContain("mode=city_limits_only");
    expect(result.basis).toContain("Round Rock");
    expect(result.basis).toContain("not a confirmed absence of ETJ");
  });

  it("stays absent inside a city limits that DOES publish ETJ", () => {
    // The paired control for the test above: same box, but the containing city
    // publishes rings, so the miss is a real checked absence.
    const result = resolveEtjAtPoint(
      -97.75715,
      30.41603,
      buildEtjBoundaryIndex([austinRing]),
      [
        coverageEntry({
          cityKey: "austin-tx",
          cityName: "Austin",
          cityGeoId: "4805000",
          bbox: {
            westLng: -98.02,
            southLat: 30.03,
            eastLng: -97.47,
            northLat: 30.53,
          },
        }),
      ],
      { cityName: "Austin", geoId: "4805000" },
    );
    expect(result.status).toBe("absent");
  });

  it("reports unresolved and names the city when nothing is registered for it", () => {
    const result = resolveEtjAtPoint(
      -95.36936,
      29.76024,
      buildEtjBoundaryIndex([austinRing]),
      [
        coverageEntry({
          cityKey: "austin-tx",
          cityName: "Austin",
          bbox: {
            westLng: -98.02,
            southLat: 30.03,
            eastLng: -97.47,
            northLat: 30.53,
          },
        }),
      ],
      { cityName: "Houston", geoId: "4835000" },
    );
    expect(result.status).toBe("unresolved");
    if (result.status !== "unresolved") throw new Error("unreachable");
    expect(result.basis).toContain("Houston");
    expect(result.basis).toContain("not in the ETJ register");
  });

  it("reports absent for an unincorporated point inside a publisher's extent", () => {
    const result = resolveEtjAtPoint(
      -97.7,
      30.42,
      buildEtjBoundaryIndex([austinRing]),
      [
        coverageEntry({
          cityKey: "austin-tx",
          cityName: "Austin",
          bbox: {
            westLng: -98.02,
            southLat: 30.03,
            eastLng: -97.47,
            northLat: 30.53,
          },
        }),
      ],
      null,
    );
    expect(result.status).toBe("absent");
  });

  it("reports unresolved for an unincorporated point outside every extent", () => {
    const result = resolveEtjAtPoint(
      -95.36936,
      29.76024,
      buildEtjBoundaryIndex([austinRing]),
      [
        coverageEntry({
          cityKey: "austin-tx",
          cityName: "Austin",
          bbox: {
            westLng: -98.02,
            southLat: 30.03,
            eastLng: -97.47,
            northLat: 30.53,
          },
        }),
      ],
      null,
    );
    expect(result.status).toBe("unresolved");
    if (result.status !== "unresolved") throw new Error("unreachable");
    expect(result.basis).toContain("0 of 1 registered ETJ publishers");
  });

  it("resolves a parcel geometry through its representative point", () => {
    const result = resolveEtj(
      squareAround(-97.855113, 30.352812, 0.0001),
      buildEtjBoundaryIndex([austinRing]),
      [
        coverageEntry({
          cityKey: "austin-tx",
          cityName: "Austin",
          bbox: {
            westLng: -98.02,
            southLat: 30.03,
            eastLng: -97.47,
            northLat: 30.53,
          },
        }),
      ],
      null,
    );
    expect(result.status).toBe("present");
  });

  it("declares an untestable ring instead of silently dropping it from the index", () => {
    // A point where a ring should be can never contain a query point, so it must
    // not be indexed as a ring that was tested and missed. It is a REFUSAL with
    // its reason (P-359), because "0 rings consulted" and "1 ring we could not
    // test" are different facts about the point.
    const built = buildEtjBoundaryIndex([
      { ...austinRing, geometry: { type: "Point", coordinates: [0, 0] } },
    ]);
    expect(built.rings).toHaveLength(0);
    expect(built.refusals).toHaveLength(1);
    expect(built.refusals[0]!.etjId).toBe("austin-tx:22");
    expect(built.refusals[0]!.reason).toMatch(/not a Polygon or MultiPolygon/);
  });
});

describe("etj containment — P-359 served geometry", () => {
  const AUSTIN_EXTENT_ENTRY = coverageEntry({
    cityKey: "austin-tx",
    cityName: "Austin",
    bbox: { westLng: -98.02, southLat: 30.03, eastLng: -97.47, northLat: 30.53 },
  });

  /**
   * The published ring is the outer square; the served geometry is that square
   * minus a hole over the city limits the ring encloses — the real Austin shape
   * (its 2-mile ETJ wraps city limits) reduced to a fixture.
   */
  const OUTER = [
    [
      [-97.90, 30.30],
      [-97.80, 30.30],
      [-97.80, 30.40],
      [-97.90, 30.40],
      [-97.90, 30.30],
    ],
  ];
  const HOLE = [
    [-97.87, 30.33],
    [-97.83, 30.33],
    [-97.83, 30.37],
    [-97.87, 30.37],
    [-97.87, 30.33],
  ];
  const IN_HOLE = { longitude: -97.85, latitude: 30.35 };
  const IN_RING_OUTSIDE_HOLE = { longitude: -97.885, latitude: 30.385 };

  function body(
    servedStatus: "verbatim" | "underived" | "excluded" | "withheld",
    over: Record<string, unknown> = {},
  ) {
    return {
      etjId: "austin-tx:7",
      cityKey: "austin-tx",
      cityName: "Austin",
      ringLabel: "AUSTIN 2 MILE ETJ",
      geometry: { type: "Polygon", coordinates: OUTER },
      sourceCitation: "https://example.test/austin/0",
      servedStatus,
      ...over,
    } as Parameters<typeof buildEtjBoundaryIndex>[0][number];
  }

  const DERIVATION_NOTE =
    "the ring contains its own city's representative point; served geometry is the ring minus that city's limits";

  it("FALSIFIER A: the SERVED geometry is what containment tests, not the published ring", () => {
    // Pre-change, `geometry` was tested for every row, so a point inside the
    // subtracted city limits read `present` — ETJ over a house inside the city.
    const derived = buildEtjBoundaryIndex([
      body("derived", {
        servedGeometry: { type: "Polygon", coordinates: [OUTER[0], HOLE] },
        derivation: { kind: "self_containing", note: DERIVATION_NOTE },
      }),
    ]);
    const inHole = resolveEtjAtPoint(
      IN_HOLE.longitude,
      IN_HOLE.latitude,
      derived,
      [AUSTIN_EXTENT_ENTRY],
      { cityName: "Austin", geoId: "4805000" },
    );
    expect(inHole.status).toBe("absent");
    if (inHole.status !== "absent") throw new Error("unreachable");
    // Two rings would be wrong to report as "tested and missed": the derived ring
    // WAS tested, and its answer over its own hole is a real no.
    expect(inHole.ringsConsulted).toBe(1);

    // The pair: the same row still answers `present` over the derived part of
    // the ring, so the falsifier is about WHICH polygon, not about refusing.
    const inRing = resolveEtjAtPoint(
      IN_RING_OUTSIDE_HOLE.longitude,
      IN_RING_OUTSIDE_HOLE.latitude,
      buildEtjBoundaryIndex([
        body("derived", {
          servedGeometry: { type: "Polygon", coordinates: [OUTER[0], HOLE] },
          derivation: { kind: "self_containing", note: DERIVATION_NOTE },
        }),
      ]),
      [AUSTIN_EXTENT_ENTRY],
      { cityName: "Austin", geoId: "4805000" },
    );
    expect(inRing.status).toBe("present");
    if (inRing.status !== "present") throw new Error("unreachable");
    expect(inRing.servedStatus).toBe("derived");
    expect(inRing.derivationNote).toBe(DERIVATION_NOTE);
    expect(inRing.basis).toContain("served derived");
  });

  it("a present on a verbatim ring carries verbatim and no derivation note", () => {
    const result = resolveEtjAtPoint(
      IN_RING_OUTSIDE_HOLE.longitude,
      IN_RING_OUTSIDE_HOLE.latitude,
      buildEtjBoundaryIndex([body("verbatim")]),
      [AUSTIN_EXTENT_ENTRY],
      { cityName: "Austin", geoId: "4805000" },
    );
    expect(result.status).toBe("present");
    if (result.status !== "present") throw new Error("unreachable");
    expect(result.servedStatus).toBe("verbatim");
    expect(result.derivationNote).toBeNull();
    expect(etjFactFromContainment(result).derivationNote).toBeUndefined();
  });

  it("FALSIFIER B: a ring whose derivation never ran is refused, and the point is unresolved, never absent", () => {
    // The row is IN the bbox pre-filter and its published polygon contains the
    // point — pre-change that was a `present` against an unproven polygon.
    const result = resolveEtjAtPoint(
      -97.885,
      30.385,
      buildEtjBoundaryIndex([body("underived")]),
      [AUSTIN_EXTENT_ENTRY],
      { cityName: "Austin", geoId: "4805000" },
    );
    expect(result.status).toBe("unresolved");
    expect(result.status).not.toBe("absent");
    if (result.status !== "unresolved") throw new Error("unreachable");
    expect(result.basis).toContain("austin-tx:7");
    expect(result.basis).toContain("underived");
    expect(result.refusedRings).toEqual([
      {
        etjId: "austin-tx:7",
        servedStatus: "underived",
        reason: expect.stringContaining("no derivation pass has run"),
      },
    ]);
  });

  it("FALSIFIER C: an excluded ring declares the derivation's own reason instead of being tested", () => {
    const reason =
      "ST_IsValid false and ST_MakeValid moved the area beyond the declared relative tolerance; nothing is served";
    const result = resolveEtjAtPoint(
      -97.885,
      30.385,
      buildEtjBoundaryIndex([
        body("excluded", { derivation: { kind: "invalid", note: reason } }),
      ]),
      [AUSTIN_EXTENT_ENTRY],
      { cityName: "Austin", geoId: "4805000" },
    );
    expect(result.status).toBe("unresolved");
    if (result.status !== "unresolved") throw new Error("unreachable");
    expect(result.basis).toContain(reason);
    expect(result.refusedRings?.[0]?.servedStatus).toBe("excluded");
  });

  it("FALSIFIER D: a servable status with no usable served geometry is a refusal, not a silent absence", () => {
    const result = resolveEtjAtPoint(
      -97.885,
      30.385,
      buildEtjBoundaryIndex([
        body("derived", { servedGeometry: null }),
      ]),
      [AUSTIN_EXTENT_ENTRY],
      { cityName: "Austin", geoId: "4805000" },
    );
    expect(result.status).toBe("unresolved");
    if (result.status !== "unresolved") throw new Error("unreachable");
    expect(result.refusedRings?.[0]?.reason).toMatch(
      /served_status=derived but the served geometry is not a Polygon/,
    );
  });
});

describe("etj fact DTO", () => {
  it("carries the publisher citation on present and the coverage set on absent", () => {
    const present = etjFactFromContainment({
      status: "present",
      cityKey: "austin-tx",
      cityName: "Austin",
      etjId: "austin-tx:22",
      ringLabel: "AUSTIN 2 MILE ETJ",
      sourceCitation: "https://example.test/austin/0",
      basis: "basis",
    });
    expect(present.source).toBe("tx_etj_boundary");
    expect(present.sourceCitation).toBe("https://example.test/austin/0");

    const absent = etjFactFromContainment({
      status: "absent",
      coveredBy: ["austin-tx"],
      ringsConsulted: 3,
      basis: "basis",
    });
    expect(absent.status).toBe("absent");
    expect(absent.coveredBy).toEqual(["austin-tx"]);
    expect(absent.ringsConsulted).toBe(3);
  });

  it("treats a degenerate query point as unusable", () => {
    expect(usableEtjQueryPoint(0, 0)).toBeNull();
    expect(usableEtjQueryPoint(Number.NaN, 30)).toBeNull();
    expect(usableEtjQueryPoint(-97.8, 30.3)).toEqual({
      longitude: -97.8,
      latitude: 30.3,
    });
  });

  it("never reports a disposition other than unresolved from unmeasuredEtjFact", () => {
    expect(unmeasuredEtjFact("why").status).toBe("unresolved");
    expect(unmeasuredEtjFact("why").basis).toBe("why");
  });
});

describe("etj parse", () => {
  const austin = etjRegistryEntry("austin-tx")!;
  const georgetown = etjRegistryEntry("georgetown-tx")!;
  const waco = etjRegistryEntry("waco-tx")!;

  const austinProperties = {
    OBJECTID: 22,
    JURISDICTION_TYPE: "2MILE",
    JURISDICTION_LABEL: "AUSTIN 2 MILE ETJ",
  };

  it("keys the ring by register city and publisher object id", () => {
    const counters = newCounters();
    const rec = normalizeEtjBoundaryFeature(
      austin,
      { geometry: squareAround(-97.8, 30.3), properties: austinProperties },
      { layerName: "BOUNDARIES_jurisdictions", objectIdField: "OBJECTID" },
      counters,
    );
    expect(rec).not.toBeNull();
    expect(rec!.etjId).toBe("austin-tx:22");
    expect(rec!.cityKey).toBe("austin-tx");
    expect(rec!.cityGeoId).toBe("4805000");
    expect(rec!.ringLabel).toBe("AUSTIN 2 MILE ETJ");
    expect(rec!.sourceCitation).toBe(austin.layerUrl);
    expect(counters.rowsSkipped).toBe(0);
  });

  it("reads the declaring layer's own object id field name", () => {
    expect(readObjectId({ OBJECTID_1: 9 }, "OBJECTID_1")).toBe("9");
    expect(readObjectId({ FID: 4 }, "FID")).toBe("4");
    expect(readObjectId({ OBJECTID: 7 }, null)).toBe("7");
    expect(readObjectId({ notes: "x" }, "OBJECTID")).toBeNull();
  });

  it("falls back to the publisher's layer name when the layer names no ring label", () => {
    // Waco publishes only an integer INSIDE flag, so the label has to be the
    // publisher's layer name — still a published string, never synthesised.
    expect(
      readRingLabel(waco, { OBJECTID: 1, INSIDE: 1 }, { layerName: "Waco ETJ" }),
    ).toBe("Waco ETJ");
    expect(
      readRingLabel(waco, { OBJECTID: 1 }, { layerName: null }),
    ).toBe("Waco ETJ");
  });

  it("prefers the label attribute and collapses its whitespace", () => {
    expect(
      readRingLabel(
        { ...austin, labelField: "Label" },
        { Label: "  North   ETJ  " },
        { layerName: "ignored" },
      ),
    ).toBe("North ETJ");
  });

  it("declines a feature with no readable object id instead of inventing a key", () => {
    const counters = newCounters();
    const rec = normalizeEtjBoundaryFeature(
      georgetown,
      { geometry: squareAround(-97.8, 30.3), properties: { CITY_NAME: "Georgetown" } },
      { layerName: "Extra-Territorial Jurisdiction", objectIdField: null },
      counters,
    );
    expect(rec).toBeNull();
    expect(counters.rowsSkipped).toBe(1);
    expect(counters.skipSamples[0]).toContain("no readable object id");
  });

  it("declines a line or point geometry", () => {
    const counters = newCounters();
    const rec = normalizeEtjBoundaryFeature(
      austin,
      {
        geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
        properties: austinProperties,
      },
      { layerName: "BOUNDARIES_jurisdictions", objectIdField: "OBJECTID" },
      counters,
    );
    expect(rec).toBeNull();
    expect(counters.skipSamples[0]).toContain("no polygon geometry");
  });

  it("declines a feature with no label attribute and no layer name to fall back on", () => {
    const counters = newCounters();
    const rec = normalizeEtjBoundaryFeature(
      { ...waco, layerNameFallback: null },
      { geometry: squareAround(-97.8, 30.3), properties: { OBJECTID: 5 } },
      { layerName: null, objectIdField: "OBJECTID" },
      counters,
    );
    expect(rec).toBeNull();
    expect(counters.skipSamples[0]).toContain("no ring label");
  });
});

// ---------------------------------------------------------------------------
// P-376: an incorporated parcel is outside every ETJ, and the determination says
// so BEFORE any ring is consulted.
//
// Pre-change, every point reached the ring path, so a published ring the reader
// must refuse (P-359) turned an incorporated parcel's answer into `unresolved`
// — "we could not look", served for land the law had already placed outside
// every ETJ. The subject is a parcel whose OWN city-limits fact determines it
// incorporated; the ETJ side is P-359's refused-ring fixture, unchanged.
//
// Every assertion here is paired: the same fixture with the settlement removed
// must still answer `unresolved` with the refused ring named. A change that
// moves both directions is a change that flattened the disposition.
// ---------------------------------------------------------------------------

/** A query point inside the fixture city and inside the fixture rings. */
const QUERY_LNG = -97.4;
const QUERY_LAT = 30.3;

/** What the city-limits fact hands over when it determines incorporation. */
function settlement(
  over: Partial<EtjIncorporationSettlement> = {},
): EtjIncorporationSettlement {
  return {
    cityName: "Elgin",
    geoId: "48118",
    source: "tx_city_boundary",
    cityLimitsBasis:
      "parcel_record cityLimits: incorporated, city 'Elgin' " +
      "(source: landing_parcel_jurisdiction, vintage: 2026-09-17T00:00:00.000Z).",
    ...over,
  };
}

/** A ring the reader may NOT test: no derivation pass has run (P-359). */
const UNDERIVED_RING = {
  etjId: "elgin-tx:3",
  cityKey: "elgin-tx",
  cityName: "Elgin",
  ringLabel: "Elgin ETJ",
  geometry: squareAround(QUERY_LNG, QUERY_LAT, 0.05),
  servedGeometry: null,
  servedStatus: "underived" as const,
  derivation: null,
  bbox: {
    westLng: QUERY_LNG - 0.05,
    southLat: QUERY_LAT - 0.05,
    eastLng: QUERY_LNG + 0.05,
    northLat: QUERY_LAT + 0.05,
  },
  sourceCitation: "https://example.test/elgin/3",
};

/** A ring the reader MAY test, drawn around the same point. */
const ELGIN_VERBATIM_RING = {
  ...UNDERIVED_RING,
  etjId: "elgin-tx:10",
  ringLabel: "Elgin ETJ (verbatim)",
  geometry: squareAround(QUERY_LNG, QUERY_LAT, 0.05),
  servedStatus: "verbatim" as const,
};

const ELGIN_EXTENT = coverageEntry({
  cityKey: "elgin-tx",
  cityName: "Elgin",
  bbox: {
    westLng: -97.6,
    southLat: 30.1,
    eastLng: -97.2,
    northLat: 30.5,
  },
});

describe("etj containment — P-376 the incorporation settlement", () => {
  it("FALSIFIER 1: an incorporated parcel with a REAL basis reads not in an ETJ, and no refused ring is named", () => {
    const result = resolveEtjAtPoint(
      QUERY_LNG,
      QUERY_LAT,
      buildEtjBoundaryIndex([UNDERIVED_RING]),
      [ELGIN_EXTENT],
      { cityName: "Elgin", geoId: "48118", incorporation: settlement() },
    );
    expect(result.status).toBe("absent");
    if (result.status !== "absent") return;
    expect(result.settledBy).toBe("incorporation");
    expect(result.coveredBy).toEqual([]);
    expect(result.ringsConsulted).toBe(0);
    expect(result.basis).toContain("not in an ETJ");
    expect(result.basis).toContain("Elgin");
    // The legal ground is NAMED in the answer, not left to the reader's memory.
    expect(result.basis).toContain("UNINCORPORATED area contiguous");
    expect(result.basis).toContain("Tex. Loc. Gov't Code ch. 42");
    // The fact's own source and vintage travel with the settlement.
    expect(result.incorporation).toEqual(settlement());
    // The refused ring is NOT the reason this answer is what it is: it never had
    // to be asked, so a consumer cannot read a refusal into a settled absence.
    expect("refusedRings" in result).toBe(false);
  });

  it("FALSIFIER 2 (the control, same fixture): without the settlement the SAME point is unresolved and NAMES the refused ring", () => {
    const result = resolveEtjAtPoint(
      QUERY_LNG,
      QUERY_LAT,
      buildEtjBoundaryIndex([UNDERIVED_RING]),
      [ELGIN_EXTENT],
      { cityName: "Elgin", geoId: "48118" },
    );
    expect(result.status).toBe("unresolved");
    if (result.status !== "unresolved") return;
    expect(result.refusedRings?.[0]?.etjId).toBe("elgin-tx:3");
    expect(result.basis).not.toContain("not in an ETJ");
  });

  it("FALSIFIER 3: the settlement precedes the EMPTY STORE too — an incorporated parcel is not answered by our coverage", () => {
    // No rings, no refusals, no register at all. Pre-change (and without a
    // settlement) this is `unresolved`: "no ETJ source has been acquired". The
    // parcel's ETJ answer does not depend on our ETJ coverage, so it does not.
    const withSettlement = resolveEtjAtPoint(QUERY_LNG, QUERY_LAT, { rings: [], refusals: [] }, [], {
      cityName: "Elgin",
      geoId: "48118",
      incorporation: settlement(),
    });
    expect(withSettlement.status).toBe("absent");

    const withoutSettlement = resolveEtjAtPoint(
      QUERY_LNG,
      QUERY_LAT,
      { rings: [], refusals: [] },
      [],
      { cityName: "Elgin", geoId: "48118" },
    );
    expect(withoutSettlement.status).toBe("unresolved");
    if (withoutSettlement.status !== "unresolved") return;
    expect(withoutSettlement.basis).toContain("no ETJ source has been acquired");
  });

  it("FALSIFIER 4: a servable ring that CONTAINS the point does not answer for an incorporated parcel", () => {
    // The pair is the direction check. The law settles the first: an ETJ is
    // unincorporated area, so a published ring that swallows an in-city parcel
    // is a drawing convention (P-359's own subject), not an answer.
    const incorporated = resolveEtjAtPoint(
      QUERY_LNG,
      QUERY_LAT,
      buildEtjBoundaryIndex([ELGIN_VERBATIM_RING]),
      [ELGIN_EXTENT],
      { cityName: "Elgin", geoId: "48118", incorporation: settlement() },
    );
    expect(incorporated.status).toBe("absent");
    if (incorporated.status === "absent") {
      expect(incorporated.settledBy).toBe("incorporation");
    }

    // The same ring and the same point, unincorporated: `present`, untouched,
    // with the publisher's own label and layer.
    const unincorporated = resolveEtjAtPoint(
      QUERY_LNG,
      QUERY_LAT,
      buildEtjBoundaryIndex([ELGIN_VERBATIM_RING]),
      [ELGIN_EXTENT],
    );
    expect(unincorporated.status).toBe("present");
    if (unincorporated.status !== "present") return;
    expect(unincorporated.etjId).toBe("elgin-tx:10");
    expect(unincorporated.basis).toContain("etj_id=elgin-tx:10");
  });

  it("refuses to settle on a settlement that names no city, no source or no basis — the gate is able to fire", () => {
    // Hand-assembled, so the check this asserts is the resolver's own and not a
    // type's. Each of the three is dropped in turn; each must fall through to
    // the ring path rather than serve "incorporated in ."
    for (const broken of [
      settlement({ cityName: "  " }),
      settlement({ source: "" }),
      settlement({ cityLimitsBasis: "\n" }),
    ]) {
      const result = resolveEtjAtPoint(
        QUERY_LNG,
        QUERY_LAT,
        buildEtjBoundaryIndex([UNDERIVED_RING]),
        [ELGIN_EXTENT],
        { cityName: "Elgin", geoId: "48118", incorporation: broken },
      );
      expect(result.status, JSON.stringify(broken)).toBe("unresolved");
      expect("settledBy" in result, JSON.stringify(broken)).toBe(false);
    }
    // Non-vacuity: the same call with an intact settlement settles.
    const intact = resolveEtjByIncorporation({
      incorporation: settlement(),
    });
    expect(intact?.status).toBe("absent");
  });

  it("never settles from an `unincorporated` or an unmeasured city-limits fact", () => {
    expect(incorporationSettlesEtj(null)).toBeNull();
    expect(
      incorporationSettlesEtj({
        status: "unmeasured",
        etjStatus: "unresolved",
        source: "tx_city_boundary",
        basis: "tx_city_boundary has zero rows; city limits are unmeasured",
      }),
    ).toBeNull();
    expect(
      incorporationSettlesEtj({
        status: "unincorporated",
        etjStatus: "unresolved",
        source: "tx_city_boundary",
        basis: "no incorporated-place polygon contains the query point",
      }),
    ).toBeNull();
    // An `incorporated` fact with no city to name is a legal ground with no
    // subject: it settles nothing rather than settling on air.
    expect(
      incorporationSettlesEtj({
        status: "incorporated",
        etjStatus: "unresolved",
        source: "tx_city_boundary",
        basis: "point-in-polygon against tx_city_boundary geo_id=48118",
      }),
    ).toBeNull();
  });

  it("carries the fact's own city, geoId, source and basis sentence into the settlement verbatim", () => {
    const s = incorporationSettlesEtj({
      status: "incorporated",
      etjStatus: "unresolved",
      source: "tx_city_boundary",
      basis:
        "parcel_record cityLimits: incorporated, city 'Kyle' " +
        "(source: landing_parcel_jurisdiction, vintage: 2026-09-16T00:00:00.000Z).",
      cityName: " Kyle ",
      geoId: "4824188",
    });
    expect(s).toEqual({
      cityName: "Kyle",
      geoId: "4824188",
      source: "tx_city_boundary",
      // NOT re-parsed: the vintage is inside the sentence the fact wrote.
      cityLimitsBasis:
        "parcel_record cityLimits: incorporated, city 'Kyle' " +
        "(source: landing_parcel_jurisdiction, vintage: 2026-09-16T00:00:00.000Z).",
    });
    // And a branch with no geoId says so rather than inventing one.
    expect(
      incorporationSettlesEtj({
        status: "incorporated",
        etjStatus: "unresolved",
        source: "tx_city_boundary",
        basis: "parcel_record cityLimits: incorporated, city 'Buda'.",
        cityName: "Buda",
      })?.geoId,
    ).toBeNull();
  });
});

