/**
 * zoningFactFromParcelRecord.ts — the OPS-16 A-096/A-097/A-098 cutover
 * adapter. THE LOAD-BEARING CASE is the "not-applicable / unincorporated"
 * fixture: this is the specific 346,165-parcel defect
 * (_inbox/2026-09-02_p106_rail_census_zoningdiv.json) this whole card exists
 * to fix. Fixtures use the real sample parcel from
 * _inbox/2026-09-02_p106_projection_recon.json (48021:10001, unincorporated)
 * with BOTH of parcel_record's own absence kinds (not-applicable, per
 * OPS-16 A-097's direct read of rail-keys.js/instantiate.js, and
 * absent-verified, per that same census projection's own label for this
 * row) to prove the adapter is honest either way.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordCellRead";
import { zoningFactFromParcelRecord } from "./zoningFactFromParcelRecord";
import {
  ZONING_DISTRICT_RAIL_KEY,
  ZONING_JURISDICTION_KEY_RAIL_KEY,
  ZONING_PROVENANCE_RAIL_KEY,
} from "./zoningFactFromParcelRecord";

const UNINCORPORATED_PARCEL = "48021:10001"; // real sample, projection_recon.json

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

describe("zoningFactFromParcelRecord", () => {
  it("a malformed parcelNodeId refuses invalid-parcel-node-id without touching the store", async () => {
    const result = await zoningFactFromParcelRecord("not-a-valid-id");
    expect(result).toEqual({
      state: "refused",
      code: "invalid-parcel-node-id",
      source: "zoning-fact-parcel-record",
      entityId: null,
      reason:
        '"not-a-valid-id" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.',
    });
  });

  it("no store configured refuses parcel-record-store-not-configured", async () => {
    setParcelRecordQueryableForTests(null);
    const result = await zoningFactFromParcelRecord("48021:34137");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-store-not-configured");
  });

  it("THE LOAD-BEARING CASE (kind: not-applicable, per OPS-16 A-097's direct read of instantiate.js): an unincorporated parcel's zoningDistrict cell maps to a verified absence, not a fabricated unknown or a fabricated district", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: UNINCORPORATED_PARCEL,
            railKey: ZONING_DISTRICT_RAIL_KEY,
            cellState: {
              kind: "not-applicable",
              reason: "unincorporated parcel -- no municipal zoning authority applies",
            },
          },
        ],
      }),
    );
    const result = await zoningFactFromParcelRecord(UNINCORPORATED_PARCEL);
    expect(result.state).toBe("absent");
    if (result.state !== "absent") throw new Error("unreachable");
    expect(result.absence).toEqual({
      kind: "not-applicable",
      reason: "unincorporated parcel -- no municipal zoning authority applies",
    });
    expect(result.verifiedAbsence).toBeNull();
  });

  it("THE SAME LOAD-BEARING CASE under the census projection's own label (kind: absent-verified): still a verified absence, proving the adapter is honest under either vocabulary the live writer turns out to use", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: UNINCORPORATED_PARCEL,
            railKey: ZONING_DISTRICT_RAIL_KEY,
            cellState: {
              kind: "absent-verified",
              basis: { finding: "unincorporated-no-municipal-zoning" },
            },
          },
        ],
      }),
    );
    const result = await zoningFactFromParcelRecord(UNINCORPORATED_PARCEL);
    expect(result.state).toBe("absent");
    if (result.state !== "absent") throw new Error("unreachable");
    expect(result.absence.kind).toBe("absent-verified");
    expect(result.verifiedAbsence).toBe(true);
  });

  it("a present district also reads its sibling jurisdictionKey and provenance cells", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:103387",
            railKey: ZONING_DISTRICT_RAIL_KEY,
            cellState: { kind: "value", value: "SF-1", source: "bastrop_city_tx", vintage: "2026-09-04T00:00:00.000Z" },
          },
          {
            placeKey: "48021:103387",
            railKey: ZONING_JURISDICTION_KEY_RAIL_KEY,
            cellState: { kind: "value", value: "bastrop_city_tx", source: "bastrop_city_tx", vintage: "2026-09-04T00:00:00.000Z" },
          },
          {
            placeKey: "48021:103387",
            railKey: ZONING_PROVENANCE_RAIL_KEY,
            cellState: { kind: "value", value: "https://gis.example.test/zoning/bastrop", source: "bastrop_city_tx", vintage: "2026-09-04T00:00:00.000Z" },
          },
        ],
      }),
    );
    const result = await zoningFactFromParcelRecord("48021:103387");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.district).toBe("SF-1");
    expect(result.jurisdictionKey).toBe("bastrop_city_tx");
    expect(result.provenance).toBe("https://gis.example.test/zoning/bastrop");
  });

  it("a present district with no sibling cells at all is still present, with jurisdictionKey/provenance honestly null -- never fabricated", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48453:103281",
            railKey: ZONING_DISTRICT_RAIL_KEY,
            cellState: { kind: "value", value: "GC", source: "austin_tx", vintage: "2026-09-04" },
          },
        ],
      }),
    );
    const result = await zoningFactFromParcelRecord("48453:103281");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.district).toBe("GC");
    expect(result.jurisdictionKey).toBeNull();
    expect(result.provenance).toBeNull();
  });

  it("unaccounted (not yet examined) refuses, never a fabricated absence or present", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [{ placeKey: "48021:999", railKey: ZONING_DISTRICT_RAIL_KEY, cellState: { kind: "unaccounted" } }],
      }),
    );
    const result = await zoningFactFromParcelRecord("48021:999");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-unaccounted");
  });

  it("a value cell whose value is not a readable district string refuses rather than inventing one", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [{ placeKey: "48021:1", railKey: ZONING_DISTRICT_RAIL_KEY, cellState: { kind: "value", value: null, source: "x", vintage: "2026-09-04" } }],
      }),
    );
    const result = await zoningFactFromParcelRecord("48021:1");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-malformed-cell");
  });

  it("no cell row at all (no-such-parcel-or-rail) maps to parcel-record-cell-miss, distinct from unaccounted", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordStore({ cells: [] }));
    const result = await zoningFactFromParcelRecord("48021:999999");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-cell-miss");
  });
});
