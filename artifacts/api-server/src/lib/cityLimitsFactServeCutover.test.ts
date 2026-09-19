/**
 * cityLimitsFactServeCutover.ts — P-297 (operator ruling A-193, OPS-24 law 7): the serve switch
 * is the code-owned SLATE, and what a parcel shows comes from ITS OWN cell.
 *
 * Rail note: cityLimits' legacy reader is POINT-based (loadCityLimitsFact takes a query
 * point, not a parcelNodeId) and its wire is `CityLimitsFactWire` — a refusal is served as
 * `status: "unmeasured"` with the reason in `basis`, NOT as a `state: "refused"` object.
 * That is this rail's existing refusal shape, reused rather than replaced.
 *
 * THIS FILE REPLACES the pre-P-297 suite, which pinned the old contract
 * ("only a PASS verdict reaches the record; refuse / excluded / no verdict /
 * store failure / no store all fall back to the legacy value"). Those
 * assertions encoded the exact defect the ruling names -- one unaccounted cell
 * anywhere in a slated county turning every parcel in it back to the bake --
 * so they are deleted rather than kept passing. The adapter's own answer
 * shapes are covered by <rail>FactFromParcelRecord.test.ts; what this file
 * covers is the SWITCH, per the dispatch's falsifiers 1, 2 and 4.
 */

import { afterEach, describe, expect, it } from "vitest";
import { loadCityLimitsFactForServe } from "./cityLimitsFactServeCutover";
import {
  loadCityLimitsFact,
  resetCityLimitsIndexForTests,
  setCityLimitsIndexForTests,
} from "./cityLimitsFactRead";
import {
  resetEtjIndexForTests,
  setEtjIndexForTests,
  type EtjIndexInjection,
} from "./etjFactRead";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
  type ParcelRecordQueryable,
} from "./parcelRecordCellRead";
import { isSlatedForCellServe } from "./cellServeRule";
import {
  buildEtjBoundaryIndex,
  type EtjBoundarySourceRow,
  type EtjSourceCoverageEntry,
} from "@workspace/cad-ingest/boundary";

const RAIL_KEY = "cityLimits";
const SLATED = "48021:34137";
const UNSLATED = "48103:100";

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

describe("cityLimitsFactServeCutover — the slate is the switch", () => {
  it("the slate says what this suite assumes about its two counties", () => {
    expect(isSlatedForCellServe("48021", RAIL_KEY)).toBe(true);
    expect(isSlatedForCellServe("48103", RAIL_KEY)).toBe(false);
  });

  it("an UNSLATED pair keeps the point-based legacy read, with zero parcel_record I/O", async () => {
    let calls = 0;
    const counter = {
      async query() {
        calls += 1;
        return { rows: [] };
      },
    } as ParcelRecordQueryable;
    const withoutStore = await loadCityLimitsFactForServe(UNSLATED, null);
    setParcelRecordQueryableForTests(counter);
    const withStore = await loadCityLimitsFactForServe(UNSLATED, null);
    expect(calls).toBe(0);
    expect(withStore).toEqual(withoutStore);
    expect(withoutStore).toEqual(await loadCityLimitsFact(null));
  });

  it("FALSIFIER 2: an unaccounted cell on a SLATED pair is served as this rail's own refusal shape, with the cell's reason", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [{ placeKey: SLATED, railKey: RAIL_KEY, cellState: { kind: "unaccounted" } }],
      }),
    );
    const served = await loadCityLimitsFactForServe(SLATED, null);
    const legacy = await loadCityLimitsFact(null);
    expect(served.status).toBe("unmeasured");
    expect(served.basis).toContain("unaccounted");
    expect(served.basis).toContain("has not yet examined this rail");
    expect(served).not.toEqual(legacy);
  });

  it("an UNSLATED-shaped malformed parcelNodeId falls through to the point-only legacy read", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordStore({ cells: [] }));
    const served = await loadCityLimitsFactForServe("not-a-valid-id", null);
    resetParcelRecordQueryableForTests();
    expect(served).toEqual(await loadCityLimitsFact(null));
  });

  it("a SLATED pair with a real absent-verified cell is served that determination, not the legacy read", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: SLATED,
            railKey: RAIL_KEY,
            cellState: { kind: "absent-verified", basis: { disposition: "unincorporated" } },
          },
        ],
      }),
    );
    const served = await loadCityLimitsFactForServe(SLATED, null);
    expect(served.status).not.toBe("unmeasured");
    expect(served.source).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// P-296: the ETJ overlay. Pre-registered falsifiers live here: a parcel inside
// a registered publisher's ETJ ring reads `present`; a parcel inside that
// publisher's own published extent and outside every ring reads `absent` (a
// CHECKED absence, carrying the publishers consulted and the rings tested); a
// parcel with no ETJ source to check reads `unresolved` and never `absent`.
// A fourth case was added after the live staging probe found it (2026-09-17):
// an extent-box miss with the CONTAINING CITY unread stays `unresolved`, so a
// city whose ETJ layer was never published is never served a verified absence.
// These run on the UNSLATED branch, whose city-limits answer is injected, so
// the assertions are about the overlay and nothing else.
// ---------------------------------------------------------------------------

/** 3128 Edgewater Dr — the point P-241's own suite resolved `present` on. */
const IN_ETJ = { longitude: -97.855113, latitude: 30.352812 };
/** Inside Austin's published extent, outside every published ring. */
const IN_EXTENT_OUTSIDE_RINGS = { longitude: -97.75, latitude: 30.45 };

const AUSTIN_ETJ_RING: EtjBoundarySourceRow = {
  etjId: "austin-tx:22",
  cityKey: "austin-tx",
  cityName: "Austin",
  ringLabel: "AUSTIN 2 MILE ETJ",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-97.88, 30.33],
        [-97.83, 30.33],
        [-97.83, 30.38],
        [-97.88, 30.38],
        [-97.88, 30.33],
      ],
    ],
  },
  bbox: { westLng: -97.88, southLat: 30.33, eastLng: -97.83, northLat: 30.38 },
  sourceCitation:
    "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/BOUNDARIES_jurisdictions/FeatureServer/0",
  servedStatus: "verbatim",
};

/** The reader's index, built the way the reader builds it — see the note in
 * `etjFactRead.test.ts`: a hand-assembled index can hold rings the builder would
 * refuse, and then the assertion tests the fixture's shortcut, not the contract. */
function indexOf(...rows: EtjBoundarySourceRow[]): EtjIndexInjection["index"] {
  return buildEtjBoundaryIndex(rows);
}

const AUSTIN_EXTENT: EtjSourceCoverageEntry = {
  cityKey: "austin-tx",
  cityName: "Austin",
  cityGeoId: "4805000",
  mode: "combined",
  hasEtjRings: true,
  bbox: { westLng: -98.02, southLat: 30.03, eastLng: -97.47, northLat: 30.53 },
};

/** An empty, populated city-limits index: the parcel is unincorporated, and
 * the point is usable, so the overlay has both a point and a city answer. */
const UNINCORPORATED_INDEX = { tablePopulated: true, entries: [] };

describe("cityLimitsFactServeCutover — the ETJ overlay (P-296)", () => {
  afterEach(() => {
    resetEtjIndexForTests();
    resetCityLimitsIndexForTests();
  });

  it("FALSIFIER 1a: a point inside a registered publisher's ETJ ring serves etjStatus present, with the ring and layer named", async () => {
    setCityLimitsIndexForTests(UNINCORPORATED_INDEX);
    setEtjIndexForTests({
      sourceRowsPresent: true,
      ringRowsPresent: true,
      index: indexOf(AUSTIN_ETJ_RING),
      coverage: [AUSTIN_EXTENT],
    });
    const served = await loadCityLimitsFactForServe(UNSLATED, IN_ETJ);
    // The ETJ determination is the read's, not a hardcoded value.
    expect(served.etjStatus).toBe("present");
    expect(served.etjFact?.cityKey).toBe("austin-tx");
    expect(served.etjFact?.ringLabel).toBe("AUSTIN 2 MILE ETJ");
    expect(served.etjFact?.etjId).toBe("austin-tx:22");
    expect(served.etjFact?.sourceCitation).toBe(AUSTIN_ETJ_RING.sourceCitation);
    // The city-limits answer itself is untouched by the overlay.
    expect(served.status).toBe("unincorporated");
    expect(served.source).toBe("tx_city_boundary");
    // Both bases travel: incorporation first, then the ETJ determination.
    expect(served.basis).toContain("tx_city_boundary statewide index");
    expect(served.basis).toContain("ETJ: ");
  });

  it("FALSIFIER 1b: a point inside the publisher's own published extent and outside every ring serves a CHECKED absence, with the publishers consulted and rings tested", async () => {
    setCityLimitsIndexForTests(UNINCORPORATED_INDEX);
    setEtjIndexForTests({
      sourceRowsPresent: true,
      ringRowsPresent: true,
      index: indexOf(AUSTIN_ETJ_RING),
      coverage: [AUSTIN_EXTENT],
    });
    const served = await loadCityLimitsFactForServe(UNSLATED, IN_EXTENT_OUTSIDE_RINGS);
    expect(served.etjStatus).toBe("absent");
    // A checked absence says WHO was checked and HOW MUCH was tested -- that is
    // what separates it from "we have no source".
    expect(served.etjFact?.coveredBy).toEqual(["austin-tx"]);
    expect(served.etjFact?.ringsConsulted).toBe(1);
    expect(served.etjStatus).not.toBe("unresolved");
  });

  it("FALSIFIER 1c: an extent-box miss with the containing city UNREAD stays unresolved — a city whose ETJ was never published could be sitting on the point", async () => {
    // City limits are unmeasured: the point is usable, but nothing determines
    // which city (if any) contains it. This is the Round Rock shape from the
    // live staging probe: Round Rock publishes no ETJ layer, and a box-only
    // miss would report `absent` for a city whose ETJ is simply unpublished.
    setCityLimitsIndexForTests({ tablePopulated: false, entries: [] });
    setEtjIndexForTests({
      sourceRowsPresent: true,
      ringRowsPresent: true,
      index: indexOf(AUSTIN_ETJ_RING),
      coverage: [AUSTIN_EXTENT],
    });
    const served = await loadCityLimitsFactForServe(UNSLATED, IN_EXTENT_OUTSIDE_RINGS);
    expect(served.status).toBe("unmeasured");
    expect(served.etjStatus).toBe("unresolved");
    expect(served.etjStatus).not.toBe("absent");
    // The check still happened and still travels: who was consulted, how many
    // rings were tested, and why the disposition is not a verified absence.
    expect(served.etjFact?.coveredBy).toEqual(["austin-tx"]);
    expect(served.etjFact?.ringsConsulted).toBe(1);
    expect(served.etjFact?.basis).toContain("the containing city is unread here");
    // The served value and the disclosed read agree -- one answer per fact.
    expect(served.etjFact?.status).toBe(served.etjStatus);
  });

  it("a ring containment is `present` on every branch: it never depends on the containing city", async () => {
    setCityLimitsIndexForTests({ tablePopulated: false, entries: [] });
    setEtjIndexForTests({
      sourceRowsPresent: true,
      ringRowsPresent: true,
      index: indexOf(AUSTIN_ETJ_RING),
      coverage: [AUSTIN_EXTENT],
    });
    const served = await loadCityLimitsFactForServe(UNSLATED, IN_ETJ);
    expect(served.status).toBe("unmeasured");
    expect(served.etjStatus).toBe("present");
    expect(served.etjFact?.cityKey).toBe("austin-tx");
  });

  it("FALSIFIER 2: with no ETJ source to check, the served value is unresolved and never absent", async () => {
    setCityLimitsIndexForTests(UNINCORPORATED_INDEX);
    setEtjIndexForTests({
      sourceRowsPresent: false,
      ringRowsPresent: false,
      index: indexOf(),
      coverage: [],
    });
    const served = await loadCityLimitsFactForServe(UNSLATED, IN_ETJ);
    expect(served.etjStatus).toBe("unresolved");
    expect(served.etjFact?.basis).toContain("no ETJ source has been acquired");
    expect(served.etjStatus).not.toBe("absent");
  });

  it("a publisher enumerated as publishing no ETJ layer leaves the point unresolved, not absent", async () => {
    setCityLimitsIndexForTests(UNINCORPORATED_INDEX);
    setEtjIndexForTests({
      sourceRowsPresent: true,
      ringRowsPresent: true,
      index: indexOf(AUSTIN_ETJ_RING),
      coverage: [
        {
          cityKey: "round-rock-tx",
          cityName: "Round Rock",
          cityGeoId: "4863500",
          mode: "city_limits_only",
          hasEtjRings: false,
          bbox: null,
        },
      ],
    });
    const served = await loadCityLimitsFactForServe(UNSLATED, IN_ETJ);
    expect(served.etjStatus).toBe("unresolved");
  });

  it("with no usable query point there is no ETJ read to disclose: the fact is the legacy read, byte for byte", async () => {
    setCityLimitsIndexForTests(UNINCORPORATED_INDEX);
    const served = await loadCityLimitsFactForServe(UNSLATED, null);
    expect(served).toEqual(await loadCityLimitsFact(null));
    expect("etjFact" in served).toBe(false);
  });
});
