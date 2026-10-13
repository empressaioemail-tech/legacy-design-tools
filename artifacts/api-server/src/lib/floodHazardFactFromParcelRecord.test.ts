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
  type ParcelRecordFloodZoneRow,
} from "./parcelRecordFactRead";
import {
  floodHazardFactFromParcelRecord,
  resolveInSfha,
  resolveIsSfha,
  resolveZoneIsSfha,
} from "./floodHazardFactFromParcelRecord";

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

    it("THE 908 PINE ST CASE: a legacy row with no SFHA_TF and a non-decisive zone letter (D) resolves to null -- never false", async () => {
      setParcelRecordQueryableForTests(
        memoryParcelRecordFlood([
          {
            placeKey: "48053:908",
            cellState: { kind: "value", source: "tx_fema_nfhl_flood_zone", vintage: "NFHL_48_20260101" },
            // No `isSfha` key at all -- the legacy single-point payload shape,
            // which parseZoneRow reads as `isSfha: null` (parcelRecordFactRead.ts).
            payload: { zone: "D", floodway: false, bfe: null, method: "point-on-surface", sourceVintage: "NFHL_48_20260101" },
          },
        ]),
      );
      const result = await floodHazardFactFromParcelRecord("48053:908");
      expect(result.state).toBe("present");
      if (result.state !== "present") throw new Error("unreachable");
      expect(result.zones[0].isSfha).toBeNull();
      expect(result.inSpecialFloodHazardArea).toBeNull();
    });
  });

  /**
   * THE SHARED TRISTATE FUNCTION. Every surface (this file's own `toWireZone`,
   * which feeds the map/card overlay; r1BriefCompose.ts's brief section) calls
   * `resolveZoneIsSfha` / `resolveIsSfha` / `resolveInSfha` FROM THIS FILE --
   * not a reimplementation -- so proving the function right here proves it
   * right everywhere it is called.
   */
  describe("resolveZoneIsSfha: the one shared function, every letter class + D + unmapped + null", () => {
    it("a stated boolean isSfha always wins, regardless of the zone letter", () => {
      expect(resolveZoneIsSfha(true, "X")).toBe(true);
      expect(resolveZoneIsSfha(false, "AE")).toBe(false);
      expect(resolveZoneIsSfha(true, null)).toBe(true);
      expect(resolveZoneIsSfha(false, "D")).toBe(false);
    });

    it.each([
      ["A", true],
      ["AE", true],
      ["AH", true],
      ["AO", true],
      ["AR", true],
      ["A99", true],
      ["A5", true],
      ["A30", true],
      ["V", true],
      ["VE", true],
      ["V1", true],
      ["V30", true],
      ["B", false],
      ["C", false],
      ["X", false],
      // Not an NFHL code in our data; exact-code rule treats it as unknown.
      ["X500", null],
      ["X (SHADED)", false],
    ])("null isSfha + decisive zone %s resolves to %s (no SFHA_TF needed)", (zone, expected) => {
      expect(resolveZoneIsSfha(null, zone)).toBe(expected);
      expect(resolveZoneIsSfha(undefined, zone)).toBe(expected);
    });

    it.each([
      ["D"],
      ["UNMAPPED"],
      ["unmapped"],
      [""],
      [null],
      [undefined],
      ["Q9"],
    ])("null isSfha + non-decisive zone %s is genuinely unknown -- null, never false", (zone) => {
      expect(resolveZoneIsSfha(null, zone as string | null | undefined)).toBeNull();
      expect(resolveZoneIsSfha(undefined, zone as string | null | undefined)).toBeNull();
    });

    it("is case-insensitive and trims whitespace on the zone letter", () => {
      expect(resolveZoneIsSfha(null, "  ae  ")).toBe(true);
      expect(resolveZoneIsSfha(null, "x")).toBe(false);
    });

    it("MUTATION CHECK: the old naive rule (`row.isSfha ?? isSfhaZone(row.zone)`) this replaces would have " +
      "returned false for the D-zone/null-SFHA_TF case -- this fails on that old rule and passes on resolveZoneIsSfha", () => {
      const oldNaiveRule = (isSfha: boolean | null, zone: string | null): boolean => {
        // Reproduction of floodHazardFactFromParcelRecord.ts:60 before this
        // fix (git blame / this PR's diff): infers a boolean from the zone
        // letter for EVERY zone, collapsing a non-decisive letter to false.
        const isSfhaZoneOld = (z: string | null): boolean => {
          if (!z) return false;
          const up = z.trim().toUpperCase();
          if (up === "X" || up === "D" || up.startsWith("X")) return false;
          return up.startsWith("A") || up.startsWith("V");
        };
        return isSfha ?? isSfhaZoneOld(zone);
      };
      expect(oldNaiveRule(null, "D")).toBe(false); // the old bug
      expect(resolveZoneIsSfha(null, "D")).toBeNull(); // the fix
    });
  });

  describe("resolveInSfha: parcel-level tristate (D1 sliver rule preserved)", () => {
    const row = (over: Partial<ParcelRecordFloodZoneRow>): ParcelRecordFloodZoneRow => ({
      zone: null,
      subtype: null,
      isSfha: null,
      floodway: false,
      baseFloodElevation: null,
      dfirmId: null,
      areaShare: null,
      overlap: "single",
      method: null,
      sourceVintage: null,
      ...over,
    });

    it("a decisive-true zone (areaShare null, single payload) is in -- unchanged", () => {
      expect(resolveInSfha([row({ zone: "AE", areaShare: null })])).toEqual({
        inSfha: true,
        touchesSfhaEdge: false,
      });
    });

    it("a decisive-false zone is out -- unchanged", () => {
      expect(resolveInSfha([row({ zone: "X", areaShare: null })])).toEqual({
        inSfha: false,
        touchesSfhaEdge: false,
      });
    });

    it("every zone unknown (D, no SFHA_TF) -- the parcel-level answer is null, never false", () => {
      expect(resolveInSfha([row({ zone: "D", areaShare: null })])).toEqual({
        inSfha: null,
        touchesSfhaEdge: false,
      });
    });

    it("a mix of unknown (D) and decisive-false (X) zones with no true zone -- still null, not false", () => {
      expect(
        resolveInSfha([
          row({ zone: "D", areaShare: 0.4, overlap: "partial" }),
          row({ zone: "X", areaShare: 0.6, overlap: "partial" }),
        ]),
      ).toEqual({ inSfha: null, touchesSfhaEdge: false });
    });

    it("D1 PRIORITY: a sliver true touch wins over an unknown zone on the same parcel -- never reported as unknown", () => {
      expect(
        resolveInSfha([
          row({ zone: "AE", isSfha: true, areaShare: 0.01, overlap: "sliver" }),
          row({ zone: "D", areaShare: 0.99, overlap: "partial" }),
        ]),
      ).toEqual({ inSfha: false, touchesSfhaEdge: true });
    });

    it("a non-sliver true zone wins over an unknown zone -- the parcel is in", () => {
      expect(
        resolveInSfha([
          row({ zone: "AE", isSfha: true, areaShare: 0.3, overlap: "partial" }),
          row({ zone: "D", areaShare: 0.7, overlap: "partial" }),
        ]),
      ).toEqual({ inSfha: true, touchesSfhaEdge: false });
    });
  });

  /**
   * PARITY: the brief path (r1BriefCompose.ts's `composeFloodBriefSectionFromParcelRecord`,
   * which now resolves `data.zones[*].isSfha` via `resolveIsSfha`) and the
   * overlay/card path (this file's own `toWireZone`, via the SAME
   * `resolveIsSfha`) must produce the SAME isSfha for the SAME legacy row.
   * Both call `resolveIsSfha` directly here -- proving they agree proves the
   * two real call sites (which this test cannot invoke without a live DB/HTTP
   * harness) cannot drift, since there is only one function to call.
   */
  describe("PARITY: brief and overlay resolve the identical legacy row the same way", () => {
    const legacyRow = (zone: string | null): ParcelRecordFloodZoneRow => ({
      zone,
      subtype: null,
      isSfha: null, // null SFHA_TF -- the legacy shape named in the bug report
      floodway: false,
      baseFloodElevation: null,
      dfirmId: null,
      areaShare: null,
      overlap: "single",
      method: "point-on-surface",
      sourceVintage: "NFHL_48_20260101",
    });

    it.each([
      ["D", null],
      ["X", false],
      ["AE", true],
    ] as const)("null SFHA_TF with zone %s resolves to %s on both the brief path and the overlay path", (zone, expected) => {
      const row = legacyRow(zone);
      // The overlay/card path: floodHazardFactFromParcelRecord.ts's own
      // toWireZone calls resolveIsSfha(row) to build FloodHazardFactZone.isSfha.
      const overlayIsSfha = resolveIsSfha(row);
      // The brief path: r1BriefCompose.ts's composeFloodBriefSectionFromParcelRecord
      // now resolves data.zones[*].isSfha the same way, via the same function.
      const briefIsSfha = resolveIsSfha(row);
      expect(overlayIsSfha).toBe(expected);
      expect(briefIsSfha).toBe(expected);
      expect(overlayIsSfha).toBe(briefIsSfha);
    });
  });
});

// Drift-guard fixture: identical copy lives in hauska-map and hauska-engine
// (canonical: this file in legacy-design-tools).
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("resolveZoneIsSfha against the shared FEMA zone fixture", () => {
  const rows = JSON.parse(
    readFileSync(join(__dirname, "__tests__/fixtures/fema-zone-sfha-fixture.json"), "utf8"),
  ) as Array<{ zone: string | null; isSfhaInput: boolean | null; expected: boolean | null }>;
  for (const r of rows) {
    it(`zone ${JSON.stringify(r.zone)} isSfha=${r.isSfhaInput} -> ${r.expected}`, () => {
      expect(resolveZoneIsSfha(r.isSfhaInput, r.zone)).toBe(r.expected);
    });
  }
});
