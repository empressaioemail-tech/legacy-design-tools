/**
 * floodHazardFactFromParcelRecord.ts — the PARCEL-FLOOD-CUTOVER adapter.
 * Reuses parcelRecordFactRead.ts's own loadParcelRecordFloodFact (built by
 * PARCEL-C-REPORT) as the raw cell reader -- these tests inject via THAT
 * module's own test seam (setParcelRecordQueryableForTests /
 * memoryParcelRecordFlood), a same-named but SEPARATE seam from
 * parcelRecordCellRead.ts's own (used by the wells/specialDistricts/
 * cityLimits adapters) -- do not confuse the two.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelRecordFlood,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordFactRead";
import { floodHazardFactFromParcelRecord } from "./floodHazardFactFromParcelRecord";

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

describe("floodHazardFactFromParcelRecord", () => {
  it("a malformed parcelNodeId refuses invalid-parcel-node-id", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordFlood([]));
    const result = await floodHazardFactFromParcelRecord("not-a-valid-id");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("invalid-parcel-node-id");
  });

  it("no store configured refuses parcel-record-store-not-configured", async () => {
    setParcelRecordQueryableForTests(null);
    const result = await floodHazardFactFromParcelRecord("48021:34137");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-store-not-configured");
  });

  it("LIVE-SHAPE: a real value cell maps to present, inSpecialFloodHazardArea derived from the zone prefix (AE -> true)", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordFlood([
        {
          placeKey: "48021:34137",
          cellState: { kind: "value", source: "tx_fema_nfhl_flood_zone", vintage: "NFHL_48_20260101" },
          payload: { zone: "AE", floodway: false, bfe: 512.3, method: "point-on-surface", sourceVintage: "NFHL_48_20260101" },
        },
      ]),
    );
    const result = await floodHazardFactFromParcelRecord("48021:34137");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.floodZone).toBe("AE");
    expect(result.inSpecialFloodHazardArea).toBe(true);
    expect(result.baseFloodElevation).toBe(512.3);
    expect(result.sourceAdapter).toBe("parcel_record");
  });

  it("a zone X value cell maps to present with inSpecialFloodHazardArea false", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordFlood([
        {
          placeKey: "48021:34137",
          cellState: { kind: "value", source: "tx_fema_nfhl_flood_zone", vintage: "NFHL_48_20260101" },
          payload: { zone: "X", floodway: false, bfe: null, method: "point-on-surface", sourceVintage: "NFHL_48_20260101" },
        },
      ]),
    );
    const result = await floodHazardFactFromParcelRecord("48021:34137");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.inSpecialFloodHazardArea).toBe(false);
    expect(result.baseFloodElevation).toBeNull();
  });

  it("LIVE-SHAPE: absent-verified (real basis shape) maps to a typed absence", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordFlood([
        {
          placeKey: "48055:10068",
          cellState: {
            kind: "absent-verified",
            basis: { method: "point-on-surface", finding: "no containing NFHL zone found", vintage: "NFHL_48_20260101" },
          },
        },
      ]),
    );
    const result = await floodHazardFactFromParcelRecord("48055:10068");
    expect(result.state).toBe("absent");
    if (result.state !== "absent") throw new Error("unreachable");
    expect(result.absence).toEqual({ kind: "absent-verified", reason: "no containing NFHL zone found" });
    expect(result.verifiedAbsence).toBe(true);
    expect(result.sourceTier).toBe("point-on-surface");
  });

  it("THE LOAD-BEARING CASE: unaccounted refuses, never a fabricated absence or zone", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordFlood([{ placeKey: "48453:493738", cellState: { kind: "unaccounted" } }]),
    );
    const result = await floodHazardFactFromParcelRecord("48453:493738");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-unaccounted");
  });

  it("no cell row at all maps to parcel-record-cell-miss", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordFlood([]));
    const result = await floodHazardFactFromParcelRecord("48021:999999");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-cell-miss");
  });

  it("a malformed cell (kind=value, no payload) refuses parcel-record-malformed-cell rather than inventing a zone", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordFlood([{ placeKey: "48021:1", cellState: { kind: "value", source: "tx_fema_nfhl_flood_zone", vintage: "2026" } }]),
    );
    const result = await floodHazardFactFromParcelRecord("48021:1");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-malformed-cell");
  });
});
