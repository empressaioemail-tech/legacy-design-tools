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
import type {
  EtjBoundaryIndexEntry,
  EtjSourceCoverageEntry,
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
const AUSTIN_ETJ_RING: EtjBoundaryIndexEntry = {
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
};

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
    index: [AUSTIN_ETJ_RING],
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
    setEtjIndexForTests(injection({ index: [], ringRowsPresent: false }));
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
        index: [AUSTIN_ETJ_RING],
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
