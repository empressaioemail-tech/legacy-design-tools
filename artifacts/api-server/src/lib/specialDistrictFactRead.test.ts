/**
 * Dual-grammar special-district-fact bind + interpret. No store.
 *
 * Bake / snapshot / CAD / mud-pid values are out of this file on purpose.
 * Flood-style parcel-only entity_id is a miss. Gold 48021:34137 is the
 * live :sd:outside row, not a fabricated MUD.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  districtSuffixFromSpecialDistrictEntityId,
  interpretSpecialDistrictFactRows,
  loadSpecialDistrictFactAtom,
  memorySpecialDistrictFactAtoms,
  resetSpecialDistrictFactAtomQueryableForTests,
  setSpecialDistrictFactAtomQueryableForTests,
  specialDistrictFactBindPrefixes,
  specialDistrictFactLikePrefixPattern,
} from "./specialDistrictFactRead";

const GOLD = "48021:34137";
const GOLD_PADDED = "48021:34137.00000000";
const GOLD_OUTSIDE = "48021:34137:sd:outside";
const BASTROP_PRESENT = "48021:102817";
const BASTROP_PRESENT_PADDED = "48021:102817.00000000";
const BASTROP_SD = "48021:102817:sd:3504125";
const BASTROP_SD_PADDED = "48021:102817.00000000:sd:3504125";
const TRAVIS = "48453:587851";
const TRAVIS_SD = "48453:587851:sd:5460000";

const GOLD_OUTSIDE_BODY = {
  entityType: "special-district-fact",
  parcelNodeId: GOLD,
  sourceTier: "tceq-water-districts",
  absence: {
    kind: "outside-tceq-source-boundaries",
    reason:
      "Parcel geometry does not intersect any polygon in tx_special_district (TCEQ Public/WaterDistricts MapServer/0) for county 48021.",
  },
  sourceAdapter: "tceq-water-districts-v1",
  evaluatedAt: "2026-08-12T21:33:03.719Z",
};

const BASTROP_PRESENT_BODY = {
  entityType: "special-district-fact",
  parcelNodeId: BASTROP_PRESENT,
  sourceTier: "tceq-water-districts",
  districtId: "3504125",
  districtType: "MUD",
  districtName: "The Colony MUD 1C",
  membershipBasis: "point-in-polygon",
  sourceAdapter: "tceq-water-districts-v1",
  evaluatedAt: "2026-08-12T21:33:03.719Z",
};

const TRAVIS_PRESENT_BODY = {
  entityType: "special-district-fact",
  parcelNodeId: TRAVIS,
  sourceTier: "tceq-water-districts",
  districtId: "5460000",
  districtType: "RA",
  districtName: "Lower Colorado River Authority",
  membershipBasis: "point-in-polygon",
  sourceAdapter: "tceq-water-districts-v1",
  evaluatedAt: "2026-08-13T09:07:29.732Z",
};

afterEach(() => {
  resetSpecialDistrictFactAtomQueryableForTests();
});

describe("specialDistrictFactBindPrefixes — dual grammar on parcel PREFIX only", () => {
  it("returns integer then padded for an integer inbound id and never appends :sd:", () => {
    expect(specialDistrictFactBindPrefixes(GOLD)).toEqual([GOLD, GOLD_PADDED]);
  });

  it("inverts a padded inbound id to the same pair", () => {
    expect(specialDistrictFactBindPrefixes(GOLD_PADDED)).toEqual([
      GOLD,
      GOLD_PADDED,
    ]);
  });

  it("never collapses to one prefix", () => {
    const keys = specialDistrictFactBindPrefixes("48021:102817");
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("specialDistrictFactLikePrefixPattern — LIKE wildcards in parcel ids", () => {
  it("escapes underscore so it is not an any-char wildcard", () => {
    expect(specialDistrictFactLikePrefixPattern("48021:341_7")).toBe(
      "48021:341\\_7:sd:%",
    );
  });

  it("escapes percent and backslash", () => {
    expect(specialDistrictFactLikePrefixPattern("48021:a%b\\c")).toBe(
      "48021:a\\%b\\\\c:sd:%",
    );
  });
});

describe("districtSuffixFromSpecialDistrictEntityId", () => {
  const prefixes = specialDistrictFactBindPrefixes(GOLD);

  it("parses gold 48021:34137:sd:outside against the integer prefix", () => {
    expect(districtSuffixFromSpecialDistrictEntityId(GOLD_OUTSIDE, prefixes)).toEqual({
      prefix: GOLD,
      districtId: "outside",
    });
  });

  it("parses a padded-prefix entity_id without matching the integer prefix", () => {
    const paddedPrefixes = specialDistrictFactBindPrefixes(BASTROP_PRESENT);
    expect(
      districtSuffixFromSpecialDistrictEntityId(BASTROP_SD_PADDED, paddedPrefixes),
    ).toEqual({
      prefix: BASTROP_PRESENT_PADDED,
      districtId: "3504125",
    });
  });

  it("flood-style parcel-only entity_id is not a special-district bind", () => {
    expect(districtSuffixFromSpecialDistrictEntityId(GOLD, prefixes)).toBeNull();
    expect(
      districtSuffixFromSpecialDistrictEntityId(GOLD_PADDED, prefixes),
    ).toBeNull();
  });

  it("parses IDENT new-write absence :sd:none", () => {
    expect(
      districtSuffixFromSpecialDistrictEntityId(`${GOLD}:sd:none`, prefixes),
    ).toEqual({ prefix: GOLD, districtId: "none" });
  });

  it("parses unpatched IDENT exact :sd as absence, not a miss", () => {
    expect(
      districtSuffixFromSpecialDistrictEntityId(`${GOLD}:sd`, prefixes),
    ).toEqual({ prefix: GOLD, districtId: "" });
  });
});

describe("interpretSpecialDistrictFactRows", () => {
  it("serves a present finding stored on the integer prefix plus :sd: (Bastrop 48021:102817:sd:3504125)", () => {
    const read = interpretSpecialDistrictFactRows(BASTROP_PRESENT, [
      { entity_id: BASTROP_SD, body: BASTROP_PRESENT_BODY },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.source).toBe("special-district-fact");
    expect(read.boundAs).toBe(BASTROP_SD);
    expect(read.entityId).toBe(BASTROP_SD);
    expect(read.tried).toEqual([BASTROP_PRESENT, BASTROP_PRESENT_PADDED]);
    expect(read.districtId).toBe("3504125");
    expect(read.districtType).toBe("MUD");
    expect(read.districtName).toBe("The Colony MUD 1C");
    expect(read.evaluatedAt).toBe("2026-08-12T21:33:03.719Z");
  });

  it("serves a present finding stored only on the padded parcel prefix (dual-grammar hit)", () => {
    const read = interpretSpecialDistrictFactRows(BASTROP_PRESENT, [
      {
        entity_id: BASTROP_SD_PADDED,
        body: { ...BASTROP_PRESENT_BODY, parcelNodeId: BASTROP_PRESENT_PADDED },
      },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.boundAs).toBe(BASTROP_SD_PADDED);
    expect(read.districtId).toBe("3504125");
    expect(read.districtType).toBe("MUD");
  });

  it("fails closed with atom-miss when both prefixes are empty — never a silent null", () => {
    const read = interpretSpecialDistrictFactRows(GOLD, []);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("atom-miss");
    expect(read.source).toBe("special-district-fact");
    expect(read.tried).toEqual([GOLD, GOLD_PADDED]);
    expect(read.reason).toContain(GOLD);
    expect(read.reason).toContain(GOLD_PADDED);
    expect(read.reason.toLowerCase()).toContain("atom miss");
  });

  it("fails closed with atom-miss on flood-style parcel-only entity_id (no :sd:)", () => {
    const read = interpretSpecialDistrictFactRows(GOLD, [
      { entity_id: GOLD, body: BASTROP_PRESENT_BODY },
      { entity_id: GOLD_PADDED, body: BASTROP_PRESENT_BODY },
    ]);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("atom-miss");
  });

  it("serves gold 48021:34137:sd:outside as typed absence, not a fabricated MUD", () => {
    const read = interpretSpecialDistrictFactRows(GOLD, [
      { entity_id: GOLD_OUTSIDE, body: GOLD_OUTSIDE_BODY },
    ]);
    expect(read.state).toBe("absent");
    if (read.state !== "absent") return;
    expect(read.source).toBe("special-district-fact");
    expect(read.boundAs).toBe(GOLD_OUTSIDE);
    expect(read.entityId).toBe(GOLD_OUTSIDE);
    expect(read.absence?.kind).toBe("outside-tceq-source-boundaries");
    expect(read).not.toHaveProperty("districtType");
    expect(read).not.toHaveProperty("districtName");
    expect(read).not.toHaveProperty("districtId");
  });

  it("does not invent MUD on a confirmatory Travis RA row", () => {
    const read = interpretSpecialDistrictFactRows(TRAVIS, [
      { entity_id: TRAVIS_SD, body: TRAVIS_PRESENT_BODY },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.districtId).toBe("5460000");
    expect(read.districtType).toBe("RA");
    expect(read.districtName).toBe("Lower Colorado River Authority");
  });

  it("prefers a stored MUD type over a WCID on the same parcel and does not invent the type", () => {
    const read = interpretSpecialDistrictFactRows(BASTROP_PRESENT, [
      {
        entity_id: "48021:102817:sd:200",
        body: {
          ...BASTROP_PRESENT_BODY,
          districtId: "200",
          districtType: "WCID",
          districtName: "OVERLAP WCID",
        },
      },
      { entity_id: BASTROP_SD, body: BASTROP_PRESENT_BODY },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.districtId).toBe("3504125");
    expect(read.districtType).toBe("MUD");
    expect(read.districtName).toBe("The Colony MUD 1C");
  });

  it("serves IDENT :sd:none as typed absence and does not emit districtId none", () => {
    const read = interpretSpecialDistrictFactRows(GOLD, [
      { entity_id: `${GOLD}:sd:none`, body: GOLD_OUTSIDE_BODY },
    ]);
    expect(read.state).toBe("absent");
    if (read.state !== "absent") return;
    expect(read.entityId).toBe(`${GOLD}:sd:none`);
    expect(read).not.toHaveProperty("districtId");
    expect(read).not.toHaveProperty("districtType");
  });

  it("serves unpatched IDENT exact :sd as typed absence, not atom-miss", () => {
    const read = interpretSpecialDistrictFactRows(GOLD, [
      { entity_id: `${GOLD}:sd`, body: GOLD_OUTSIDE_BODY },
    ]);
    expect(read.state).toBe("absent");
    if (read.state !== "absent") return;
    expect(read.entityId).toBe(`${GOLD}:sd`);
    expect(read).not.toHaveProperty("districtId");
  });

  it("prefers present membership over :sd:outside on the same parcel", () => {
    const read = interpretSpecialDistrictFactRows(BASTROP_PRESENT, [
      {
        entity_id: "48021:102817:sd:outside",
        body: GOLD_OUTSIDE_BODY,
      },
      { entity_id: BASTROP_SD, body: BASTROP_PRESENT_BODY },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.districtId).toBe("3504125");
  });

  it("fails closed with bind-conflict when the same districtId hits both grammars and the claims disagree", () => {
    const read = interpretSpecialDistrictFactRows(BASTROP_PRESENT, [
      { entity_id: BASTROP_SD, body: BASTROP_PRESENT_BODY },
      {
        entity_id: BASTROP_SD_PADDED,
        body: {
          ...BASTROP_PRESENT_BODY,
          parcelNodeId: BASTROP_PRESENT_PADDED,
          districtName: "Some Other Name",
        },
      },
    ]);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("bind-conflict");
    expect(read.tried).toEqual([BASTROP_PRESENT, BASTROP_PRESENT_PADDED]);
  });

  it("refuses a body that is neither a present finding nor an absence", () => {
    const read = interpretSpecialDistrictFactRows(BASTROP_PRESENT, [
      { entity_id: BASTROP_SD, body: { entityType: "special-district-fact" } },
    ]);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("malformed-atom");
  });

  it("does not copy snapshot district field names onto specialDistrictFact", () => {
    const read = interpretSpecialDistrictFactRows(BASTROP_PRESENT, [
      {
        entity_id: BASTROP_SD,
        body: {
          entityType: "special-district-fact",
          name: "The Colony MUD 1C",
          type: "MUD",
          id: "3504125",
        },
      },
    ]);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("malformed-atom");
  });
});

describe("loadSpecialDistrictFactAtom — store seam", () => {
  it("refuses as atoms-store-not-configured when the queryable is null", async () => {
    setSpecialDistrictFactAtomQueryableForTests(null);
    const read = await loadSpecialDistrictFactAtom(GOLD);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("atoms-store-not-configured");
    expect(read.reason).toContain("ATOMS_DATABASE_URL");
    expect(read.reason).toMatch(/Refusing rather than reading place_layer_snapshots/);
  });

  it("yields typed absence when a fixture atom exists on 48021:34137:sd:none", async () => {
    setSpecialDistrictFactAtomQueryableForTests(
      memorySpecialDistrictFactAtoms([
        { entityId: `${GOLD}:sd:none`, body: GOLD_OUTSIDE_BODY },
      ]),
    );
    const read = await loadSpecialDistrictFactAtom(GOLD);
    expect(read.state).toBe("absent");
    if (read.state !== "absent") return;
    expect(read.entityId).toBe(`${GOLD}:sd:none`);
    expect(read).not.toHaveProperty("districtId");
  });

  it("yields typed absence for unpatched exact :sd, not atom-miss", async () => {
    setSpecialDistrictFactAtomQueryableForTests(
      memorySpecialDistrictFactAtoms([
        { entityId: `${GOLD}:sd`, body: GOLD_OUTSIDE_BODY },
      ]),
    );
    const read = await loadSpecialDistrictFactAtom(GOLD);
    expect(read.state).toBe("absent");
    if (read.state !== "absent") return;
    expect(read.entityId).toBe(`${GOLD}:sd`);
  });

  it("yields districtId when a fixture atom exists on 48021:102817:sd:3504125", async () => {
    setSpecialDistrictFactAtomQueryableForTests(
      memorySpecialDistrictFactAtoms([
        { entityId: BASTROP_SD, body: BASTROP_PRESENT_BODY },
      ]),
    );
    const read = await loadSpecialDistrictFactAtom(BASTROP_PRESENT);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.districtId).toBe("3504125");
    expect(read.districtType).toBe("MUD");
    expect(read.source).toBe("special-district-fact");
    expect(read.boundAs).toBe(BASTROP_SD);
  });

  it("the memory fake refuses a cad_property query", async () => {
    const fake = memorySpecialDistrictFactAtoms([]);
    await expect(
      fake.query("SELECT district /* cad_property */ WHERE prop_id = $1", [
        "34137",
      ]),
    ).rejects.toThrow(/cad_property/);
  });

  it("the memory fake refuses a place_layer_snapshots query", async () => {
    const fake = memorySpecialDistrictFactAtoms([]);
    await expect(
      fake.query("SELECT payload_json FROM place_layer_snapshots WHERE place_key = $1", [
        "node:48021:34137",
      ]),
    ).rejects.toThrow(/place_layer_snapshots/);
  });

  it("the memory fake refuses flood-style entity_id = ANY(parcel keys)", async () => {
    const fake = memorySpecialDistrictFactAtoms([
      { entityId: BASTROP_SD, body: BASTROP_PRESENT_BODY },
    ]);
    await expect(
      fake.query(
        "SELECT entity_id, body FROM atoms WHERE entity_type = $1 AND entity_id = ANY($2::text[])",
        ["special-district-fact", [BASTROP_PRESENT, BASTROP_PRESENT_PADDED]],
      ),
    ).rejects.toThrow(/entity_id = ANY/);
  });

  it("an underscore in the requested prefix does not match a different parcel via LIKE", async () => {
    setSpecialDistrictFactAtomQueryableForTests(
      memorySpecialDistrictFactAtoms([
        { entityId: "48021:102817:sd:3504125", body: BASTROP_PRESENT_BODY },
      ]),
    );
    const read = await loadSpecialDistrictFactAtom("48021:102_17");
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("atom-miss");
    expect(read.tried).toEqual(["48021:102_17", "48021:102_17.00000000"]);
  });
});

describe("specialDistrictFactRead source does not name the retired store", () => {
  it("the SELECT binds by prefix LIKE :sd: and does not use flood-style ANY parcel keys", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "specialDistrictFactRead.ts"), "utf8");
    expect(src).not.toMatch(/FROM\s+cad_property/i);
    expect(src).not.toMatch(/FROM\s+place_layer_snapshots/i);
    expect(src).not.toMatch(/FROM\s+mud-pid/i);
    const select = src.match(
      /const SELECT_SPECIAL_DISTRICT_FACT = `([\s\S]*?)`;/,
    )?.[1];
    expect(select).toBeTruthy();
    expect(select).toMatch(/FROM atoms/);
    expect(select).toMatch(/LIKE \$2 ESCAPE/);
    expect(select).toMatch(/LIKE \$3 ESCAPE/);
    expect(select).toMatch(/entity_id = \$4/);
    expect(select).toMatch(/entity_id = \$5/);
    expect(select).not.toMatch(/\$2 \|\| ':%'/);
    expect(select).not.toMatch(/\bANY\b/);
    expect(select).toMatch(/entity_type = \$1/);
  });
});
