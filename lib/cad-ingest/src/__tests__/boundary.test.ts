/**
 * Texas city/county boundary layer unit tests — adapter parsing against
 * recorded fixtures, spatial containment (in-city + unincorporated), and
 * idempotency contract for re-run semantics.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeCityBoundaryFeature,
  normalizeCountyBoundaryFeature,
} from "../boundary/parse";
import {
  buildCityBoundaryIndex,
  buildCountyBoundaryIndex,
  resolveCityContainment,
  resolveCityContainmentAtPoint,
  resolveCountyContainmentAtPoint,
} from "../boundary/containment";
import {
  cityLimitsFactFromContainment,
} from "../boundary/cityLimitsFact";
import {
  upsertCityBoundaries,
  deleteAllCityBoundaries,
} from "../boundary/ingest";
import {
  CITY_SOURCE_CITATION,
  COUNTY_SOURCE_CITATION,
} from "../boundary/service";
import { newCounters } from "../types";
import {
  FIXTURE_AUSTIN_CITY,
  FIXTURE_AUSTIN_INTERIOR_LAT,
  FIXTURE_AUSTIN_INTERIOR_LNG,
  FIXTURE_RURAL_UNINCORPORATED_LAT,
  FIXTURE_RURAL_UNINCORPORATED_LNG,
  FIXTURE_TRAVIS_COUNTY,
  LIVE_PROBE_CITY_FEATURE,
  LIVE_PROBE_COUNTY_FEATURE,
} from "./__fixtures__/boundaryFixtures";

describe("boundary parse — recorded fixtures", () => {
  it("normalizes a TxGIO city feature with exact geo_id casing", () => {
    const counters = newCounters();
    const rec = normalizeCityBoundaryFeature(LIVE_PROBE_CITY_FEATURE, counters);
    expect(rec).not.toBeNull();
    expect(rec!.geoId).toBe("4805000");
    expect(rec!.cityName).toBe("Austin");
    expect(rec!.gnis).toBe("1389879");
    expect(rec!.geometry.type).toBe("Polygon");
    expect(counters.rowsSkipped).toBe(0);
  });

  it("normalizes a TIGER county feature with exact GEOID casing", () => {
    const counters = newCounters();
    const rec = normalizeCountyBoundaryFeature(
      LIVE_PROBE_COUNTY_FEATURE,
      counters,
    );
    expect(rec).not.toBeNull();
    expect(rec!.countyFips).toBe("48453");
    expect(rec!.countyName).toBe("Travis County");
    expect(rec!.stateFips).toBe("48");
    expect(counters.rowsSkipped).toBe(0);
  });

  it("skips city features missing geo_id", () => {
    const counters = newCounters();
    const rec = normalizeCityBoundaryFeature(
      {
        properties: { city_name: "Nowhere" },
        geometry: LIVE_PROBE_CITY_FEATURE.geometry,
      },
      counters,
    );
    expect(rec).toBeNull();
    expect(counters.rowsSkipped).toBe(1);
  });
});

describe("city containment helper", () => {
  const cityIndex = buildCityBoundaryIndex([
    {
      geoId: "4805000",
      cityName: "Austin",
      gnis: "1389879",
      geometry: FIXTURE_AUSTIN_CITY.geometry!,
    },
  ]);

  it("returns incorporated for a known in-city point", () => {
    const result = resolveCityContainmentAtPoint(
      FIXTURE_AUSTIN_INTERIOR_LNG,
      FIXTURE_AUSTIN_INTERIOR_LAT,
      cityIndex,
    );
    expect(result.status).toBe("incorporated");
    if (result.status === "incorporated") {
      expect(result.cityName).toBe("Austin");
      expect(result.geoId).toBe("4805000");
      expect(result.basis).toContain("geo_id=4805000");
      expect(result.etjStatus).toBe("unresolved");
    }
    const fact = cityLimitsFactFromContainment(result);
    expect(fact.status).toBe("incorporated");
    expect(fact.cityName).toBe("Austin");
    expect(fact.etjStatus).toBe("unresolved");
    expect(fact.source).toBe("tx_city_boundary");
  });

  it("returns explicit unincorporated for rural West Texas (not failure)", () => {
    const result = resolveCityContainmentAtPoint(
      FIXTURE_RURAL_UNINCORPORATED_LNG,
      FIXTURE_RURAL_UNINCORPORATED_LAT,
      cityIndex,
    );
    expect(result.status).toBe("unincorporated");
    if (result.status === "unincorporated") {
      expect(result.basis).toContain("unincorporated");
      expect(result.basis).not.toContain("error");
      expect(result.etjStatus).toBe("unresolved");
    }
    const fact = cityLimitsFactFromContainment(result);
    expect(fact.status).toBe("unincorporated");
    expect(fact.cityName).toBeUndefined();
    expect(fact.etjStatus).toBe("unresolved");
  });

  it("returns unmeasured for an empty index (not unincorporated)", () => {
    const result = resolveCityContainmentAtPoint(
      FIXTURE_AUSTIN_INTERIOR_LNG,
      FIXTURE_AUSTIN_INTERIOR_LAT,
      [],
    );
    expect(result.status).toBe("unmeasured");
    if (result.status === "unmeasured") {
      expect(result.basis).toContain("unmeasured");
      expect(result.basis).not.toContain("unincorporated is the honest answer");
      expect(result.etjStatus).toBe("unresolved");
    }
    expect(cityLimitsFactFromContainment(result).status).toBe("unmeasured");
  });

  it("does not treat a 2-mile offset ring as ETJ", () => {
    // Austin fixture east edge is -97.72. ~2 miles ≈ 0.033 deg lon at lat 30.
    // A point 0.04 deg east sits outside the city polygon and inside a
    // fabricated 2-mile buffer. That buffer is the defect this test violates.
    const offsetLng = -97.72 + 0.04;
    const offsetLat = 30.26;
    const result = resolveCityContainmentAtPoint(
      offsetLng,
      offsetLat,
      cityIndex,
    );
    expect(result.status).toBe("unincorporated");
    expect(result.etjStatus).toBe("unresolved");
    expect(result).not.toHaveProperty("cityName");
    const wire = JSON.stringify(cityLimitsFactFromContainment(result));
    expect(wire).not.toMatch(/"status":"etj/i);
    expect(wire).not.toMatch(/etj_buffer|offset.*etj|buffer.*etj/i);

    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../boundary/containment.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/buffer(ed)?\s*(polygon|ring|miles)/i);
    expect(src).not.toMatch(/offset\s*2\s*miles/i);
    expect(src).not.toMatch(/derive\w*\s+etj/i);
  });

  it("resolves from parcel geometry via representative point", () => {
    const parcel = {
      type: "Polygon",
      coordinates: [
        [
          [FIXTURE_AUSTIN_INTERIOR_LNG, FIXTURE_AUSTIN_INTERIOR_LAT],
          [FIXTURE_AUSTIN_INTERIOR_LNG + 0.001, FIXTURE_AUSTIN_INTERIOR_LAT],
          [
            FIXTURE_AUSTIN_INTERIOR_LNG + 0.001,
            FIXTURE_AUSTIN_INTERIOR_LAT + 0.001,
          ],
          [FIXTURE_AUSTIN_INTERIOR_LNG, FIXTURE_AUSTIN_INTERIOR_LAT + 0.001],
          [FIXTURE_AUSTIN_INTERIOR_LNG, FIXTURE_AUSTIN_INTERIOR_LAT],
        ],
      ],
    };
    const result = resolveCityContainment(parcel, cityIndex);
    expect(result.status).toBe("incorporated");
  });
});

describe("county containment helper", () => {
  const countyIndex = buildCountyBoundaryIndex([
    {
      countyFips: "48453",
      countyName: "Travis County",
      geometry: FIXTURE_TRAVIS_COUNTY.geometry!,
    },
  ]);

  it("resolves Travis for an in-county Austin point", () => {
    const result = resolveCountyContainmentAtPoint(
      FIXTURE_AUSTIN_INTERIOR_LNG,
      FIXTURE_AUSTIN_INTERIOR_LAT,
      countyIndex,
    );
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.countyFips).toBe("48453");
      expect(result.countyName).toBe("Travis County");
    }
  });
});

describe("boundary ingest idempotency (mock db)", () => {
  it("replace + upsert yields identical row count on re-run", async () => {
    type Row = Record<string, unknown>;
    const cityStore = new Map<string, Row>();

    let deleteTarget: "city" | "county" = "city";
    const mockDb = {
      delete: () => {
        if (deleteTarget === "city") cityStore.clear();
        return Promise.resolve(undefined);
      },
      insert: () => ({
        values: (rows: Row[]) => ({
          onConflictDoUpdate: async () => {
            for (const row of rows) {
              cityStore.set(String(row.geoId), { ...row });
            }
          },
        }),
      }),
      execute: async () => undefined,
    };

    const counters = newCounters();
    const cityRec = normalizeCityBoundaryFeature(FIXTURE_AUSTIN_CITY, counters)!;

    async function* cityRows() {
      yield cityRec;
    }

    const meta = {
      source: "test",
      sourceVintage: "fixture",
      sourceCitation: "fixture://test",
    };

    deleteTarget = "city";
    await deleteAllCityBoundaries(mockDb as never);
    const run1 = await upsertCityBoundaries(mockDb as never, cityRows(), meta);
    expect(run1.rowsInserted).toBe(1);
    expect(cityStore.size).toBe(1);

    await deleteAllCityBoundaries(mockDb as never);
    const run2 = await upsertCityBoundaries(mockDb as never, cityRows(), {
      ...meta,
      sourceVintage: "fixture-rerun",
    });
    expect(run2.rowsInserted).toBe(1);
    expect(cityStore.size).toBe(1);
    expect(cityStore.get("4805000")?.sourceVintage).toBe("fixture-rerun");

    expect(CITY_SOURCE_CITATION).toContain("City_Boundaries");
    expect(COUNTY_SOURCE_CITATION).toContain("State_County");
  });
});
