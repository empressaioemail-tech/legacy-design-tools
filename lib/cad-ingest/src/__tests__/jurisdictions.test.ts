/**
 * Unified jurisdiction-config tests.
 *
 * These are ZERO-BEHAVIOR-CHANGE proofs: the composed descriptor must
 * return the EXACT objects the individual source registries hold. The
 * descriptor derives every field from those registries at call time, so
 * `toBe` (reference identity) — not just `toEqual` — proves it composes
 * rather than copies, and therefore cannot drift or change behavior.
 */

import { describe, expect, it } from "vitest";
import {
  getJurisdictionConfig,
  listJurisdictions,
  listJurisdictionFips,
  unlinkedSetbackKeys,
} from "../jurisdictions";
import { TXGIO_COUNTIES } from "../txgio/counties";
import { CAD_COUNTIES } from "../counties";
import { CAD_BULK_SOURCES } from "../sources";
import { ZONING_LAYERS } from "../txgio/zoning-layers";
import {
  getSetbackTable,
  SETBACK_JURISDICTION_KEYS,
} from "@workspace/adapters/setbacks";

describe("getJurisdictionConfig — composes the same objects the registries hold", () => {
  it("Hays (48209): geometry + orion CAD + manual-download bulk + city zoning + setbacks, all by reference", () => {
    const j = getJurisdictionConfig("48209");
    expect(j).toBeDefined();
    if (!j) throw new Error("expected Hays");

    expect(j.fips).toBe("48209");
    expect(j.name).toBe("Hays");
    expect(j.state).toBe("TX");

    // Every present facet is the SAME object the source registry holds.
    expect(j.geometry).toBe(TXGIO_COUNTIES["48209"]);
    expect(j.cad).toBe(CAD_COUNTIES["48209"]);
    expect(j.bulkSource).toBe(CAD_BULK_SOURCES["48209"]);

    // Dripping Springs is the Hays-county zoning layer.
    expect(j.zoningLayers).toEqual([ZONING_LAYERS["dripping-springs-tx"]]);
    expect(j.zoningLayers?.[0]).toBe(ZONING_LAYERS["dripping-springs-tx"]);

    // Its setback table is the one getSetbackTable returns for that city.
    const ds = getSetbackTable("dripping-springs-tx");
    expect(ds).not.toBeNull();
    expect(j.setbackTables).toEqual([ds]);
    expect(j.setbackTables?.[0]).toBe(ds);
  });

  it("Williamson (48491): orion CAD + open-fetch bulk + FOUR city zoning layers + their setbacks", () => {
    const j = getJurisdictionConfig("48491");
    if (!j) throw new Error("expected Williamson");

    expect(j.geometry).toBe(TXGIO_COUNTIES["48491"]);
    expect(j.cad).toBe(CAD_COUNTIES["48491"]);
    expect(j.bulkSource).toBe(CAD_BULK_SOURCES["48491"]);

    // Georgetown, Round Rock, Leander, Hutto all target 48491 — in
    // registry declaration order.
    const expectedCities = Object.values(ZONING_LAYERS).filter(
      (z) => z.countyFips === "48491",
    );
    expect(j.zoningLayers).toEqual(expectedCities);
    expect(expectedCities.map((c) => c.cityKey)).toEqual([
      "georgetown-tx",
      "round-rock-tx",
      "leander-tx",
      "hutto-tx",
    ]);

    // Each city's setback table, resolved identically to the CLIs.
    expect(j.setbackTables).toEqual(
      expectedCities.map((c) => getSetbackTable(c.cityKey)),
    );
  });

  it("Travis (48453): geometry + pacs CAD, but NO free bulk source and NO zoning/setbacks", () => {
    const j = getJurisdictionConfig("48453");
    if (!j) throw new Error("expected Travis");

    expect(j.geometry).toBe(TXGIO_COUNTIES["48453"]);
    expect(j.cad).toBe(CAD_COUNTIES["48453"]);
    // Travis/TCAD has no free bulk roll (PIA route) — honestly absent.
    expect(j.bulkSource).toBeUndefined();
    expect(j.zoningLayers).toBeUndefined();
    expect(j.setbackTables).toBeUndefined();
  });

  it("Comal (48091): geometry-only county gains a city zoning layer + setback (New Braunfels)", () => {
    const j = getJurisdictionConfig("48091");
    if (!j) throw new Error("expected Comal");

    expect(j.geometry).toBe(TXGIO_COUNTIES["48091"]);
    // Comal is not in CAD_COUNTIES nor CAD_BULK_SOURCES.
    expect(j.cad).toBeUndefined();
    expect(j.bulkSource).toBeUndefined();
    expect(j.zoningLayers).toEqual([ZONING_LAYERS["new-braunfels-tx"]]);
    expect(j.setbackTables).toEqual([getSetbackTable("new-braunfels-tx")]);
  });

  it("trims surrounding whitespace on the fips key", () => {
    expect(getJurisdictionConfig(" 48209 ")?.fips).toBe("48209");
  });

  it("returns undefined for a county no registry knows", () => {
    expect(getJurisdictionConfig("99999")).toBeUndefined();
  });
});

describe("getJurisdictionConfig — exhaustive parity with every source registry", () => {
  it("reproduces each TXGIO_COUNTIES entry exactly", () => {
    for (const [fips, county] of Object.entries(TXGIO_COUNTIES)) {
      expect(getJurisdictionConfig(fips)?.geometry).toBe(county);
    }
  });

  it("reproduces each CAD_COUNTIES entry exactly", () => {
    for (const [fips, cad] of Object.entries(CAD_COUNTIES)) {
      expect(getJurisdictionConfig(fips)?.cad).toBe(cad);
    }
  });

  it("reproduces each CAD_BULK_SOURCES entry exactly", () => {
    for (const [fips, src] of Object.entries(CAD_BULK_SOURCES)) {
      expect(getJurisdictionConfig(fips)?.bulkSource).toBe(src);
    }
  });

  it("attaches every ZONING_LAYERS entry to exactly its countyFips descriptor", () => {
    for (const layer of Object.values(ZONING_LAYERS)) {
      const j = getJurisdictionConfig(layer.countyFips);
      expect(j?.zoningLayers).toContain(layer);
    }
  });

  it("attaches a city's setback table wherever its zoning layer is attached", () => {
    for (const layer of Object.values(ZONING_LAYERS)) {
      const table = getSetbackTable(layer.cityKey);
      if (!table) continue; // city with a zoning layer but no setback table
      const j = getJurisdictionConfig(layer.countyFips);
      expect(j?.setbackTables).toContain(table);
    }
  });
});

describe("listJurisdictions / listJurisdictionFips", () => {
  it("covers the union of all FIPS-bearing registries, sorted, no gaps", () => {
    const expected = new Set<string>([
      ...Object.keys(TXGIO_COUNTIES),
      ...Object.keys(CAD_COUNTIES),
      ...Object.keys(CAD_BULK_SOURCES),
      ...Object.values(ZONING_LAYERS).map((z) => z.countyFips),
    ]);
    const fips = listJurisdictionFips();
    expect(fips).toEqual([...expected].sort());
    expect(fips).toEqual([...fips].sort()); // sorted
  });

  it("listJurisdictions returns one descriptor per known FIPS", () => {
    const list = listJurisdictions();
    expect(list.map((j) => j.fips)).toEqual(listJurisdictionFips());
    for (const j of list) {
      expect(getJurisdictionConfig(j.fips)).toEqual(j);
    }
  });

  it("every descriptor carries at least one registered facet (never an empty shell)", () => {
    for (const j of listJurisdictions()) {
      const hasFacet =
        j.geometry !== undefined ||
        j.cad !== undefined ||
        j.bulkSource !== undefined ||
        (j.zoningLayers?.length ?? 0) > 0;
      expect(hasFacet).toBe(true);
    }
  });
});

describe("unlinkedSetbackKeys — county-level / fallback tables not on a FIPS view", () => {
  it("lists exactly the setback keys no zoning layer links to a FIPS", () => {
    const linked = new Set(Object.values(ZONING_LAYERS).map((z) => z.cityKey));
    const expected = SETBACK_JURISDICTION_KEYS.filter(
      (k) => !linked.has(k),
    ).sort();
    expect(unlinkedSetbackKeys()).toEqual(expected);
  });

  it("includes the known county-level / unincorporated fallback tables", () => {
    const unlinked = unlinkedSetbackKeys();
    // These have no city zoning layer, so they are reached directly via
    // getSetbackTable, exactly as the CLIs do — not attached to a county.
    expect(unlinked).toContain("grand-county-ut");
    expect(unlinked).toContain("utah-unincorporated");
    expect(unlinked).toContain("idaho-unincorporated");
  });
});
