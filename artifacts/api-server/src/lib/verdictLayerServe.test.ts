import { describe, expect, it } from "vitest";
import {
  assertNoVerdictUpgrade,
  buildStructuralLookupFailedAbsence,
  countyFipsFromParcelNodeId,
  countyHasUnzonedUnincorporatedDoctrine,
  isStructuralCamaLookupFailed,
  isStructuralCamaLookupFailedForDeclaredTier,
  isUnincorporatedNoZoningAuthorityShape,
  LAYER_ABSENCE_VERDICTS,
  mergeLayerVerdict,
  parcelShapeLacksZoningAuthority,
  zoningVerdictFromCityLimits,
  type CityLimitsContainment,
} from "./verdictLayerServe";
import { enrichLandUseFactWithZoningVerdict } from "./landUseFactVerdict";

type LandUseAtomMiss = {
  state: "refused";
  code: "atom-miss";
  source: "land-use-fact";
  tried: readonly string[];
  reason: string;
};

const AS_OF = "2026-08-28T20:00:00.000Z";
const POINT = { longitude: -97.75, latitude: 30.26 };

/** The baked facets of a conformant parcel WITHOUT a stamp (the stored shape, before serve). */
const UNSTAMPED_NULL_CITY = {
  zoning: null,
  baseFacts: { situsCity: null, situsZip: null },
  facetCoverage: { zoning: false },
  envelope: { declineReason: "no-zoning-stamp" },
};

const INSIDE_AUSTIN: CityLimitsContainment = {
  status: "incorporated",
  etjStatus: "unresolved",
  source: "tx_city_boundary",
  basis: "point-in-polygon against tx_city_boundary geo_id=4805000",
  cityName: "Austin",
  geoId: "4805000",
  gnis: "1389879",
  queryPoint: POINT,
};

const OUTSIDE_EVERY_POLYGON: CityLimitsContainment = {
  status: "unincorporated",
  etjStatus: "unresolved",
  source: "tx_city_boundary",
  basis:
    "no incorporated-place polygon contains the query point (tx_city_boundary statewide index; unincorporated is the honest answer)",
  queryPoint: { longitude: -97.9, latitude: 30.4 },
};

const EMPTY_INDEX: CityLimitsContainment = {
  status: "unmeasured",
  etjStatus: "unresolved",
  source: "tx_city_boundary",
  basis: "tx_city_boundary has zero rows; city limits are unmeasured, not unincorporated",
  queryPoint: POINT,
};

const NO_POINT: CityLimitsContainment = {
  status: "unmeasured",
  etjStatus: "unresolved",
  source: "tx_city_boundary",
  basis: "no usable parcel query point; city limits are unmeasured",
  queryPoint: null,
};

describe("verdictLayerServe", () => {
  it("parses county FIPS from parcelNodeId", () => {
    expect(countyFipsFromParcelNodeId("48439:412831")).toBe("48439");
    expect(countyFipsFromParcelNodeId("bad")).toBeNull();
  });

  it("flags bulk_primary + stratmap-roll as structural lookup-failed", () => {
    expect(isStructuralCamaLookupFailedForDeclaredTier("48439", "stratmap-roll")).toBe(
      true,
    );
    expect(isStructuralCamaLookupFailedForDeclaredTier("48439", "cad-export")).toBe(
      false,
    );
    // 48085 Collin is stratmap-roll but not bulk_primary
    expect(isStructuralCamaLookupFailedForDeclaredTier("48085", "stratmap-roll")).toBe(
      false,
    );
    // Dallas/Tarrant are bulk_primary but currently cad-export in vintage.ts
    expect(isStructuralCamaLookupFailed("48113")).toBe(false);
    expect(isStructuralCamaLookupFailed("48439")).toBe(false);
  });

  it("builds lookup-failed absence with required doc 19 fields", () => {
    const wire = buildStructuralLookupFailedAbsence(
      "48439",
      "2026-08-22T00:00:00.000Z",
    );
    expect(wire).toMatchObject({
      status: "absent",
      verdict: "lookup-failed",
      authority: "tad",
      provenanceClass: "Record",
      serveLayer: "cad",
      chainAnchoring: "backfill",
      subjectKind: "extensional",
      entityType: "cad_property",
    });
    expect(wire.basis).toContain("bulk_primary=true");
    expect(wire.basis).toContain("stratmap-roll");
    expect(wire.scopeSearched).toContain("stratmap-roll");
  });

  it("the stamp predicate sees an unstamped shape and never reads situsCity", () => {
    expect(parcelShapeLacksZoningAuthority(UNSTAMPED_NULL_CITY)).toBe(true);
    expect(
      parcelShapeLacksZoningAuthority({ ...UNSTAMPED_NULL_CITY, baseFacts: { situsCity: "AUSTIN" } }),
    ).toBe(true);
    expect(
      parcelShapeLacksZoningAuthority({ zoning: { district: "SF-1" }, baseFacts: { situsCity: null } }),
    ).toBe(false);
  });

  it("the six Central Texas counties declare unzoned unincorporated territory (texas_county_roster_v1)", () => {
    for (const fips of ["48021", "48055", "48209", "48309", "48453", "48491"]) {
      expect(countyHasUnzonedUnincorporatedDoctrine(fips)).toBe(true);
    }
  });

  it("the verdict vocabulary carries stamp-missing and unmeasured beside the three P-63 verdicts", () => {
    expect([...LAYER_ABSENCE_VERDICTS]).toEqual([
      "absent-verified",
      "lookup-failed",
      "not-applicable",
      "stamp-missing",
      "unmeasured",
    ]);
  });

  it("refuses lookup-failed → absent-verified upgrade", () => {
    expect(() =>
      assertNoVerdictUpgrade("lookup-failed", "absent-verified"),
    ).toThrow(/forbidden/);
    expect(() =>
      assertNoVerdictUpgrade("lookup-failed", "lookup-failed"),
    ).not.toThrow();
  });

  it("mergeLayerVerdict enforces no upgrade", () => {
    expect(() =>
      mergeLayerVerdict(
        { source: "structural-fact" },
        {
          status: "absent",
          verdict: "absent-verified",
          authority: "x",
          scopeSearched: "x",
          asOf: "2026-08-22T00:00:00.000Z",
          basis: "x",
          provenanceClass: "Record",
          subjectKind: "extensional",
          chainAnchoring: "backfill",
          serveLayer: "cad",
        },
        { priorVerdict: "lookup-failed" },
      ),
    ).toThrow(/forbidden/);
  });
});

/**
 * CTX card F (2026-08-28): unincorporated is a finding about a boundary, never
 * about a null. The predicate takes the city-limits containment fact; a postal
 * or situs city is never the derivation. These three fixtures were run against
 * the pre-card code first and all three failed (the old predicate read
 * baseFacts.situsCity and ignored the third argument): fixture 1 "expected true
 * to be false", fixture 2 "expected false to be true", fixture 3 "expected true
 * to be false" (vitest run 2026-08-28 20:02Z on 5e5d1d95).
 */
describe("card F: incorporation is derived from city-limits containment, never from situsCity", () => {
  it("fixture 1: null situsCity with the point INSIDE a populated polygon is NOT unincorporated", () => {
    expect(
      isUnincorporatedNoZoningAuthorityShape("48453:493738", UNSTAMPED_NULL_CITY, INSIDE_AUSTIN),
    ).toBe(false);
  });

  it("fixture 2: a point OUTSIDE every polygon of a populated index is unincorporated even when the roll carries a postal city", () => {
    const postalCityOnly = {
      ...UNSTAMPED_NULL_CITY,
      baseFacts: { situsCity: "AUSTIN", situsZip: "78756" },
    };
    expect(
      isUnincorporatedNoZoningAuthorityShape("48453:1", postalCityOnly, OUTSIDE_EVERY_POLYGON),
    ).toBe(true);
  });

  it("fixture 3: an EMPTY index is unmeasured, never unincorporated", () => {
    expect(
      isUnincorporatedNoZoningAuthorityShape("48453:493738", UNSTAMPED_NULL_CITY, EMPTY_INDEX),
    ).toBe(false);
  });

  it("a missing containment fact, a missing point, and a stamped parcel are all not unincorporated", () => {
    expect(isUnincorporatedNoZoningAuthorityShape("48453:1", UNSTAMPED_NULL_CITY, null)).toBe(false);
    expect(isUnincorporatedNoZoningAuthorityShape("48453:1", UNSTAMPED_NULL_CITY, NO_POINT)).toBe(false);
    expect(
      isUnincorporatedNoZoningAuthorityShape(
        "48453:1",
        { zoning: { district: "SF-3" }, baseFacts: { situsCity: null } },
        OUTSIDE_EVERY_POLYGON,
      ),
    ).toBe(false);
  });

  it("a county with no declared unincorporated doctrine is never not-applicable", () => {
    // All 254 Texas counties declare zoning_regime.unincorporated=unzoned in
    // texas_county_roster_v1 (read 2026-08-28), so the undeclared branch is a
    // non-Texas parcel: 49019 Grand County, Utah (the Moab corpus).
    expect(countyHasUnzonedUnincorporatedDoctrine("49019")).toBe(false);
    expect(
      isUnincorporatedNoZoningAuthorityShape("49019:1", UNSTAMPED_NULL_CITY, OUTSIDE_EVERY_POLYGON),
    ).toBe(false);
  });
});

describe("zoningVerdictFromCityLimits: the served zoning layer for an unstamped parcel", () => {
  it("inside an incorporated place: stamp-missing, the place named, never not-applicable", () => {
    const wire = zoningVerdictFromCityLimits("48453:493738", UNSTAMPED_NULL_CITY, INSIDE_AUSTIN, AS_OF);
    expect(wire).not.toBeNull();
    expect(wire).toMatchObject({
      status: "absent",
      verdict: "stamp-missing",
      authority: "Austin",
      asOf: AS_OF,
      serveLayer: "zoning",
      entityType: "zoning-fact",
      derivation: {
        method: "city-limits-containment",
        source: "tx_city_boundary",
        cityLimitsStatus: "incorporated",
        queryPoint: POINT,
        place: { cityName: "Austin", geoId: "4805000", gnis: "1389879" },
        countyDoctrine: "unzoned-unincorporated",
      },
    });
    expect(wire!.scopeSearched).toBe(
      "municipal zoning stamp for Austin (tx_city_boundary geo_id=4805000) on parcel 48453:493738; query point lng -97.75 lat 30.26",
    );
    expect(wire!.basis).toBe(
      "point-in-polygon against tx_city_boundary geo_id=4805000; the parcel sits inside the incorporated place Austin and carries no zoning stamp, so the stamp is missing; zoning authority is not absent",
    );
    expect(wire!.verdict).not.toBe("not-applicable");
  });

  it("outside every polygon of a populated index in an unzoned county: not-applicable with the city-limits basis and source", () => {
    const wire = zoningVerdictFromCityLimits("48453:1", UNSTAMPED_NULL_CITY, OUTSIDE_EVERY_POLYGON, AS_OF);
    expect(wire).toMatchObject({
      status: "absent",
      verdict: "not-applicable",
      authority: "none",
      derivation: {
        method: "city-limits-containment",
        source: "tx_city_boundary",
        cityLimitsStatus: "unincorporated",
        queryPoint: { longitude: -97.9, latitude: 30.4 },
        place: null,
        countyDoctrine: "unzoned-unincorporated",
      },
    });
    expect(wire!.scopeSearched).toBe(
      "incorporated-place polygons in tx_city_boundary at the parcel query point lng -97.9 lat 30.4; texas_county_roster_v1 zoning_regime.unincorporated for county 48453",
    );
    expect(wire!.basis).toBe(
      "no incorporated-place polygon contains the query point (tx_city_boundary statewide index; unincorporated is the honest answer); county 48453 unincorporated territory is unzoned (texas_county_roster_v1), so no municipal zoning authority applies",
    );
    // The old wire's shape-predicate text is gone.
    expect(JSON.stringify(wire)).not.toContain("shape predicate");
    expect(JSON.stringify(wire)).not.toContain("situs");
  });

  it("outside every polygon in a county with no declared doctrine: unmeasured, not-applicable is not asserted from silence", () => {
    const wire = zoningVerdictFromCityLimits("49019:1", UNSTAMPED_NULL_CITY, OUTSIDE_EVERY_POLYGON, AS_OF);
    expect(wire).toMatchObject({
      verdict: "unmeasured",
      authority: "unresolved",
      derivation: { cityLimitsStatus: "unincorporated", countyDoctrine: "undeclared" },
    });
    expect(wire!.basis).toContain("county 49019 does not declare zoning_regime.unincorporated=unzoned");
  });

  it("an empty index: unmeasured with the index's reason", () => {
    const wire = zoningVerdictFromCityLimits("48453:1", UNSTAMPED_NULL_CITY, EMPTY_INDEX, AS_OF);
    expect(wire).toMatchObject({
      verdict: "unmeasured",
      authority: "unresolved",
      basis: EMPTY_INDEX.basis,
      scopeSearched: "incorporated-place polygons in tx_city_boundary; query point lng -97.75 lat 30.26",
      derivation: { cityLimitsStatus: "unmeasured", queryPoint: POINT, place: null },
    });
  });

  it("no usable query point: unmeasured with that reason and a null point", () => {
    const wire = zoningVerdictFromCityLimits("48453:1", UNSTAMPED_NULL_CITY, NO_POINT, AS_OF);
    expect(wire).toMatchObject({
      verdict: "unmeasured",
      authority: "unresolved",
      basis: "no usable parcel query point; city limits are unmeasured",
      scopeSearched: "incorporated-place polygons in tx_city_boundary; no usable query point",
      derivation: { cityLimitsStatus: "unmeasured", queryPoint: null },
    });
  });

  it("a stamped parcel gets no verdict wire (the stamp is served as-is)", () => {
    expect(
      zoningVerdictFromCityLimits(
        "48021:34137",
        { zoning: { district: "SF-1", jurisdictionKey: "bastrop_city_tx" }, facetCoverage: { zoning: true } },
        INSIDE_AUSTIN,
        AS_OF,
      ),
    ).toBeNull();
  });
});

/**
 * The four golds of the card, as production stored them on 2026-08-28 (read
 * 19:48Z): the three unstamped golds hold the 0,0 bake coordinate sentinel
 * (join no-row for Travis, gate-blocked for Williamson and Hays), so their
 * containment is unmeasured for lack of a point; Bastrop is stamped SF-1 and
 * sits inside geo_id 4805864. Before this card the three were served
 * `not-applicable: shape predicate: no zoning authority exists for
 * unincorporated land` from their null situsCity.
 */
describe("the four golds: served zoning verdict after card F, from their stored facets", () => {
  const unstampedStored = (parcelJoinState: "no-row" | "gate-blocked") => ({
    zoning: null,
    envelope: null,
    facetCoverage: { baseFacts: true, landUse: false, acreage: false, zoning: false, envelope: false, tier1: "populated" },
    baseFacts: { situsCity: null, situsZip: null },
    provenance: { parcelJoin: { state: parcelJoinState } },
  });

  it.each([
    ["48453:493738", "no-row"],
    ["48491:76149", "gate-blocked"],
    ["48209:135570", "gate-blocked"],
  ] as const)("%s (join %s): unmeasured, never not-applicable, until the bake holds a point", (id, join) => {
    const wire = zoningVerdictFromCityLimits(id, unstampedStored(join), NO_POINT, AS_OF);
    expect(wire).toMatchObject({
      status: "absent",
      verdict: "unmeasured",
      authority: "unresolved",
      scopeSearched: "incorporated-place polygons in tx_city_boundary; no usable query point",
      basis: "no usable parcel query point; city limits are unmeasured",
      derivation: { cityLimitsStatus: "unmeasured", queryPoint: null, place: null },
    });
  });

  it("48453:493738 with a point inside Austin (what the re-bake owes it): stamp-missing for Austin", () => {
    const wire = zoningVerdictFromCityLimits("48453:493738", unstampedStored("no-row"), INSIDE_AUSTIN, AS_OF);
    expect(wire!.verdict).toBe("stamp-missing");
    expect(wire!.authority).toBe("Austin");
  });

  it("48021:34137 (stamped SF-1, inside Bastrop geo_id 4805864): no verdict wire, the stamp stands", () => {
    const stored = {
      zoning: {
        district: "SF-1",
        jurisdictionKey: "bastrop_city_tx",
        provenance: { cityKey: "bastrop-city-tx", layerName: "Zoned_Parcels" },
      },
      facetCoverage: { zoning: true },
      baseFacts: { situsCity: null },
    };
    const bastrop: CityLimitsContainment = {
      status: "incorporated",
      etjStatus: "unresolved",
      source: "tx_city_boundary",
      basis: "point-in-polygon against tx_city_boundary geo_id=4805864",
      cityName: "Bastrop",
      geoId: "4805864",
      gnis: "2409795",
      queryPoint: { longitude: -97.31654, latitude: 30.10981 },
    };
    expect(zoningVerdictFromCityLimits("48021:34137", stored, bastrop, AS_OF)).toBeNull();
  });
});

describe("enrichLandUseFactWithZoningVerdict", () => {
  const atomMiss: LandUseAtomMiss = {
    state: "refused",
    code: "atom-miss",
    source: "land-use-fact",
    tried: ["48453:1", "48453:1.00000000"],
    reason: "miss",
  };
  const notApplicable = zoningVerdictFromCityLimits("48453:1", UNSTAMPED_NULL_CITY, OUTSIDE_EVERY_POLYGON, AS_OF);
  const stampMissing = zoningVerdictFromCityLimits("48453:1", UNSTAMPED_NULL_CITY, INSIDE_AUSTIN, AS_OF);
  const unmeasured = zoningVerdictFromCityLimits("48453:1", UNSTAMPED_NULL_CITY, NO_POINT, AS_OF);

  it("upgrades atom-miss to not-applicable only on a containment-derived not-applicable", () => {
    const enriched = enrichLandUseFactWithZoningVerdict(atomMiss, notApplicable);
    expect(enriched).toMatchObject({
      status: "absent",
      verdict: "not-applicable",
      source: "land-use-fact",
      derivation: { method: "city-limits-containment", cityLimitsStatus: "unincorporated" },
    });
  });

  it("leaves atom-miss unchanged for stamp-missing, unmeasured, and no verdict", () => {
    expect(enrichLandUseFactWithZoningVerdict(atomMiss, stampMissing)).toBe(atomMiss);
    expect(enrichLandUseFactWithZoningVerdict(atomMiss, unmeasured)).toBe(atomMiss);
    expect(enrichLandUseFactWithZoningVerdict(atomMiss, null)).toBe(atomMiss);
  });

  it("upgrades absent no-cad-row to not-applicable on a containment-derived not-applicable", () => {
    const absentNoCad = {
      state: "absent" as const,
      source: "land-use-fact",
      boundAs: "48055:1:2026",
      absence: {
        kind: "no-cad-row",
        reason: "no cad_property row for 48055:1 at taxYear=2026",
      },
    };
    const enriched = enrichLandUseFactWithZoningVerdict(absentNoCad, notApplicable);
    expect(enriched).toMatchObject({
      status: "absent",
      verdict: "not-applicable",
      absence: { kind: "no-cad-row" },
    });
  });

  it("a present land-use fact is never touched", () => {
    const present = { state: "present" as const, source: "land-use-fact", landUseCode: "A1" };
    expect(enrichLandUseFactWithZoningVerdict(present, notApplicable)).toBe(present);
  });
});
