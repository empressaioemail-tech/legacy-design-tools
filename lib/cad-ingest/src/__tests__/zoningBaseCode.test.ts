/**
 * Base-code parser tests (P-259): the Austin finding, the longest-match rule,
 * and the two ways a wrong district could get in instead of a parse —
 * truncation, and calling an interim or overlay family a district.
 *
 * Every value asserted here is LIVE data from the fixture
 * (`austin-zoning-ztype.json`, read anonymously from source: see its
 * `.source.fetchedAt`, `.source.listQuery` and `.samplingRule`). This file
 * never re-fetches, so a red test is a fact about the code, not about the
 * network. The fixture's `allDistinctValues` is the WHOLE published vocabulary
 * — 558 group-by rows / 22,504 polygons at that fetch, of which 557 rows carry
 * a named value (22,502 polygons) and the null row carries 2 — which is the
 * denominator the unrecognised list travels with.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  baseCodePrefixes,
  normalizeBaseCode,
  parseBaseCode,
  type BaseCodeKind,
  type BaseCodeParseConfig,
} from "../txgio/zoning-base-code";
import {
  AUSTIN_BASE_CODES,
  AUSTIN_INTERIM_QUALIFIERS,
  PLANNED_DEVELOPMENT_FLAGS,
  PLANNED_DEVELOPMENT_PATTERN,
  ZONING_LAYERS,
  wiredZoningCityKeys,
} from "../txgio/zoning-layers";
import {
  assertWgs84Frame,
  fetchZoningLayerMeta,
  reduceZoningFeature,
} from "../txgio/zoning-service";
import { buildZoningIndex, zoningCodeAtPoint } from "../txgio/zoning-stamp";
import { layerParseAudit } from "../txgio/zoning-cli";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): string => join(here, "__fixtures__", name);

interface ZtypeFixture {
  source: {
    layerUrl: string;
    codeField: string;
    fetchedAt: string;
    listQuery: string;
    layerName: string;
    featureCount: number;
    maxRecordCount: number;
    spatialReference: { wkid: number; latestWkid: number };
    lastEditDate: string;
  };
  samplingRule: string;
  sampledValues: { value: string; polygons: number }[];
  a164NamedCompoundCodes: string[];
  allDistinctValues: { value: string | null; polygons: number }[];
}

const FIXTURE = JSON.parse(
  readFileSync(fx("austin-zoning-ztype.json"), "utf8"),
) as ZtypeFixture;

const AUSTIN: BaseCodeParseConfig = {
  knownBaseCodes: AUSTIN_BASE_CODES,
  plannedDevelopmentPattern: PLANNED_DEVELOPMENT_PATTERN,
  plannedDevelopmentFlags: PLANNED_DEVELOPMENT_FLAGS,
  interimQualifiers: AUSTIN_INTERIM_QUALIFIERS,
};

/** The setback table the vocabulary must equal — read at source, not assumed. */
interface SetbackTable {
  jurisdictionKey: string;
  districts: { district_name: string }[];
}
const SETBACK_TABLE = JSON.parse(
  readFileSync(
    join(here, "..", "..", "..", "adapters", "src", "local", "setbacks", "austin-tx.json"),
    "utf8",
  ),
) as SetbackTable;

/** `districtCode()` in buildableEnvelope/districtMapping.ts, transposed 1:1. */
const tableDistrictCode = (districtName: string): string =>
  normalizeBaseCode(districtName.trim().split(/\s+/)[0] ?? "");

const kindOf = (value: string): BaseCodeKind => parseBaseCode(value, AUSTIN).kind;
const baseOf = (value: string): string | null => parseBaseCode(value, AUSTIN).base;

interface Expectation {
  kind: BaseCodeKind;
  base: string | null;
  overlays?: string[];
  /** P-259b: a declared interim qualifier was recognised on the value. */
  interim?: boolean;
}

/** The three compound codes A-164 names by hand, with what each one must yield. */
const A164: { value: string; expected: Expectation }[] = [
  {
    value: "SF-3-HD-NP",
    expected: { kind: "base", base: "SF-3", overlays: ["HD", "NP"] },
  },
  {
    value: "MF-4-H-CO",
    expected: { kind: "base", base: "MF-4", overlays: ["H", "CO"] },
  },
  {
    value: "CS-1-MU-V-NCCD-ETOD-DBETOD-NP",
    expected: {
      kind: "base",
      base: "CS-1",
      overlays: ["MU", "V", "NCCD", "ETOD", "DBETOD", "NP"],
    },
  },
];

/**
 * The live top-24 sample (`sampledValues`), each with the district the parser
 * must produce. This is the fixture: it fails if a rule changes, and it is
 * written against values the layer actually publishes today.
 */
const LIVE_SAMPLE: Record<string, Expectation> = {
  "SF-3-NP": { kind: "base", base: "SF-3", overlays: ["NP"] },
  "SF-2": { kind: "base", base: "SF-2", overlays: [] },
  "SF-3": { kind: "base", base: "SF-3", overlays: [] },
  PUD: { kind: "planned-development", base: null, overlays: [] },
  // The interim family (P-259b). These three are the load-bearing LIVE cases:
  // each has a REAL district one token in (SF-2 / RR / SF-4A), so the old
  // reading either left them unstamped or (had it truncated) would have written
  // a district — the value now reads as its base with the interim fact carried.
  "I-SF-2": { kind: "base", base: "SF-2", overlays: [], interim: true },
  "SF-1": { kind: "base", base: "SF-1", overlays: [] },
  "SF-2-NP": { kind: "base", base: "SF-2", overlays: ["NP"] },
  GR: { kind: "base", base: "GR", overlays: [] },
  "I-RR": { kind: "base", base: "RR", overlays: [], interim: true },
  "SF-4A": { kind: "base", base: "SF-4A", overlays: [] },
  CS: { kind: "base", base: "CS", overlays: [] },
  P: { kind: "base", base: "P", overlays: [] },
  "GR-CO": { kind: "base", base: "GR", overlays: ["CO"] },
  "P-NP": { kind: "base", base: "P", overlays: ["NP"] },
  LO: { kind: "base", base: "LO", overlays: [] },
  "MF-3-NP": { kind: "base", base: "MF-3", overlays: ["NP"] },
  "GR-NP": { kind: "base", base: "GR", overlays: ["NP"] },
  DR: { kind: "base", base: "DR", overlays: [] },
  "CS-NP": { kind: "base", base: "CS", overlays: ["NP"] },
  "I-SF-4A": { kind: "base", base: "SF-4A", overlays: [], interim: true },
  "CS-MU-CO-NP": { kind: "base", base: "CS", overlays: ["MU", "CO", "NP"] },
  RR: { kind: "base", base: "RR", overlays: [] },
  "SF-3-CO-NP": { kind: "base", base: "SF-3", overlays: ["CO", "NP"] },
  "MF-2-NP": { kind: "base", base: "MF-2", overlays: ["NP"] },
};

/** Every live value with its parse, for the whole-vocabulary assertions. */
const ALL_PARSED = FIXTURE.allDistinctValues.filter(
  (v): v is { value: string; polygons: number } =>
    typeof v.value === "string" && v.value.trim().length > 0,
).map((v) => ({ value: v.value, polygons: v.polygons, parse: parseBaseCode(v.value, AUSTIN) }));

describe("the fixture is provenance, not decoration", () => {
  it("carries the live fetch time, the query that produced it and the layer's own identity", () => {
    expect(Date.parse(FIXTURE.source.fetchedAt)).not.toBeNaN();
    expect(FIXTURE.source.listQuery).toContain("groupByFieldsForStatistics=ZONING_ZTYPE");
    expect(FIXTURE.source.codeField).toBe("ZONING_ZTYPE");
    expect(FIXTURE.source.layerName).toBe("Zoning (Large Map Scale)");
    expect(FIXTURE.source.spatialReference.wkid).toBe(102739);
    expect(FIXTURE.source.spatialReference.latestWkid).toBe(2277);
    expect(FIXTURE.source.featureCount).toBe(22504);
    expect(Date.parse(FIXTURE.source.lastEditDate)).not.toBeNaN();
  });

  it("samples at least 20 real values (the dispatch's floor) and names its sampling rule", () => {
    expect(FIXTURE.sampledValues.length).toBeGreaterThanOrEqual(20);
    expect(FIXTURE.samplingRule).toContain("ordered by polygon count descending");
  });

  it("names every compound code A-164 names, and each one appears in the fixture vocabulary", () => {
    expect(FIXTURE.a164NamedCompoundCodes).toEqual([
      "SF-3-HD-NP",
      "MF-4-H-CO",
      "CS-1-MU-V-NCCD-ETOD-DBETOD-NP",
    ]);
    // The third is the load-bearing one and does not appear in the top-24 sample,
    // so it is taken from the A-164 finding itself (measured 2026-09-15).
    expect(FIXTURE.a164NamedCompoundCodes.length).toBe(3);
  });

  it("covers the whole published vocabulary with polygon counts that sum to the layer's feature count", () => {
    expect(FIXTURE.allDistinctValues.length).toBe(558);
    const summed = FIXTURE.allDistinctValues.reduce((s, v) => s + v.polygons, 0);
    expect(summed).toBe(FIXTURE.source.featureCount);
    // Exactly one group publishes nothing (2 polygons). Named here because it is
    // the one part of the layer the parser cannot speak about: those polygons
    // are dropped from the PIP index, so a parcel inside one is counted in the
    // stamp's "no zoning polygon" bucket, and the audit line sizes it.
    const empty = FIXTURE.allDistinctValues.filter(
      (v) => v.value === null || String(v.value).trim().length === 0,
    );
    expect(empty.length).toBe(1);
    expect(empty[0]!.polygons).toBe(2);
  });
});

describe("the vocabulary cannot drift from the setback table it must hit", () => {
  it("equals austin-tx.json's district-code set exactly, normalized the way the router normalizes", () => {
    // The router (buildableEnvelope/districtMapping.ts) matches an exact
    // normalized code before any prefix fallback, and normalizes with
    // `upper + strip non-alphanumeric`. If this set equality holds, every base
    // this parser can return exact-matches a row.
    const fromTable = new Set(SETBACK_TABLE.districts.map((d) => tableDistrictCode(d.district_name)));
    const fromConfig = new Set(AUSTIN_BASE_CODES.map(normalizeBaseCode));
    expect(fromConfig).toEqual(fromTable);
    expect(AUSTIN_BASE_CODES.length).toBe(37);
    expect(SETBACK_TABLE.districts.length).toBe(37);
  });

  it("has no vocabulary entry that is a prefix of another WITHOUT the longer one winning (CS vs CS-1)", () => {
    // The pair that makes the longest-match rule load-bearing: both are rows.
    const codes = new Set(AUSTIN_BASE_CODES.map(normalizeBaseCode));
    expect(codes.has("CS")).toBe(true);
    expect(codes.has("CS1")).toBe(true);
    expect(baseOf("CS-1-MU-V-NCCD-ETOD-DBETOD-NP")).toBe("CS-1");
    expect(baseOf("CS-MU-CO-NP")).toBe("CS");
  });

  it("normalizes each vocabulary member to itself (the parser's own output re-parses unchanged)", () => {
    for (const code of AUSTIN_BASE_CODES) {
      expect(baseOf(code), code).toBe(code);
    }
  });
});

describe("FALSIFIER 1: CS-1-MU-V-NCCD-ETOD-DBETOD-NP parses to CS-1, never CS", () => {
  it("yields CS-1 with the combining districts and overlays carried separately", () => {
    const parse = parseBaseCode("CS-1-MU-V-NCCD-ETOD-DBETOD-NP", AUSTIN);
    expect(parse.kind).toBe("base");
    expect(parse.base).toBe("CS-1");
    expect(parse.base).not.toBe("CS");
    expect(parse.overlays).toEqual(["MU", "V", "NCCD", "ETOD", "DBETOD", "NP"]);
    expect(parse.reason).toContain("CS-1");
  });

  it("shows what the truncated reading would have produced: CS, a DIFFERENT row that also resolves", () => {
    // Not a near miss: `CS General Commercial Services` and `CS-1
    // Commercial-Liquor Sales` are both rows, so the wrong reading is a silent
    // wrong district rather than a decline. Asserted through the same parser
    // with the rule inverted, never through a hand-written expectation.
    const truncated = parseBaseCode("CS-1-MU-V-NCCD-ETOD-DBETOD-NP", {
      ...AUSTIN,
      matchMode: "first-token",
    });
    expect(truncated.base).toBe("CS");
    expect(truncated.base).not.toBe("CS-1");
    expect(new Set(AUSTIN_BASE_CODES.map(normalizeBaseCode)).has("CS")).toBe(true);
  });

  it("parses the other two A-164 compounds the same way", () => {
    for (const { value, expected } of A164) {
      const parse = parseBaseCode(value, AUSTIN);
      expect(parse.kind, value).toBe(expected.kind);
      expect(parse.base, value).toBe(expected.base);
      expect(parse.overlays, value).toEqual(expected.overlays);
    }
  });

  it("parses every value in the live top-24 sample to the district it publishes", () => {
    for (const { value } of FIXTURE.sampledValues) {
      const expected = LIVE_SAMPLE[value];
      expect(expected, `unexpected sample value ${value}`).toBeDefined();
      const parse = parseBaseCode(value, AUSTIN);
      expect(parse.kind, value).toBe(expected!.kind);
      expect(parse.base, value).toBe(expected!.base);
      if (expected!.overlays) expect(parse.overlays, value).toEqual(expected!.overlays);
      // The interim disclosure travels with the parse (P-259b): true for the
      // three live I-* sample values, false for every other value in the sample.
      expect(parse.interim, value).toBe(expected!.interim ?? false);
    }
    expect(Object.keys(LIVE_SAMPLE).length).toBe(FIXTURE.sampledValues.length);
  });
});

describe("FALSIFIER 2: an unmatched prefix returns unrecognised, never a shorter match", () => {
  it("does not drop a leading token to reach a real district when NO qualifier is declared", () => {
    // Each of these has a REAL district one token in — dropping the leading
    // token would yield SF-2 / RR / LA / SF-3 / MF-3 / SF-4A, every one a table
    // row. With no DECLARED interim qualifier the parser must still refuse: the
    // strip is legitimate only because `interimQualifiers` names `I`, which is
    // what this paired control pins (and what falsifier 3 of this lane tests).
    const noQualifiers: BaseCodeParseConfig = { ...AUSTIN, interimQualifiers: [] };
    for (const value of ["I-SF-2", "I-RR", "I-LA", "I-SF-3", "I-MF-3", "I-SF-4A"]) {
      const parse = parseBaseCode(value, noQualifiers);
      expect(parse.kind, value).toBe("unrecognised");
      expect(parse.base, value).toBeNull();
      expect(parse.reason, value).toContain("unrecognised");
      // Nothing declared ⇒ nothing interim, so the disclosure cannot fire on a
      // value the layer never qualified.
      expect(parse.interim, value).toBe(false);
    }
  });

  it("does not truncate a suffix to reach a shorter district (SF-4A is not SF-4, and SF-4 is not a row)", () => {
    expect(baseOf("SF-4A")).toBe("SF-4A");
    expect(new Set(AUSTIN_BASE_CODES.map(normalizeBaseCode)).has("SF4")).toBe(false);
    // A value nothing in the vocabulary prefixes at a boundary:
    for (const value of ["TOD-NP", "NBG-CO-NP", "ERC", "TND", "UNZ-H", "PUD-SF"]) {
      expect(kindOf(value), value).not.toBe("base");
    }
  });

  it("returns unrecognised for an empty value rather than an empty-string district", () => {
    const parse = parseBaseCode("   ", AUSTIN);
    expect(parse.kind).toBe("unrecognised");
    expect(parse.base).toBeNull();
    expect(parse.reason).toContain("empty published value");
  });

  it("keeps the separator rule that makes truncation impossible: '.' and '&' are not boundaries", () => {
    // "R&D" is one district; if '&' were a boundary, "R" would be a candidate.
    expect(baseOf("R&D-CO-NP")).toBe("R&D");
    expect(baseOf("R&D-PDA")).toBe("R&D");
    // A decimal suffix is NOT a boundary. With both spellings in the
    // vocabulary the longer one wins, and with only SF-4 present, "SF-4.5"
    // must come back unrecognised rather than truncating to SF-4.
    expect(parseBaseCode("SF-4.5", { knownBaseCodes: ["SF-4", "SF-4.5"] }).base).toBe("SF-4.5");
    const sf4Only = parseBaseCode("SF-4.5", { knownBaseCodes: ["SF-4"] });
    expect(sf4Only.kind).toBe("unrecognised");
    expect(sf4Only.base).toBeNull();
  });
});

describe("FALSIFIER 4: removing the longest-match rule fails fixtures", () => {
  /** Fixtures with a base expectation (the ones the rule can get wrong). */
  const BASE_FIXTURES = [
    ...A164.map((c) => c.value),
    ...Object.entries(LIVE_SAMPLE)
      .filter(([, e]) => e.base !== null)
      .map(([v]) => v),
  ];

  const failuresUnder = (mode: "longest-match" | "shortest-match" | "first-token") =>
    BASE_FIXTURES.filter((value) => {
      const expected = LIVE_SAMPLE[value] ?? A164.find((c) => c.value === value)?.expected;
      return parseBaseCode(value, { ...AUSTIN, matchMode: mode }).base !== expected!.base;
    });

  it("produces ZERO fixture failures under the shipped rule", () => {
    expect(failuresUnder("longest-match")).toEqual([]);
    // 3 A-164 compounds + 20 live sample values with a base district (23 before
    // P-259b; the three live interim sample values I-SF-2 / I-RR / I-SF-4A now
    // also carry a base, so they join the fixture set as 26).
    expect(BASE_FIXTURES.length).toBe(26);
  });

  it("inverting the preference to shortest-match fails the CS-1 fixture (and only the CS-1 case)", () => {
    const failed = failuresUnder("shortest-match");
    expect(failed).toContain("CS-1-MU-V-NCCD-ETOD-DBETOD-NP");
    const cs1 = parseBaseCode("CS-1-MU-V-NCCD-ETOD-DBETOD-NP", {
      ...AUSTIN,
      matchMode: "shortest-match",
    });
    expect(cs1.base).toBe("CS");
    // Named, not hand-waved: in Austin the longest-match rule changes exactly
    // the values where a SHORTER base is also a boundary prefix. That is CS vs
    // CS-1 in this vocabulary.
    expect(failed).toEqual(["CS-1-MU-V-NCCD-ETOD-DBETOD-NP"]);
  });

  it("splitting on '-' and taking the first token fails many fixtures (A-164's naive reading)", () => {
    const failed = failuresUnder("first-token");
    // Every district whose code carries a numeric suffix loses it under that
    // reading: SF-1..SF-6, MF-*, CS-1, SF-4A/SF-4B, W/LO.
    expect(failed.length).toBeGreaterThan(failuresUnder("shortest-match").length);
    for (const value of ["SF-3-HD-NP", "SF-1", "SF-4A", "CS-1-MU-V-NCCD-ETOD-DBETOD-NP"]) {
      expect(failed, value).toContain(value);
    }
  });
});

describe("the whole live vocabulary, parsed", () => {
  it("resolves all 557 named values into exactly one class each, and the classes sum to the layer", () => {
    const named = ALL_PARSED.length;
    expect(named).toBe(557);
    const base = ALL_PARSED.filter((v) => v.parse.kind === "base");
    const pd = ALL_PARSED.filter((v) => v.parse.kind === "planned-development");
    const unrec = ALL_PARSED.filter((v) => v.parse.kind === "unrecognised");
    expect(base.length + pd.length + unrec.length).toBe(named);
    const polygons = (rows: typeof ALL_PARSED) =>
      rows.reduce((s, v) => s + v.polygons, 0);
    // The two polygons that publish nothing are the only ones outside these
    // classes (asserted in the fixture describe above).
    expect(polygons(base) + polygons(pd) + polygons(unrec)).toBe(
      FIXTURE.source.featureCount - 2,
    );
    // Every base is a vocabulary member and re-parses to itself: the stamped
    // code is always resolvable a second time, so a re-run is a no-op.
    for (const row of base) {
      expect(AUSTIN_BASE_CODES as readonly string[], row.value).toContain(row.parse.base);
      expect(baseOf(row.parse.base!), row.value).toBe(row.parse.base);
    }
    // Every unrecognised value carries a reason that names it.
    for (const row of unrec) {
      expect(row.parse.reason, row.value).toContain("unrecognised");
      expect(row.parse.base, row.value).toBeNull();
      // Nothing here is interim: with the declared qualifier in place every
      // I-* value resolves (asserted in the interim describe below), so an
      // unrecognised value that still reports interim would be I-XYZ — and the
      // live layer publishes none.
      expect(row.parse.interim, row.value).toBe(false);
    }
  });

  it("lists every unrecognised family by name, with its polygon count (the worklist)", () => {
    const unrec = ALL_PARSED.filter((v) => v.parse.kind === "unrecognised");
    const byFamily = new Map<string, { values: number; polygons: number }>();
    for (const row of unrec) {
      const family = row.value.split(/[-/\s]/)[0]!;
      const e = byFamily.get(family) ?? { values: 0, polygons: 0 };
      e.values += 1;
      e.polygons += row.polygons;
      byFamily.set(family, e);
    }
    // Families, measured on the live layer — these are the acquisition gaps the
    // dry run reports at parcel grain. The I-* interim family is NO LONGER one
    // of them: P-259b reads it as its base (it was 14 values / 1,229 polygons
    // of this bucket before the rule, and the bucket fell by exactly that).
    expect(byFamily.has("I")).toBe(false);
    for (const row of unrec) expect(row.value.startsWith("I-")).toBe(false);
    expect(byFamily.get("TOD")).toEqual({ values: 7, polygons: 138 });
    expect(byFamily.get("NBG")).toEqual({ values: 4, polygons: 49 });
    expect(byFamily.get("UNZ")).toEqual({ values: 3, polygons: 63 });
    expect(byFamily.get("ERC")).toEqual({ values: 1, polygons: 58 });
    expect(byFamily.get("TND")).toEqual({ values: 1, polygons: 2 });
    // SF-4 is a REAL published Austin base district (5 polygons) that the
    // setback table does not row: it lists SF-4A, SF-4B, SF-5, SF-6 and no
    // SF-4. The parser refuses to guess between them, so this is a table gap
    // the dry run will surface, not a parser bug — and it is the family that
    // proves the "never cut a suffix to reach a row" rule on live data.
    expect(byFamily.get("SF")).toEqual({ values: 1, polygons: 5 });
    expect(byFamily.size).toBe(6);
    expect(unrec.reduce((s, v) => s + v.polygons, 0)).toBe(315);
  });

  it("reads the whole interim family as its base: 14 values, 1,229 polygons, every one disclosed", () => {
    // The values are taken from the FIXTURE's vocabulary, not from a parcel
    // histogram, so a value that stamps nothing on a given leg is still covered
    // (I-AV publishes one polygon and no sampled parcel sits in it).
    const interim = ALL_PARSED.filter((v) => v.parse.interim);
    const values = interim.map((v) => v.value).sort();
    expect(values).toEqual([
      "I-AV",
      "I-GR",
      "I-LA",
      "I-MF-2",
      "I-MF-3",
      "I-PUD",
      "I-RR",
      "I-RR-NP",
      "I-SF-1",
      "I-SF-2",
      "I-SF-2-NP",
      "I-SF-3",
      "I-SF-4A",
      "I-SF-6",
    ]);
    expect(interim.reduce((s, v) => s + v.polygons, 0)).toBe(1229);

    // 13 resolve to a base district; I-PUD takes the planned-development route.
    // Not one of them is left unrecognised, and not one is stamped as a district
    // of its own.
    const asBase = interim.filter((v) => v.parse.kind === "base");
    const asPd = interim.filter((v) => v.parse.kind === "planned-development");
    expect(asBase.length).toBe(13);
    expect(asPd.map((v) => v.value)).toEqual(["I-PUD"]);
    expect(interim.filter((v) => v.parse.kind === "unrecognised")).toEqual([]);

    // Every resolved base is a real vocabulary member and re-parses to itself,
    // so the stamped code is resolvable a second time and a re-run is a no-op.
    for (const row of asBase) {
      expect(AUSTIN_BASE_CODES as readonly string[], row.value).toContain(row.parse.base);
      expect(baseOf(row.parse.base!), row.value).toBe(row.parse.base);
      // The disclosure never survives a re-parse: the BASE is not interim, so a
      // second pass over the stamped code reads a stable district. The interim
      // fact lives on the parcel row, not in the code.
      expect(parseBaseCode(row.parse.base!, AUSTIN).interim, row.value).toBe(false);
    }

    // The three the ruling names by hand.
    expect(parseBaseCode("I-SF-2-NP", AUSTIN)).toMatchObject({
      kind: "base",
      base: "SF-2",
      overlays: ["NP"],
      interim: true,
    });
    expect(parseBaseCode("I-RR-NP", AUSTIN)).toMatchObject({
      kind: "base",
      base: "RR",
      overlays: ["NP"],
      interim: true,
    });
    expect(parseBaseCode("I-PUD", AUSTIN)).toMatchObject({
      kind: "planned-development",
      base: null,
      interim: true,
    });
  });

  it("FALSIFIER 3: with the qualifier rule removed, these fixtures fail (paired control)", () => {
    // The SAME shipped parser, the SAME fixture values, one config field
    // dropped. Nothing is re-implemented on either side, so the pair cannot pass
    // by both being wrong.
    const removed: BaseCodeParseConfig = { ...AUSTIN, interimQualifiers: [] };
    const interimValues = ALL_PARSED.filter((v) => v.parse.interim).map((v) => v.value);
    expect(interimValues.length).toBe(14);

    const failing = interimValues.filter(
      (v) => parseBaseCode(v, removed).kind !== parseBaseCode(v, AUSTIN).kind,
    );
    // 14 of 14 flip: 13 base -> unrecognised, I-PUD planned-development ->
    // unrecognised. A test asserting the resolved base for any of them (the
    // fixture loop above does, for all of them) therefore fails without the rule.
    expect(failing.sort()).toEqual([...interimValues].sort());

    // And the flip is exactly "unrecognised", not a wrong district: the rule
    // never invents a district, and removing it never invents one either.
    for (const v of interimValues) {
      const parse = parseBaseCode(v, removed);
      expect(parse.kind, v).toBe("unrecognised");
      expect(parse.base, v).toBeNull();
      expect(parse.interim, v).toBe(false);
    }
  });

  it("an empty or unmatched remainder stays unrecognised and never becomes the qualifier", () => {
    // A qualifier is not a district. These publish no remainder to read.
    for (const value of ["I", "I-", "I ", "I / "]) {
      const parse = parseBaseCode(value, AUSTIN);
      expect(parse.kind, value).toBe("unrecognised");
      expect(parse.base, value).toBeNull();
      expect(parse.interim, value).toBe(true);
      expect(parse.reason, value).toContain("interim");
    }
    // A qualifier followed by a value matching no base: still unrecognised, and
    // still disclosed as interim rather than folded into the generic bucket.
    for (const value of ["I-XYZ", "I-TOD-NP", "I-SF-9"]) {
      const parse = parseBaseCode(value, AUSTIN);
      expect(parse.kind, value).toBe("unrecognised");
      expect(parse.base, value).toBeNull();
      expect(parse.interim, value).toBe(true);
      expect(parse.reason, value).toContain("unrecognised");
    }
  });

  it("only strips a DECLARED qualifier, and only at a separator boundary", () => {
    // 'I' heads I-* only when the declaration names it.
    expect(parseBaseCode("I-SF-2", { ...AUSTIN, interimQualifiers: ["IX"] }).kind).toBe(
      "unrecognised",
    );
    // The qualifier is a TOKEN: it must end at a boundary. No live value tests
    // this because every interim code publishes "I-…", so it is pinned here —
    // "IX-SF-2" is not an interim "I", and "I-SF-2" is not an interim "IS".
    expect(parseBaseCode("IX-SF-2", AUSTIN).kind).toBe("unrecognised");
    expect(parseBaseCode("I-SF-2", { ...AUSTIN, interimQualifiers: ["IS"] }).kind).toBe(
      "unrecognised",
    );
    // A declared qualifier that is ALSO a real district code: the whole value is
    // resolved FIRST, so "L" stays the district it is, with no interim flag.
    // Strip-first would have left it unrecognised, because the qualifier is
    // followed by nothing at all — this is the ORDER rule, pinned.
    const lAsQualifier: BaseCodeParseConfig = { ...AUSTIN, interimQualifiers: ["L"] };
    expect(parseBaseCode("L", lAsQualifier)).toMatchObject({
      kind: "base",
      base: "L",
      interim: false,
    });
    // And nothing is "stripped" even when the tail is not a district: "L-XY"
    // still resolves to L at the boundary, because the direct resolution runs on
    // the whole value first. A declared qualifier can never override a real
    // district code that heads the value.
    expect(parseBaseCode("L-XY", lAsQualifier)).toMatchObject({
      kind: "base",
      base: "L",
      overlays: ["XY"],
      interim: false,
    });
  });

  it("agrees with P-255's census formula on planned development except for I-PUD, and names that divergence", () => {
    // The parser checks the vocabulary FIRST, so a city whose table really rows
    // a PD/PC/PUD district would resolve it as a district while the census
    // (raw-code-only) would call it planned development. For Austin no
    // vocabulary entry is PD-shaped, so that divergence is empty.
    const censusRegex = new RegExp(PLANNED_DEVELOPMENT_PATTERN, PLANNED_DEVELOPMENT_FLAGS);
    const disagreements = ALL_PARSED.filter(
      (v) => (v.parse.kind === "planned-development") !== censusRegex.test(v.value),
    );
    // THE ONE DIVERGENCE P-259b INTRODUCES, named rather than smoothed: the
    // census reads the raw published code, so `I-PUD` does not match its
    // start-anchored pattern, while the parser strips the declared interim
    // qualifier and finds PUD underneath. One value, one polygon. The parser is
    // right (an interim PUD's setbacks do come from its own ordinance, which is
    // what A-164's message says), so this is a census gap the P-255 re-run will
    // show — not a parser defect, and NOT a reason to widen the census pattern
    // in this lane.
    expect(disagreements.map((v) => v.value)).toEqual(["I-PUD"]);
    expect(disagreements.reduce((s, v) => s + v.polygons, 0)).toBe(1);

    const pdValues = ALL_PARSED.filter((v) => v.parse.kind === "planned-development");
    expect(pdValues.map((v) => v.value).sort()).toEqual([
      "I-PUD",
      "PUD",
      "PUD-H",
      "PUD-H-NP",
      "PUD-NCCD-NP",
      "PUD-NP",
    ]);
    expect(pdValues.reduce((s, v) => s + v.polygons, 0)).toBe(1143);
  });

  it("carries the multi-district '/' values as additionalBases instead of discarding them", () => {
    const twoWay = parseBaseCode("GR-MU-CO-NP/MF-6-CO-NP", AUSTIN);
    expect(twoWay.base).toBe("GR");
    expect(twoWay.additionalBases).toEqual(["MF-6"]);
    expect(twoWay.overlays).toEqual(["MU", "CO", "NP", "CO", "NP"]);
    expect(twoWay.unmatchedParts).toEqual([]);
    const cs = parseBaseCode("CS-MU-NP/MF-6-CO-NP", AUSTIN);
    expect(cs.base).toBe("CS");
    expect(cs.additionalBases).toEqual(["MF-6"]);
    // The '/' inside a district name must not be read as a district separator:
    expect(baseOf("W/LO-CO-NP")).toBe("W/LO");
    expect(parseBaseCode("W/LO-CO-NP", AUSTIN).additionalBases).toEqual([]);
  });

  it("handles the layer's one whitespace-broken value (LR -NP) as LR + NP", () => {
    const parse = parseBaseCode("LR -NP", AUSTIN);
    expect(parse.base).toBe("LR");
    expect(parse.overlays).toEqual(["NP"]);
  });
});

describe("the registry wiring this parser depends on", () => {
  it("wires all three Austin county entries to the public PLANNINGCADASTRE layer, sharing one cityKey", () => {
    const austin = Object.values(ZONING_LAYERS).filter((c) => c.cityKey === "austin-tx");
    expect(austin.length).toBe(3);
    expect(austin.map((c) => c.countyFips).sort()).toEqual(["48209", "48453", "48491"]);
    for (const c of austin) {
      expect(c.codeField).toBe("ZONING_ZTYPE");
      expect(c.layerUrl).toContain("PLANNINGCADASTRE_zoning_large_map_scale/FeatureServer/0");
      expect(c.baseCodeParse?.knownBaseCodes).toEqual(AUSTIN_BASE_CODES);
      expect(c.baseCodeParse?.matchMode).toBeUndefined();
      // P-259b: all three Austin county entries declare the interim qualifier.
      expect(c.baseCodeParse?.interimQualifiers).toEqual(["I"]);
      expect(c.baseCodeParse?.interimQualifiers).toEqual(AUSTIN_INTERIM_QUALIFIERS);
    }
    expect(new Set(Object.keys(ZONING_LAYERS))).toContain("austin-tx-williamson");
    expect(new Set(Object.keys(ZONING_LAYERS))).toContain("austin-tx-hays");
  });

  it("declares the interim qualifier for Austin and for NO other city", () => {
    const withInterim = Object.values(ZONING_LAYERS).filter(
      (c) => c.baseCodeParse?.interimQualifiers !== undefined,
    );
    expect(withInterim.map((c) => c.cityKey)).toEqual([
      "austin-tx",
      "austin-tx",
      "austin-tx",
    ]);
    // Only `I`: an undeclared qualifier must leave a value unrecognised, so a
    // stray entry here would silently widen the strip for every Austin leg.
    for (const c of withInterim) {
      expect(c.baseCodeParse!.interimQualifiers).toEqual(["I"]);
    }
  });

  it("no longer reads the superseded Austin layer or its collapsed BASE_ZONE field", () => {
    for (const c of Object.values(ZONING_LAYERS)) {
      expect(c.layerUrl).not.toContain("Publish_Zoning_AGOL");
    }
    const austin = Object.values(ZONING_LAYERS).filter((c) => c.cityKey === "austin-tx");
    for (const c of austin) expect(c.codeField).not.toBe("BASE_ZONE");
  });

  it("makes Austin a wired jurisdiction in all three of its counties", () => {
    for (const fips of ["48453", "48491", "48209"]) {
      expect([...wiredZoningCityKeys(fips)], fips).toContain("austin-tx");
    }
  });

  it("only Austin carries a base-code parse (the other 30 entries are untouched by P-259)", () => {
    const withParse = Object.values(ZONING_LAYERS).filter((c) => c.baseCodeParse !== undefined);
    expect(withParse.map((c) => c.cityKey)).toEqual(["austin-tx", "austin-tx", "austin-tx"]);
  });

  it("no registry entry ever ships a non-default match mode", () => {
    for (const c of Object.values(ZONING_LAYERS)) {
      if (c.baseCodeParse) expect(c.baseCodeParse.matchMode ?? "longest-match").toBe("longest-match");
    }
  });
});

/**
 * The surfaces the parse has to survive on its way to a stamped parcel: the
 * layer fetch (reduce + frame check + vintage), the PIP index, and the audit
 * the CLI prints. Each is asserted on a synthetic page whose geometry is a real
 * Austin-scale polygon in WGS84 degrees and, where the check is about frames,
 * the same polygon as the layer actually publishes it (state-plane FEET).
 */
describe("the parse survives the layer fetch, the index and the audit", () => {
  const austinCfg = ZONING_LAYERS["austin-tx"]!;

  /** A ~0.002-degree square around downtown Austin, in WGS84 degrees. */
  const wgs84Square = {
    type: "Polygon",
    coordinates: [
      [
        [-97.744, 30.266],
        [-97.742, 30.266],
        [-97.742, 30.268],
        [-97.744, 30.268],
        [-97.744, 30.266],
      ],
    ],
  };

  /**
   * The SAME square as Austin's layer actually stores it: state-plane feet
   * (wkid 102739 / latestWkid 2277). x ≈ 3.1e6, y ≈ 1.0e7 — the frame a host
   * that ignored `outSR=4326` would return.
   */
  const statePlaneSquare = {
    type: "Polygon",
    coordinates: [
      [
        [3115600, 10075300],
        [3115800, 10075300],
        [3115800, 10075500],
        [3115600, 10075500],
        [3115600, 10075300],
      ],
    ],
  };

  const page = (ztype: string | null, geometry: unknown, oid: number) => ({
    attributes: { OBJECTID: oid, ZONING_ZTYPE: ztype, ZONING_BASE: "CS" },
    geometry,
  });

  it("reduces a compound ZONING_ZTYPE to its base and carries the full parse", () => {
    const f = reduceZoningFeature(
      page("CS-1-MU-V-NCCD-ETOD-DBETOD-NP", wgs84Square, 1) as never,
      austinCfg,
    );
    expect(f.code).toBe("CS-1");
    expect(f.parse?.kind).toBe("base");
    expect(f.parse?.base).toBe("CS-1");
    expect(f.parse?.raw).toBe("CS-1-MU-V-NCCD-ETOD-DBETOD-NP");
    expect(f.parse?.overlays).toEqual(["MU", "V", "NCCD", "ETOD", "DBETOD", "NP"]);
    expect(f.description).toBe("CS");
  });

  it("stamps an UNRECOGNISED value verbatim, and planned development raw", () => {
    // An overlay family with no base in the vocabulary: written as published.
    const unrec = reduceZoningFeature(page("TOD-NP", wgs84Square, 2) as never, austinCfg);
    expect(unrec.parse?.kind).toBe("unrecognised");
    expect(unrec.code).toBe("TOD-NP");
    expect(unrec.parse?.base).toBeNull();
    // The falsifier, at the layer boundary: never a truncation to a row.
    expect(unrec.code).not.toBe("TOD");

    const pud = reduceZoningFeature(page("PUD-NP", wgs84Square, 3) as never, austinCfg);
    expect(pud.parse?.kind).toBe("planned-development");
    expect(pud.code).toBe("PUD-NP");
  });

  it("reads an interim value as its base and discloses it — and, with the qualifier undeclared, still refuses to guess", () => {
    // I-SF-2 was this file's original "never SF" falsifier: the value has a real
    // district one token in, and the old reading correctly refused. P-259b makes
    // the strip legitimate by DECLARING `I` as an interim qualifier, so the same
    // input now reads as SF-2 with `interim: true` — and never as "SF", which is
    // not a row in this vocabulary at all.
    const interim = reduceZoningFeature(page("I-SF-2", wgs84Square, 2) as never, austinCfg);
    expect(interim.parse?.kind).toBe("base");
    expect(interim.parse?.base).toBe("SF-2");
    expect(interim.parse?.interim).toBe(true);
    expect(interim.code).toBe("SF-2");
    expect(interim.code).not.toBe("SF");
    expect(interim.parse?.raw).toBe("I-SF-2");

    // The paired control: the SAME page, the SAME shipped parser, with the
    // declaration dropped. It must land back on unrecognised verbatim, which is
    // what makes the strip a rule rather than a truncation.
    const undeclared = reduceZoningFeature(page("I-SF-2", wgs84Square, 2) as never, {
      ...austinCfg,
      baseCodeParse: { ...austinCfg.baseCodeParse!, interimQualifiers: [] },
    });
    expect(undeclared.parse?.kind).toBe("unrecognised");
    expect(undeclared.parse?.base).toBeNull();
    expect(undeclared.parse?.interim).toBe(false);
    expect(undeclared.code).toBe("I-SF-2");
    expect(undeclared.code).not.toBe("SF");
  });

  it("leaves every NON-parse layer on the old contract (published value IS the district)", () => {
    const georgetown = ZONING_LAYERS["georgetown-tx"]!;
    const f = reduceZoningFeature(
      { attributes: { OBJECTID: 1, ZONE: "RS" }, geometry: wgs84Square } as never,
      georgetown,
    );
    expect(f.code).toBe("RS");
    expect(f.parse).toBeUndefined();
  });

  it("drops a polygon that publishes no code rather than inventing one", () => {
    const f = reduceZoningFeature(page(null, wgs84Square, 4) as never, austinCfg);
    expect(f.code).toBeNull();
    expect(f.parse).toBeUndefined();
  });

  it("PASSES the frame check on a WGS84 page and FAILS it on the state-plane page the layer stores", () => {
    const good = reduceZoningFeature(page("CS", wgs84Square, 1) as never, austinCfg);
    expect(() => assertWgs84Frame([good], austinCfg.layerUrl)).not.toThrow();

    // Same polygon, feet instead of degrees: exactly what a host that ignored
    // outSR=4326 would return, and the reason the check exists (PIP would have
    // matched nothing and reported a clean 0%).
    const feet = reduceZoningFeature(page("CS", statePlaneSquare, 1) as never, austinCfg);
    expect(() => assertWgs84Frame([feet], austinCfg.layerUrl)).toThrow(
      /outside the plausible Texas WGS84 envelope/,
    );
  });

  it("reads the layer's OWN projection and vintage from ?f=json, never assumes them", async () => {
    const meta = await fetchZoningLayerMeta(austinCfg.layerUrl, async () => ({
      name: "PLANNINGCADASTRE.zoning_large_map_scale",
      maxRecordCount: 2000,
      spatialReference: { wkid: 102739, latestWkid: 2277 },
      editingInfo: { lastEditDate: Date.parse("2026-09-16T23:11:33.427Z") },
    }));
    expect(meta.unavailable).toBe(false);
    expect(meta.name).toBe("PLANNINGCADASTRE.zoning_large_map_scale");
    expect(meta.sourceWkid).toBe(102739);
    expect(meta.sourceLatestWkid).toBe(2277);
    expect(meta.lastEditDate).toBe("2026-09-16T23:11:33.427Z");
    expect(meta.maxRecordCount).toBe(2000);

    // A host that refuses ?f=json must be reported as UNAVAILABLE, not guessed.
    const missing = await fetchZoningLayerMeta(austinCfg.layerUrl, async () => {
      throw new Error("no metadata");
    });
    expect(missing.unavailable).toBe(true);
    expect(missing.sourceWkid).toBeNull();
    expect(missing.lastEditDate).toBeNull();
  });

  it("carries the parse through the PIP index, so the stamped code is the resolved base", () => {
    const features = [
      reduceZoningFeature(page("CS-1-MU-V-NCCD-ETOD-DBETOD-NP", wgs84Square, 1) as never, austinCfg),
    ];
    const index = buildZoningIndex(features);
    expect(index).toHaveLength(1);
    expect(index[0]!.code).toBe("CS-1");
    expect(index[0]!.parse?.overlays).toContain("NCCD");

    // A parcel point inside the square resolves to CS-1 with its parse intact.
    const hit = zoningCodeAtPoint(index, -97.743, 30.267);
    expect(hit?.code).toBe("CS-1");
    expect(hit?.parse?.kind).toBe("base");
  });

  it("audits the page: every feature lands in a bucket, and the buckets sum to the page", () => {
    const features = [
      reduceZoningFeature(page("CS-1-MU-V-NCCD-ETOD-DBETOD-NP", wgs84Square, 1) as never, austinCfg),
      reduceZoningFeature(page("SF-3-HD-NP", wgs84Square, 2) as never, austinCfg),
      reduceZoningFeature(page("SF-3-NP", wgs84Square, 3) as never, austinCfg),
      reduceZoningFeature(page("PUD-NP", wgs84Square, 4) as never, austinCfg),
      reduceZoningFeature(page("I-SF-2", wgs84Square, 5) as never, austinCfg),
      reduceZoningFeature(page("I-SF-2", wgs84Square, 6) as never, austinCfg),
      reduceZoningFeature(page(null, wgs84Square, 7) as never, austinCfg),
    ];
    const audit = layerParseAudit(features);
    expect(audit.features).toBe(7);
    // The two interim pages resolve to SF-2, so they are BASE features here —
    // and the interim disclosure counts them as a SUBSET of that bucket.
    expect(audit.base).toBe(5);
    expect(audit.plannedDevelopment).toBe(1);
    expect(audit.unrecognised).toBe(0);
    expect(audit.noCode).toBe(1);
    expect(audit.interimBase).toBe(2);
    expect(audit.interimPlannedDevelopment).toBe(0);
    expect(audit.interimValueHistogram).toEqual({ "I-SF-2": 2 });
    // Totality: no feature is unaccounted for, and none is double-counted.
    expect(audit.base + audit.plannedDevelopment + audit.unrecognised + audit.noCode).toBe(
      audit.features,
    );
    expect(audit.unrecognisedHistogram).toEqual({});
    expect(audit.baseHistogram).toEqual({
      "CS-1": 1,
      "SF-3": 2,
      "SF-2": 2,
      "PUD-NP": 1,
    });
    expect(audit.overlayHistogram["NP"]).toBe(3);
    expect(audit.overlayHistogram["HD"]).toBe(1);
    // An interim value IS classified, so its own tokens are counted where they
    // are real overlays and never invented where they are not: "I-SF-2" has no
    // overlays at all, and "I" is not a token of anything here. The PUD in
    // "PUD-NP" is not an overlay either — that value has no base to hang one on.
    expect(audit.overlayHistogram["I"]).toBeUndefined();
    expect(audit.overlayHistogram["SF"]).toBeUndefined();
    expect(audit.overlayHistogram["PUD"]).toBeUndefined();
  });

  it("audits an interim I-PUD page as planned development AND interim, counted once", () => {
    const features = [
      reduceZoningFeature(page("I-PUD", wgs84Square, 1) as never, austinCfg),
      reduceZoningFeature(page("PUD", wgs84Square, 2) as never, austinCfg),
    ];
    const audit = layerParseAudit(features);
    expect(audit.plannedDevelopment).toBe(2);
    expect(audit.interimPlannedDevelopment).toBe(1);
    expect(audit.interimBase).toBe(0);
    expect(audit.interimValueHistogram).toEqual({ "I-PUD": 1 });
    expect(audit.base + audit.plannedDevelopment + audit.unrecognised + audit.noCode).toBe(
      audit.features,
    );
  });
});
