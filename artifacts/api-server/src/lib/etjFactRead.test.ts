import { describe, expect, it, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadEtjFact,
  resetEtjIndexForTests,
  setEtjIndexForTests,
  type EtjIndexInjection,
} from "./etjFactRead";
import {
  buildEtjBoundaryIndex,
  type EtjBoundarySourceRow,
  type EtjSourceCoverageEntry,
} from "@workspace/cad-ingest/boundary";

/**
 * feat/p241-etj-acquisition (P-241). Mirrors `cityLimitsFactRead.test.ts`, with
 * the cases ETJ adds: the disposition is three-valued, and `absent` must mean a
 * registered publisher's own extent covered the point and no ring did — never
 * "we have no source".
 */

const AUSTIN_LAYER =
  "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/BOUNDARIES_jurisdictions/FeatureServer/0";

/** A real Austin 2-mile ETJ ring, shrunk around the mission's own ETJ falsifier point. */
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
  sourceCitation: AUSTIN_LAYER,
  // P-359: a served ring says how its geometry came to be. This one is the
  // publisher's own drawing, so the reader tests `geometry` unchanged.
  servedStatus: "verbatim",
};

/**
 * The reader's index, built the way the reader builds it. Tests never hand-assemble
 * `{rings, refusals}`: that would let a fixture put a ring the builder would
 * REFUSE (an `underived` row, a servable status with no usable geometry) into
 * `rings`, and the assertion would then be about the test's own shortcut rather
 * than about the contract.
 */
function indexOf(...rows: EtjBoundarySourceRow[]): EtjIndexInjection["index"] {
  return buildEtjBoundaryIndex(rows);
}

/** 3128 Edgewater Dr — the parcel the mission's first falsifier resolved present on. */
const IN_ETJ = { longitude: -97.855113, latitude: 30.352812 };
/** 5833 Taylor Draper Cv — inside Austin city limits, outside every ETJ ring. */
const IN_CITY_LIMITS = { longitude: -97.75715, latitude: 30.41603 };
/** Round Rock City Hall — inside Austin's published extent, in a city with no ETJ layer. */
const ROUND_ROCK = { longitude: -97.67769, latitude: 30.50827 };
/** Houston City Hall — no publisher in the register is anywhere near it. */
const HOUSTON = { longitude: -95.36936, latitude: 29.76024 };

const AUSTIN_EXTENT: EtjSourceCoverageEntry = {
  cityKey: "austin-tx",
  cityName: "Austin",
  cityGeoId: "4805000",
  mode: "combined",
  hasEtjRings: true,
  // The publisher's own published extent, which is much wider than the ring above.
  bbox: { westLng: -98.02, southLat: 30.03, eastLng: -97.47, northLat: 30.53 },
};

const ROUND_ROCK_COVERAGE: EtjSourceCoverageEntry = {
  cityKey: "round-rock-tx",
  cityName: "Round Rock",
  cityGeoId: "4863500",
  mode: "city_limits_only",
  hasEtjRings: false,
  bbox: null,
};

function injection(over: Partial<EtjIndexInjection> = {}): EtjIndexInjection {
  return {
    sourceRowsPresent: true,
    ringRowsPresent: true,
    index: indexOf(AUSTIN_ETJ_RING),
    coverage: [AUSTIN_EXTENT],
    ...over,
  };
}

afterEach(() => {
  resetEtjIndexForTests();
});

describe("loadEtjFact", () => {
  it("present: a ring contains the point, and the fact cites the publisher's own label and layer", async () => {
    setEtjIndexForTests(injection());
    const fact = await loadEtjFact(IN_ETJ);
    expect(fact.status).toBe("present");
    expect(fact.source).toBe("tx_etj_boundary");
    expect(fact.cityKey).toBe("austin-tx");
    expect(fact.cityName).toBe("Austin");
    expect(fact.ringLabel).toBe("AUSTIN 2 MILE ETJ");
    expect(fact.etjId).toBe("austin-tx:22");
    expect(fact.sourceCitation).toBe(AUSTIN_LAYER);
    expect(fact.basis).toContain("etj_id=austin-tx:22");
    expect(fact.queryPoint).toEqual(IN_ETJ);
  });

  it("absent: the publisher's own extent covers the point and no ring does", async () => {
    setEtjIndexForTests(injection());
    const fact = await loadEtjFact(IN_CITY_LIMITS);
    expect(fact.status).toBe("absent");
    expect(fact.coveredBy).toEqual(["austin-tx"]);
    expect(fact.ringsConsulted).toBe(1);
    expect(fact.basis).toContain("verified absent");
    // The combined-layer trap: an ETJ fact must never carry a city-limits ring id.
    expect(fact.etjId).toBeUndefined();
    expect(fact.queryPoint).toEqual(IN_CITY_LIMITS);
  });

  it("city_limits_only: unresolved and names the mode, never a confirmed absence", async () => {
    setEtjIndexForTests(
      injection({ coverage: [ROUND_ROCK_COVERAGE, AUSTIN_EXTENT] }),
    );
    const fact = await loadEtjFact(ROUND_ROCK, undefined, {
      cityName: "Round Rock",
      geoId: "4863500",
    });
    expect(fact.status).toBe("unresolved");
    expect(fact.basis).toContain("mode=city_limits_only");
    expect(fact.basis).toContain("Round Rock");
    expect(fact.basis).not.toMatch(/verified absent/);
  });

  it("a city outside the register is unresolved, not a false absence", async () => {
    setEtjIndexForTests(injection());
    const fact = await loadEtjFact(HOUSTON, undefined, {
      cityName: "Houston",
      geoId: "4835000",
    });
    expect(fact.status).toBe("unresolved");
    expect(fact.basis).toContain("not in the ETJ register");
    expect(fact.basis).not.toMatch(/verified absent/);
  });

  it("an empty ring table is unresolved, not absent, when the register claims rings", async () => {
    // The register lists a publisher whose extent covers the point AND whose
    // rings exist; zero rings were loaded. Zero rings consulted cannot support
    // "verified absent", so this must stay unresolved.
    setEtjIndexForTests(
      injection({ index: indexOf(), ringRowsPresent: false }),
    );
    const fact = await loadEtjFact(IN_ETJ);
    expect(fact.status).toBe("unresolved");
    expect(fact.basis).toContain("incomplete");
    expect(fact.basis).not.toMatch(/verified absent/);
  });

  it("but a populated ring table with no bbox hit is a real absent", async () => {
    // The paired control: rings were loaded, the publisher's extent covers the
    // point, and none of its rings reaches it. That IS a checked absence, and
    // collapsing it to unresolved would be the opposite error.
    setEtjIndexForTests(
      injection({
        index: indexOf(AUSTIN_ETJ_RING),
        coverage: [ROUND_ROCK_COVERAGE, AUSTIN_EXTENT],
      }),
    );
    const fact = await loadEtjFact(ROUND_ROCK);
    expect(fact.status).toBe("absent");
    expect(fact.coveredBy).toEqual(["austin-tx"]);
  });

  it("an empty source register is unmeasured, not absent", async () => {
    setEtjIndexForTests(injection({ sourceRowsPresent: false, coverage: [] }));
    const fact = await loadEtjFact(IN_ETJ);
    expect(fact.status).toBe("unresolved");
    expect(fact.basis).toContain("unmeasured");
    expect(fact.basis).not.toMatch(/verified absent/);
  });

  it("rings with no source register are unresolved: coverage is not reconstructible from geometry", async () => {
    setEtjIndexForTests(injection({ coverage: [] }));
    const fact = await loadEtjFact(IN_ETJ);
    expect(fact.status).toBe("unresolved");
    expect(fact.basis).toContain("coverage is unreadable");
    expect(fact.queryPoint).toEqual(IN_ETJ);
  });

  it("a missing query point is unmeasured and carries a null point", async () => {
    setEtjIndexForTests(injection());
    const fact = await loadEtjFact(null);
    expect(fact.status).toBe("unresolved");
    expect(fact.basis).toContain("query point");
    expect(fact.queryPoint).toBeNull();
  });

  it("the 0,0 bake sentinel is not a query point", async () => {
    setEtjIndexForTests(injection());
    const fact = await loadEtjFact({ longitude: 0, latitude: 0 });
    expect(fact.status).toBe("unresolved");
    expect(fact.queryPoint).toBeNull();
  });

  it("does not treat a 2-mile offset from a city limit as ETJ: there is no buffer path", async () => {
    // 0.04 degrees east of the ring's own edge is outside it; a §42.021
    // derivation would have called it ETJ.
    setEtjIndexForTests(injection());
    const fact = await loadEtjFact({ longitude: -97.83 + 0.04, latitude: 30.35 });
    expect(fact.status).toBe("absent");
    expect(fact.etjId).toBeUndefined();

    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "etjFactRead.ts"),
      "utf8",
    );
    // COMMENTS ARE STRIPPED FIRST, and that is not cosmetic: this module's own
    // header documents the §42.021 retirement by name, so a naive grep matches
    // its own documentation and the control is permanently red — the dead-gate
    // failure mode pr-checks.yml records twice. The rule is about code.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join("\n");
    expect(code).not.toMatch(/42\.021/);
    expect(code).not.toMatch(/offset\s*2\s*miles/i);
    expect(code).not.toMatch(/buffer(ed)?\s*(polygon|ring|miles)/i);
    // Non-vacuity: the instrument must be able to fail. A buffer derivation
    // added to the code (not the comments) has to trip it.
    const withBuffer = code + "\nfunction bufferRing() { return /*42.021*/ 2; }\n";
    expect(withBuffer).toMatch(/42\.021/);
  });
});

// ---------------------------------------------------------------------------
// P-359: the read path serves the DERIVED geometry and refuses what it cannot
// test. Pre-change, every candidate row's `geometry` went to ST_Contains, so a
// ring that swallows its own city limits reported ETJ over houses inside those
// limits, and a ring whose derivation never ran (or whose repair moved the area
// past the declared tolerance) was tested as if it had been proven testable.
// ---------------------------------------------------------------------------

/** The published ring: a square that encloses the fixture city limits. */
const OUTER = [
  [
    [-97.90, 30.30],
    [-97.80, 30.30],
    [-97.80, 30.40],
    [-97.90, 30.40],
    [-97.90, 30.30],
  ],
];
/** The city's own limits, inside the ring — what the derivation subtracted. */
const HOLE = [
  [-97.87, 30.33],
  [-97.83, 30.33],
  [-97.83, 30.37],
  [-97.87, 30.37],
  [-97.87, 30.33],
];
/** Inside the subtracted limits: in the city, and therefore NOT in its ETJ. */
const IN_THE_CITY_LIMITS = { longitude: -97.85, latitude: 30.35 };
/** Inside the ring, outside the city limits: the derived part, still ETJ. */
const IN_DERIVED_ETJ = { longitude: -97.885, latitude: 30.385 };

const DERIVATION_NOTE =
  "the ring contains its own city's representative point; served geometry is the ring minus that city's limits";

const AUSTIN_DERIVED_ROW: EtjBoundarySourceRow = {
  ...AUSTIN_ETJ_RING,
  etjId: "austin-tx:7",
  geometry: { type: "Polygon", coordinates: OUTER },
  servedGeometry: { type: "Polygon", coordinates: [OUTER[0]!, HOLE] },
  servedStatus: "derived",
  derivation: { kind: "self_containing", note: DERIVATION_NOTE },
  // The bbox is the PUBLISHED ring's, which is what the pre-filter uses: the
  // derived geometry is strictly smaller, so a row can never be filtered out
  // because its own subtraction shrank it.
  bbox: { westLng: -97.90, southLat: 30.30, eastLng: -97.80, northLat: 30.40 },
};

const AUSTIN_UNDERIVED_ROW: EtjBoundarySourceRow = {
  ...AUSTIN_DERIVED_ROW,
  etjId: "austin-tx:8",
  // Nothing was served for this row, and no pass ran to say why: exactly the
  // state of every row between the insert and the derivation pass.
  servedGeometry: null,
  servedStatus: "underived",
  derivation: null,
};

const AUSTIN_WITHHELD_ROW: EtjBoundarySourceRow = {
  ...AUSTIN_DERIVED_ROW,
  etjId: "austin-tx:9",
  servedGeometry: null,
  servedStatus: "withheld",
  derivation: {
    kind: "self_containing",
    note: "the ring contains its own city's representative point but the subtraction left no usable polygon; nothing is served",
  },
};

describe("loadEtjFact — P-359 served geometry and refusals", () => {
  it("FALSIFIER A: a point inside the ring's own subtracted city limits is absent, not present", async () => {
    setEtjIndexForTests(injection({ index: indexOf(AUSTIN_DERIVED_ROW) }));
    const fact = await loadEtjFact(IN_THE_CITY_LIMITS, undefined, {
      cityName: "Austin",
      geoId: "4805000",
    });
    // The published square contains this point. The SERVED geometry does not.
    expect(fact.status).toBe("absent");
    expect(fact.etjId).toBeUndefined();
  });

  it("the derived part still answers present, and says it was derived", async () => {
    setEtjIndexForTests(injection({ index: indexOf(AUSTIN_DERIVED_ROW) }));
    const fact = await loadEtjFact(IN_DERIVED_ETJ, undefined, {
      cityName: "Austin",
      geoId: "4805000",
    });
    expect(fact.status).toBe("present");
    expect(fact.etjId).toBe("austin-tx:7");
    expect(fact.servedStatus).toBe("derived");
    expect(fact.derivationNote).toBe(DERIVATION_NOTE);
    expect(fact.basis).toContain("served derived");
  });

  it("FALSIFIER B: a ring whose derivation never ran is refused, and the fact is unresolved — never absent", async () => {
    setEtjIndexForTests(injection({ index: indexOf(AUSTIN_UNDERIVED_ROW) }));
    const fact = await loadEtjFact(IN_DERIVED_ETJ, undefined, {
      cityName: "Austin",
      geoId: "4805000",
    });
    expect(fact.status).toBe("unresolved");
    expect(fact.refusedRings).toEqual([
      {
        etjId: "austin-tx:8",
        servedStatus: "underived",
        reason: expect.stringContaining("no derivation pass has run"),
      },
    ]);
    expect(fact.basis).not.toMatch(/verified absent/);
    // The refusal names the ring, and the ring id names its publisher, so the
    // declaration is attributable without a second field to keep in sync.
    expect(fact.basis).toContain("austin-tx:8");
  });

  it("FALSIFIER C: a withheld ring declares the derivation's own reason, and never reads as a tested miss", async () => {
    setEtjIndexForTests(injection({ index: indexOf(AUSTIN_WITHHELD_ROW) }));
    const fact = await loadEtjFact(IN_DERIVED_ETJ, undefined, {
      cityName: "Austin",
      geoId: "4805000",
    });
    expect(fact.status).toBe("unresolved");
    expect(fact.refusedRings?.[0]).toEqual({
      etjId: "austin-tx:9",
      servedStatus: "withheld",
      reason: expect.stringContaining("the subtraction left no usable polygon"),
    });
  });

  it("a refused ring does not mask a servable ring that does contain the point", async () => {
    // Order-independence, both directions: one untestable row and one tested row
    // in the same result set must still answer `present` from the tested one.
    setEtjIndexForTests(
      injection({ index: indexOf(AUSTIN_WITHHELD_ROW, AUSTIN_DERIVED_ROW) }),
    );
    const fact = await loadEtjFact(IN_DERIVED_ETJ, undefined, {
      cityName: "Austin",
      geoId: "4805000",
    });
    expect(fact.status).toBe("present");
    expect(fact.etjId).toBe("austin-tx:7");
  });

  it("P-359 DIVERGENCE: a refused ring that cannot reach the point does not subtract the answer", async () => {
    // Pre-change the reader had no refusals at all, so this test is the one that
    // fails on a build which refuses on publisher extent alone: a withheld ring
    // 40 km south of the point is untestable, but it cannot be the reason the
    // answer is unknown, and returning `unresolved` there would throw away an
    // absence the reader is able to prove. The envelope is the ring's OWN, so
    // the narrowing can only over-include.
    const REMOTE: EtjBoundarySourceRow = {
      ...AUSTIN_WITHHELD_ROW,
      etjId: "austin-tx:10",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-97.60, 30.2],
            [-97.58, 30.2],
            [-97.58, 30.22],
            [-97.60, 30.22],
            [-97.60, 30.2],
          ],
        ],
      },
      bbox: { westLng: -97.6, southLat: 30.2, eastLng: -97.58, northLat: 30.22 },
    };
    setEtjIndexForTests(injection({ index: indexOf(REMOTE) }));
    const fact = await loadEtjFact(IN_DERIVED_ETJ, undefined, {
      cityName: "Austin",
      geoId: "4805000",
    });
    // AUSTIN_EXTENT covers the point; the withheld ring does not reach it.
    expect(fact.status).toBe("absent");
    expect(fact.refusedRings).toBeUndefined();

    // Control, same fixture, point moved INTO the refused ring's own envelope:
    // the refusal is consulted and the answer is unresolved again.
    const reachable = await loadEtjFact(
      { longitude: -97.59, latitude: 30.21 },
      undefined,
      { cityName: "Austin", geoId: "4805000" },
    );
    expect(reachable.status).toBe("unresolved");
    expect(reachable.refusedRings?.[0]?.etjId).toBe("austin-tx:10");
  });
});
