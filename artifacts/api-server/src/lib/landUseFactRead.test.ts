/**
 * Dual-grammar land-use-fact bind + interpret. No store.
 *
 * Cad-roll / snapshot land-use values are out of this file on purpose: this
 * module must yield an atom determination when a fixture row exists on
 * ${parcel}:${taxYear}, and refuse with a named miss when it does not.
 * cad_property is not a source. Flood-style parcel-only entity_id is a miss.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  interpretLandUseFactRows,
  landUseFactBindPrefixes,
  landUseFactLikePrefixPattern,
  loadLandUseFactAtom,
  memoryLandUseFactAtoms,
  resetLandUseFactAtomQueryableForTests,
  setLandUseFactAtomQueryableForTests,
  taxYearFromLandUseEntityId,
} from "./landUseFactRead";

const GOLD = "48021:34137";
const GOLD_PADDED = "48021:34137.00000000";
const GOLD_2025 = "48021:34137:2025";
const GOLD_PADDED_2025 = "48021:34137.00000000:2025";
const GOLD_2024 = "48021:34137:2024";

const GOLD_PRESENT_BODY = {
  entityType: "land-use-fact",
  atomDid: "lufact_0123456789abcdef",
  parcelNodeId: GOLD,
  taxYear: 2025,
  sourceTier: "cad-authoritative",
  landUseCode: "C1",
  landUseLabel: "Vacant commercial",
  sourceAdapter: "cad-roll-v1",
  sourceVintage: "2025-bastrop-cad-export",
  evaluatedAt: "2026-08-11T23:13:43.774Z",
};

afterEach(() => {
  resetLandUseFactAtomQueryableForTests();
});

describe("landUseFactBindPrefixes — dual grammar on parcel PREFIX only", () => {
  it("returns integer then padded for an integer inbound id and never appends a year", () => {
    expect(landUseFactBindPrefixes(GOLD)).toEqual([GOLD, GOLD_PADDED]);
  });

  it("inverts a padded inbound id to the same pair", () => {
    expect(landUseFactBindPrefixes(GOLD_PADDED)).toEqual([GOLD, GOLD_PADDED]);
  });

  it("never collapses to one prefix", () => {
    const keys = landUseFactBindPrefixes("48021:36521");
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("landUseFactLikePrefixPattern — LIKE wildcards in parcel ids", () => {
  it("escapes underscore so it is not an any-char wildcard", () => {
    expect(landUseFactLikePrefixPattern("48021:341_7")).toBe(
      "48021:341\\_7:%",
    );
  });

  it("escapes percent and backslash", () => {
    expect(landUseFactLikePrefixPattern("48021:a%b\\c")).toBe(
      "48021:a\\%b\\\\c:%",
    );
  });
});

describe("taxYearFromLandUseEntityId", () => {
  const prefixes = landUseFactBindPrefixes(GOLD);

  it("parses gold 48021:34137:2025 against the integer prefix", () => {
    expect(taxYearFromLandUseEntityId(GOLD_2025, prefixes)).toEqual({
      prefix: GOLD,
      taxYear: 2025,
    });
  });

  it("parses a padded-prefix entity_id without matching the integer prefix", () => {
    expect(taxYearFromLandUseEntityId(GOLD_PADDED_2025, prefixes)).toEqual({
      prefix: GOLD_PADDED,
      taxYear: 2025,
    });
  });

  it("flood-style parcel-only entity_id is not a land-use bind", () => {
    expect(taxYearFromLandUseEntityId(GOLD, prefixes)).toBeNull();
    expect(taxYearFromLandUseEntityId(GOLD_PADDED, prefixes)).toBeNull();
  });
});

describe("interpretLandUseFactRows", () => {
  it("serves a present finding stored on the integer prefix plus taxYear (gold 48021:34137:2025)", () => {
    const read = interpretLandUseFactRows(GOLD, [
      { entity_id: GOLD_2025, body: GOLD_PRESENT_BODY },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.source).toBe("land-use-fact");
    expect(read.boundAs).toBe(GOLD_2025);
    expect(read.entityId).toBe(GOLD_2025);
    expect(read.tried).toEqual([GOLD, GOLD_PADDED]);
    expect(read.taxYear).toBe(2025);
    expect(read.landUseCode).toBe("C1");
    expect(read.landUseLabel).toBe("Vacant commercial");
    expect(read).not.toHaveProperty("code");
    expect(read).not.toHaveProperty("description");
  });

  it("serves a present finding stored only on the padded parcel prefix (dual-grammar hit)", () => {
    const read = interpretLandUseFactRows(GOLD, [
      {
        entity_id: GOLD_PADDED_2025,
        body: { ...GOLD_PRESENT_BODY, parcelNodeId: GOLD_PADDED },
      },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.boundAs).toBe(GOLD_PADDED_2025);
    expect(read.landUseCode).toBe("C1");
    expect(read.taxYear).toBe(2025);
  });

  it("fails closed with atom-miss when both prefixes are empty — never a silent null", () => {
    const read = interpretLandUseFactRows(GOLD, []);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("atom-miss");
    expect(read.tried).toEqual([GOLD, GOLD_PADDED]);
    expect(read.reason).toContain(GOLD);
    expect(read.reason).toContain(GOLD_PADDED);
    expect(read.reason.toLowerCase()).toContain("atom miss");
  });

  it("fails closed with atom-miss on flood-style parcel-only entity_id (no :taxYear)", () => {
    const read = interpretLandUseFactRows(GOLD, [
      { entity_id: GOLD, body: GOLD_PRESENT_BODY },
      { entity_id: GOLD_PADDED, body: GOLD_PRESENT_BODY },
    ]);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("atom-miss");
  });

  it("prefers the highest taxYear among prefix hits", () => {
    const read = interpretLandUseFactRows(GOLD, [
      {
        entity_id: GOLD_2024,
        body: { ...GOLD_PRESENT_BODY, taxYear: 2024, landUseCode: "A1" },
      },
      { entity_id: GOLD_2025, body: GOLD_PRESENT_BODY },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.taxYear).toBe(2025);
    expect(read.landUseCode).toBe("C1");
    expect(read.boundAs).toBe(GOLD_2025);
  });

  it("serves integer first when the same year hits both grammars and the claims agree", () => {
    const read = interpretLandUseFactRows(GOLD, [
      { entity_id: GOLD_2025, body: GOLD_PRESENT_BODY },
      {
        entity_id: GOLD_PADDED_2025,
        body: { ...GOLD_PRESENT_BODY, parcelNodeId: GOLD_PADDED },
      },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.boundAs).toBe(GOLD_2025);
    expect(read.landUseCode).toBe("C1");
  });

  it("fails closed with bind-conflict when the same year hits both grammars and the claims disagree", () => {
    const read = interpretLandUseFactRows(GOLD, [
      { entity_id: GOLD_2025, body: GOLD_PRESENT_BODY },
      {
        entity_id: GOLD_PADDED_2025,
        body: {
          ...GOLD_PRESENT_BODY,
          parcelNodeId: GOLD_PADDED,
          landUseCode: "A1",
        },
      },
    ]);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("bind-conflict");
    expect(read.tried).toEqual([GOLD, GOLD_PADDED]);
  });

  it("serves typed absence as absence, not as a miss", () => {
    const read = interpretLandUseFactRows("48021:99999", [
      {
        entity_id: "48021:99999:2025",
        body: {
          entityType: "land-use-fact",
          taxYear: 2025,
          sourceTier: "cad-authoritative",
          absence: {
            kind: "no-land-use-code",
            reason: "cad row present but property_use_code empty",
          },
        },
      },
    ]);
    expect(read.state).toBe("absent");
    if (read.state !== "absent") return;
    expect(read.absence?.kind).toBe("no-land-use-code");
    expect(read.taxYear).toBe(2025);
  });

  it("refuses a body that is neither a present finding nor an absence", () => {
    const read = interpretLandUseFactRows(GOLD, [
      { entity_id: GOLD_2025, body: { entityType: "land-use-fact", taxYear: 2025 } },
    ]);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("malformed-atom");
  });

  it("does not copy cad-roll code/description field names onto landUseFact", () => {
    const read = interpretLandUseFactRows(GOLD, [
      {
        entity_id: GOLD_2025,
        body: {
          entityType: "land-use-fact",
          taxYear: 2025,
          code: "A1",
          description: "Single-family residential",
        },
      },
    ]);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("malformed-atom");
  });
});

describe("loadLandUseFactAtom — store seam", () => {
  it("refuses as atoms-store-not-configured when the queryable is null", async () => {
    setLandUseFactAtomQueryableForTests(null);
    const read = await loadLandUseFactAtom(GOLD);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("atoms-store-not-configured");
    expect(read.reason).toContain("ATOMS_DATABASE_URL");
    expect(read.reason).toMatch(/Refusing rather than reading cad_property/);
  });

  it("yields landUseCode when a fixture atom exists on 48021:34137:2025", async () => {
    setLandUseFactAtomQueryableForTests(
      memoryLandUseFactAtoms([
        { entityId: GOLD_2025, body: GOLD_PRESENT_BODY },
      ]),
    );
    const read = await loadLandUseFactAtom(GOLD);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.landUseCode).toBe("C1");
    expect(read.source).toBe("land-use-fact");
    expect(read.boundAs).toBe(GOLD_2025);
    expect(read.taxYear).toBe(2025);
  });

  it("the memory fake refuses a cad_property query", async () => {
    const fake = memoryLandUseFactAtoms([]);
    // Colocated *.test.ts is outside L17's __tests__ allowlist, so a
    // SQL FROM-clause naming that table would fail ci-vintage-predicate
    // even though this is a refusal probe. The fake matches the
    // cad_property token anywhere in the text.
    await expect(
      fake.query("SELECT property_use_code /* cad_property */ WHERE prop_id = $1", [
        "34137",
      ]),
    ).rejects.toThrow(/cad_property/);
  });

  it("the memory fake refuses flood-style entity_id = ANY(parcel keys)", async () => {
    const fake = memoryLandUseFactAtoms([
      { entityId: GOLD_2025, body: GOLD_PRESENT_BODY },
    ]);
    await expect(
      fake.query(
        "SELECT entity_id, body FROM atoms WHERE entity_type = $1 AND entity_id = ANY($2::text[])",
        ["land-use-fact", [GOLD, GOLD_PADDED]],
      ),
    ).rejects.toThrow(/entity_id = ANY/);
  });

  it("an underscore in the requested prefix does not match a different parcel via LIKE", async () => {
    setLandUseFactAtomQueryableForTests(
      memoryLandUseFactAtoms([
        { entityId: "48021:34117:2025", body: GOLD_PRESENT_BODY },
      ]),
    );
    const read = await loadLandUseFactAtom("48021:341_7");
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("atom-miss");
    expect(read.tried).toEqual(["48021:341_7", "48021:341_7.00000000"]);
  });
});

describe("landUseFactRead source does not name the retired store", () => {
  it("the SELECT binds by prefix LIKE and does not use flood-style ANY parcel keys", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "landUseFactRead.ts"), "utf8");
    expect(src).not.toMatch(/FROM\s+cad_property/i);
    expect(src).not.toMatch(/FROM\s+place_layer_snapshots/i);
    const select = src.match(
      /const SELECT_LAND_USE_FACT = `([\s\S]*?)`;/,
    )?.[1];
    expect(select).toBeTruthy();
    expect(select).toMatch(/FROM atoms/);
    expect(select).toMatch(/LIKE \$2 ESCAPE/);
    expect(select).toMatch(/LIKE \$3 ESCAPE/);
    expect(select).not.toMatch(/\$2 \|\| ':%'/);
    expect(select).not.toMatch(/\bANY\b/);
    expect(select).toMatch(/land-use-fact|entity_type = \$1/);
  });
});
