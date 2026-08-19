/**
 * The serving-sweep record validator and the statewide assembly (SS-W7 / P-44).
 *
 * Two things are pinned here, and both are things that would otherwise be
 * remembered rather than enforced:
 *
 *   1. THE VALIDATOR CAN REJECT. A parser that cannot fail is not a parser
 *      (DEV_PROCESS 2.2). Every rejection case below is a real shape Command
 *      Center's own parseStatewideSweep flags as a problem, so an accepted
 *      body is one the console can read.
 *   2. THE ASSEMBLY INVENTS NOTHING. countiesSwept is measured from the array,
 *      sweptAt is never newer than the newest sweep in it, and a mixed
 *      resolverVersion is reported as mixed rather than having one county's
 *      version stand for all of them.
 */
import { describe, it, expect } from "vitest";
import {
  FIELD_KEYS,
  assembleStatewideSweep,
  parseServingSweepIngestBody,
  type CountyServingSweep,
  type FieldTally,
} from "./servingSweepRecord";

function tally(present = 0, absentCovered = 0, absentUncovered = 0, unresolved = 0): FieldTally {
  return { present, absentCovered, absentUncovered, unresolved };
}

function fields(): Record<string, FieldTally> {
  return Object.fromEntries(FIELD_KEYS.map((k) => [k, tally()]));
}

function county(overrides: Partial<CountyServingSweep> = {}): Record<string, unknown> {
  return {
    countyFips: "48021",
    countyName: "Bastrop",
    sweptAt: "2026-08-19T00:00:48.244Z",
    resolverVersion: "ss-w5/1.0.0",
    parcelsTotal: 62399,
    parcelsUnresolvable: 0,
    fields: fields(),
    singleFamily: { parcelsTotal: 32269, fields: fields() },
    contradictions: [],
    multiZoneFloodParcels: 0,
    absenceClusters: [],
    sourcesByField: {},
    ...overrides,
  };
}

describe("parseServingSweepIngestBody, accepted shapes", () => {
  it("reads a single CountyServingSweep", () => {
    const res = parseServingSweepIngestBody(county());
    expect(res.ok).toBe(true);
    expect(res.shape).toBe("county");
    expect(res.counties).toHaveLength(1);
    expect(res.counties[0].countyFips).toBe("48021");
  });

  it("reads a StatewideServingSweep and returns its counties", () => {
    const res = parseServingSweepIngestBody({
      sweptAt: "2026-08-19T00:01:03.846Z",
      resolverVersion: "ss-w5/1.0.0",
      countiesTotal: 254,
      countiesSwept: 2,
      parcelsTotal: 866857,
      counties: [county(), county({ countyFips: "48453", countyName: "Travis" })],
    });
    expect(res.ok).toBe(true);
    expect(res.shape).toBe("statewide");
    expect(res.counties.map((c) => c.countyFips)).toEqual(["48021", "48453"]);
  });

  it("carries every FieldKey through unchanged", () => {
    const res = parseServingSweepIngestBody(
      county({
        fields: { ...fields(), geometry: tally(3931, 0, 58468, 0) } as CountyServingSweep["fields"],
      }),
    );
    expect(res.ok).toBe(true);
    expect(Object.keys(res.counties[0].fields).sort()).toEqual([...FIELD_KEYS].sort());
    expect(res.counties[0].fields.geometry).toEqual({
      present: 3931,
      absentCovered: 0,
      absentUncovered: 58468,
      unresolved: 0,
    });
  });
});

describe("parseServingSweepIngestBody, proven able to reject", () => {
  it("rejects a body that is not an object at all", () => {
    const res = parseServingSweepIngestBody("not a sweep");
    expect(res.ok).toBe(false);
    expect(res.shape).toBe("unrecognized");
    expect(res.problems).toHaveLength(1);
  });

  it("rejects a missing FieldKey and names it by path", () => {
    const partial = fields();
    delete partial.frontage;
    const res = parseServingSweepIngestBody(county({ fields: partial as never }));
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toContain("root.fields.frontage");
  });

  it("rejects an unknown FieldKey — a tenth key is a shape change, not a detail", () => {
    const extra = { ...fields(), soilType: tally() };
    const res = parseServingSweepIngestBody(county({ fields: extra as never }));
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toMatch(/soilType/);
  });

  it("rejects a contradiction kind outside the frozen union", () => {
    const res = parseServingSweepIngestBody(
      county({
        contradictions: [
          { kind: "some-new-defect", count: 1, exampleParcelNodeIds: [] } as never,
        ],
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toContain("root.contradictions.0.kind");
  });

  it("rejects more than 20 exampleParcelNodeIds — the console flags a longer list", () => {
    const ids = Array.from({ length: 21 }, (_, i) => "48021:" + String(i));
    const res = parseServingSweepIngestBody(
      county({
        contradictions: [
          { kind: "flood-zone-disagreement", count: 21, exampleParcelNodeIds: ids },
        ],
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toContain("root.contradictions.0.exampleParcelNodeIds");
  });

  it("rejects a bbox that is not four numbers", () => {
    const res = parseServingSweepIngestBody(
      county({
        absenceClusters: [
          { field: "zoning", label: "sw", parcelCount: 10, bbox: [1, 2, 3] as never },
        ],
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toContain("root.absenceClusters.0.bbox");
  });

  it("rejects a negative tally", () => {
    const bad = { ...fields(), zoning: tally(-1) };
    const res = parseServingSweepIngestBody(county({ fields: bad as never }));
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toContain("root.fields.zoning.present");
  });

  it("rejects a countyFips that is not five digits", () => {
    const res = parseServingSweepIngestBody(county({ countyFips: "48_21" }));
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toContain("root.countyFips");
  });

  it("rejects an unparseable sweptAt rather than failing later at the column", () => {
    const res = parseServingSweepIngestBody(county({ sweptAt: "last tuesday" }));
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toContain("root.sweptAt");
  });

  it("rejects a statewide body whose countiesSwept disagrees with counties.length", () => {
    const res = parseServingSweepIngestBody({
      sweptAt: "2026-08-19T00:01:03.846Z",
      resolverVersion: "ss-w5/1.0.0",
      countiesTotal: 254,
      countiesSwept: 7,
      parcelsTotal: 1,
      counties: [county()],
    });
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toContain("root.countiesSwept");
  });

  it("rejects a statewide body carrying the same county twice", () => {
    const res = parseServingSweepIngestBody({
      sweptAt: "2026-08-19T00:01:03.846Z",
      resolverVersion: "ss-w5/1.0.0",
      countiesTotal: 254,
      countiesSwept: 2,
      parcelsTotal: 2,
      counties: [county(), county()],
    });
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toContain("appears more than once");
  });

  it("every rejection carries at least one problem — ok=false with an empty list is impossible", () => {
    const bodies: unknown[] = [
      "x",
      42,
      [],
      county({ countyName: "" }),
      county({ parcelsTotal: -3 }),
    ];
    for (const body of bodies) {
      const res = parseServingSweepIngestBody(body);
      expect(res.ok).toBe(false);
      expect(res.problems.length).toBeGreaterThan(0);
    }
  });
});

describe("assembleStatewideSweep counting rules", () => {
  const bastrop = parseServingSweepIngestBody(county()).counties[0];
  const travis = parseServingSweepIngestBody(
    county({
      countyFips: "48453",
      countyName: "Travis",
      sweptAt: "2026-08-19T00:01:00.000Z",
      parcelsTotal: 804458,
    }),
  ).counties[0];

  it("measures countiesSwept from the array, so it can never disagree with it", () => {
    const sweep = assembleStatewideSweep([
      { countyFips: travis.countyFips, payload: travis },
      { countyFips: bastrop.countyFips, payload: bastrop },
    ]);
    expect(sweep.countiesSwept).toBe(sweep.counties.length);
    expect(sweep.countiesSwept).toBe(2);
  });

  it("orders counties by FIPS regardless of row order", () => {
    const sweep = assembleStatewideSweep([
      { countyFips: travis.countyFips, payload: travis },
      { countyFips: bastrop.countyFips, payload: bastrop },
    ]);
    expect(sweep.counties.map((c) => c.countyFips)).toEqual(["48021", "48453"]);
  });

  it("sums parcelsTotal over the SWEPT counties only", () => {
    const sweep = assembleStatewideSweep([
      { countyFips: bastrop.countyFips, payload: bastrop },
      { countyFips: travis.countyFips, payload: travis },
    ]);
    expect(sweep.parcelsTotal).toBe(62399 + 804458);
  });

  it("uses 254 as countiesTotal — a denominator about Texas, not about our data", () => {
    const sweep = assembleStatewideSweep([{ countyFips: bastrop.countyFips, payload: bastrop }]);
    expect(sweep.countiesTotal).toBe(254);
    expect(sweep.countiesSwept).toBe(1);
  });

  it("never claims a sweptAt newer than the newest county in the assembly", () => {
    const sweep = assembleStatewideSweep([
      { countyFips: bastrop.countyFips, payload: bastrop },
      { countyFips: travis.countyFips, payload: travis },
    ]);
    expect(sweep.sweptAt).toBe("2026-08-19T00:01:00.000Z");
    const newest = Math.max(
      ...sweep.counties.map((c) => Date.parse(c.sweptAt)),
    );
    expect(Date.parse(sweep.sweptAt)).toBeLessThanOrEqual(newest);
  });

  it("reports a mixed resolverVersion as mixed rather than picking one", () => {
    const other = parseServingSweepIngestBody(
      county({ countyFips: "48453", countyName: "Travis", resolverVersion: "ss-w5/1.1.0" }),
    ).counties[0];
    const sweep = assembleStatewideSweep([
      { countyFips: bastrop.countyFips, payload: bastrop },
      { countyFips: other.countyFips, payload: other },
    ]);
    expect(sweep.resolverVersion).toContain("mixed:");
    expect(sweep.resolverVersion).toContain("ss-w5/1.0.0");
    expect(sweep.resolverVersion).toContain("ss-w5/1.1.0");
  });

  it("passes the single version through untouched when every county agrees", () => {
    const sweep = assembleStatewideSweep([
      { countyFips: bastrop.countyFips, payload: bastrop },
      { countyFips: travis.countyFips, payload: travis },
    ]);
    expect(sweep.resolverVersion).toBe("ss-w5/1.0.0");
  });
});
