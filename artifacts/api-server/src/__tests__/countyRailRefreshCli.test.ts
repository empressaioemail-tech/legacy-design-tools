import { describe, it, expect } from "vitest";
import { diffRails } from "../countyRailRefreshCli";
import { COUNTY_RAIL_DECLARATION } from "@workspace/db";

/**
 * Unit tests for `diffRails`, the pure diff at the heart of
 * `countyRailRefreshCli.ts`. No DB — these exercise the comparison logic
 * directly against synthetic "live row" fixtures shaped like what
 * `pg.Pool.query` returns for `county_rail` (snake_case columns, numeric
 * columns arriving as strings).
 */

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

describe("diffRails", () => {
  it("finds no diffs when live rows exactly match the declaration", () => {
    // Build live rows that mirror every declared field exactly, one per declared rail.
    const live = COUNTY_RAIL_DECLARATION.map((d) =>
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
    const diffs = diffRails(live as any, COUNTY_RAIL_DECLARATION);
    expect(diffs).toEqual([]);
  });

  it("reports an UPDATE when a live row's atomFamilyState is stale (the geometry defect)", () => {
    const decl = COUNTY_RAIL_DECLARATION.find((d) => d.railKey === "geometry")!;
    const live = [
      liveRow({
        rail_key: "geometry",
        display_name: decl.displayName,
        ordinal: decl.ordinal,
        rail_letter: decl.railLetter,
        kind: decl.kind,
        threshold_pct: decl.thresholdPct.toFixed(2),
        atom_family_state: "missing", // stale — declaration says 'present'
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
    expect(diffs[0].railKey).toBe("geometry");
    expect(diffs[0].kind).toBe("update");
    const stateField = diffs[0].fields.find((f) => f.column === "atomFamilyState");
    expect(stateField).toEqual({
      column: "atomFamilyState",
      live: "missing",
      declared: "present",
    });
  });

  it("reports a DELETE for a live rail_key absent from the declaration (the join-quality removal)", () => {
    const live = [
      liveRow({
        rail_key: "join",
        display_name: "Join quality",
        ordinal: 3,
        rail_letter: null,
        kind: "spine",
        threshold_pct: "95.00",
        atom_family_state: "missing",
        atom_family_ref: null,
        has_writer: true,
        writer_ref: "county_facet_coverage.owner_match_rate",
        declared_source: "Derived",
        notes: null,
      }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const diffs = diffRails(live as any, []);
    expect(diffs).toEqual([
      {
        railKey: "join",
        kind: "delete",
        fields: expect.arrayContaining([
          expect.objectContaining({ column: "hasWriter", live: true, declared: null }),
        ]),
      },
    ]);
  });

  it("reports an INSERT for a declared rail_key absent from the live table", () => {
    const decl = COUNTY_RAIL_DECLARATION.find((d) => d.railKey === "footprint")!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const diffs = diffRails([] as any, [decl]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].railKey).toBe("footprint");
    expect(diffs[0].kind).toBe("insert");
  });
});
