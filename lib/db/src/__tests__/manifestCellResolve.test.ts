import { describe, it, expect } from "vitest";

import {
  mergeAtomFamilyState,
  mergeHasWriter,
  mergeEffectiveRailFields,
  resolveManifestDisplayState,
} from "../manifestCellResolve";
import { MANIFEST_DISPLAY_STATE_SQL } from "../manifestDisplayState";

describe("mergeEffectiveRailFields", () => {
  it("does not upgrade store missing to derived present", () => {
    expect(mergeAtomFamilyState("missing", "present")).toBe("missing");
  });

  it("downgrades store present when derived is partial", () => {
    expect(mergeAtomFamilyState("present", "partial")).toBe("partial");
  });

  it("does not upgrade store hasWriter false", () => {
    expect(mergeHasWriter(false, true)).toBe(false);
  });

  it("downgrades store hasWriter true when derived false", () => {
    expect(mergeHasWriter(true, false)).toBe(false);
  });

  it("mergeEffectiveRailFields combines both", () => {
    expect(
      mergeEffectiveRailFields("present", true, "partial", false),
    ).toEqual({ atomFamilyState: "partial", hasWriter: false });
  });
});

/**
 * resolveManifestDisplayState is a SECOND, TypeScript-side implementation of
 * `MANIFEST_DISPLAY_STATE_SQL`'s own CASE (`manifestDisplayState.ts`), used
 * by `manifestGridRead.ts`'s effective-rail-fields overlay when a live-probed
 * value differs from what the SQL query already computed on the raw stored
 * fields. This function predates operator ruling 4 (2026-08-19, OPS-16
 * A-020, lane SS-W15's not-measured/measured-below-bar split) and was never
 * updated for it when the SQL CASE was: composing ruling 4 with R-09 (PR
 * #447) surfaced that this function still returned `not-yet` for a null
 * railState, silently clobbering the SQL's own `not-measured` back down for
 * every cell the overlay path touches (manifestDisplayState.test.ts's own
 * "SEPARATES a never-measured cell from a measured-below-bar cell" failed
 * against the full pipeline until this was fixed). These cases pin the exact
 * mapping so the two implementations cannot re-diverge the same way again.
 */
describe("resolveManifestDisplayState — mirrors MANIFEST_DISPLAY_STATE_SQL exactly", () => {
  it("no-atom wins over everything else", () => {
    expect(resolveManifestDisplayState("missing", true, "satisfied-present")).toBe(
      "no-atom",
    );
  });

  it("no-writer wins over the stored state", () => {
    expect(resolveManifestDisplayState("present", false, "satisfied-present")).toBe(
      "no-writer",
    );
  });

  it("a null railState (no ledger row) is not-measured — an INSTRUMENT gap", () => {
    expect(resolveManifestDisplayState("present", true, null)).toBe("not-measured");
  });

  it("a stored not-yet railState is measured-below-bar — a COVERAGE gap, ruling 4's whole point", () => {
    expect(resolveManifestDisplayState("present", true, "not-yet")).toBe(
      "measured-below-bar",
    );
  });

  it("not-measured and measured-below-bar are genuinely distinct outputs", () => {
    expect(resolveManifestDisplayState("present", true, null)).not.toBe(
      resolveManifestDisplayState("present", true, "not-yet"),
    );
  });

  it("satisfied-present and satisfied-absent pass through verbatim", () => {
    expect(resolveManifestDisplayState("present", true, "satisfied-present")).toBe(
      "satisfied-present",
    );
    expect(resolveManifestDisplayState("present", true, "satisfied-absent")).toBe(
      "satisfied-absent",
    );
  });

  it("the SQL CASE this mirrors actually encodes the same split (source-text check)", () => {
    // Not a substitute for the behavioral cases above -- a cheap tripwire if
    // the SQL side is ever edited without this function being touched too.
    expect(MANIFEST_DISPLAY_STATE_SQL).toContain(
      "WHEN c.rail_state IS NULL THEN 'not-measured'",
    );
    expect(MANIFEST_DISPLAY_STATE_SQL).toContain(
      "WHEN c.rail_state = 'not-yet' THEN 'measured-below-bar'",
    );
  });
});
