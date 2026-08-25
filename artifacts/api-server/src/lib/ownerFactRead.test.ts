/**
 * Dual-grammar owner-fact bind + interpret. No store.
 *
 * CAD-roll / snapshot / GIS owner values are out of this file on purpose:
 * this module must yield an atom determination when a fixture row exists on
 * ${parcel}:${taxYear}, and refuse with a named miss when it does not.
 * L17: refuse probes use lowercase `from cad_property` only.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  anonymousOwnerFactRefusal,
  studioGatedOwnerFactRefusal,
  interpretOwnerFactRows,
  loadOwnerFactAtom,
  memoryOwnerFactAtoms,
  ownerFactBindPrefixes,
  ownerFactLikePrefixPattern,
  resetOwnerFactAtomQueryableForTests,
  setOwnerFactAtomQueryableForTests,
  taxYearFromOwnerFactEntityId,
} from "./ownerFactRead";

const GOLD = "48021:34137";
const GOLD_PADDED = "48021:34137.00000000";
const GOLD_2025 = "48021:34137:2025";
const GOLD_PADDED_2025 = "48021:34137.00000000:2025";
const GOLD_2024 = "48021:34137:2024";

const GOLD_PRESENT_BODY = {
  entityType: "owner-fact",
  atomDid: "ownfact_0123456789abcdef",
  parcelNodeId: GOLD,
  taxYear: 2025,
  sourceTier: "cad-authoritative",
  ownerName: "FIXTURE OWNER",
  ownerMailingAddress: "1 FIXTURE RD, BASTROP, TX 78602",
  exemptionFlags: {
    homestead: true,
    seniorOrDisability: false,
    agricultural: false,
    veteran: false,
  },
  sourceAdapter: "cad-property-owner-v1",
  sourceVintage: "2025-bastrop-cad-export",
  evaluatedAt: "2026-08-11T23:13:43.774Z",
};

afterEach(() => {
  resetOwnerFactAtomQueryableForTests();
});

describe("ownerFactBindPrefixes — dual grammar on parcel PREFIX only", () => {
  it("returns integer then padded for an integer inbound id and never appends a year", () => {
    expect(ownerFactBindPrefixes(GOLD)).toEqual([GOLD, GOLD_PADDED]);
  });

  it("inverts a padded inbound id to the same pair", () => {
    expect(ownerFactBindPrefixes(GOLD_PADDED)).toEqual([GOLD, GOLD_PADDED]);
  });

  it("never collapses to one prefix", () => {
    const keys = ownerFactBindPrefixes("48021:36521");
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("ownerFactLikePrefixPattern — LIKE wildcards in parcel ids", () => {
  it("escapes underscore so it is not an any-char wildcard", () => {
    expect(ownerFactLikePrefixPattern("48021:341_7")).toBe("48021:341\\_7:%");
  });

  it("escapes percent and backslash", () => {
    expect(ownerFactLikePrefixPattern("48021:a%b\\c")).toBe("48021:a\\%b\\\\c:%");
  });
});

describe("taxYearFromOwnerFactEntityId", () => {
  const prefixes = ownerFactBindPrefixes(GOLD);

  it("parses gold 48021:34137:2025 against the integer prefix", () => {
    expect(taxYearFromOwnerFactEntityId(GOLD_2025, prefixes)).toEqual({
      prefix: GOLD,
      taxYear: 2025,
    });
  });

  it("parses a padded-prefix entity_id without matching the integer prefix", () => {
    expect(taxYearFromOwnerFactEntityId(GOLD_PADDED_2025, prefixes)).toEqual({
      prefix: GOLD_PADDED,
      taxYear: 2025,
    });
  });

  it("flood-style parcel-only entity_id is not an owner-fact bind", () => {
    expect(taxYearFromOwnerFactEntityId(GOLD, prefixes)).toBeNull();
    expect(taxYearFromOwnerFactEntityId(GOLD_PADDED, prefixes)).toBeNull();
  });

  it("edge :boundary: suffix is not an owner-fact year", () => {
    expect(
      taxYearFromOwnerFactEntityId("48021:34137:boundary:2", prefixes),
    ).toBeNull();
  });
});

describe("interpretOwnerFactRows", () => {
  it("serves a present finding stored on the integer prefix plus taxYear (gold 48021:34137:2025)", () => {
    const read = interpretOwnerFactRows(GOLD, [
      { entity_id: GOLD_2025, body: GOLD_PRESENT_BODY },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.source).toBe("owner-fact");
    expect(read.boundAs).toBe(GOLD_2025);
    expect(read.entityId).toBe(GOLD_2025);
    expect(read.tried).toEqual([GOLD, GOLD_PADDED]);
    expect(read.taxYear).toBe(2025);
    expect(read.ownerName).toBe("FIXTURE OWNER");
    expect(read.ownerMailingAddress).toBe("1 FIXTURE RD, BASTROP, TX 78602");
    expect(read).not.toHaveProperty("code");
    expect(read).not.toHaveProperty("description");
  });

  it("serves a present finding stored only on the padded parcel prefix (dual-grammar hit)", () => {
    const read = interpretOwnerFactRows(GOLD, [
      {
        entity_id: GOLD_PADDED_2025,
        body: { ...GOLD_PRESENT_BODY, parcelNodeId: GOLD_PADDED },
      },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.boundAs).toBe(GOLD_PADDED_2025);
    expect(read.ownerName).toBe("FIXTURE OWNER");
    expect(read.taxYear).toBe(2025);
  });

  it("fails closed with atom-miss when both prefixes are empty — never a silent null", () => {
    const read = interpretOwnerFactRows(GOLD, []);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("atom-miss");
    expect(read.tried).toEqual([GOLD, GOLD_PADDED]);
    expect(read.reason).toContain(GOLD);
    expect(read.reason).toContain(GOLD_PADDED);
    expect(read.reason.toLowerCase()).toContain("atom miss");
    expect(read).not.toHaveProperty("ownerName");
    expect(read).not.toHaveProperty("ownerMailingAddress");
  });

  it("fails closed with atom-miss on flood-style parcel-only entity_id (no :taxYear)", () => {
    const read = interpretOwnerFactRows(GOLD, [
      { entity_id: GOLD, body: GOLD_PRESENT_BODY },
      { entity_id: GOLD_PADDED, body: GOLD_PRESENT_BODY },
    ]);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("atom-miss");
  });

  it("prefers the highest taxYear among prefix hits", () => {
    const read = interpretOwnerFactRows(GOLD, [
      {
        entity_id: GOLD_2024,
        body: { ...GOLD_PRESENT_BODY, taxYear: 2024, ownerName: "FIXTURE OLD" },
      },
      { entity_id: GOLD_2025, body: GOLD_PRESENT_BODY },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.taxYear).toBe(2025);
    expect(read.ownerName).toBe("FIXTURE OWNER");
    expect(read.boundAs).toBe(GOLD_2025);
  });

  it("serves integer first when the same year hits both grammars and the claims agree", () => {
    const read = interpretOwnerFactRows(GOLD, [
      { entity_id: GOLD_2025, body: GOLD_PRESENT_BODY },
      {
        entity_id: GOLD_PADDED_2025,
        body: { ...GOLD_PRESENT_BODY, parcelNodeId: GOLD_PADDED },
      },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.boundAs).toBe(GOLD_2025);
    expect(read.ownerName).toBe("FIXTURE OWNER");
  });

  it("fails closed with bind-conflict when the same year hits both grammars and the claims disagree", () => {
    const read = interpretOwnerFactRows(GOLD, [
      { entity_id: GOLD_2025, body: GOLD_PRESENT_BODY },
      {
        entity_id: GOLD_PADDED_2025,
        body: {
          ...GOLD_PRESENT_BODY,
          parcelNodeId: GOLD_PADDED,
          ownerName: "FIXTURE OTHER",
        },
      },
    ]);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("bind-conflict");
    expect(read.tried).toEqual([GOLD, GOLD_PADDED]);
  });

  it("serves typed absence as absence, not as a miss", () => {
    const read = interpretOwnerFactRows("48021:99999", [
      {
        entity_id: "48021:99999:2025",
        body: {
          entityType: "owner-fact",
          taxYear: 2025,
          sourceTier: "cad-authoritative",
          absence: {
            kind: "no-cad-row",
            reason: "cad row present but owner_name empty",
          },
        },
      },
    ]);
    expect(read.state).toBe("absent");
    if (read.state !== "absent") return;
    expect(read.absence?.kind).toBe("no-cad-row");
    expect(read.taxYear).toBe(2025);
    expect(read).not.toHaveProperty("ownerName");
  });

  it("refuses a body that is neither a present finding nor an absence", () => {
    const read = interpretOwnerFactRows(GOLD, [
      { entity_id: GOLD_2025, body: { entityType: "owner-fact", taxYear: 2025 } },
    ]);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("malformed-atom");
  });

  it("does not copy CAD-roll / GIS owner field names onto ownerFact", () => {
    const read = interpretOwnerFactRows(GOLD, [
      {
        entity_id: GOLD_2025,
        body: {
          entityType: "owner-fact",
          taxYear: 2025,
          owner: "CAD ROLL MUST NOT LEAK",
          ParcelCardData: { owner: "GIS OWNER MUST NOT LEAK" },
        },
      },
    ]);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("malformed-atom");
    expect(JSON.stringify(read)).not.toContain("CAD ROLL MUST NOT LEAK");
    expect(JSON.stringify(read)).not.toContain("GIS OWNER MUST NOT LEAK");
  });
});

describe("studioGatedOwnerFactRefusal", () => {
  it("names owner-fact and carries no PII", () => {
    const read = studioGatedOwnerFactRefusal(GOLD);
    expect(read.state).toBe("refused");
    expect(read.code).toBe("studio-gated");
    expect(read.source).toBe("owner-fact");
    expect(read.tried).toEqual([GOLD, GOLD_PADDED]);
    expect(read).not.toHaveProperty("ownerName");
    expect(read).not.toHaveProperty("ownerMailingAddress");
    expect(JSON.stringify(read)).not.toMatch(/FIXTURE OWNER/);
  });

  it("anonymousOwnerFactRefusal is the same studio-gated refusal", () => {
    const read = anonymousOwnerFactRefusal(GOLD);
    expect(read.code).toBe("studio-gated");
    expect(read).not.toHaveProperty("ownerName");
  });
});

describe("loadOwnerFactAtom — store seam", () => {
  it("refuses as atoms-store-not-configured when the queryable is null", async () => {
    setOwnerFactAtomQueryableForTests(null);
    const read = await loadOwnerFactAtom(GOLD);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("atoms-store-not-configured");
    expect(read.reason).toContain("ATOMS_DATABASE_URL");
    expect(read.reason).toMatch(/Refusing rather than reading cad_property/);
  });

  it("yields ownerName when a fixture atom exists on 48021:34137:2025", async () => {
    setOwnerFactAtomQueryableForTests(
      memoryOwnerFactAtoms([{ entityId: GOLD_2025, body: GOLD_PRESENT_BODY }]),
    );
    const read = await loadOwnerFactAtom(GOLD);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.ownerName).toBe("FIXTURE OWNER");
    expect(read.source).toBe("owner-fact");
    expect(read.boundAs).toBe(GOLD_2025);
    expect(read.taxYear).toBe(2025);
  });

  it("the memory fake refuses a cad_property query", async () => {
    const fake = memoryOwnerFactAtoms([]);
    await expect(
      fake.query("SELECT * from cad_property WHERE parcel_id = $1", [GOLD]),
    ).rejects.toThrow(/cad_property/);
  });

  it("the memory fake refuses place_layer_snapshots", async () => {
    const fake = memoryOwnerFactAtoms([]);
    await expect(
      fake.query("SELECT payload from place_layer_snapshots", []),
    ).rejects.toThrow(/place_layer_snapshots/);
  });

  it("the memory fake refuses cad-parcel-roll", async () => {
    const fake = memoryOwnerFactAtoms([]);
    await expect(
      fake.query(
        "SELECT entity_id FROM atoms WHERE entity_type = 'cad-parcel-roll'",
        [],
      ),
    ).rejects.toThrow(/cad-parcel-roll/);
  });

  it("the memory fake refuses GIS ParcelCardData.owner", async () => {
    const fake = memoryOwnerFactAtoms([]);
    await expect(
      fake.query("SELECT owner FROM ParcelCardData", []),
    ).rejects.toThrow(/GIS/);
  });

  it("the memory fake refuses flood-style entity_id = ANY(parcel keys)", async () => {
    const fake = memoryOwnerFactAtoms([
      { entityId: GOLD_2025, body: GOLD_PRESENT_BODY },
    ]);
    await expect(
      fake.query(
        "SELECT entity_id, body FROM atoms WHERE entity_type = $1 AND entity_id = ANY($2::text[])",
        ["owner-fact", [GOLD, GOLD_PADDED]],
      ),
    ).rejects.toThrow(/entity_id = ANY/);
  });

  it("the memory fake refuses special-district :sd: picker", async () => {
    const fake = memoryOwnerFactAtoms([]);
    await expect(
      fake.query("SELECT entity_id FROM atoms WHERE entity_id LIKE $1 -- :sd:", [
        "48021:34137:sd:%",
      ]),
    ).rejects.toThrow(/:sd:/);
  });

  it("the memory fake refuses edge :boundary: prefix-range", async () => {
    const fake = memoryOwnerFactAtoms([]);
    await expect(
      fake.query(
        "SELECT entity_id FROM atoms WHERE entity_id >= $1 AND entity_id < $2 -- :boundary:",
        ["48021:34137:boundary:", "48021:34137:boundary;"],
      ),
    ).rejects.toThrow(/:boundary:/);
  });

  it("an underscore in the requested prefix does not match a different parcel via LIKE", async () => {
    setOwnerFactAtomQueryableForTests(
      memoryOwnerFactAtoms([
        { entityId: "48021:34117:2025", body: GOLD_PRESENT_BODY },
      ]),
    );
    const read = await loadOwnerFactAtom("48021:341_7");
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("atom-miss");
    expect(read.tried).toEqual(["48021:341_7", "48021:341_7.00000000"]);
  });
});

describe("ownerFactRead source does not name the retired store", () => {
  it("the SELECT binds by prefix LIKE and does not use flood-style ANY parcel keys", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "ownerFactRead.ts"), "utf8");
    expect(src).not.toMatch(/FROM\s+cad_property/i);
    expect(src).not.toMatch(/FROM\s+place_layer_snapshots/i);
    expect(src).not.toMatch(/CAD_PROPERTY_MULTI_YEAR_INVENTORY/);
    const select = src.match(/const SELECT_OWNER_FACT = `([\s\S]*?)`;/)?.[1];
    expect(select).toBeTruthy();
    expect(select).toMatch(/FROM atoms/);
    expect(select).toMatch(/LIKE \$2 ESCAPE/);
    expect(select).toMatch(/LIKE \$3 ESCAPE/);
    expect(select).not.toMatch(/\$2 \|\| ':%'/);
    expect(select).not.toMatch(/\bANY\b/);
    expect(select).not.toMatch(/:boundary:/);
    expect(select).not.toMatch(/:sd:/);
    expect(select).toMatch(/owner-fact|entity_type = \$1/);
  });
});
