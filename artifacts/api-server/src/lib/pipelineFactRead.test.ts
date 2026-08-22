/**
 * Dual-grammar rrc-pipeline-fact bind + interpret. No store.
 *
 * Snapshot / texas-rrc GIS values are out of this file on purpose: this
 * module must yield an atom determination when a fixture row exists, and
 * refuse with a named miss when it does not. place_layer_snapshots,
 * cad_property, texas-rrc, and tx_rrc_pipeline are not sources.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  interpretPipelineFactRows,
  loadPipelineFactAtom,
  memoryPipelineFactAtoms,
  pipelineFactBindKeys,
  resetPipelineFactAtomQueryableForTests,
  setPipelineFactAtomQueryableForTests,
} from "./pipelineFactRead";

const GOLD = "48021:34137";
const GOLD_PADDED = "48021:34137.00000000";
const NEAR = "48021:10048";
const NEAR_PADDED = "48021:10048.00000000";

const GOLD_OUTSIDE_BODY = {
  entityType: "rrc-pipeline-fact",
  atomDid: "pipefact_4802134137aaaaaa",
  parcelNodeId: GOLD,
  sourceTier: "rrc-public-gis",
  nearPipeline: false,
  bufferMeters: 152.4,
  sourceAdapter: "tx-rrc-pipeline-staged-v1",
  evaluatedAt: "2026-08-12T14:20:00.000Z",
};

const NEAR_BODY = {
  entityType: "rrc-pipeline-fact",
  atomDid: "pipefact_4802110048aaaaaa",
  parcelNodeId: NEAR,
  sourceTier: "rrc-public-gis",
  nearPipeline: true,
  bufferMeters: 152.4,
  nearestPipelineDistanceMeters: 87.9,
  t4permit: "05781",
  p5Num: "252017",
  operatorName: "ENERGY TRANSFER COMPANY",
  systemName: "PRAIRIE LEA",
  commodity: "NATURAL GAS",
  sourceAdapter: "tx-rrc-pipeline-staged-v1",
  evaluatedAt: "2026-08-12T14:20:00.000Z",
};

afterEach(() => {
  resetPipelineFactAtomQueryableForTests();
});

describe("pipelineFactBindKeys — dual grammar on parcel keys only", () => {
  it("returns integer then padded for an integer inbound id", () => {
    expect(pipelineFactBindKeys(GOLD)).toEqual([GOLD, GOLD_PADDED]);
  });

  it("inverts a padded inbound id to the same pair", () => {
    expect(pipelineFactBindKeys(GOLD_PADDED)).toEqual([GOLD, GOLD_PADDED]);
  });

  it("never collapses to one key and never appends a pipeline id", () => {
    const keys = pipelineFactBindKeys("48021:10048");
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toBe("48021:10048");
    expect(keys[1]).toBe("48021:10048.00000000");
    expect(keys.join("|")).not.toContain(":sd:");
    expect(keys.join("|")).not.toContain("05781");
  });
});

describe("interpretPipelineFactRows", () => {
  it("serves a nearby finding stored on the integer key", () => {
    const read = interpretPipelineFactRows(NEAR, [
      { entity_id: NEAR, body: NEAR_BODY },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.source).toBe("rrc-pipeline-fact");
    expect(read.boundAs).toBe(NEAR);
    expect(read.tried).toEqual([NEAR, NEAR_PADDED]);
    expect(read.entityId).toBe(NEAR);
    expect(read.nearPipeline).toBe(true);
    expect(read.t4permit).toBe("05781");
    expect(read.p5Num).toBe("252017");
    expect(read.operatorName).toBe("ENERGY TRANSFER COMPANY");
    expect(read.systemName).toBe("PRAIRIE LEA");
    expect(read.commodity).toBe("NATURAL GAS");
    expect(read.nearestPipelineDistanceMeters).toBe(87.9);
    expect(read.bufferMeters).toBe(152.4);
  });

  it("serves a nearby finding stored only on the padded key (dual-grammar hit)", () => {
    const read = interpretPipelineFactRows(NEAR, [
      {
        entity_id: NEAR_PADDED,
        body: { ...NEAR_BODY, parcelNodeId: NEAR_PADDED },
      },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.boundAs).toBe(NEAR_PADDED);
    expect(read.nearPipeline).toBe(true);
    expect(read.t4permit).toBe("05781");
  });

  it("serves gold 48021:34137 outside-buffer as present, not a fabricated nearby pipeline", () => {
    const read = interpretPipelineFactRows(GOLD, [
      { entity_id: GOLD, body: GOLD_OUTSIDE_BODY },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.source).toBe("rrc-pipeline-fact");
    expect(read.nearPipeline).toBe(false);
    expect(read.t4permit).toBeNull();
    expect(read.operatorName).toBeNull();
    expect(read.systemName).toBeNull();
    expect(read.nearestPipelineDistanceMeters).toBeNull();
    expect(read.bufferMeters).toBe(152.4);
    expect(read.entityId).toBe(GOLD);
  });

  it("fails closed with atom-miss when both grammars are empty — never a silent null and never invented nearPipeline=false", () => {
    const read = interpretPipelineFactRows(GOLD, []);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("atom-miss");
    expect(read.tried).toEqual([GOLD, GOLD_PADDED]);
    expect(read.reason).toContain(GOLD);
    expect(read.reason).toContain(GOLD_PADDED);
    expect(read.reason.toLowerCase()).toContain("atom miss");
    expect(read).not.toHaveProperty("nearPipeline");
  });

  it("serves when both grammars hit and the claims agree", () => {
    const read = interpretPipelineFactRows(NEAR, [
      { entity_id: NEAR, body: NEAR_BODY },
      {
        entity_id: NEAR_PADDED,
        body: { ...NEAR_BODY, parcelNodeId: NEAR_PADDED },
      },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.boundAs).toBe(NEAR);
    expect(read.t4permit).toBe("05781");
  });

  it("fails closed with bind-conflict when both grammars hit and the claims disagree", () => {
    const read = interpretPipelineFactRows(NEAR, [
      { entity_id: NEAR, body: NEAR_BODY },
      {
        entity_id: NEAR_PADDED,
        body: {
          ...NEAR_BODY,
          parcelNodeId: NEAR_PADDED,
          t4permit: "99999",
        },
      },
    ]);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("bind-conflict");
    expect(read.tried).toEqual([NEAR, NEAR_PADDED]);
  });

  it("serves typed absence as absence, not as a miss and not as nearPipeline=false", () => {
    const read = interpretPipelineFactRows("48021:99999", [
      {
        entity_id: "48021:99999",
        body: {
          entityType: "rrc-pipeline-fact",
          sourceTier: "rrc-public-gis",
          absence: {
            kind: "no-parcel-geometry",
            reason: "no usable parcel ring geometry for 48021:99999",
          },
        },
      },
    ]);
    expect(read.state).toBe("absent");
    if (read.state !== "absent") return;
    expect(read.absence?.kind).toBe("no-parcel-geometry");
    expect(read).not.toHaveProperty("nearPipeline");
  });

  it("refuses a body that is neither a present finding nor an absence", () => {
    const read = interpretPipelineFactRows(GOLD, [
      { entity_id: GOLD, body: { entityType: "rrc-pipeline-fact" } },
    ]);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("malformed-atom");
  });

  it("does not copy GIS / snapshot pipeline field names onto pipelineFact from a non-atom body", () => {
    const read = interpretPipelineFactRows(GOLD, [
      {
        entity_id: GOLD,
        body: {
          entityType: "rrc-pipeline-fact",
          nearPipeline: false,
          bufferMeters: 152.4,
        },
      },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read).not.toHaveProperty("P5_NUM");
    expect(read).not.toHaveProperty("OPER_NM");
    expect(read).not.toHaveProperty("SYS_NM");
    expect(read.source).toBe("rrc-pipeline-fact");
  });
});

describe("loadPipelineFactAtom — store seam", () => {
  it("refuses as atoms-store-not-configured when the queryable is null", async () => {
    setPipelineFactAtomQueryableForTests(null);
    const read = await loadPipelineFactAtom(GOLD);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("atoms-store-not-configured");
    expect(read.reason).toContain("ATOMS_DATABASE_URL");
    expect(read.reason).toMatch(/place_layer_snapshots|texas-rrc/);
  });

  it("yields a value when a fixture atom exists", async () => {
    setPipelineFactAtomQueryableForTests(
      memoryPipelineFactAtoms([{ entityId: NEAR_PADDED, body: NEAR_BODY }]),
    );
    const read = await loadPipelineFactAtom(NEAR);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.nearPipeline).toBe(true);
    expect(read.t4permit).toBe("05781");
    expect(read.source).toBe("rrc-pipeline-fact");
    expect(read.boundAs).toBe(NEAR_PADDED);
  });

  it("the memory fake refuses a place_layer_snapshots query", async () => {
    const fake = memoryPipelineFactAtoms([]);
    await expect(
      fake.query("SELECT payload_json FROM place_layer_snapshots WHERE place_key = $1", [
        "node:48021:34137",
      ]),
    ).rejects.toThrow(/place_layer_snapshots/);
  });

  it("the memory fake refuses a cad_property query", async () => {
    const fake = memoryPipelineFactAtoms([]);
    await expect(
      fake.query("SELECT * FROM cad_property WHERE parcel_id = $1", ["48021:10048"]),
    ).rejects.toThrow(/cad_property/);
  });

  it("the memory fake refuses a texas-rrc GIS query", async () => {
    const fake = memoryPipelineFactAtoms([]);
    await expect(
      fake.query("SELECT geom FROM texas-rrc WHERE layer = $1", ["pipeline"]),
    ).rejects.toThrow(/texas-rrc/);
  });

  it("the memory fake refuses a tx_rrc_pipeline query", async () => {
    const fake = memoryPipelineFactAtoms([]);
    await expect(
      fake.query("SELECT t4permit FROM tx_rrc_pipeline WHERE county_fips = $1", [
        "48021",
      ]),
    ).rejects.toThrow(/tx_rrc_pipeline/);
  });

  it("the memory fake refuses a special-district :sd: picker query", async () => {
    const fake = memoryPipelineFactAtoms([]);
    await expect(
      fake.query(
        "SELECT entity_id, body FROM atoms WHERE entity_type = $1 AND entity_id LIKE $2 ESCAPE '\\' AND entity_id LIKE '%:sd:%'",
        ["rrc-pipeline-fact", "48021:10048:sd:%"],
      ),
    ).rejects.toThrow(/:sd:/);
  });
});

describe("pipelineFactRead source does not name the retired store", () => {
  it("the SELECT binds by ANY parcel keys and does not read bake/CAD/GIS", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "pipelineFactRead.ts"), "utf8");
    expect(src).not.toMatch(/FROM\s+cad_property/i);
    expect(src).not.toMatch(/FROM\s+place_layer_snapshots/i);
    expect(src).not.toMatch(/FROM\s+texas-rrc/i);
    expect(src).not.toMatch(/FROM\s+tx_rrc_pipeline/i);
    expect(src).not.toMatch(/ST_DWithin/i);
    const select = src.match(/const SELECT_PIPELINE_FACT = `([\s\S]*?)`;/)?.[1];
    expect(select).toBeTruthy();
    expect(select).toMatch(/FROM atoms/);
    expect(select).toMatch(/entity_type = \$1/);
    expect(select).toMatch(/entity_id = ANY\(\$2::text\[\]\)/);
    expect(select).not.toMatch(/LIKE/);
    expect(select).not.toMatch(/:sd:/);
  });
});
