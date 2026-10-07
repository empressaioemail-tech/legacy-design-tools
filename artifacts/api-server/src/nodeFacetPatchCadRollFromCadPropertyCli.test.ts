/**
 * Gate 4 / P4 (audit 2026-10-07): `isDestructiveOverwrite` is the
 * population measurement `node-facet-patch-cad-roll`'s blast-radius guard
 * (destructiveWriteGuard.ts) is evaluated against. Importing this module
 * is safe (no DB pool, no process.exit) because its `main()` is gated on a
 * direct-run check -- see the file's own comment above that guard.
 */
import { describe, expect, it } from "vitest";
import { isDestructiveOverwrite } from "./nodeFacetPatchCadRollFromCadPropertyCli.js";
import type { CadRollBaked } from "./lib/cadRollValue.js";

function cadRoll(overrides: Partial<CadRollBaked> = {}): CadRollBaked {
  return {
    marketValue: null,
    assessedValue: null,
    landValue: null,
    improvementValue: null,
    livingAreaSqft: null,
    ...overrides,
  };
}

const DOLLAR = { v: 100000, source: "cad_property" as const, vintage: "2026", valueBasis: "county-assessed" as const };
const DOLLAR_DIFFERENT = { v: 150000, source: "cad_property" as const, vintage: "2026", valueBasis: "county-assessed" as const };

describe("isDestructiveOverwrite", () => {
  it("a first-ever patch (old cadRoll absent on every field) is never destructive, however much the new facts fill in", () => {
    expect(isDestructiveOverwrite(null, cadRoll({ marketValue: DOLLAR, assessedValue: DOLLAR }))).toBe(false);
    expect(isDestructiveOverwrite(cadRoll(), cadRoll({ marketValue: DOLLAR }))).toBe(false);
  });

  it("filling a field that was absent (null -> value) on one field while others repeat is not destructive", () => {
    const old = cadRoll({ marketValue: DOLLAR });
    const next = cadRoll({ marketValue: DOLLAR, assessedValue: DOLLAR });
    expect(isDestructiveOverwrite(old, next)).toBe(false);
  });

  it("REFUSES-worthy: an already-answered field changing to a DIFFERENT value is destructive", () => {
    const old = cadRoll({ marketValue: DOLLAR });
    const next = cadRoll({ marketValue: DOLLAR_DIFFERENT });
    expect(isDestructiveOverwrite(old, next)).toBe(true);
  });

  it("re-writing the SAME value is not destructive (byte-identical field)", () => {
    const old = cadRoll({ marketValue: DOLLAR });
    const next = cadRoll({ marketValue: { ...DOLLAR } });
    expect(isDestructiveOverwrite(old, next)).toBe(false);
  });

  it("a destructive change on ANY one of the five fields is enough, even if the others are unchanged", () => {
    const old = cadRoll({ marketValue: DOLLAR, livingAreaSqft: { v: 1200, source: "cad_property", vintage: "2026" } });
    const next = cadRoll({ marketValue: DOLLAR, livingAreaSqft: { v: 1500, source: "cad_property", vintage: "2026" } });
    expect(isDestructiveOverwrite(old, next)).toBe(true);
  });

  it("FALSIFIER: this check can fail -- comparing only truthiness (old != null -> always destructive) wrongly flags a pure fill", () => {
    function brokenIsDestructive(old: Partial<CadRollBaked> | null) {
      return old != null; // the bug: any prior cadRoll object at all (even all-null fields) reads as destructive.
    }
    const old = cadRoll(); // every field null -- a genuine first-ever-fill shape.
    expect(brokenIsDestructive(old)).toBe(true);
    expect(isDestructiveOverwrite(old, cadRoll({ marketValue: DOLLAR }))).toBe(false);
  });
});
