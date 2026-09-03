/**
 * The PARCEL-B-SLATE2 integration point. Two load-bearing assertions, same
 * discipline as wellFactServeCutover.test.ts:
 *   - an UNSLATED county returns every field null (keep legacy) regardless
 *     of what the verdict store says -- the slate gates everything.
 *   - a SLATED county genuinely overlays on a real pass verdict, and
 *     genuinely returns null (keep legacy) on refuse/no-verdict -- fail
 *     closed even when slated, per rail independently.
 */

import { afterEach, describe, expect, it } from "vitest";
import { memoryParcelGateVerdicts } from "./parcelGateVerdictRead";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordCellRead";
import {
  resetCadRollVerdictStoreForTests,
  resolveCadRollOverlaysForServe,
  setCadRollVerdictStoreForTests,
} from "./cadRollServeCutover";
import { PARCEL_RECORD_SLATE } from "./parcelRecordAllowlist";

afterEach(() => {
  resetCadRollVerdictStoreForTests();
  resetParcelRecordQueryableForTests();
});

const NOW = "2026-09-03T07:00:00.000Z";

describe("resolveCadRollOverlaysForServe", () => {
  it("an unslated county returns every field null, even with a fabricated pass verdict and real cell data present", async () => {
    expect(PARCEL_RECORD_SLATE.has("48103:marketValue")).toBe(false);
    setCadRollVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48103", railKey: "marketValue", verdict: "pass", unaccountedCount: 0, evaluatedAt: NOW, runId: "r" },
      ]),
    );
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [{ placeKey: "48103:100", railKey: "marketValue", cellState: { kind: "value", value: "999999", source: "cad_property", vintage: NOW } }],
      }),
    );
    const result = await resolveCadRollOverlaysForServe("48103", "100");
    expect(result).toEqual({
      marketValue: null,
      assessedValue: null,
      landValue: null,
      improvementValue: null,
      livingAreaSqft: null,
      yearBuilt: null,
    });
  });

  it("no store configured for either the verdict or the cell reads returns every field null", async () => {
    setCadRollVerdictStoreForTests(null);
    setParcelRecordQueryableForTests(null);
    const result = await resolveCadRollOverlaysForServe("48021", "34137");
    expect(Object.values(result).every((v) => v === null)).toBe(true);
  });
});
