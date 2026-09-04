/**
 * overlayDistrictsFactFromParcelRecord.ts — the serve/prod-cutover adapter.
 * Fixtures mirror the real writer shapes in hauska-factory's
 * parcel-overlay-districts.mjs: overlayCompanionPayload
 * ({city, ...tx_city_overlay.payload}, live sample from the acquire-gis
 * close: Bastrop Character-District {CD_Name, CD_Desc, Shape__Area,
 * Shape__Length}), and overlayDistrictsSweepAbsentBasis's absent-verified
 * shape.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordCellRead";
import { overlayDistrictsFactFromParcelRecord } from "./overlayDistrictsFactFromParcelRecord";
import { OVERLAY_DISTRICTS_RAIL_KEY } from "./overlayDistrictsFactRead";

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

describe("overlayDistrictsFactFromParcelRecord", () => {
  it("a malformed parcelNodeId refuses invalid-parcel-node-id without touching the store", async () => {
    const result = await overlayDistrictsFactFromParcelRecord("not-a-valid-id");
    expect(result).toEqual({
      state: "refused",
      code: "invalid-parcel-node-id",
      source: "overlay-districts-fact",
      entityId: null,
      reason:
        '"not-a-valid-id" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.',
    });
  });

  it("no store configured refuses parcel-record-store-not-configured", async () => {
    setParcelRecordQueryableForTests(null);
    const result = await overlayDistrictsFactFromParcelRecord("48021:34137");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-store-not-configured");
  });

  it("LIVE-SHAPE: absent-verified (a parcel inside a confirmed city, zero overlay hits) maps to a typed absence naming the city", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48491:R391390",
            railKey: OVERLAY_DISTRICTS_RAIL_KEY,
            cellState: {
              kind: "absent-verified",
              basis: {
                source: "tx_city_overlay",
                countyFips: "48491",
                propId: "R391390",
                cityName: "Round Rock",
                method: "zone-major-sweep",
                finding: "no tx_city_overlay polygon for Round Rock contains this parcel's centroid",
                vintage: "2026-09-04T00:00:00.000Z",
              },
            },
          },
        ],
      }),
    );
    const result = await overlayDistrictsFactFromParcelRecord("48491:R391390");
    expect(result.state).toBe("absent");
    if (result.state !== "absent") throw new Error("unreachable");
    expect(result.cityName).toBe("Round Rock");
    expect(result.absence).toEqual({
      kind: "absent-verified",
      reason: "no tx_city_overlay polygon for Round Rock contains this parcel's centroid",
    });
    expect(result.verifiedAbsence).toBe(true);
  });

  it("LIVE-SHAPE: one overlay hit (real Bastrop Character-District payload shape) maps to a present districts array of length 1", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:103255",
            railKey: OVERLAY_DISTRICTS_RAIL_KEY,
            cellState: { kind: "value", disposition: "rows", rowCount: 1, source: "tx_city_overlay", vintage: "2026-09-04T00:00:00.000Z" },
          },
        ],
        companionRows: [
          {
            placeKey: "48021:103255",
            railKey: OVERLAY_DISTRICTS_RAIL_KEY,
            rowIndex: 0,
            payload: {
              city: "Bastrop",
              CD_Name: "Planned Development District",
              CD_Desc: "Character District overlay text",
              Shape__Area: 1234.5,
              Shape__Length: 89.1,
            },
            source: "tx_city_overlay",
            vintage: "2026-09-04T00:00:00.000Z",
          },
        ],
      }),
    );
    const result = await overlayDistrictsFactFromParcelRecord("48021:103255");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.districts).toHaveLength(1);
    expect(result.districts[0].city).toBe("Bastrop");
    expect(result.districts[0].attributes).toEqual({
      CD_Name: "Planned Development District",
      CD_Desc: "Character District overlay text",
      Shape__Area: 1234.5,
      Shape__Length: 89.1,
    });
  });

  it("multiple overlay hits (rowCount 2) carry every district, none dropped as a picked lead", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48453:772805",
            railKey: OVERLAY_DISTRICTS_RAIL_KEY,
            cellState: { kind: "value", disposition: "rows", rowCount: 2, source: "tx_city_overlay", vintage: "2026-09-04" },
          },
        ],
        companionRows: [
          { placeKey: "48453:772805", railKey: OVERLAY_DISTRICTS_RAIL_KEY, rowIndex: 0, payload: { city: "Austin", kind: "historic" }, source: "tx_city_overlay", vintage: "2026-09-04" },
          { placeKey: "48453:772805", railKey: OVERLAY_DISTRICTS_RAIL_KEY, rowIndex: 1, payload: { city: "Austin", kind: "waterfront-overlay" }, source: "tx_city_overlay", vintage: "2026-09-04" },
        ],
      }),
    );
    const result = await overlayDistrictsFactFromParcelRecord("48453:772805");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.districts).toHaveLength(2);
    expect(result.districts.map((d) => d.attributes.kind)).toEqual(["historic", "waterfront-overlay"]);
  });

  it("THE LOAD-BEARING CASE: unaccounted (a parcel outside all 12 confirmed cities, never touched by the writer) refuses, never a fabricated absence or present", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48055:5001", railKey: OVERLAY_DISTRICTS_RAIL_KEY, cellState: { kind: "unaccounted" } },
        ],
      }),
    );
    const result = await overlayDistrictsFactFromParcelRecord("48055:5001");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-unaccounted");
  });

  it("a value cell with no readable companion rows refuses rather than inventing a district", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:1",
            railKey: OVERLAY_DISTRICTS_RAIL_KEY,
            cellState: { kind: "value", disposition: "rows", rowCount: 1, source: "tx_city_overlay", vintage: "2026-09-04" },
          },
        ],
        companionRows: [],
      }),
    );
    const result = await overlayDistrictsFactFromParcelRecord("48021:1");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-malformed-cell");
  });

  it("no cell row at all (no-such-parcel-or-rail) maps to parcel-record-cell-miss, distinct from unaccounted", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordStore({ cells: [] }));
    const result = await overlayDistrictsFactFromParcelRecord("48021:999999");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-cell-miss");
  });
});
