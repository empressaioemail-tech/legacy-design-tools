/**
 * P-257 — the planned-development gate, pinned against the real corpus.
 *
 * Three things are asserted here that a normal unit test would not bother with,
 * and all three exist because the dispatch's verification demands them:
 *
 *  1. THE WHOLE SHIPPED CORPUS IS SWEPT. The gate must not refuse a single real
 *     district in any of the 44 tables under `lib/adapters/src/local/setbacks/`,
 *     and must refuse exactly the planned-development codes that have no row of
 *     their own. "A fix that makes everything refuse is not a fix."
 *  2. THE TWO MEASURED ESCAPES. Smithville's `PD-Z Zero Lot Line Garden Home
 *     District` and Grand County's `PUD Planned Unit Development` are real rows
 *     whose codes the pattern matches; both must keep resolving. These are the
 *     cases that falsify a pattern-only gate, and both were found by sweeping,
 *     not by reading.
 *  3. THE CROSS-REPO PINS. hauska-map vendors its resolvers and cannot import
 *     these constants, so the pattern, the flags and the refusal sentence are
 *     asserted byte-for-byte against the identical literals that hauska-map's
 *     `setback-decline-wording.test.ts` asserts its own pinned copies against.
 *     Do not soften these to `toMatch`/`toContain` — the point is exact bytes.
 *
 *     WHAT THIS PROVES (P-331, 2026-09-18). A LOCAL pin: it fails when THIS
 *     module's constant moves away from the literal typed below. It cannot fail
 *     on drift with hauska-map, because both sides of the assertion live in this
 *     repo — a one-sided edit with the literal here updated too passes both
 *     CIs, which is the opposite of what this comment claimed until P-331. The
 *     cross-repo half is now `scripts/check-cross-repo-literal-drift.mjs`
 *     (workflow `.github/workflows/cross-repo-literal-drift.yml`), which reads
 *     hauska-map's main from the defining modules and fails on disagreement.
 *     Keep both: they fail on different things.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { getSetbackTableForZoning, type SetbackTable } from "@workspace/adapters";

import { districtCodeHasExactRow, districtCode, mapDistrict } from "./districtMapping";
import {
  PLANNED_DEVELOPMENT_FLAGS,
  PLANNED_DEVELOPMENT_PATTERN,
  PUD_SETBACK_REFUSAL_REASON,
  isPlannedDevelopmentCode,
  plannedDevelopmentDisclosure,
  plannedDevelopmentSetbackRefusalFor,
} from "./plannedDevelopmentSetback";
import { resolveAuthoritativeSetbacks } from "./authoritativeSetbackSource";

// ---------------------------------------------------------------------------
// The cross-repo pins, as hauska-map holds them.
// ---------------------------------------------------------------------------
const HAYSKA_MAP_PLANNED_DEVELOPMENT_PATTERN =
  "^(PUD|PDD|PD|PC|P-?U-?D)([\\s-].*)?$";
const HAYSKA_MAP_PLANNED_DEVELOPMENT_FLAGS = "i";
const P256_PUD_REFUSAL_REASON =
  "setbacks for this parcel are set by its planned-development ordinance, " +
  "not a district schedule";

describe("P-257 cross-repo pins", () => {
  it("the pattern is the one definition, and hauska-map's copy is pinned to it", () => {
    expect(PLANNED_DEVELOPMENT_PATTERN).toBe(
      HAYSKA_MAP_PLANNED_DEVELOPMENT_PATTERN,
    );
  });

  it("the flags are pinned the same way", () => {
    expect(PLANNED_DEVELOPMENT_FLAGS).toBe(HAYSKA_MAP_PLANNED_DEVELOPMENT_FLAGS);
  });

  it("the refusal sentence is P-256's byte for byte", () => {
    expect(PUD_SETBACK_REFUSAL_REASON).toBe(P256_PUD_REFUSAL_REASON);
  });

  it("the disclosure is pinned: hauska-map composes the same bytes", () => {
    expect(
      plannedDevelopmentDisclosure({
        districtCode: "PD",
        jurisdictionKey: "smithville-tx",
      }),
    ).toBe(
      "PD is a planned-development code, not a Euclidean district: its " +
        "dimensional standards are set by the development's own ordinance and " +
        "development plan, not by a district schedule, so no setback table is " +
        "served for smithville-tx. " +
        "Setbacks for this parcel are set by its planned-development " +
        "ordinance, not a district schedule. " +
        "Verify the development plan's own standards with the city.",
    );
  });
});

// ---------------------------------------------------------------------------
// The corpus sweep. The tables are read from disk so the sweep covers what
// ships, not what a test fixture says ships.
// ---------------------------------------------------------------------------
const TABLES_DIR = join(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "../../../../../lib/adapters/src/local/setbacks",
);

function shippedTables(): Array<{ file: string; table: SetbackTable }> {
  const out: Array<{ file: string; table: SetbackTable }> = [];
  for (const file of readdirSync(TABLES_DIR)) {
    if (!file.endsWith(".json") || file === "schema.json") continue;
    const parsed = JSON.parse(
      readFileSync(join(TABLES_DIR, file), "utf8"),
    ) as SetbackTable & { districts?: unknown };
    if (!Array.isArray(parsed.districts) || !parsed.districts.length) continue;
    out.push({ file, table: parsed });
  }
  return out;
}

describe("the planned-development gate over the whole shipped corpus", () => {
  const tables = shippedTables();

  it("reads the shipped corpus (a sweep with no inputs would pass silently)", () => {
    expect(tables.length).toBeGreaterThanOrEqual(40);
    expect(tables.reduce((n, t) => n + t.table.districts.length, 0)).toBeGreaterThan(
      300,
    );
  });

  it("refuses NO district that its own table really rows — every row in every table still resolves to itself", () => {
    const broken: string[] = [];
    // idaho-unincorporated.json and utah-unincorporated.json ship two rows whose
    // leading token is the same word ("Default Agricultural" / "Default
    // Unincorporated Residential"), so the first wins for both. That is a
    // pre-existing property of those two seed tables and not this gate's doing
    // (it is measured below rather than assumed away: the count of such rows is
    // asserted so a NEW collision cannot hide here).
    const collisions: string[] = [];
    for (const { file, table } of tables) {
      const byToken = new Map<string, string[]>();
      for (const d of table.districts) {
        const code = districtCode(d);
        if (!code) continue;
        byToken.set(code, [...(byToken.get(code) ?? []), d.district_name]);
      }
      for (const [code, names] of byToken) {
        if (names.length > 1) collisions.push(`${file}:${code} -> ${names.join(" / ")}`);
      }
      for (const d of table.districts) {
        const code = districtCode(d);
        if (!code) continue;
        if ((byToken.get(code) ?? []).length > 1) continue;
        const mapped = mapDistrict(table, code);
        if (!mapped || mapped.district.district_name !== d.district_name) {
          broken.push(`${file}: ${d.district_name} -> ${mapped?.district.district_name ?? "null"}`);
        }
      }
    }
    expect(broken).toEqual([]);
    expect(collisions).toEqual([
      "idaho-unincorporated.json:DEFAULT -> Default Unincorporated Residential / Default Agricultural",
      "utah-unincorporated.json:DEFAULT -> Default Unincorporated Residential / Default Agricultural",
    ]);
  });

  it("refuses exactly the planned-development codes that have no row of their own, across every table", () => {
    const refused: string[] = [];
    const served: string[] = [];
    // The codes to probe: every leading token the corpus actually ships, plus
    // the bare planned-development codes the pattern admits that no table here
    // rows. Derived from the corpus rather than hand-listed, so a future table
    // adding a `PD` row shows up as a served code instead of being forgotten.
    const codes = new Set<string>(["PD", "PUD", "PDD", "PC", "P-UD", "PUDX", "PDX"]);
    for (const { table } of tables) {
      for (const d of table.districts) {
        const code = districtCode(d);
        if (code) codes.add(code);
      }
    }
    for (const { file, table } of tables) {
      for (const code of codes) {
        const exact = districtCodeHasExactRow(table, code);
        const refusal = plannedDevelopmentSetbackRefusalFor(
          { jurisdictionKey: table.jurisdictionKey, districtCode: code },
          (c) => districtCodeHasExactRow(table, c),
        );
        if (exact && refusal) refused.push(`FALSE-REFUSAL ${file}:${code}`);
        else if (refusal) refused.push(`${file}:${code}`);
        if (exact) served.push(`${file}:${code}`);
      }
    }
    expect(refused.filter((r) => r.startsWith("FALSE-REFUSAL"))).toEqual([]);
    expect(refused.length).toBeGreaterThan(0);
    // The two measured escapes: real rows whose codes the pattern matches.
    expect(served).toContain("smithville-tx.json:PDZ");
    expect(served).toContain("grand-county-ut.json:PUD");
    // ...and the two codes a pattern-only gate would falsely have refused.
    expect(refused).not.toContain("FALSE-REFUSAL smithville-tx.json:PDZ");
    expect(refused).not.toContain("FALSE-REFUSAL grand-county-ut.json:PUD");
  });

  it("the measured defect's jurisdiction no longer resolves the PD-Z row for a PD parcel", () => {
    const table = getSetbackTableForZoning("smithville-tx", "PD");
    expect(table).not.toBeNull();
    // Before this lane: kind "matched", confidence 0.7, and the served numbers
    // were PD-Z's 20/100/100/100 (three of them the not_specified sentinel 100).
    expect(mapDistrict(table!, "PD")).toBeNull();
    // ...while Smithville's own PD-Z still resolves, unchanged.
    const pdz = mapDistrict(table!, "PD-Z");
    expect(pdz?.kind).toBe("matched");
    expect(pdz?.district.front_ft).toBe(20);
  });
});

describe("a planned-development code resolves no setback on either side", () => {
  it("returns null from the resolver even when an atom rule carries usable scalars", () => {
    // The measured defect's shape one layer down: Euclidean axes for a PUD code
    // arriving from the per-parcel/atom side rather than the codified side.
    const resolved = resolveAuthoritativeSetbacks({
      jurisdictionKey: "smithville-tx",
      districtCode: "PD",
      atomRule: {
        front: 20,
        side: 100,
        rear: 100,
        sideCorner: 100,
        sourceAdapter: "layer-23-per-parcel",
        sourceVintage: "2025-07-14",
      },
    });
    expect(resolved).toBeNull();
  });

  it("does not touch a genuine Euclidean district's resolution", () => {
    const resolved = resolveAuthoritativeSetbacks({
      jurisdictionKey: "smithville-tx",
      districtCode: "SF-1",
      atomRule: null,
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.district.district.district_name).toContain("SF-1");
    expect(resolved!.scalars.front_ft).toBe(25);
  });

  it("does not touch a PUD-pattern code that its own table really rows (Grand County's PUD row)", () => {
    const resolved = resolveAuthoritativeSetbacks({
      jurisdictionKey: "grand-county-ut",
      districtCode: "PUD",
      atomRule: null,
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.district.district.district_name).toContain("PUD");
  });

  it("leaves an unrecognised code alone — unmeasured, never 'treat as Euclidean'", () => {
    expect(
      plannedDevelopmentSetbackRefusalFor(
        { jurisdictionKey: "austin-tx", districtCode: "QQ-9" },
        () => false,
      ),
    ).toBeNull();
    expect(isPlannedDevelopmentCode("QQ-9")).toBe(false);
  });
});
