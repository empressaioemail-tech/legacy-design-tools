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

  describe("CARD F2: whole-parcel flood (2026-10-12_whole_parcel_flood_design.md)", () => {
    it("the OLD single-point payload is unchanged: present, inSFHA from the zone letter, zones has one entry, overlap single, touchesSfhaEdge false", async () => {
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
      expect(result.zones).toEqual([
        { zone: "AE", subtype: null, isSfha: true, floodway: false, bfe: 512.3, areaShare: null },
      ]);
      expect(result.overlap).toBe("single");
      expect(result.touchesSfhaEdge).toBe(false);
    });

    it("a new whole-parcel payload: 23% AE / 77% X -> zones in order, inSfha true, overlap partial", async () => {
      setParcelRecordQueryableForTests(
        memoryParcelRecordFlood([
          {
            placeKey: "48053:1001",
            cellState: { kind: "value", source: "tx_fema_nfhl_flood_zone", vintage: "NFHL_48_20260101" },
            payloads: [
              { zone: "AE", subtype: null, isSfha: true, floodway: false, bfe: 820, dfirmId: "48053C", areaShare: 0.23, overlap: "partial", method: "whole-parcel-area-share" },
              { zone: "X", subtype: null, isSfha: false, floodway: false, bfe: null, dfirmId: "48053C", areaShare: 0.77, overlap: "partial", method: "whole-parcel-area-share" },
            ],
          },
        ]),
      );
      const result = await floodHazardFactFromParcelRecord("48053:1001");
      expect(result.state).toBe("present");
      if (result.state !== "present") throw new Error("unreachable");
      expect(result.zones).toHaveLength(2);
      expect(result.zones.map((z) => z.zone)).toEqual(["AE", "X"]);
      expect(result.zones[0]).toMatchObject({ zone: "AE", isSfha: true, areaShare: 0.23 });
      expect(result.zones[1]).toMatchObject({ zone: "X", isSfha: false, areaShare: 0.77 });
      expect(result.inSpecialFloodHazardArea).toBe(true);
      expect(result.overlap).toBe("partial");
      expect(result.touchesSfhaEdge).toBe(false);
    });

    it("a sliver SFHA touch: inSfha false, touchesSfhaEdge true -- never 'in', never hidden (operator ruling D1)", async () => {
      setParcelRecordQueryableForTests(
        memoryParcelRecordFlood([
          {
            placeKey: "48053:1002",
            cellState: { kind: "value", source: "tx_fema_nfhl_flood_zone", vintage: "NFHL_48_20260101" },
            payloads: [
              { zone: "X", subtype: null, isSfha: false, floodway: false, bfe: null, dfirmId: "48053C", areaShare: 0.993, overlap: "partial", method: "whole-parcel-area-share" },
              { zone: "AE", subtype: null, isSfha: true, floodway: false, bfe: 810, dfirmId: "48053C", areaShare: 0.007, overlap: "sliver", method: "whole-parcel-area-share" },
            ],
          },
        ]),
      );
      const result = await floodHazardFactFromParcelRecord("48053:1002");
      expect(result.state).toBe("present");
      if (result.state !== "present") throw new Error("unreachable");
      expect(result.inSpecialFloodHazardArea).toBe(false);
      expect(result.touchesSfhaEdge).toBe(true);
      // Still never hidden: the sliver zone is in the list with its share.
      expect(result.zones.some((z) => z.zone === "AE" && z.areaShare === 0.007)).toBe(true);
    });

    it("unmapped: a parcel outside any NFHL polygon gets an explicit 'unmapped' zone, never 'X'", async () => {
      setParcelRecordQueryableForTests(
        memoryParcelRecordFlood([
          {
            placeKey: "48053:1003",
            cellState: { kind: "value", source: "tx_fema_nfhl_flood_zone", vintage: "NFHL_48_20260101" },
            payloads: [
              { zone: "unmapped", subtype: null, isSfha: false, floodway: false, bfe: null, dfirmId: null, areaShare: 1, overlap: "single", method: "whole-parcel-area-share" },
            ],
          },
        ]),
      );
      const result = await floodHazardFactFromParcelRecord("48053:1003");
      expect(result.state).toBe("present");
      if (result.state !== "present") throw new Error("unreachable");
      expect(result.floodZone).toBe("unmapped");
      expect(result.inSpecialFloodHazardArea).toBe(false);
      expect(result.touchesSfhaEdge).toBe(false);
    });

    it("a re-read with 3 companion rows carries every zone through this adapter too", async () => {
      setParcelRecordQueryableForTests(
        memoryParcelRecordFlood([
          {
            placeKey: "48053:1004",
            cellState: { kind: "value", source: "tx_fema_nfhl_flood_zone", vintage: "NFHL_48_20260101" },
            payloads: [
              { zone: "AE", isSfha: true, floodway: false, bfe: 480, areaShare: 0.5, overlap: "partial", method: "whole-parcel-area-share" },
              { zone: "X", isSfha: false, floodway: false, bfe: null, areaShare: 0.3, overlap: "partial", method: "whole-parcel-area-share" },
              { zone: "VE", isSfha: true, floodway: false, bfe: 495, areaShare: 0.2, overlap: "partial", method: "whole-parcel-area-share" },
            ],
          },
        ]),
      );
      const result = await floodHazardFactFromParcelRecord("48053:1004");
      expect(result.state).toBe("present");
      if (result.state !== "present") throw new Error("unreachable");
      expect(result.zones).toHaveLength(3);
      expect(result.zones.map((z) => z.zone)).toEqual(["AE", "X", "VE"]);
      expect(result.inSpecialFloodHazardArea).toBe(true);
    });
  });
});
