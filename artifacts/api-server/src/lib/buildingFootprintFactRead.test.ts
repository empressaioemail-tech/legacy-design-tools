/**
 * Dual-grammar building-footprint bind + interpret. No store.
 *
 * Snapshot / CAD / GIS / tx_building_footprint values are out of this file
 * on purpose. :primary is a writer slot, not identity — structureRole
 * comes from the body.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  interpretBuildingFootprintFactRows,
  loadBuildingFootprintFactAtom,
  memoryBuildingFootprintFactAtoms,
  resetBuildingFootprintFactAtomQueryableForTests,
  setBuildingFootprintFactAtomQueryableForTests,
  buildingFootprintFactBindPrefixes,
  buildingFootprintFactPrefixRanges,
} from "./buildingFootprintFactRead";

const GOLD = "48021:34137";
const GOLD_PADDED = "48021:34137.00000000";
const ANDERSON = "48001:10136";
const ANDERSON_PADDED = "48001:10136.00000000";
const ANDERSON_PRIMARY = "48001:10136.00000000:footprint:primary";
const ANDERSON_ACCESSORY = "48001:10136.00000000:footprint:accessory-1";
const ANDREWS = "48003:10007";
const ANDREWS_PRIMARY = "48003:10007:footprint:primary";
const ABSENT = "48001:10001";
const ABSENT_KEY = "48001:10001.00000000:footprint:primary";

const RING: Array<[number, number]> = [
  [-95.0, 31.0],
  [-95.0, 31.001],
  [-94.999, 31.001],
  [-94.999, 31.0],
  [-95.0, 31.0],
];

const ANDERSON_PRIMARY_BODY = {
  entityType: "building-footprint",
  atomDid: "bfoot_4800110136aaaaaaaa",
  parcelNodeId: ANDERSON_PADDED,
  footprintId: "primary",
  structureRole: "primary",
  sourceTier: "ml-derived",
  verificationStatus: "unsurveyed",
  footprintGeometry: { type: "Polygon", coordinates: [RING] },
  sourceAdapter: "ml-global-building-footprints-v1",
  sourceVintage: "GlobalMLBuildingFootprints-Texas",
  evaluatedAt: "2026-08-16T10:45:43.182Z",
};

const ANDERSON_ACCESSORY_BODY = {
  entityType: "building-footprint",
  parcelNodeId: ANDERSON_PADDED,
  footprintId: "accessory-1",
  structureRole: "primary",
  sourceTier: "ml-derived",
  verificationStatus: "unsurveyed",
  footprintGeometry: { type: "Polygon", coordinates: [RING] },
  sourceAdapter: "ml-global-building-footprints-v1",
};

const ANDREWS_BODY = {
  entityType: "building-footprint",
  parcelNodeId: ANDREWS,
  footprintId: "primary",
  structureRole: "primary",
  sourceTier: "ml-derived",
  footprintGeometry: { type: "Polygon", coordinates: [RING] },
  sourceAdapter: "ml-global-building-footprints-v1",
};

const ABSENT_BODY = {
  entityType: "building-footprint",
  parcelNodeId: "48001:10001.00000000",
  footprintId: "primary",
  sourceTier: "ml-derived",
  absence: {
    kind: "no-footprint-feature",
    reason:
      "staged-geometry-true-join-below-10pct-overlap-threshold — no qualifying staged footprint for parcel",
  },
  sourceAdapter: "ml-global-building-footprints-v1",
};

afterEach(() => {
  resetBuildingFootprintFactAtomQueryableForTests();
});

describe("buildingFootprintFactBindPrefixes — dual grammar on parcel prefixes only", () => {
  it("returns integer then padded for an integer inbound id", () => {
    expect(buildingFootprintFactBindPrefixes(ANDERSON)).toEqual([
      ANDERSON,
      ANDERSON_PADDED,
    ]);
  });

  it("inverts a padded inbound id to the same pair", () => {
    expect(buildingFootprintFactBindPrefixes(ANDERSON_PADDED)).toEqual([
      ANDERSON,
      ANDERSON_PADDED,
    ]);
  });

  it("never collapses to one prefix and never appends :footprint: or :primary or :sd:", () => {
    const prefixes = buildingFootprintFactBindPrefixes("48001:10136");
    expect(prefixes).toHaveLength(2);
    expect(new Set(prefixes).size).toBe(2);
    expect(prefixes[0]).toBe("48001:10136");
    expect(prefixes[1]).toBe("48001:10136.00000000");
    expect(prefixes.join("|")).not.toContain(":sd:");
    expect(prefixes.join("|")).not.toContain(":footprint:");
    expect(prefixes.join("|")).not.toContain("primary");
  });

  it("builds prefix-range bounds that close on the writer suffix", () => {
    const ranges = buildingFootprintFactPrefixRanges(
      buildingFootprintFactBindPrefixes(ANDERSON),
    );
    expect(ranges.integerStart).toBe("48001:10136:");
    expect(ranges.integerEnd).toBe("48001:10136;");
    expect(ranges.paddedStart).toBe("48001:10136.00000000:");
    expect(ranges.paddedEnd).toBe("48001:10136.00000000;");
  });
});

describe("interpretBuildingFootprintFactRows", () => {
  it("serves Anderson 48001:10136 as present from the writer key and body.structureRole", () => {
    const read = interpretBuildingFootprintFactRows(ANDERSON, [
      { entity_id: ANDERSON_PRIMARY, body: ANDERSON_PRIMARY_BODY },
      { entity_id: ANDERSON_ACCESSORY, body: ANDERSON_ACCESSORY_BODY },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.source).toBe("building-footprint");
    expect(read.boundAs).toBe(ANDERSON_PRIMARY);
    expect(read.tried).toEqual([ANDERSON, ANDERSON_PADDED]);
    expect(read.entityId).toBe(ANDERSON_PRIMARY);
    expect(read.footprintId).toBe("primary");
    expect(read.structureRole).toBe("primary");
    expect(read.sourceTier).toBe("ml-derived");
    expect(read.verificationStatus).toBe("unsurveyed");
    expect(read.footprintGeometry?.type).toBe("Polygon");
    expect(read.footprints).toHaveLength(2);
    expect(read.sourceAdapter).toBe("ml-global-building-footprints-v1");
    expect(JSON.stringify(read)).not.toContain("GIS-MUST-NOT-LEAK");
  });

  it("reads structureRole from the body when the entity_id slot is accessory-1 (live Anderson shape)", () => {
    const read = interpretBuildingFootprintFactRows(ANDERSON, [
      { entity_id: ANDERSON_ACCESSORY, body: ANDERSON_ACCESSORY_BODY },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.entityId).toBe(ANDERSON_ACCESSORY);
    expect(read.footprintId).toBe("accessory-1");
    expect(read.structureRole).toBe("primary");
    expect(read.structureRole).not.toBe("accessory");
  });

  it("fails if :primary is parsed as identity — body.structureRole=accessory wins", () => {
    const read = interpretBuildingFootprintFactRows(ANDERSON, [
      {
        entity_id: ANDERSON_PRIMARY,
        body: {
          ...ANDERSON_PRIMARY_BODY,
          structureRole: "accessory",
        },
      },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.structureRole).toBe("accessory");
    expect(read.footprintId).toBe("primary");
    expect(read.entityId).toBe(ANDERSON_PRIMARY);
  });

  it("serves Andrews integer grammar 48003:10007 as present", () => {
    const read = interpretBuildingFootprintFactRows(ANDREWS, [
      { entity_id: ANDREWS_PRIMARY, body: ANDREWS_BODY },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.boundAs).toBe(ANDREWS_PRIMARY);
    expect(read.structureRole).toBe("primary");
    expect(read.source).toBe("building-footprint");
  });

  it("serves a nearby finding stored only on the padded prefix (dual-grammar hit)", () => {
    const read = interpretBuildingFootprintFactRows(ANDERSON, [
      { entity_id: ANDERSON_PRIMARY, body: ANDERSON_PRIMARY_BODY },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.boundAs).toBe(ANDERSON_PRIMARY);
    expect(read.structureRole).toBe("primary");
  });

  it("fails closed with atom-miss when both prefixes are empty — never a silent null and never invented absence", () => {
    const read = interpretBuildingFootprintFactRows(GOLD, []);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("atom-miss");
    expect(read.tried).toEqual([GOLD, GOLD_PADDED]);
    expect(read.reason).toContain(GOLD);
    expect(read.reason).toContain(GOLD_PADDED);
    expect(read.reason.toLowerCase()).toContain("atom miss");
    expect(read).not.toHaveProperty("structureRole");
    expect(read).not.toHaveProperty("footprintId");
    expect(read).not.toHaveProperty("absence");
  });

  it("serves typed :footprint:primary absence as absence, not as a present structure", () => {
    const read = interpretBuildingFootprintFactRows(ABSENT, [
      { entity_id: ABSENT_KEY, body: ABSENT_BODY },
    ]);
    expect(read.state).toBe("absent");
    if (read.state !== "absent") return;
    expect(read.source).toBe("building-footprint");
    expect(read.entityId).toBe(ABSENT_KEY);
    expect(read.absence?.kind).toBe("no-footprint-feature");
    expect(read.structureRole).toBeNull();
    expect(read.footprintId).toBe("primary");
    expect(read).not.toHaveProperty("footprintGeometry");
  });

  it("fails closed with bind-conflict when both prefixes hit and the footprintId sets disagree", () => {
    const read = interpretBuildingFootprintFactRows(ANDERSON, [
      { entity_id: ANDERSON_PRIMARY, body: ANDERSON_PRIMARY_BODY },
      {
        entity_id: "48001:10136:footprint:primary",
        body: {
          ...ANDERSON_PRIMARY_BODY,
          parcelNodeId: ANDERSON,
          footprintId: "other-slot",
        },
      },
    ]);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("bind-conflict");
    expect(read.tried).toEqual([ANDERSON, ANDERSON_PADDED]);
  });

  it("serves when both prefixes hit and the footprintId sets agree", () => {
    const read = interpretBuildingFootprintFactRows(ANDERSON, [
      {
        entity_id: "48001:10136:footprint:primary",
        body: { ...ANDERSON_PRIMARY_BODY, parcelNodeId: ANDERSON },
      },
      { entity_id: ANDERSON_PRIMARY, body: ANDERSON_PRIMARY_BODY },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.structureRole).toBe("primary");
    expect(read.source).toBe("building-footprint");
  });

  it("refuses a body that is neither a present finding nor an absence", () => {
    const read = interpretBuildingFootprintFactRows(ANDERSON, [
      { entity_id: ANDERSON_PRIMARY, body: { entityType: "building-footprint" } },
    ]);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("malformed-atom");
  });

  it("does not copy GIS / snapshot field names onto buildingFootprintFact from a non-atom body", () => {
    const read = interpretBuildingFootprintFactRows(ANDERSON, [
      { entity_id: ANDERSON_PRIMARY, body: ANDERSON_PRIMARY_BODY },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read).not.toHaveProperty("bldg_type");
    expect(read).not.toHaveProperty("FOOTPRINT");
    expect(read.source).toBe("building-footprint");
  });
});

describe("loadBuildingFootprintFactAtom — store seam", () => {
  it("refuses as atoms-store-not-configured when the queryable is null", async () => {
    setBuildingFootprintFactAtomQueryableForTests(null);
    const read = await loadBuildingFootprintFactAtom(GOLD);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("atoms-store-not-configured");
    expect(read.reason).toContain("ATOMS_DATABASE_URL");
    expect(read.reason).toMatch(/place_layer_snapshots|tx_building_footprint|GIS/);
  });

  it("yields a value when a fixture atom exists", async () => {
    setBuildingFootprintFactAtomQueryableForTests(
      memoryBuildingFootprintFactAtoms([
        { entityId: ANDERSON_PRIMARY, body: ANDERSON_PRIMARY_BODY },
      ]),
    );
    const read = await loadBuildingFootprintFactAtom(ANDERSON);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.structureRole).toBe("primary");
    expect(read.source).toBe("building-footprint");
    expect(read.boundAs).toBe(ANDERSON_PRIMARY);
  });

  it("the memory fake refuses a place_layer_snapshots query", async () => {
    const fake = memoryBuildingFootprintFactAtoms([]);
    await expect(
      fake.query("SELECT payload_json FROM place_layer_snapshots WHERE place_key = $1", [
        "node:48021:34137",
      ]),
    ).rejects.toThrow(/place_layer_snapshots/);
  });

  it("the memory fake refuses a cad_property query", async () => {
    const fake = memoryBuildingFootprintFactAtoms([]);
    await expect(
      fake.query("SELECT * from cad_property WHERE parcel_id = $1", ["48001:10136"]),
    ).rejects.toThrow(/cad_property/);
  });

  it("the memory fake refuses a tx_building_footprint query", async () => {
    const fake = memoryBuildingFootprintFactAtoms([]);
    await expect(
      fake.query("SELECT geom FROM tx_building_footprint WHERE county_fips = $1", [
        "48001",
      ]),
    ).rejects.toThrow(/tx_building_footprint/);
  });

  it("the memory fake refuses a GIS query", async () => {
    const fake = memoryBuildingFootprintFactAtoms([]);
    await expect(
      fake.query("SELECT geom FROM footprints_GIS WHERE parcel = $1", [ANDERSON]),
    ).rejects.toThrow(/GIS/);
  });

  it("the memory fake refuses a query that parses :primary as identity", async () => {
    const fake = memoryBuildingFootprintFactAtoms([]);
    await expect(
      fake.query(
        "SELECT entity_id, split_part(entity_id, ':', 4) AS structure_role FROM atoms WHERE entity_id LIKE '%:primary'",
        [],
      ),
    ).rejects.toThrow(/:primary|split_part/);
  });

  it("the memory fake refuses a special-district :sd: picker query", async () => {
    const fake = memoryBuildingFootprintFactAtoms([]);
    await expect(
      fake.query(
        "SELECT entity_id, body FROM atoms WHERE entity_type = $1 AND entity_id LIKE $2 ESCAPE '\\' AND entity_id LIKE '%:sd:%'",
        ["building-footprint", "48001:10136:sd:%"],
      ),
    ).rejects.toThrow(/:sd:/);
  });

  it("the memory fake refuses a pipeline-style ANY(bare parcel) query", async () => {
    const fake = memoryBuildingFootprintFactAtoms([]);
    await expect(
      fake.query(
        "SELECT entity_id, body FROM atoms WHERE entity_type = $1 AND entity_id = ANY($2::text[])",
        ["building-footprint", [ANDERSON, ANDERSON_PADDED]],
      ),
    ).rejects.toThrow(/ANY/);
  });
});

describe("buildingFootprintFactRead source does not name the retired store", () => {
  it("the SELECT binds by prefix-range and does not read bake/CAD/GIS or parse :primary", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "buildingFootprintFactRead.ts"), "utf8");
    expect(src).not.toMatch(/FROM\s+cad_property/i);
    expect(src).not.toMatch(/FROM\s+place_layer_snapshots/i);
    expect(src).not.toMatch(/FROM\s+tx_building_footprint/i);
    expect(src).not.toMatch(/ST_Intersects/i);
    expect(src).not.toMatch(/ST_DWithin/i);
    const select = src.match(
      /const SELECT_BUILDING_FOOTPRINT_FACT = `([\s\S]*?)`;/,
    )?.[1];
    expect(select).toBeTruthy();
    expect(select).toMatch(/FROM atoms/);
    expect(select).toMatch(/entity_type = \$1/);
    expect(select).toMatch(/entity_id >= \$2/);
    expect(select).toMatch(/entity_id < \$3/);
    expect(select).not.toMatch(/LIKE/);
    expect(select).not.toMatch(/:sd:/);
    expect(select).not.toMatch(/:primary/);
    expect(select).not.toMatch(/split_part/);
    expect(select).not.toMatch(/entity_id = ANY/);
  });
});
