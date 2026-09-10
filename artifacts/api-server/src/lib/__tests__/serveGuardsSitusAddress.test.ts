/**
 * P-124 CTX-B6 (2026-09-10): the shared situs-address classification.
 *
 * `classifyRawSitusAddress` is the ONE predicate every producer of
 * `baseFacts.situsAddress` runs (the bake CLI's `situsForBake`, the builder's
 * `situsAddressLeaf`). Before it, the bake, the CLI and the serve guard were
 * three independent answers to one question, and the widest of the three
 * still admitted `", TX 78756"` -- served as a paying customer's address on
 * 146,494 Travis rows and 696 McLennan ones.
 *
 * THE CONTAINMENT OBLIGATION. hauska-factory's own S1 grade
 * (`src/stages/grade/s-rules.mjs` `isSentinelSitus`) already detected part of
 * this population with two regexes. One rule with two implementations in two
 * repos is the CTRL-1 shape, and this repo cannot edit hauska-factory, so the
 * available control is the containment test below: those two regexes are
 * carried here as FIXTURES, and every string either of them matches must be
 * refused by `classifyRawSitusAddress`. If hauska-factory widens its regexes
 * and nobody widens this file, this test does NOT catch it -- a single source
 * of truth across the two repos is filed as a leave-behind and this test is
 * the interim, one-directional guard.
 *
 * The containment also holds on real data: over all 1,505,610 stored tier-1
 * rows in the six CTX counties (staging, read-only, 2026-09-10) there is not
 * one row where an S1 regex matches and this predicate says the string
 * carries a street. In the other direction the predicate is strictly wider:
 * the S1 pair catches 124,319 of the 147,199 street-less rows (84.5%), and
 * the 22,880 it misses are shapes like `", TX"` (22,039 Travis rows) and
 * `", WACO, TX 76705"` (McLennan) that neither regex was written for.
 */
import { describe, expect, it } from "vitest";
import {
  classifyRawSitusAddress,
  situsCarriesStreetComponent,
  situsStreetSegment,
  type RawSitusAddressClass,
} from "../serveGuards";

/** VERBATIM from hauska-factory src/stages/grade/s-rules.mjs (read 2026-09-10 at origin/main 83c98f97). */
const FACTORY_SENTINEL_EMPTY_COMMAS = /^,\s*,/;
const FACTORY_SENTINEL_STATE_ZIP_ONLY = /^,\s*TX\s+\d{5}/i;
function factoryIsSentinelSitus(situs: string): boolean {
  const s = String(situs).trim();
  if (s === "") return false;
  return FACTORY_SENTINEL_EMPTY_COMMAS.test(s) || FACTORY_SENTINEL_STATE_ZIP_ONLY.test(s);
}

const kindOf = (raw: string | null | undefined): RawSitusAddressClass["kind"] =>
  classifyRawSitusAddress(raw).kind;

describe("CTX-B6 situs address classification", () => {
  it("reads the segment before the first comma, which is what it claims to read", () => {
    expect(situsStreetSegment("4709 SHOALWOOD AVE")).toBe("4709 SHOALWOOD AVE");
    expect(situsStreetSegment("908 PINE , BASTROP, TX 78602")).toBe("908 PINE");
    expect(situsStreetSegment(", TX 78756")).toBe("");
    expect(situsStreetSegment(", , AUSTIN, TX 78756")).toBe("");
  });

  it("blank, usable and unusable are three kinds, never one bad bucket", () => {
    expect(kindOf(null)).toBe("blank");
    expect(kindOf(undefined)).toBe("blank");
    expect(kindOf("")).toBe("blank");
    expect(kindOf("   ")).toBe("blank");
    expect(kindOf("4709 SHOALWOOD AVE")).toBe("usable");
    expect(kindOf(", TX 78756")).toBe("unusable");
    expect(kindOf(", ,")).toBe("unusable");
  });

  it("the reason distinguishes a placeholder from a lost street", () => {
    const punct = classifyRawSitusAddress(", ,");
    const noStreet = classifyRawSitusAddress(", TX 78756");
    expect(punct).toEqual({ kind: "unusable", reason: "punctuation-only", raw: ", ," });
    expect(noStreet).toEqual({
      kind: "unusable",
      reason: "no-street-component",
      raw: ", TX 78756",
    });
  });

  it("the raw value is carried VERBATIM, untrimmed, so an absence can quote it", () => {
    const c = classifyRawSitusAddress("  , TX 78756  ");
    expect(c).toMatchObject({ kind: "unusable", raw: "  , TX 78756  " });
  });

  it("a usable address is trimmed and otherwise byte-identical", () => {
    expect(classifyRawSitusAddress("  908 PINE , BASTROP, TX 78602 ")).toEqual({
      kind: "usable",
      value: "908 PINE , BASTROP, TX 78602",
    });
  });

  /**
   * The measured live shapes, each with the county it was found in. These are
   * not invented fixtures: every string here was read out of
   * place_layer_snapshots on 2026-09-10.
   */
  it("refuses every street-less shape measured live in the six CTX counties", () => {
    for (const raw of [
      ", TX 78756", // Travis, 123,120 rows on this regex family
      ", TX", // Travis, 22,039 rows -- neither factory regex matches this
      ", TX 0", // Travis, 75 rows -- a degenerate ZIP
      ", WACO, TX 76705", // McLennan, 157 rows -- a city and a ZIP, no street
      ", LORENA, TX 76655", // McLennan
      ", CHINA SPRING, TX 76633", // McLennan
      ", ,", // Bastrop/Hays/McLennan, the CTX-SITUS-SKIP population
      ", , BASTROP, TX 78602", // Bastrop, the ", ," family with locality
      ",,",
      " , , ",
    ]) {
      expect(kindOf(raw)).toBe("unusable");
    }
  });

  it("leaves every real address alone, including the range forms a stricter rule would destroy", () => {
    for (const raw of [
      "4709 SHOALWOOD AVE", // Travis 224793, the 2026 PACS roll's own value
      "908 PINE , BASTROP, TX 78602", // the live Bastrop gold form
      "2610, 2612 S 1 ST", // Travis: a RANGE. Its first segment is a bare
      "720,729 NOMAD DR", // house number with no letters -- a rule demanding
      "4701,4703 SHOAL CREEK BLVD", // letters in the street segment would refuse
      "5237, 5241 N LAMAR BLVD", // ten real addresses to catch six junk ones.
      "1 MAIN ST",
    ]) {
      expect(kindOf(raw)).toBe("usable");
    }
  });

  /**
   * THE RESIDUE, named rather than hidden. Six Travis rows carry a lone token
   * before the comma and no street name: "D , TX 78617" (2), "CA , TX 78758",
   * "349564 , TX 78645", "58818 , TX 78645", "18829". They pass as usable,
   * deliberately: refusing them needs a "the street segment must contain a
   * letter" rule, which would refuse the ten real range addresses above, and
   * ruling A1 forbids converting usable data into an absence. Six of 500,307
   * Travis rows. This test exists so the residue is a counted, tested
   * decision and not an oversight somebody rediscovers.
   */
  it("declared residue: a lone house-number-like token still counts as a street component", () => {
    expect(kindOf("D , TX 78617")).toBe("usable");
    expect(kindOf("349564 , TX 78645")).toBe("usable");
    expect(kindOf("18829")).toBe("usable");
  });

  it("CONTAINMENT: every string hauska-factory's S1 sentinel regexes match is refused here", () => {
    const sentinels = [
      ", ,",
      ",,",
      ", , AUSTIN, TX 78756",
      ", TX 78756",
      ",TX 78756",
      ", tx 78756",
      ", TX 78756 SUITE 4",
    ];
    for (const raw of sentinels) {
      // the fixture is a real sentinel by the factory's own rule ...
      expect(factoryIsSentinelSitus(raw)).toBe(true);
      // ... and this predicate refuses it. Containment in the direction that
      // matters: the factory can never grade a row a sentinel that this
      // predicate let through as a value.
      expect(kindOf(raw)).toBe("unusable");
    }
  });

  it("CONTAINMENT is verified by violation: a non-sentinel that this predicate WOULD refuse proves the test is not vacuous", () => {
    // If the containment test could only ever see strings both sides refuse,
    // it would pass on a broken predicate. This is the asymmetry: a string the
    // factory does NOT call a sentinel and this predicate still refuses.
    expect(factoryIsSentinelSitus(", TX")).toBe(false);
    expect(kindOf(", TX")).toBe("unusable");
    expect(factoryIsSentinelSitus(", WACO, TX 76705")).toBe(false);
    expect(kindOf(", WACO, TX 76705")).toBe("unusable");
    // And a real address is refused by neither, so the predicate is not
    // trivially refusing everything.
    expect(factoryIsSentinelSitus("4709 SHOALWOOD AVE")).toBe(false);
    expect(kindOf("4709 SHOALWOOD AVE")).toBe("usable");
  });

  it("situsCarriesStreetComponent is the whole rule and can be read on its own", () => {
    expect(situsCarriesStreetComponent("4709 SHOALWOOD AVE")).toBe(true);
    expect(situsCarriesStreetComponent(", TX 78756")).toBe(false);
    expect(situsCarriesStreetComponent(", ,")).toBe(false);
  });
});
