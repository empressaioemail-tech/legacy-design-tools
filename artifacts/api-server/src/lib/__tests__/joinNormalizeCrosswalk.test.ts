/**
 * P-124 CTX-HAYS-REBIND: the published-identifier crosswalk join key.
 *
 * Every fixture here is a REAL row, read on 2026-09-10 from the county's own
 * public export (2026-PROPERTY-DATA-EXPORT-FILES-AS-OF-8-26-2026.zip) and from
 * `txgio_parcel` on the staging Neon branch, read-only. Nothing is invented,
 * because a fixture invented to make a join agree is exactly the defect that
 * put the WCAD ag-valuation join on the wrong column
 * (`fix(cad-ingest): join tx_wcad_ag_valuation on wcad_property_id, not prop_id`).
 *
 * THE WORKED PAIR, verbatim from both sources:
 *
 *   CAD account 40138  QuickRefID R26199   PropertyNumber 11-2520-0000-03100-2
 *                      situs 340 WINDMILL WAY, BUDA        market 172,700
 *   CAD account 26199  QuickRefID R117015  PropertyNumber 11-2242-000I-02900-2
 *                      situs 134 LEAR AVE, BUDA            market 426,950
 *
 *   txgio_parcel 48209 feature 57725  prop_id 26199   geo_id 11-2520-0000-03100-2
 *                                     situs 340 WINDMILL WAY, BUDA
 *   txgio_parcel 48209 feature 40337  prop_id 117015  geo_id 11-2242-000I-02900-2
 *                                     situs 134 LEAR AVE, BUDA
 *
 * So TxGIO parcel 26199 IS CAD account 40138, and node:48209:26199 is served
 * feature 57725 on production today: another parcel's polygon.
 */

import { describe, expect, it } from "vitest";
import {
  addressJoinKey,
  cadAccountNumberStem,
  crosswalkBindCorroborated,
  landUseJoinKey,
  LANDUSE_JOIN_DISABLED_FIPS_SEED,
  parcelCrosswalkJoinKey,
} from "../joinNormalize";

const HAYS = "48209";
const WILLIAMSON = "48491";
const TRAVIS = "48453";
const BASTROP = "48021";

describe("parcelCrosswalkJoinKey", () => {
  it("returns the county's published Geographic ID for a gate-blocked county", () => {
    expect(parcelCrosswalkJoinKey(HAYS, "11-2520-0000-03100-2")).toBe(
      "11-2520-0000-03100-2",
    );
  });

  it("trims, and does not otherwise normalize a published identifier", () => {
    expect(parcelCrosswalkJoinKey(HAYS, "  11-2242-000I-02900-2  ")).toBe(
      "11-2242-000I-02900-2",
    );
    // The letter in 000I is real (Hays account 26199's own PropertyNumber) and
    // must survive verbatim. Uppercasing or stripping punctuation here would
    // silently widen the key space the way normalizeSitusAddress deliberately
    // does for an address -- and an identifier is not an address.
    expect(parcelCrosswalkJoinKey(HAYS, "11-2242-000i-02900-2")).toBe(
      "11-2242-000i-02900-2",
    );
  });

  it("REFUSES for a county whose prop_id join is not gate-blocked", () => {
    // Travis and Bastrop join correctly on prop_id. A second join there could
    // only add a way to be wrong; this mirrors addressJoinKey's inversion.
    expect(parcelCrosswalkJoinKey(TRAVIS, "0207030616")).toBeNull();
    expect(parcelCrosswalkJoinKey(BASTROP, "R34137")).toBeNull();
    // ...and the sibling keys behave the opposite way on the same county,
    // which is what proves this scoping is the intended inversion and not a
    // copy-paste of landUseJoinKey.
    expect(landUseJoinKey(TRAVIS, "0207030616")).toBe("207030616");
    expect(addressJoinKey(TRAVIS, "908 PINE ST")).toBeNull();
  });

  it("refuses a null, undefined, blank or whitespace identifier", () => {
    for (const v of [null, undefined, "", "   ", "\t"]) {
      expect(parcelCrosswalkJoinKey(HAYS, v)).toBeNull();
    }
  });

  it("honours a caller-supplied blocked set rather than the seed alone", () => {
    // The seed holds 48209 and 48491. A ledger-driven set that does not is
    // authoritative, because the block decision is a parameter and never a
    // county literal.
    expect(parcelCrosswalkJoinKey(HAYS, "11-2520-0000-03100-2", new Set())).toBeNull();
    expect(
      parcelCrosswalkJoinKey(TRAVIS, "0207030616", new Set([TRAVIS])),
    ).toBe("0207030616");
    expect(LANDUSE_JOIN_DISABLED_FIPS_SEED.has(HAYS)).toBe(true);
    expect(LANDUSE_JOIN_DISABLED_FIPS_SEED.has(WILLIAMSON)).toBe(true);
  });

  it("WILLIAMSON: a key alone binds nothing, because the index side is empty", () => {
    // WCAD's Socrata property dataset DOES publish a propertynumber (real row:
    // propertyid 63514, quickrefid R002338, propertynumber
    // R-17-W338-401P-0013-0006), so after a Williamson re-ingest this function
    // WILL return a key for that county. That is not the thing that keeps
    // Williamson unchanged.
    expect(parcelCrosswalkJoinKey(WILLIAMSON, "R-17-W338-401P-0013-0006")).toBe(
      "R-17-W338-401P-0013-0006",
    );
    // What keeps it unchanged is that txgio_parcel 48491 carries ZERO
    // non-blank geo_id across 304,298 rows (staging, read-only, 2026-09-10),
    // so the index this key is looked up in has no entries. Modelled here as
    // an empty index; the CLI proves the same thing by skipping the
    // corroborator fetch entirely when the geo_id index comes back empty.
    const emptyGeoIdIndex = new Map<string, number>();
    const key = parcelCrosswalkJoinKey(WILLIAMSON, "R-17-W338-401P-0013-0006");
    expect(emptyGeoIdIndex.get(key as string)).toBeUndefined();
    expect(crosswalkBindCorroborated(undefined, 12345)).toBe(false);
  });
});

describe("cadAccountNumberStem", () => {
  it("strips the account-class prefix and leading zeros", () => {
    expect(cadAccountNumberStem("R26199")).toBe("26199");
    expect(cadAccountNumberStem("R117015")).toBe("117015");
    expect(cadAccountNumberStem("M12214")).toBe("12214");
    expect(cadAccountNumberStem("R000042")).toBe("42");
    expect(cadAccountNumberStem("  R26199 ")).toBe("26199");
  });

  it("NON-VACUITY: the stem is not the input, on the case the finding rests on", () => {
    // If this ever returned its input, the whole corroboration would be
    // comparing a value with itself and would agree by construction.
    expect(cadAccountNumberStem("R26199")).not.toBe("R26199");
    expect(cadAccountNumberStem("R26199")).not.toBe("40138");
  });

  it("REFUSES a bare-numeric value, so a PropertyID cannot corroborate itself", () => {
    // cad_property.prop_id IS bare-numeric. If this accepted one, an account
    // with no QuickRefID would corroborate the crosswalk using the very key
    // whose collision caused the defect.
    expect(cadAccountNumberStem("26199")).toBeNull();
    expect(cadAccountNumberStem("0")).toBeNull();
  });

  it("refuses anything that is not <letters><digits>", () => {
    for (const v of [null, undefined, "", "  ", "R", "R-17-W338", "12-34", "PRIVATE ROAD"]) {
      expect(cadAccountNumberStem(v)).toBeNull();
    }
  });
});

describe("crosswalkBindCorroborated", () => {
  it("BINDS when both published identifiers name the same parcel", () => {
    // Real: CAD 40138's PropertyNumber and its QuickRefID stem both resolve to
    // txgio feature 57725.
    expect(crosswalkBindCorroborated(57725, 57725)).toBe(true);
  });

  it("BINDS when the corroborator found nothing", () => {
    // 1,042 real Hays R accounts reach a geo_id parcel that the account-number
    // path does not reach, and 8,388 more reach neither. An absent
    // corroborator is not evidence against the bind, and treating it as such
    // would withdraw correct geometry.
    expect(crosswalkBindCorroborated(57725, null)).toBe(true);
    expect(crosswalkBindCorroborated(57725, undefined)).toBe(true);
  });

  it("REFUSES when the two identifiers name DIFFERENT parcels", () => {
    // THE BRANCH THAT MATTERS. It fires ZERO times on Hays today (115,035 of
    // 115,035 binds corroborate), and a control observed only passing has not
    // been observed working. This is the violation: two published identifiers
    // disagreeing must refuse, never pick a winner.
    expect(crosswalkBindCorroborated(57725, 40337)).toBe(false);
    expect(crosswalkBindCorroborated(40337, 57725)).toBe(false);
  });

  it("REFUSES when there is no geo_id bind at all", () => {
    // A corroborator on its own is not a bind: the bare-numeric account stem
    // is precisely the key class this change refuses to bind on.
    expect(crosswalkBindCorroborated(null, 57725)).toBe(false);
    expect(crosswalkBindCorroborated(undefined, undefined)).toBe(false);
  });

  it("does not treat feature index 0 as absent", () => {
    // A falsy-vs-nullish bug here would silently refuse (or silently accept)
    // the first feature of a county's shapefile.
    expect(crosswalkBindCorroborated(0, 0)).toBe(true);
    expect(crosswalkBindCorroborated(0, 1)).toBe(false);
  });
});
