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
import {
  ZONING_LAYERS,
  canonicalZoningJurisdictionKey,
  resolveZoningJurisdiction,
  wiredZoningCityKeys,
} from "../txgio/zoning-layers";
import {
  getSetbackTable,
  getSetbackTableForZoning,
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

    // Dripping Springs, Buda, Kyle, and San Marcos are the Hays-county zoning
    // layers, in registry-declaration order.
    const haysCities = Object.values(ZONING_LAYERS).filter(
      (z) => z.countyFips === "48209",
    );
    expect(j.zoningLayers).toEqual(haysCities);
    expect(j.zoningLayers?.[0]).toBe(ZONING_LAYERS["dripping-springs-tx"]);
    expect(haysCities.map((c) => c.cityKey)).toEqual([
      "dripping-springs-tx",
      "buda-tx",
      "kyle-tx",
      "san-marcos-tx",
      // P-259 (2026-09-17): Austin's Hays-county layer. The registry declares
      // "austin-tx-hays" after the four Hays cities, so it lands last — same
      // cityKey as the Travis/Williamson entries, so a HALF of Austin inside
      // Hays county stamps as austin-tx, not as a county-less stub.
      "austin-tx",
    ]);

    // Setback tables: Dripping Springs, Buda, Kyle have real tables; San
    // Marcos has a stub table (empty districts[]) so it too resolves. Each is
    // the identical object getSetbackTable returns for that city.
    const ds = getSetbackTable("dripping-springs-tx");
    expect(ds).not.toBeNull();
    expect(j.setbackTables).toEqual(
      haysCities.map((c) => getSetbackTable(c.cityKey)),
    );
    expect(j.setbackTables?.[0]).toBe(ds);
  });

  it("Williamson (48491): orion CAD + open-fetch bulk + eight city zoning layers + their setbacks", () => {
    const j = getJurisdictionConfig("48491");
    if (!j) throw new Error("expected Williamson");

    expect(j.geometry).toBe(TXGIO_COUNTIES["48491"]);
    expect(j.cad).toBe(CAD_COUNTIES["48491"]);
    expect(j.bulkSource).toBe(CAD_BULK_SOURCES["48491"]);

    // Georgetown, Round Rock, Leander, Hutto, Cedar Park, Taylor, Liberty
    // Hill all target 48491 — in registry declaration order. P-259
    // (2026-09-17) appends Austin's Williamson-county entry, which is the
    // last declared.
    const expectedCities = Object.values(ZONING_LAYERS).filter(
      (z) => z.countyFips === "48491",
    );
    expect(j.zoningLayers).toEqual(expectedCities);
    expect(expectedCities.map((c) => c.cityKey)).toEqual([
      "georgetown-tx",
      "round-rock-tx",
      "leander-tx",
      "hutto-tx",
      "cedar-park-tx",
      "taylor-tx",
      "liberty-hill-tx",
      "austin-tx",
    ]);

    // Cedar Park's GIS-mappable districts carry ordinance-backed dimensions.
    // Taylor and Liberty Hill are cited tables (WDLL item 5) -- cited, not
    // empty: Taylor ships 6 place-type rows and Liberty Hill 14 rows.
    // P-258 lane-c (2026-09-16) moved Cedar Park 16 -> 17 districts (UR,
    // conservative envelope) and Pflugerville 10 -> 13 (CL3/CL4/CL5), so the
    // count assertions below carry this lane's numbers.
    expect(j.setbackTables).toEqual(
      expectedCities
        .map((c) => getSetbackTable(c.cityKey))
        .filter((t) => t !== null),
    );
    expect(j.setbackTables).toEqual([
      getSetbackTable("georgetown-tx"),
      getSetbackTable("round-rock-tx"),
      getSetbackTable("leander-tx"),
      getSetbackTable("hutto-tx"),
      getSetbackTable("cedar-park-tx"),
      getSetbackTable("taylor-tx"),
      getSetbackTable("liberty-hill-tx"),
      // P-259: Austin is the eighth city on this county view.
      getSetbackTable("austin-tx"),
    ]);
    const cedarPark = getSetbackTable("cedar-park-tx");
    expect(cedarPark?.districts).toHaveLength(17);
    expect(cedarPark?.districts.map((district) => district.district_name)).toEqual(
      expect.arrayContaining([
        "DR Development Reserve",
        "SR Suburban Residential",
        "MF Multifamily",
        "NB Neighborhood Business",
        "GB General Business",
        "LI Light Industrial",
      ]),
    );
    // P-258 lane-c: UR is no longer omitted. The note keeps the original
    // omission reasoning as history and points at the conservative-envelope
    // row, so both halves are asserted.
    expect(cedarPark?.note).toMatch(/UR was originally omitted/i);
    expect(cedarPark?.note).toMatch(
      /NOW ROWED AS A DOCUMENTED CONSERVATIVE ENVELOPE/i,
    );
    expect(
      cedarPark?.districts.some((d) => d.district_name.startsWith("UR ")),
    ).toBe(true);
    expect(getSetbackTable("taylor-tx")?.districts).toHaveLength(6);
    expect(getSetbackTable("taylor-tx")?.note).toMatch(/WDLL 51/i);
    expect(getSetbackTable("liberty-hill-tx")?.districts).toHaveLength(14);
    expect(getSetbackTable("liberty-hill-tx")?.note).toMatch(/WDLL 51/i);
  });

  it("Travis (48453): geometry + pacs CAD, no free bulk source; multi-city Austin+Pflugerville+Elgin zoning SET", () => {
    const j = getJurisdictionConfig("48453");
    if (!j) throw new Error("expected Travis");

    expect(j.geometry).toBe(TXGIO_COUNTIES["48453"]);
    expect(j.cad).toBe(CAD_COUNTIES["48453"]);
    // Travis/TCAD has no free bulk roll (PIA route) — honestly absent.
    expect(j.bulkSource).toBeUndefined();
    // Multi-city county: wired layers are a SET, never a sole-city assumption.
    const travisCities = Object.values(ZONING_LAYERS).filter(
      (z) => z.countyFips === "48453",
    );
    expect(j.zoningLayers).toEqual(travisCities);
    // "elgin-tx" appears here from the "elgin-tx-travis" registry entry
    // (CTX-ELGIN, P-124, 2026-09-08) — same cityKey as the Bastrop-side
    // Elgin entry, so it collapses into one set member, not a fourth city.
    expect(new Set(travisCities.map((c) => c.cityKey))).toEqual(
      new Set(["pflugerville-tx", "austin-tx", "elgin-tx"]),
    );
    const pflugerville = getSetbackTable("pflugerville-tx");
    const austin = getSetbackTable("austin-tx");
    // P-258 lane-c (2026-09-16): 10 -> 13 with the corridor rows CL3/CL4/CL5.
    expect(pflugerville?.districts).toHaveLength(13);
    expect(pflugerville?.note).toMatch(/GB1.*omitted/i);
    expect(austin?.districts.length).toBeGreaterThan(0);
    expect(j.setbackTables).toEqual(
      travisCities
        .map((c) => getSetbackTable(c.cityKey))
        .filter((t) => t !== null),
    );
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

describe("wiredZoningCityKeys + resolveZoningJurisdiction (per-parcel)", () => {
  it("Travis composes the SET {austin-tx, pflugerville-tx, elgin-tx}", () => {
    // elgin-tx added by the "elgin-tx-travis" registry entry (CTX-ELGIN,
    // P-124, 2026-09-08): layer 1 of the Elgin_Zoning FeatureServer, the
    // Travis-county-side sliver, wired to the same cityKey as the
    // Bastrop-side entry so it collapses into the set, not a fourth key.
    expect(wiredZoningCityKeys("48453")).toEqual(
      new Set(["austin-tx", "pflugerville-tx", "elgin-tx"]),
    );
  });

  it("Hays and Williamson return multi-city Sets (never a sole key)", () => {
    expect(wiredZoningCityKeys("48209").size).toBeGreaterThan(1);
    expect(wiredZoningCityKeys("48491").size).toBeGreaterThan(1);
  });

  it("Guadalupe / McLennan / Bell compose wired Sets (post-breadth zero re-probe)", () => {
    expect(wiredZoningCityKeys("48187")).toEqual(
      new Set(["seguin-tx", "cibolo-tx"]),
    );
    expect(wiredZoningCityKeys("48309")).toEqual(new Set(["waco-tx"]));
    expect(wiredZoningCityKeys("48027")).toEqual(
      new Set(["killeen-tx", "belton-tx"]),
    );
  });

  it("named Austin parcel resolves austin-tx from stamped PIP jurisdiction", () => {
    expect(
      resolveZoningJurisdiction({
        zoningJurisdiction: "austin-tx",
        situsCity: null,
        countyFips: "48453",
      }),
    ).toBe("austin-tx");
  });

  it("named Pflugerville parcel resolves pflugerville-tx from stamped PIP jurisdiction", () => {
    expect(
      resolveZoningJurisdiction({
        zoningJurisdiction: "pflugerville-tx",
        situsCity: null,
        countyFips: "48453",
      }),
    ).toBe("pflugerville-tx");
  });

  it("unincorporated / no match resolves null (honest fact)", () => {
    expect(
      resolveZoningJurisdiction({
        zoningJurisdiction: null,
        situsCity: null,
        countyFips: "48453",
      }),
    ).toBeNull();
  });

  it("situs_city is FALLBACK only when stamp is null (logs via callback)", () => {    const calls: string[] = [];
    expect(
      resolveZoningJurisdiction(
        {
          zoningJurisdiction: null,
          situsCity: "Austin",
          countyFips: "48453",
        },
        {
          onSitusFallback: ({ cityKey }) => {
            calls.push(cityKey);
          },
        },
      ),
    ).toBe("austin-tx");
    expect(calls).toEqual(["austin-tx"]);
    // Stamped PIP wins over a conflicting situs.
    expect(
      resolveZoningJurisdiction({
        zoningJurisdiction: "pflugerville-tx",
        situsCity: "Austin",
        countyFips: "48453",
      }),
    ).toBe("pflugerville-tx");
  });

  // -------------------------------------------------------------------------
  // P-273 control 3: the registry was validated and then ignored.
  //
  // The two branches this replaces were
  //
  //     if (stamped && ZONING_LAYERS[stamped]) return stamped;
  //     if (stamped) return stamped;
  //
  // — the same expression, so the registry test decided nothing that any
  // caller could observe, and an unregistered stamp was indistinguishable from
  // a routable one. The rule ("an unknown-but-stamped key still wins over a
  // situs guess") is kept deliberately: the stamp is PIP evidence of which
  // city the parcel is in, and nulling it would discard that evidence. What
  // changed is that the registry verdict is now REPORTED.
  // -------------------------------------------------------------------------
  describe("P-273: the registry verdict is observable", () => {
    it("an unregistered stamp fires onUnregisteredStamp and KEEPS the key (never nulled into a guess)", () => {
      const seen: Array<{ cityKey: string; countyFips: string }> = [];
      const key = resolveZoningJurisdiction(
        { zoningJurisdiction: "nowhere-tx", situsCity: "Austin", countyFips: "48453" },
        { onUnregisteredStamp: (info) => seen.push(info) },
      );
      expect(key).toBe("nowhere-tx");
      expect(seen).toEqual([{ cityKey: "nowhere-tx", countyFips: "48453" }]);
    });

    it("a REGISTERED stamp does not fire it — the control is not always-on", () => {
      const seen: string[] = [];
      const key = resolveZoningJurisdiction(
        { zoningJurisdiction: "austin-tx", situsCity: null, countyFips: "48453" },
        { onUnregisteredStamp: ({ cityKey }) => seen.push(cityKey) },
      );
      expect(key).toBe("austin-tx");
      expect(seen).toEqual([]);
      // ...and every cityKey in the registry is on the silent side of the
      // check, so a firing callback means the key really is unregistered.
      for (const registered of Object.values(ZONING_LAYERS)) {
        const fired: string[] = [];
        expect(
          resolveZoningJurisdiction(
            { zoningJurisdiction: registered.cityKey, situsCity: null, countyFips: registered.countyFips },
            { onUnregisteredStamp: ({ cityKey }) => fired.push(cityKey) },
          ),
        ).toBe(registered.cityKey);
        expect(fired).toEqual([]);
      }
    });

    it("an UNDERSCORE-normalized stamp is looked up in its hyphen form before the verdict", () => {
      const seen: string[] = [];
      // `zoning_jurisdiction` is stored underscore-normalized on some paths;
      // the check must still recognize a registered key rather than reporting
      // every such row as unregistered.
      const key = resolveZoningJurisdiction(
        { zoningJurisdiction: "austin_tx", situsCity: null, countyFips: "48453" },
        { onUnregisteredStamp: ({ cityKey }) => seen.push(cityKey) },
      );
      expect(key).toBe("austin-tx");
      expect(seen).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// P-406 (OPS-25, 2026-09-22) — A STAMPED VALUE RESOLVES THROUGH THE REGISTRY'S
// OWN `cityKey`, NOT THROUGH THE ENTRY'S NAME.
//
// `ZONING_LAYERS` is keyed by ENTRY NAME. An entry's `cityKey` is the
// jurisdiction it serves. The two strings are identical for 23 of the 26
// entries — which is what made the difference invisible — and differ for the
// three that carry one city across several counties:
//
//   elgin-tx-travis      -> elgin-tx      (Elgin:  48021 Bastrop + 48453 Travis)
//   austin-tx-williamson -> austin-tx     (Austin: 48453 Travis + 48491 Williamson)
//   austin-tx-hays       -> austin-tx     (        + 48209 Hays)
//
// The Travis Elgin entry exists precisely to perform that indirection (its own
// comment: `cityKey` is set to the literal `elgin-tx` so `stampCountyZoning`
// persists the string `isElginCityJurisdiction` routes on). A consumer that
// received the ENTRY NAME instead shipped it as the table key, walked past the
// indirection, and refused `no-district` on `48453:959606` while PROD drew it
// R-3 — measured live 2026-09-22.
//
// The rule is one registry read, in the registry's own module: the value's own
// form first, its hyphen form second, the entry's `cityKey` out, same
// separator convention back. Everything that names no entry returns
// byte-identically, so this cannot re-key a parcel that works today.
// ---------------------------------------------------------------------------
describe("canonicalZoningJurisdictionKey — a stamped value resolves through the entry's cityKey (P-406)", () => {
  it("maps EVERY registry entry name to that entry's own cityKey — no entry name can leak out as a key", () => {
    expect(Object.keys(ZONING_LAYERS).length).toBeGreaterThan(20);
    for (const [entryName, config] of Object.entries(ZONING_LAYERS)) {
      expect(canonicalZoningJurisdictionKey(entryName), entryName).toBe(
        config.cityKey,
      );
    }
  });

  it("is NOT VACUOUS: exactly three entry names name a jurisdiction other than themselves", () => {
    // If this set ever empties, the translation above becomes a no-op that
    // proves nothing — so the three entries it exists for are named here, and
    // a fourth multi-county entry is welcome (it is covered by the invariant
    // above) but must arrive with its own county wiring, not silently.
    const translated = Object.entries(ZONING_LAYERS)
      .filter(([entryName, config]) => entryName !== config.cityKey)
      .map(([entryName, config]) => [entryName, config.cityKey])
      .sort((a, b) => a[0]!.localeCompare(b[0]!));
    expect(translated).toEqual([
      ["austin-tx-hays", "austin-tx"],
      ["austin-tx-williamson", "austin-tx"],
      ["elgin-tx-travis", "elgin-tx"],
    ]);
  });

  it("VERIFY BY VIOLATION: the entry name reaches no table, the resolved cityKey reaches the ratified Elgin one", () => {
    // `48453:959606` (Elgin, Travis side), district R-3. The pre-fix key is the
    // entry name exactly as the canary shipped it:
    expect(getSetbackTableForZoning("elgin-tx-travis", "R-3")).toBeNull();

    const resolved = canonicalZoningJurisdictionKey("elgin-tx-travis");
    expect(resolved).toBe("elgin-tx");
    // The cityKey is what the Elgin route in lib/adapters checks for...
    const table = getSetbackTableForZoning(resolved!, "R-3");
    expect(table).not.toBeNull();
    // ...and it lands on the ratified Elgin development-code table — the same
    // table the Bastrop-side cohort serves.
    expect(table).toBe(getSetbackTableForZoning("elgin-tx", "R-3"));
    expect(table).toBe(getSetbackTable("elgin-development-code"));
    // PROD's own answer for 48453:959606: R-3 -> 15 / 7.5 / 10 / 15.
    const r3 = table!.districts.find((d) => d.district_name.startsWith("R-3 "));
    expect(r3).toMatchObject({
      front_ft: 15,
      side_ft: 7.5,
      rear_ft: 10,
      side_corner_ft: 15,
    });
  });

  it("carries the same rule to the other two multi-county entries", () => {
    for (const [entryName, cityKey] of [
      ["austin-tx-williamson", "austin-tx"],
      ["austin-tx-hays", "austin-tx"],
      // The Bastrop-side Elgin entry is already the literal cityKey, so the
      // rule must leave it exactly where it is.
      ["elgin-tx", "elgin-tx"],
      ["austin-tx", "austin-tx"],
    ] as const) {
      expect(canonicalZoningJurisdictionKey(entryName), entryName).toBe(cityKey);
    }
    // Williamson's Travis-adjacent Austin row is reached through the shared
    // key, so the translation lands the parcel on the same table as Austin.
    expect(
      getSetbackTableForZoning(
        canonicalZoningJurisdictionKey("austin-tx-williamson")!,
        "SF-3",
      ),
    ).toBe(getSetbackTableForZoning("austin-tx", "SF-3"));
  });

  it("also reads an entry name written underscore-normalized, in that same convention", () => {
    // No current writer emits this — `resolveZoningJurisdiction` hyphenates
    // before it returns — but the record-rail reader (`readKey`) does not
    // normalize separators, so the spelling is accepted rather than dropped.
    // A LOOKUP falling back to the hyphen form must never re-spell a value
    // that already named an entry, which is why the fallback runs one way only.
    expect(canonicalZoningJurisdictionKey("elgin_tx_travis")).toBe("elgin_tx");
    expect(getSetbackTableForZoning("elgin_tx_travis", "R-3")).toBeNull();
    expect(
      getSetbackTableForZoning(
        canonicalZoningJurisdictionKey("elgin_tx_travis")!,
        "R-3",
      ),
    ).toBe(getSetbackTable("elgin-development-code"));
  });

  it("is a NO-OP for every key that names no entry — every table key, and every cityKey", () => {
    // The whole setback-table namespace: each one must come back byte-identical,
    // which is what makes this fix unable to re-key a parcel that works today.
    for (const tableKey of SETBACK_JURISDICTION_KEYS) {
      expect(canonicalZoningJurisdictionKey(tableKey), tableKey).toBe(tableKey);
    }
    // And every cityKey already declared, including the three shared ones.
    for (const config of Object.values(ZONING_LAYERS)) {
      expect(canonicalZoningJurisdictionKey(config.cityKey), config.cityKey).toBe(
        config.cityKey,
      );
    }
    // Cities with no layer at all, and the shapes a situs city can synthesise.
    for (const key of ["nowhere-tx", "lakeway-tx", "robinson-tx", "elgin_tx"]) {
      expect(canonicalZoningJurisdictionKey(key), key).toBe(key);
    }
  });

  it("trims, lowercases, and invents nothing", () => {
    expect(canonicalZoningJurisdictionKey("  Elgin-TX-Travis  ")).toBe("elgin-tx");
    expect(canonicalZoningJurisdictionKey("ELGIN-TX")).toBe("elgin-tx");
    expect(canonicalZoningJurisdictionKey(null)).toBeNull();
    expect(canonicalZoningJurisdictionKey(undefined)).toBeNull();
    expect(canonicalZoningJurisdictionKey("")).toBeNull();
    expect(canonicalZoningJurisdictionKey("   ")).toBeNull();
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
