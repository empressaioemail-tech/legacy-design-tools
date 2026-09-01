/**
 * Dual-grammar flood-hazard-fact bind + interpret. No store.
 *
 * Snapshot flood values are out of this file on purpose: this module must
 * yield an atom determination when a fixture row exists, and refuse with a
 * named miss when it does not. place_layer_snapshots is not a source.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  floodHazardFactBindKeys,
  interpretFloodHazardFactRows,
  loadFloodHazardFactAtom,
  memoryFloodHazardAtoms,
  resetFloodHazardAtomQueryableForTests,
  setFloodHazardAtomQueryableForTests,
} from "./floodHazardFactRead";

const GOLD = "48021:34137";
const GOLD_PADDED = "48021:34137.00000000";

const GOLD_PRESENT_BODY = {
  entityType: "flood-hazard-fact",
  atomDid: "fhfact_0123456789abcdef",
  parcelNodeId: GOLD,
  sourceTier: "fema-nfhl",
  inSpecialFloodHazardArea: true,
  floodZone: "AO",
  zoneSubtype: null,
  baseFloodElevation: null,
  sourceAdapter: "fema-nfhl-bulk-v1",
  sourceVintage: "NFHL_48_20260101",
  evaluatedAt: "2026-08-11T23:13:43.774Z",
};

afterEach(() => {
  resetFloodHazardAtomQueryableForTests();
});

describe("floodHazardFactBindKeys — dual grammar (R-07 Q8)", () => {
  it("returns integer then padded for an integer inbound id", () => {
    expect(floodHazardFactBindKeys(GOLD)).toEqual([GOLD, GOLD_PADDED]);
  });

  it("inverts a padded inbound id to the same pair", () => {
    expect(floodHazardFactBindKeys(GOLD_PADDED)).toEqual([GOLD, GOLD_PADDED]);
  });

  it("never collapses to one key", () => {
    const keys = floodHazardFactBindKeys("48021:36521");
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("interpretFloodHazardFactRows", () => {
  it("serves a present finding stored on the integer key", () => {
    const read = interpretFloodHazardFactRows(GOLD, [
      { entity_id: GOLD, body: GOLD_PRESENT_BODY },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.source).toBe("flood-hazard-fact");
    expect(read.boundAs).toBe(GOLD);
    expect(read.tried).toEqual([GOLD, GOLD_PADDED]);
    expect(read.inSpecialFloodHazardArea).toBe(true);
    expect(read.floodZone).toBe("AO");
  });

  it("serves a present finding stored only on the padded key (dual-grammar hit)", () => {
    const read = interpretFloodHazardFactRows(GOLD, [
      {
        entity_id: GOLD_PADDED,
        body: { ...GOLD_PRESENT_BODY, parcelNodeId: GOLD_PADDED },
      },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.boundAs).toBe(GOLD_PADDED);
    expect(read.floodZone).toBe("AO");
  });

  it("fails closed with atom-miss when both grammars are empty — never a silent null", () => {
    const read = interpretFloodHazardFactRows(GOLD, []);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("atom-miss");
    expect(read.tried).toEqual([GOLD, GOLD_PADDED]);
    expect(read.reason).toContain(GOLD);
    expect(read.reason).toContain(GOLD_PADDED);
    expect(read.reason.toLowerCase()).toContain("atom miss");
  });

  it("serves when both grammars hit and the claims agree", () => {
    const read = interpretFloodHazardFactRows(GOLD, [
      { entity_id: GOLD, body: GOLD_PRESENT_BODY },
      {
        entity_id: GOLD_PADDED,
        body: { ...GOLD_PRESENT_BODY, parcelNodeId: GOLD_PADDED },
      },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.boundAs).toBe(GOLD);
    expect(read.floodZone).toBe("AO");
  });

  it("fails closed with bind-conflict when both grammars hit and the claims disagree", () => {
    const read = interpretFloodHazardFactRows(GOLD, [
      { entity_id: GOLD, body: GOLD_PRESENT_BODY },
      {
        entity_id: GOLD_PADDED,
        body: {
          ...GOLD_PRESENT_BODY,
          parcelNodeId: GOLD_PADDED,
          floodZone: "AE",
        },
      },
    ]);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("bind-conflict");
    expect(read.tried).toEqual([GOLD, GOLD_PADDED]);
  });

  it("serves typed absence as absence, not as a miss", () => {
    const read = interpretFloodHazardFactRows("48021:99999", [
      {
        entity_id: "48021:99999",
        body: {
          entityType: "flood-hazard-fact",
          sourceTier: "fema-nfhl",
          absence: {
            kind: "no-flood-coverage",
            reason: "parcel centroid outside NFHL county tile coverage",
          },
        },
      },
    ]);
    expect(read.state).toBe("absent");
    if (read.state !== "absent") return;
    expect(read.absence?.kind).toBe("no-flood-coverage");
    expect(read.sourceVintage).toBeNull();
  });

  it("carries sourceVintage on a typed absence so the draw can earn absent-verified", () => {
    const read = interpretFloodHazardFactRows("48021:99999", [
      {
        entity_id: "48021:99999",
        body: {
          entityType: "flood-hazard-fact",
          sourceTier: "absent",
          absence: {
            kind: "no-flood-coverage",
            reason: "parcel centroid outside NFHL county tile coverage",
          },
          sourceVintage: "NFHL_48_20260101",
        },
      },
    ]);
    expect(read.state).toBe("absent");
    if (read.state !== "absent") return;
    expect(read.sourceVintage).toBe("NFHL_48_20260101");
  });

  it("refuses a body that is neither a present finding nor an absence", () => {
    const read = interpretFloodHazardFactRows(GOLD, [
      { entity_id: GOLD, body: { entityType: "flood-hazard-fact" } },
    ]);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("malformed-atom");
  });
});

describe("loadFloodHazardFactAtom — store seam", () => {
  it("refuses as atoms-store-not-configured when the queryable is null", async () => {
    setFloodHazardAtomQueryableForTests(null);
    const read = await loadFloodHazardFactAtom(GOLD);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("atoms-store-not-configured");
    expect(read.reason).toContain("ATOMS_DATABASE_URL");
    expect(read.reason).toMatch(/Refusing rather than reading place_layer_snapshots/);
  });

  it("yields a value when a fixture atom exists", async () => {
    setFloodHazardAtomQueryableForTests(
      memoryFloodHazardAtoms([
        { entityId: GOLD_PADDED, body: GOLD_PRESENT_BODY },
      ]),
    );
    const read = await loadFloodHazardFactAtom(GOLD);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.floodZone).toBe("AO");
    expect(read.source).toBe("flood-hazard-fact");
    expect(read.boundAs).toBe(GOLD_PADDED);
  });

  it("the memory fake refuses a place_layer_snapshots query", async () => {
    const fake = memoryFloodHazardAtoms([]);
    await expect(
      fake.query("SELECT payload_json FROM place_layer_snapshots WHERE place_key = $1", [
        "node:48021:34137",
      ]),
    ).rejects.toThrow(/place_layer_snapshots|not the flood-hazard-fact/);
  });
});

describe("floodHazardFactRead source does not name the retired store", () => {
  it("the read module source has zero place_layer_snapshots matches", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "floodHazardFactRead.ts"), "utf8");
    expect(src).not.toMatch(/FROM\s+place_layer_snapshots/i);
    expect(src).toMatch(/FROM atoms/);
    expect(src).toMatch(/flood-hazard-fact/);
  });
});
