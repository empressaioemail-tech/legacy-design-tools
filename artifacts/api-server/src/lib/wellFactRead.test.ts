/**
 * Dual-grammar well-fact bind + interpret. No store.
 *
 * Snapshot / texas-rrc GIS / tx_rrc_well values are out of this file on
 * purpose: this module must yield an atom determination when a fixture
 * row exists, and refuse with a named miss when it does not.
 * place_layer_snapshots, cad_property, texas-rrc, and tx_rrc_well are
 * not sources. The :sd: picker is not this bind.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  interpretWellFactRows,
  loadWellFactAtom,
  memoryWellFactAtoms,
  resetWellFactAtomQueryableForTests,
  setWellFactAtomQueryableForTests,
  wellFactBindPrefixes,
  wellFactPrefixRanges,
} from "./wellFactRead";

const GOLD = "48021:34137";
const GOLD_PADDED = "48021:34137.00000000";
const CRANE = "48103:100";
const CRANE_PADDED = "48103:100.00000000";
const CRANE_LEAD = "48103:100:42000001030000";
const CRANE_LEAD_PADDED = "48103:100.00000000:42000001030000";
const CRANE_GAS = "48103:100:42103032270000";
const CRANE_NEAR = "48103:100:42103319250000";
const ABSENT = "48103:104";
const ABSENT_NONE = "48103:104:none";

const CRANE_LEAD_BODY = {
  entityType: "well-fact",
  atomDid: "wlfact_48103100aaaaaaaa",
  parcelNodeId: CRANE,
  wellKey: "42000001030000",
  apiNumber14: "42000001030000",
  wellStatus: "dry",
  wellType: "unknown",
  orphaned: false,
  parcelRelation: "on-parcel",
  proximityRadiusMeters: 152,
  surfaceLocation: { lat: 31.48020694, lng: -102.75930581 },
  sourceTier: "texas-rrc-gis",
  sourceAdapter: "tx-rrc-well-staged-v1",
  evaluatedAt: "2026-08-16T09:57:36.576Z",
};

const CRANE_GAS_BODY = {
  entityType: "well-fact",
  parcelNodeId: CRANE,
  wellKey: "42103032270000",
  apiNumber14: "42103032270000",
  wellStatus: "plugged-abandoned",
  wellType: "gas",
  orphaned: true,
  parcelRelation: "on-parcel",
  proximityRadiusMeters: 152,
  sourceAdapter: "tx-rrc-well-staged-v1",
};

const CRANE_NEAR_BODY = {
  entityType: "well-fact",
  parcelNodeId: CRANE,
  wellKey: "42103319250000",
  apiNumber14: "42103319250000",
  wellStatus: "producing",
  wellType: "unknown",
  orphaned: false,
  parcelRelation: "near-parcel",
  proximityRadiusMeters: 152,
  proximityDistanceMeters: 145.80968829918092,
  sourceAdapter: "tx-rrc-well-staged-v1",
};

const ABSENT_BODY = {
  entityType: "well-fact",
  parcelNodeId: ABSENT,
  wellKey: "none",
  sourceTier: "texas-rrc-gis",
  absence: {
    kind: "no-well-on-or-near",
    reason: "no Texas RRC surface well on or within 152 m of parcel geometry",
  },
  proximityRadiusMeters: 152,
  sourceAdapter: "tx-rrc-well-staged-v1",
};

afterEach(() => {
  resetWellFactAtomQueryableForTests();
});

describe("wellFactBindPrefixes — dual grammar on parcel prefixes only", () => {
  it("returns integer then padded for an integer inbound id", () => {
    expect(wellFactBindPrefixes(CRANE)).toEqual([CRANE, CRANE_PADDED]);
  });

  it("inverts a padded inbound id to the same pair", () => {
    expect(wellFactBindPrefixes(CRANE_PADDED)).toEqual([CRANE, CRANE_PADDED]);
  });

  it("never collapses to one prefix and never appends a well id or :sd:", () => {
    const prefixes = wellFactBindPrefixes("48103:100");
    expect(prefixes).toHaveLength(2);
    expect(new Set(prefixes).size).toBe(2);
    expect(prefixes[0]).toBe("48103:100");
    expect(prefixes[1]).toBe("48103:100.00000000");
    expect(prefixes.join("|")).not.toContain(":sd:");
    expect(prefixes.join("|")).not.toContain("42000001030000");
  });

  it("builds prefix-range bounds that close on the wellKey suffix", () => {
    const ranges = wellFactPrefixRanges(wellFactBindPrefixes(CRANE));
    expect(ranges.integerStart).toBe("48103:100:");
    expect(ranges.integerEnd).toBe("48103:100;");
    expect(ranges.paddedStart).toBe("48103:100.00000000:");
    expect(ranges.paddedEnd).toBe("48103:100.00000000;");
  });
});

describe("interpretWellFactRows", () => {
  it("serves Crane 48103:100 on-parcel as present from the writer key", () => {
    const read = interpretWellFactRows(CRANE, [
      { entity_id: CRANE_LEAD, body: CRANE_LEAD_BODY },
      { entity_id: CRANE_GAS, body: CRANE_GAS_BODY },
      { entity_id: CRANE_NEAR, body: CRANE_NEAR_BODY },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.source).toBe("well-fact");
    expect(read.boundAs).toBe(CRANE_LEAD);
    expect(read.tried).toEqual([CRANE, CRANE_PADDED]);
    expect(read.entityId).toBe(CRANE_LEAD);
    expect(read.wellKey).toBe("42000001030000");
    expect(read.apiNumber14).toBe("42000001030000");
    expect(read.wellStatus).toBe("dry");
    expect(read.wellType).toBe("unknown");
    expect(read.orphaned).toBe(false);
    expect(read.operatorName).toBeNull();
    expect(read.parcelRelation).toBe("on-parcel");
    expect(read.proximityRadiusMeters).toBe(152);
    expect(read.proximityDistanceMeters).toBeNull();
    expect(read.wells).toHaveLength(3);
    expect(JSON.stringify(read)).not.toContain("t4permit");
    expect(JSON.stringify(read)).not.toContain("p5Num");
    expect(JSON.stringify(read)).not.toContain("systemName");
    expect(JSON.stringify(read)).not.toContain("commodity");
    expect(JSON.stringify(read)).not.toContain("nearPipeline");
  });

  it("serves a nearby finding stored only on the padded prefix (dual-grammar hit)", () => {
    const read = interpretWellFactRows(CRANE, [
      {
        entity_id: CRANE_LEAD_PADDED,
        body: { ...CRANE_LEAD_BODY, parcelNodeId: CRANE_PADDED },
      },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.boundAs).toBe(CRANE_LEAD_PADDED);
    expect(read.parcelRelation).toBe("on-parcel");
    expect(read.apiNumber14).toBe("42000001030000");
  });

  it("fails closed with atom-miss when both prefixes are empty — never a silent null and never invented :none", () => {
    const read = interpretWellFactRows(GOLD, []);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("atom-miss");
    expect(read.tried).toEqual([GOLD, GOLD_PADDED]);
    expect(read.reason).toContain(GOLD);
    expect(read.reason).toContain(GOLD_PADDED);
    expect(read.reason.toLowerCase()).toContain("atom miss");
    expect(read).not.toHaveProperty("apiNumber14");
    expect(read).not.toHaveProperty("parcelRelation");
  });

  it("serves typed :none absence as absence, not as a miss and not as a fabricated well", () => {
    const read = interpretWellFactRows(ABSENT, [
      { entity_id: ABSENT_NONE, body: ABSENT_BODY },
    ]);
    expect(read.state).toBe("absent");
    if (read.state !== "absent") return;
    expect(read.source).toBe("well-fact");
    expect(read.entityId).toBe(ABSENT_NONE);
    expect(read.absence?.kind).toBe("no-well-on-or-near");
    expect(read).not.toHaveProperty("apiNumber14");
    expect(read).not.toHaveProperty("parcelRelation");
  });

  it("fails closed with bind-conflict when both prefixes hit and the wellKey sets disagree", () => {
    const read = interpretWellFactRows(CRANE, [
      { entity_id: CRANE_LEAD, body: CRANE_LEAD_BODY },
      {
        entity_id: "48103:100.00000000:42999999999999",
        body: {
          ...CRANE_LEAD_BODY,
          parcelNodeId: CRANE_PADDED,
          wellKey: "42999999999999",
          apiNumber14: "42999999999999",
        },
      },
    ]);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("bind-conflict");
    expect(read.tried).toEqual([CRANE, CRANE_PADDED]);
  });

  it("serves when both prefixes hit and the wellKey sets agree", () => {
    const read = interpretWellFactRows(CRANE, [
      { entity_id: CRANE_LEAD, body: CRANE_LEAD_BODY },
      {
        entity_id: CRANE_LEAD_PADDED,
        body: { ...CRANE_LEAD_BODY, parcelNodeId: CRANE_PADDED },
      },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.boundAs).toBe(CRANE_LEAD);
    expect(read.apiNumber14).toBe("42000001030000");
  });

  it("refuses a body that is neither a present finding nor an absence", () => {
    const read = interpretWellFactRows(CRANE, [
      { entity_id: CRANE_LEAD, body: { entityType: "well-fact" } },
    ]);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("malformed-atom");
  });

  it("does not copy GIS / snapshot well field names onto wellFact from a non-atom body", () => {
    const read = interpretWellFactRows(CRANE, [
      { entity_id: CRANE_LEAD, body: CRANE_LEAD_BODY },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read).not.toHaveProperty("API");
    expect(read).not.toHaveProperty("OPER_NM");
    expect(read).not.toHaveProperty("SYMNUM");
    expect(read.source).toBe("well-fact");
  });
});

describe("loadWellFactAtom — store seam", () => {
  it("refuses as atoms-store-not-configured when the queryable is null", async () => {
    setWellFactAtomQueryableForTests(null);
    const read = await loadWellFactAtom(GOLD);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("atoms-store-not-configured");
    expect(read.reason).toContain("ATOMS_DATABASE_URL");
    expect(read.reason).toMatch(/place_layer_snapshots|texas-rrc|tx_rrc_well/);
  });

  it("yields a value when a fixture atom exists", async () => {
    setWellFactAtomQueryableForTests(
      memoryWellFactAtoms([{ entityId: CRANE_LEAD, body: CRANE_LEAD_BODY }]),
    );
    const read = await loadWellFactAtom(CRANE);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.parcelRelation).toBe("on-parcel");
    expect(read.apiNumber14).toBe("42000001030000");
    expect(read.source).toBe("well-fact");
    expect(read.boundAs).toBe(CRANE_LEAD);
  });

  it("the memory fake refuses a place_layer_snapshots query", async () => {
    const fake = memoryWellFactAtoms([]);
    await expect(
      fake.query("SELECT payload_json FROM place_layer_snapshots WHERE place_key = $1", [
        "node:48021:34137",
      ]),
    ).rejects.toThrow(/place_layer_snapshots/);
  });

  it("the memory fake refuses a cad_property query", async () => {
    const fake = memoryWellFactAtoms([]);
    await expect(
      fake.query("SELECT * from cad_property WHERE parcel_id = $1", ["48103:100"]),
    ).rejects.toThrow(/cad_property/);
  });

  it("the memory fake refuses a texas-rrc GIS query", async () => {
    const fake = memoryWellFactAtoms([]);
    await expect(
      fake.query("SELECT geom FROM texas-rrc WHERE layer = $1", ["well"]),
    ).rejects.toThrow(/texas-rrc/);
  });

  it("the memory fake refuses a tx_rrc_well query", async () => {
    const fake = memoryWellFactAtoms([]);
    await expect(
      fake.query("SELECT api FROM tx_rrc_well WHERE county_fips = $1", ["48103"]),
    ).rejects.toThrow(/tx_rrc_well/);
  });

  it("the memory fake refuses a special-district :sd: picker query", async () => {
    const fake = memoryWellFactAtoms([]);
    await expect(
      fake.query(
        "SELECT entity_id, body FROM atoms WHERE entity_type = $1 AND entity_id LIKE $2 ESCAPE '\\' AND entity_id LIKE '%:sd:%'",
        ["well-fact", "48103:100:sd:%"],
      ),
    ).rejects.toThrow(/:sd:/);
  });

  it("the memory fake refuses a pipeline-style ANY(bare parcel) query", async () => {
    const fake = memoryWellFactAtoms([]);
    await expect(
      fake.query(
        "SELECT entity_id, body FROM atoms WHERE entity_type = $1 AND entity_id = ANY($2::text[])",
        ["well-fact", [CRANE, CRANE_PADDED]],
      ),
    ).rejects.toThrow(/ANY/);
  });
});

describe("wellFactRead source does not name the retired store", () => {
  it("the SELECT binds by prefix-range and does not read bake/CAD/GIS/texas-rrc", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "wellFactRead.ts"), "utf8");
    expect(src).not.toMatch(/FROM\s+cad_property/i);
    expect(src).not.toMatch(/FROM\s+place_layer_snapshots/i);
    expect(src).not.toMatch(/FROM\s+texas-rrc/i);
    expect(src).not.toMatch(/FROM\s+tx_rrc_well/i);
    expect(src).not.toMatch(/ST_DWithin/i);
    const select = src.match(/const SELECT_WELL_FACT = `([\s\S]*?)`;/)?.[1];
    expect(select).toBeTruthy();
    expect(select).toMatch(/FROM atoms/);
    expect(select).toMatch(/entity_type = \$1/);
    expect(select).toMatch(/entity_id >= \$2/);
    expect(select).toMatch(/entity_id < \$3/);
    expect(select).not.toMatch(/LIKE/);
    expect(select).not.toMatch(/:sd:/);
    expect(select).not.toMatch(/entity_id = ANY/);
  });
});
