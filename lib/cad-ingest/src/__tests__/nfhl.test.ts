/**
 * FEMA NFHL statewide flood-zone layer unit tests — parse against recorded
 * fixtures, projection guard, idempotency contract, and parcel evaluation.
 */

import { describe, expect, it } from "vitest";
import {
  assertNfhlGeographicCoordinates,
  normalizeNfhlFeature,
} from "../nfhl/parse";
import {
  buildNfhlZoneIndex,
  resolveParcelFloodZones,
} from "../nfhl/evaluation";
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
