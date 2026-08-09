/**
 * FEMA NFHL statewide flood-zone layer unit tests — parse against recorded
 * fixtures, projection guard, idempotency contract, and parcel evaluation.
 */

import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  assertNfhlGeographicCoordinates,
  normalizeNfhlFeature,
} from "../nfhl/parse";
import {
  buildNfhlZoneIndex,
  resolveParcelFloodZones,
} from "../nfhl/evaluation";
import { streamGeoJsonSeqWithBackpressure } from "../nfhl/gdal";
import { pointInGeometry } from "../txgio/geo";
import {
  countAllNfhlFloodZones,
  deleteAllNfhlFloodZones,
  upsertNfhlFloodZones,
} from "../nfhl/ingest";
import { NFHL_SOURCE_CITATION, NFHL_FLOOD_LAYER } from "../nfhl/service";
import { newCounters } from "../types";
import {
  FIXTURE_BASTROP_AE_INTERIOR_LAT,
  FIXTURE_BASTROP_AE_INTERIOR_LNG,
  FIXTURE_BASTROP_AE_ZONE,
  FIXTURE_BASTROP_X_ZONE,
  FIXTURE_PROJECTED_METRES_POLYGON,
  FIXTURE_RURAL_OUTSIDE_LAT,
  FIXTURE_RURAL_OUTSIDE_LNG,
} from "./__fixtures__/nfhlFixtures";

describe("nfhl parse — recorded fixtures", () => {
  it("normalizes an AE zone with exact FLD_ZONE / FLD_AR_ID casing", () => {
    const counters = newCounters();
    const rec = normalizeNfhlFeature(FIXTURE_BASTROP_AE_ZONE, counters);
    expect(rec).not.toBeNull();
    expect(rec!.zoneRowId).toBe("48021C:48021C_2261");
    expect(rec!.fldZone).toBe("AE");
    expect(rec!.sfhaTf).toBe("T");
    expect(rec!.staticBfe).toBeNull();
    expect(rec!.femaObjectId).toBe(25343488);
    expect(counters.rowsSkipped).toBe(0);
  });

  it("normalizes an X outside-SFHA zone", () => {
    const counters = newCounters();
    const rec = normalizeNfhlFeature(FIXTURE_BASTROP_X_ZONE, counters);
    expect(rec).not.toBeNull();
    expect(rec!.fldZone).toBe("X");
    expect(rec!.sfhaTf).toBe("F");
    expect(rec!.zoneSubty).toContain("0.2 PCT");
  });

  it("skips projected-metre coordinates (projection guard)", () => {
    const counters = newCounters();
    const rec = normalizeNfhlFeature(FIXTURE_PROJECTED_METRES_POLYGON, counters);
    expect(rec).toBeNull();
    expect(counters.rowsSkipped).toBe(1);
    expect(counters.skipSamples[0]).toContain("projected metres");
  });

  it("assertNfhlGeographicCoordinates throws on metre coordinates", () => {
    expect(() =>
      assertNfhlGeographicCoordinates(
        FIXTURE_PROJECTED_METRES_POLYGON.geometry!,
        "test",
      ),
    ).toThrow(/projected metres/);
  });
});

describe("parcel flood-zone evaluation helper", () => {
  const index = buildNfhlZoneIndex([
    normalizeNfhlFeature(FIXTURE_BASTROP_AE_ZONE, newCounters())!,
    normalizeNfhlFeature(FIXTURE_BASTROP_X_ZONE, newCounters())!,
  ]);

  it("returns in-zones for a parcel inside the AE polygon", () => {
    const aeRec = normalizeNfhlFeature(FIXTURE_BASTROP_AE_ZONE, newCounters())!;
    expect(
      pointInGeometry(
        FIXTURE_BASTROP_AE_INTERIOR_LNG,
        FIXTURE_BASTROP_AE_INTERIOR_LAT,
        aeRec.geometry,
      ),
    ).toBe(true);
    const parcel = {
      type: "Polygon" as const,
      coordinates: [
        [
          [FIXTURE_BASTROP_AE_INTERIOR_LNG, FIXTURE_BASTROP_AE_INTERIOR_LAT],
          [FIXTURE_BASTROP_AE_INTERIOR_LNG + 0.00001, FIXTURE_BASTROP_AE_INTERIOR_LAT],
          [
            FIXTURE_BASTROP_AE_INTERIOR_LNG + 0.00001,
            FIXTURE_BASTROP_AE_INTERIOR_LAT + 0.00001,
          ],
          [FIXTURE_BASTROP_AE_INTERIOR_LNG, FIXTURE_BASTROP_AE_INTERIOR_LAT + 0.00001],
          [FIXTURE_BASTROP_AE_INTERIOR_LNG, FIXTURE_BASTROP_AE_INTERIOR_LAT],
        ],
      ],
    };
    const result = resolveParcelFloodZones(parcel, index);
    expect(result.status).toBe("in-zones");
    if (result.status === "in-zones") {
      expect(result.zones.some((z) => z.fldZone === "AE")).toBe(true);
      expect(result.zones[0].inSpecialFloodHazardArea).toBe(true);
    }
  });

  it("returns outside-mapped-zones for rural West Texas (honest absence)", () => {
    const parcel = {
      type: "Polygon" as const,
      coordinates: [
        [
          [FIXTURE_RURAL_OUTSIDE_LNG, FIXTURE_RURAL_OUTSIDE_LAT],
          [FIXTURE_RURAL_OUTSIDE_LNG + 0.01, FIXTURE_RURAL_OUTSIDE_LAT],
          [FIXTURE_RURAL_OUTSIDE_LNG + 0.01, FIXTURE_RURAL_OUTSIDE_LAT + 0.01],
          [FIXTURE_RURAL_OUTSIDE_LNG, FIXTURE_RURAL_OUTSIDE_LAT + 0.01],
          [FIXTURE_RURAL_OUTSIDE_LNG, FIXTURE_RURAL_OUTSIDE_LAT],
        ],
      ],
    };
    const result = resolveParcelFloodZones(parcel, index);
    expect(result.status).toBe("outside-mapped-zones");
    if (result.status === "outside-mapped-zones") {
      expect(result.basis).toContain("honest absence");
      expect(result.zones).toHaveLength(0);
    }
  });
});

describe("streamGeoJsonSeqWithBackpressure", () => {
  function featureLine(id: number): string {
    return JSON.stringify({
      type: "Feature",
      properties: { OBJECTID: id },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-97.8, 30.1],
            [-97.79, 30.1],
            [-97.79, 30.11],
            [-97.8, 30.11],
            [-97.8, 30.1],
          ],
        ],
      },
    });
  }

  /**
   * Fast producer that only advances while the Readable is flowing.
   * Without pause/resume it dumps the full payload into the consumer queue
   * (the statewide OOM shape). With pause/resume, queue depth stays O(highWater).
   */
  function makeGatedProducer(total: number): Readable {
    let nextId = 0;
    const stream = new Readable({
      read() {
        while (nextId < total && !this.isPaused()) {
          const ok = this.push(featureLine(nextId++) + "\n");
          if (!ok) break;
        }
        if (nextId >= total) {
          this.push(null);
        }
      },
    });
    return stream;
  }

  it("keeps queue depth near highWaterMark under a slow consumer", async () => {
    const highWater = 4;
    const lowWater = 1;
    const total = 60;
    const stream = makeGatedProducer(total);
    let yielded = 0;
    let peakDepth = 0;
    let pauseCalls = 0;
    const origPause = stream.pause.bind(stream);
    stream.pause = ((...args: []) => {
      pauseCalls += 1;
      return origPause(...args);
    }) as typeof stream.pause;

    for await (const _ of streamGeoJsonSeqWithBackpressure(stream, {
      highWaterMark: highWater,
      lowWaterMark: lowWater,
      onQueueDepth: (d) => {
        if (d > peakDepth) peakDepth = d;
      },
    })) {
      yielded += 1;
      // Slow consumer — without backpressure peakDepth approaches `total`.
      await new Promise((r) => setTimeout(r, 2));
    }

    expect(yielded).toBe(total);
    expect(pauseCalls).toBeGreaterThan(0);
    // Old unbounded bridge never pauses; peakDepth ≈ total.
    // Fixed bridge pauses at highWater (± one push race).
    expect(peakDepth).toBeLessThanOrEqual(highWater + 1);
    expect(peakDepth).toBeLessThan(total / 2);
  });

  it("delivers every feature and drains after end", async () => {
    const lines = Array.from({ length: 7 }, (_, i) => featureLine(i)).join("\n") + "\n";
    const stream = Readable.from([lines]);
    const ids: number[] = [];
    for await (const f of streamGeoJsonSeqWithBackpressure(stream, {
      highWaterMark: 2,
      lowWaterMark: 0,
    })) {
      ids.push(Number((f.properties as { OBJECTID: number }).OBJECTID));
    }
    expect(ids).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("nfhl ingest idempotency (mock db)", () => {
  it("replace + upsert yields identical row count on re-run", async () => {
    type Row = Record<string, unknown>;
    const store = new Map<string, Row>();
    const mockDb = {
      delete: async () => {
        store.clear();
      },
      insert: () => ({
        values: (rows: Row[]) => ({
          onConflictDoUpdate: async () => {
            for (const row of rows) {
              store.set(String(row.zoneRowId), { ...row });
            }
          },
        }),
      }),
      execute: async () => ({ rows: [{ n: store.size }] }),
    };

    const ae = normalizeNfhlFeature(FIXTURE_BASTROP_AE_ZONE, newCounters())!;
    async function* rows() {
      yield ae;
    }
    const meta = {
      source: "test",
      sourceVintage: "fixture",
      sourceCitation: "fixture://test",
    };

    await deleteAllNfhlFloodZones(mockDb as never);
    const run1 = await upsertNfhlFloodZones(mockDb as never, rows(), meta);
    expect(run1.rowsInserted).toBe(1);

    await deleteAllNfhlFloodZones(mockDb as never);
    const run2 = await upsertNfhlFloodZones(mockDb as never, rows(), {
      ...meta,
      sourceVintage: "fixture-rerun",
    });
    expect(run2.rowsInserted).toBe(1);
    expect(store.get("48021C:48021C_2261")?.sourceVintage).toBe("fixture-rerun");

    const count = await countAllNfhlFloodZones(mockDb as never);
    expect(count).toBe(1);

    expect(NFHL_SOURCE_CITATION).toContain("nfhlv2/output/State");
    expect(NFHL_FLOOD_LAYER).toBe("S_FLD_HAZ_AR");
  });
});
