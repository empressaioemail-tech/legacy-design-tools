import { describe, it, expect } from "vitest";
import { diffRails } from "../countyRailRefreshCli";
import { buildEffectiveCountyRailDeclaration } from "@workspace/db";

function liveRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    rail_key: "geometry",
    display_name: "Parcel geometry",
    ordinal: 1,
    rail_letter: "C",
    kind: "spine",
    threshold_pct: "95.00",
    atom_family_state: "missing",
    atom_family_ref: null,
    has_writer: false,
    writer_ref: null,
    declared_source: "TxGIO StratMap bulk zip per FIPS; county ArcGIS override where fresher",
    notes: "Spine rail, no atom.",
    ...overrides,
  };
}

const mockExists = (p: string) =>
  p.includes("write-") ||
  p.includes("countyGeometryScoreCli") ||
  p.includes("countyCoverageScoreCli") ||
  p.includes("hauska-engine");

describe("diffRails", () => {
  const effectiveDeclaration = buildEffectiveCountyRailDeclaration({
    fileExists: mockExists,
    requireEngineRoot: false,
  });

  it("finds no diffs when live rows exactly match the effective declaration", () => {
    const live = effectiveDeclaration.map((d) =>
      liveRow({
        rail_key: d.railKey,
        display_name: d.displayName,
        ordinal: d.ordinal,
        rail_letter: d.railLetter,
        kind: d.kind,
        threshold_pct: d.thresholdPct.toFixed(2),
        atom_family_state: d.atomFamilyState,
        atom_family_ref: d.atomFamilyRef,
        has_writer: d.hasWriter,
        writer_ref: d.writerRef,
        declared_source: d.declaredSource,
        notes: d.notes,
      }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const diffs = diffRails(live as any, effectiveDeclaration);
    expect(diffs).toEqual([]);
  });

  it("reports an UPDATE when a live row's atomFamilyState is stale", () => {
    const decl = effectiveDeclaration.find((d) => d.railKey === "geometry")!;
    const live = [
      liveRow({
        rail_key: "geometry",
        display_name: decl.displayName,
        ordinal: decl.ordinal,
        rail_letter: decl.railLetter,
        kind: decl.kind,
        threshold_pct: decl.thresholdPct.toFixed(2),
        atom_family_state: "missing",
        atom_family_ref: null,
        has_writer: decl.hasWriter,
        writer_ref: decl.writerRef,
        declared_source: decl.declaredSource,
        notes: "stale note",
      }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const diffs = diffRails(live as any, [decl]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].kind).toBe("update");
    expect(diffs[0].fields.find((f) => f.column === "atomFamilyState")).toEqual({
      column: "atomFamilyState",
      live: "missing",
      declared: "present",
    });
  });

  it("reports a DELETE for join rail absent from declaration", () => {
    const live = [
      liveRow({
        rail_key: "join",
        display_name: "Join quality",
        ordinal: 3,
        kind: "spine",
        threshold_pct: "95.00",
        atom_family_state: "missing",
        has_writer: true,
        declared_source: "Derived",
      }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const diffs = diffRails(live as any, []);
    expect(diffs[0].kind).toBe("delete");
    expect(diffs[0].railKey).toBe("join");
  });

  it("reports an INSERT for a declared rail_key absent from live table", () => {
    const decl = effectiveDeclaration.find((d) => d.railKey === "footprint")!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const diffs = diffRails([] as any, [decl]);
    expect(diffs[0].kind).toBe("insert");
    expect(diffs[0].railKey).toBe("footprint");
  });
});
