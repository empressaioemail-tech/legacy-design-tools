/**
 * The serve-layer integration point for maxImperviousCoverPct (F-01,
 * serve/prod cutover for ACQUIRE-GIS wave 1 + PARCEL wave 2). Travis
 * (48453) / Austin only.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelGateVerdicts,
  memoryParcelGateVerdictsThatFails,
} from "./parcelGateVerdictRead";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordCellRead";
import {
  loadMaxImperviousCoverPctFactForServe,
  resetMaxImperviousCoverPctVerdictStoreForTests,
  setMaxImperviousCoverPctVerdictStoreForTests,
} from "./maxImperviousCoverPctFactServeCutover";

const OUT_OF_SCOPE_COUNTY = "48021:34137"; // Bastrop -- a real program county but never slated for this rail.
const GOLD = "48453:34137"; // Travis IS slated for maxImperviousCoverPct.

afterEach(() => {
  resetMaxImperviousCoverPctVerdictStoreForTests();
  resetParcelRecordQueryableForTests();
});

describe("loadMaxImperviousCoverPctFactForServe — non-Travis counties are never slated", () => {
  it("a real program county outside Travis resolves to the typed not-cut-over refusal, never a store call", async () => {
    setMaxImperviousCoverPctVerdictStoreForTests(null);
    const result = await loadMaxImperviousCoverPctFactForServe(OUT_OF_SCOPE_COUNTY);
    expect(result).toEqual({
      state: "refused",
      code: "not-cut-over",
      source: "max-impervious-cover-pct-fact",
      entityId: OUT_OF_SCOPE_COUNTY,
      reason:
        "maxImperviousCoverPct has no legacy serve path -- it is served only from parcel_record (Travis/Austin only), and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
    });
  });

  it("FALSIFIER: even a fabricated PASS verdict has no effect for a non-Travis county — the slate check short-circuits first", async () => {
    setMaxImperviousCoverPctVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: "maxImperviousCoverPct", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadMaxImperviousCoverPctFactForServe(OUT_OF_SCOPE_COUNTY);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a malformed parcelNodeId resolves to not-cut-over without touching the verdict store", async () => {
    const malformed = "not-a-valid-id";
    const result = await loadMaxImperviousCoverPctFactForServe(malformed);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
    expect(result.entityId).toBe(malformed);
  });

  it("no verdict row on Travis (the real, current live state) falls back to not-cut-over", async () => {
    setMaxImperviousCoverPctVerdictStoreForTests(memoryParcelGateVerdicts([]));
    const result = await loadMaxImperviousCoverPctFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });
});

describe("loadMaxImperviousCoverPctFactForServe — SLATED pair (Travis)", () => {
  it("a real PASS verdict on Travis genuinely reaches the parcel_record adapter", async () => {
    setMaxImperviousCoverPctVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48453", railKey: "maxImperviousCoverPct", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: GOLD,
            railKey: "maxImperviousCoverPct",
            cellState: { kind: "value", value: 30, watershedType: "WATER SUPPLY SUBURBAN", inRechargeZone: false, crosswalkCitation: "LDC Sec. 25-8-423(B)", source: "tx_austin_watershed", vintage: "2026-09-04T00:00:00.000Z" },
          },
        ],
      }),
    );
    const result = await loadMaxImperviousCoverPctFactForServe(GOLD);
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.percent).toBe(30);
    expect(result.watershedType).toBe("WATER SUPPLY SUBURBAN");
  });

  it("a REFUSE verdict on Travis falls back to not-cut-over -- attempted but refused, not record", async () => {
    setMaxImperviousCoverPctVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48453", railKey: "maxImperviousCoverPct", verdict: "refuse", unaccountedCount: 9, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadMaxImperviousCoverPctFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a store failure on Travis fails closed to not-cut-over, not a thrown error", async () => {
    setMaxImperviousCoverPctVerdictStoreForTests(memoryParcelGateVerdictsThatFails());
    const result = await loadMaxImperviousCoverPctFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });
});
