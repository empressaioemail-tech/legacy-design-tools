/**
 * P-106 items 3, 4 and 5.
 *
 * The three-set partition is exercised TWICE: once against fixtures, so the
 * assembly is pinned with no database, and once against a REAL Postgres schema
 * seeded with rows whose rails are deliberately mixed, so the SQL that computes
 * the partition is exercised rather than described. The second suite is the one
 * that matters: the partition is expressed in SQL, and a test that mocks the
 * SQL away tests the mock.
 */

import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { withTestSchema } from "@workspace/db/testing";
import {
  CONSTRAINT_SEARCH_COUNTIES,
  assembleConstraintSearchResult,
  buildConstraintSearchSql,
  clampConstraintCap,
  isConstraintSearchCounty,
  readsAsSingleAddress,
  runConstraintSearch,
  unmeasuredRefuseAbovePctFromEnv,
  validateFilters,
  type ConstraintFilter,
} from "./parcelConstraintSearch";

const hasDb =
  process.env.TEST_DATABASE_URL !== undefined ||
  process.env.DATABASE_URL !== undefined;

const TWO_ACRES_OUTSIDE_FLOOD: ConstraintFilter[] = [
  { rail: "acreage", op: "gte", number: 2 },
  { rail: "flood", op: "is_false" },
];

describe("constraint search refusals", () => {
  it("refuses a search with no geographic bound rather than answering statewide", async () => {
    const result = await runConstraintSearch({
      countyFips: "",
      filters: TWO_ACRES_OUTSIDE_FLOOD,
      db: { query: async () => ({ rows: [] }) },
      unmeasuredRefuseAbovePct: null,
    });
    expect(result).toMatchObject({ refused: true, code: "constraint_bound_missing" });
  });

  it("refuses a county with no projection rather than returning an empty set", async () => {
    const result = await runConstraintSearch({
      countyFips: "48201",
      filters: TWO_ACRES_OUTSIDE_FLOOD,
      db: { query: async () => ({ rows: [] }) },
      unmeasuredRefuseAbovePct: null,
    });
    expect(result).toMatchObject({
      refused: true,
      code: "constraint_county_out_of_scope",
    });
  });

  it("routes a single street address back to find_parcel", async () => {
    expect(readsAsSingleAddress("908 PINE ST")).toBe(true);
    expect(readsAsSingleAddress("Pine St")).toBe(false);
    expect(readsAsSingleAddress(undefined)).toBe(false);
    const result = await runConstraintSearch({
      countyFips: "48021",
      filters: TWO_ACRES_OUTSIDE_FLOOD,
      query: "908 PINE ST",
      db: { query: async () => ({ rows: [] }) },
      unmeasuredRefuseAbovePct: null,
    });
    expect(result).toMatchObject({
      refused: true,
      code: "constraint_single_address",
    });
  });

  it("refuses an empty filter set", () => {
    expect(validateFilters([])).toMatchObject({
      refused: true,
      code: "constraint_filters_missing",
    });
  });

  it("refuses an ordered comparison on a rail that carries no ordered value", () => {
    expect(
      validateFilters([{ rail: "zoningDistrict", op: "gte", number: 3 }]),
    ).toMatchObject({ refused: true, code: "constraint_op_unsupported" });
  });

  it("refuses an unknown rail", () => {
    expect(
      validateFilters([
        { rail: "ossf" as never, op: "eq", text: "approved" },
      ]),
    ).toMatchObject({ refused: true, code: "constraint_rail_unknown" });
  });

  it("holds the six in-scope counties and nothing else", () => {
    expect([...CONSTRAINT_SEARCH_COUNTIES]).toEqual([
      "48021",
      "48055",
      "48209",
      "48309",
      "48453",
      "48491",
    ]);
    expect(isConstraintSearchCounty("48453")).toBe(true);
    expect(isConstraintSearchCounty("48201")).toBe(false);
  });

  it("has NO default unmeasured ceiling: the threshold is an operator ruling", () => {
    expect(unmeasuredRefuseAbovePctFromEnv({})).toBeNull();
    expect(
      unmeasuredRefuseAbovePctFromEnv({
        CONSTRAINT_SEARCH_UNMEASURED_REFUSE_ABOVE_PCT: "40",
      }),
    ).toBe(40);
    // Nonsense does not silently become a gate.
    expect(
      unmeasuredRefuseAbovePctFromEnv({
        CONSTRAINT_SEARCH_UNMEASURED_REFUSE_ABOVE_PCT: "not-a-number",
      }),
    ).toBeNull();
  });

  it("clamps cap without ever returning zero or an unbounded page", () => {
    expect(clampConstraintCap(undefined)).toBe(50);
    expect(clampConstraintCap(0)).toBe(1);
    expect(clampConstraintCap(10_000)).toBe(200);
  });
});

describe("constraint search SQL text", () => {
  it("binds every caller value as a parameter and interpolates none of them", () => {
    const { text, params } = buildConstraintSearchSql({
      countyFips: "48021",
      filters: [
        { rail: "zoningDistrict", op: "eq", text: "'; drop table atoms; --" },
        { rail: "acreage", op: "gte", number: 2 },
      ],
      cap: 25,
    });
    expect(text).not.toContain("drop table");
    expect(params).toEqual(["48021", "'; drop table atoms; --", 2, 25]);
  });

  it("never lets an unevaluable cell satisfy a comparison", () => {
    const { text } = buildConstraintSearchSql({
      countyFips: "48021",
      filters: [{ rail: "acreage", op: "gte", number: 2 }],
      cap: 10,
    });
    // Every comparison is guarded by the state, in the same predicate.
    expect(text).toContain("acreage_state = 'present' and acreage_acres >=");
  });

  it("admits a verified absence as 'not in the SFHA', and nothing weaker", () => {
    const { text } = buildConstraintSearchSql({
      countyFips: "48021",
      filters: [{ rail: "flood", op: "is_false" }],
      cap: 10,
    });
    expect(text).toContain("flood_state = 'absent-verified'");
    expect(text).not.toContain("flood_state = 'unknown'");
  });
});

describe("three-set assembly", () => {
  const filters = TWO_ACRES_OUTSIDE_FLOOD;
  const tally = {
    county_parcels: "1704",
    matched: "412",
    excluded: "89",
    not_evaluated: "1203",
    built_at_max: new Date("2026-09-02T00:00:00.000Z"),
    ne_acreage_0: "10",
    ne_flood_1: "1203",
    ex_acreage_0: "89",
    ex_flood_1: "0",
    un_acreage_0: "10",
    un_flood_1: "1300",
  };

  it("returns three counts that partition the county", () => {
    const result = assembleConstraintSearchResult({
      countyFips: "48021",
      filters,
      cap: 50,
      tally,
      page: [],
      now: new Date("2026-09-02T01:00:00.000Z"),
      unmeasuredRefuseAbovePct: null,
    });
    if ("refused" in result) throw new Error("expected a result");
    expect(result.matched.count).toBe(412);
    expect(result.excluded.count).toBe(89);
    expect(result.notEvaluated.count).toBe(1203);
    expect(
      result.matched.count + result.excluded.count + result.notEvaluated.count,
    ).toBe(result.countyParcels);
  });

  it("names the rail that could not be evaluated", () => {
    const result = assembleConstraintSearchResult({
      countyFips: "48021",
      filters,
      cap: 50,
      tally,
      page: [],
      now: new Date("2026-09-02T01:00:00.000Z"),
      unmeasuredRefuseAbovePct: null,
    });
    if ("refused" in result) throw new Error("expected a result");
    expect(result.notEvaluated.byRail).toEqual({ acreage: 10, flood: 1203 });
    expect(result.excluded.byRail).toEqual({ acreage: 89 });
  });

  it("reports the projection's own age and says when it is stale", () => {
    const fresh = assembleConstraintSearchResult({
      countyFips: "48021",
      filters,
      cap: 50,
      tally,
      page: [],
      now: new Date("2026-09-02T01:00:00.000Z"),
      unmeasuredRefuseAbovePct: null,
    });
    if ("refused" in fresh) throw new Error("expected a result");
    expect(fresh.projection.ageHours).toBe(1);
    expect(fresh.projection.stale).toBe(false);

    const old = assembleConstraintSearchResult({
      countyFips: "48021",
      filters,
      cap: 50,
      tally,
      page: [],
      now: new Date("2026-09-05T01:00:00.000Z"),
      unmeasuredRefuseAbovePct: null,
    });
    if ("refused" in old) throw new Error("expected a result");
    expect(old.projection.stale).toBe(true);
  });

  it("refuses a filter on a rail unmeasured past the operator ceiling, carrying the number", () => {
    const result = assembleConstraintSearchResult({
      countyFips: "48021",
      filters,
      cap: 50,
      tally,
      page: [],
      now: new Date("2026-09-02T01:00:00.000Z"),
      unmeasuredRefuseAbovePct: 50,
    });
    expect(result).toMatchObject({
      refused: true,
      code: "constraint_rail_unmeasured",
    });
    if (!("refused" in result)) throw new Error("expected a refusal");
    // 1300 of 1704 = 76.3 percent, and the refusal says so rather than
    // asserting "insufficient coverage".
    expect(result.detail).toMatchObject({
      rail: "flood",
      unmeasuredPct: 76.3,
      ceilingPct: 50,
    });
  });

  it("reports coverage on SUCCESS too, not only in a refusal", () => {
    const result = assembleConstraintSearchResult({
      countyFips: "48021",
      filters,
      cap: 50,
      tally,
      page: [],
      now: new Date("2026-09-02T01:00:00.000Z"),
      unmeasuredRefuseAbovePct: 90,
    });
    if ("refused" in result) throw new Error("expected a result");
    expect(result.unmeasuredPctByRail).toEqual({ acreage: 0.6, flood: 76.3 });
  });

  it("refuses rather than reporting zero when the county has no projection rows", () => {
    const result = assembleConstraintSearchResult({
      countyFips: "48021",
      filters,
      cap: 50,
      tally: { county_parcels: "0", matched: "0", excluded: "0", not_evaluated: "0" },
      page: [],
      now: new Date(),
      unmeasuredRefuseAbovePct: null,
    });
    expect(result).toMatchObject({
      refused: true,
      code: "constraint_projection_missing",
    });
  });
});

/* ------------------------------------------------------------------ */
/* The partition, against a REAL Postgres. Skipped with no DATABASE_URL;*/
/* CI always provides one.                                              */
/* ------------------------------------------------------------------ */

type SeedRow = {
  propId: string;
  acreage: number | null;
  acreageState: string;
  floodInSfha: boolean | null;
  floodZone: string | null;
  floodState: string;
};

/**
 * Nine parcels covering every cell of the (acreage x flood) verdict table for
 * "two acres or more, outside the floodplain". The expected verdict is written
 * next to each row so the test is readable as the specification it is.
 */
const SEED: Array<SeedRow & { expect: "matched" | "excluded" | "notEvaluated" }> = [
  // acreage present and passing
  { propId: "1", acreage: 5, acreageState: "present", floodInSfha: false, floodZone: "X", floodState: "present", expect: "matched" },
  { propId: "2", acreage: 5, acreageState: "present", floodInSfha: null, floodZone: null, floodState: "absent-verified", expect: "matched" },
  { propId: "3", acreage: 5, acreageState: "present", floodInSfha: true, floodZone: "AE", floodState: "present", expect: "excluded" },
  { propId: "4", acreage: 5, acreageState: "present", floodInSfha: null, floodZone: null, floodState: "unknown", expect: "notEvaluated" },
  { propId: "5", acreage: 5, acreageState: "present", floodInSfha: null, floodZone: null, floodState: "refused", expect: "notEvaluated" },
  // acreage present and failing: EXCLUDED whatever flood says, because the
  // parcel fails on a rail we did measure
  { propId: "6", acreage: 1, acreageState: "present", floodInSfha: null, floodZone: null, floodState: "unknown", expect: "excluded" },
  { propId: "7", acreage: 1, acreageState: "present", floodInSfha: false, floodZone: "X", floodState: "present", expect: "excluded" },
  // acreage unmeasured
  { propId: "8", acreage: null, acreageState: "unknown", floodInSfha: false, floodZone: "X", floodState: "present", expect: "notEvaluated" },
  { propId: "9", acreage: null, acreageState: "unread", floodInSfha: null, floodZone: null, floodState: "unknown", expect: "notEvaluated" },
];

describe.skipIf(!hasDb)("three-set partition against a real store", () => {
  it("partitions every parcel into exactly one set, and names the rail", async () => {
    await withTestSchema(async ({ pool, db }) => {
      for (const row of SEED) {
        await db.execute(sql`
          insert into pe_parcel_constraint_index (
            county_fips, prop_id, parcel_node_id, built_at, build_run_id,
            acreage_acres, acreage_state,
            land_use_state, city_limits_state, etj_state, zoning_state,
            flood_zone, flood_in_sfha, flood_state,
            special_district_state, market_value_state, land_value_state,
            improvement_value_state, year_built_state
          ) values (
            '48021', ${row.propId}, ${"48021:" + row.propId}, now(), gen_random_uuid(),
            ${row.acreage}, ${row.acreageState},
            'unknown','unknown','unread','unknown',
            ${row.floodZone}, ${row.floodInSfha}, ${row.floodState},
            'unknown','unknown','unknown','unknown','unknown'
          )
        `);
      }

      const { text, params } = buildConstraintSearchSql({
        countyFips: "48021",
        filters: TWO_ACRES_OUTSIDE_FLOOD,
        cap: 50,
      });
      const res = await pool.query(text, params);
      const result = assembleConstraintSearchResult({
        countyFips: "48021",
        filters: TWO_ACRES_OUTSIDE_FLOOD,
        cap: 50,
        tally: res.rows[0].tally,
        page: res.rows[0].page,
        now: new Date(),
        unmeasuredRefuseAbovePct: null,
      });
      if ("refused" in result) throw new Error(`unexpected refusal ${result.code}`);

      const want = {
        matched: SEED.filter((r) => r.expect === "matched").length,
        excluded: SEED.filter((r) => r.expect === "excluded").length,
        notEvaluated: SEED.filter((r) => r.expect === "notEvaluated").length,
      };
      expect(result.matched.count).toBe(want.matched);
      expect(result.excluded.count).toBe(want.excluded);
      expect(result.notEvaluated.count).toBe(want.notEvaluated);
      expect(result.countyParcels).toBe(SEED.length);
      // The partition holds: no parcel is in two sets and none is dropped.
      expect(want.matched + want.excluded + want.notEvaluated).toBe(SEED.length);

      // The matched page is exactly the two parcels the table says, and the
      // one with a VERIFIED ABSENCE of flood is one of them. That row is the
      // whole reason absent-verified is a separate state.
      expect(result.matched.parcels.map((p) => p.parcelNodeId).sort()).toEqual([
        "48021:1",
        "48021:2",
      ]);
      expect(result.matched.parcels.find((p) => p.parcelNodeId === "48021:2")?.rails.flood)
        .toEqual({ state: "absent-verified", value: null, flag: null });
      // The zone letter and the SFHA determination are two fields, so a present
      // Zone X row keeps both rather than collapsing to whichever was written
      // second.
      expect(result.matched.parcels.find((p) => p.parcelNodeId === "48021:1")?.rails.flood)
        .toEqual({ state: "present", value: "X", flag: false });

      // Attribution: flood could not be evaluated on 3 of the 4 not-evaluated
      // parcels; acreage on 2. The byRail values sum to 5 against a set of 4,
      // which is the documented counting rule, not a bug.
      expect(result.notEvaluated.byRail).toEqual({ acreage: 2, flood: 3 });
      expect(result.excluded.byRail).toEqual({ acreage: 2, flood: 1 });
    });
  }, 60_000);

  it("truncates explicitly rather than returning a silently short page", async () => {
    await withTestSchema(async ({ pool, db }) => {
      for (let i = 1; i <= 5; i += 1) {
        await db.execute(sql`
          insert into pe_parcel_constraint_index (
            county_fips, prop_id, parcel_node_id, built_at, build_run_id,
            acreage_acres, acreage_state,
            land_use_state, city_limits_state, etj_state, zoning_state,
            flood_state, special_district_state, market_value_state,
            land_value_state, improvement_value_state, year_built_state
          ) values (
            '48021', ${String(i)}, ${"48021:" + i}, now(), gen_random_uuid(),
            10, 'present',
            'unknown','unknown','unread','unknown','unknown','unknown','unknown',
            'unknown','unknown','unknown'
          )
        `);
      }
      const filters: ConstraintFilter[] = [{ rail: "acreage", op: "gte", number: 2 }];
      const { text, params } = buildConstraintSearchSql({
        countyFips: "48021",
        filters,
        cap: 2,
      });
      const res = await pool.query(text, params);
      const result = assembleConstraintSearchResult({
        countyFips: "48021",
        filters,
        cap: 2,
        tally: res.rows[0].tally,
        page: res.rows[0].page,
        now: new Date(),
        unmeasuredRefuseAbovePct: null,
      });
      if ("refused" in result) throw new Error(`unexpected refusal ${result.code}`);
      expect(result.matched.count).toBe(5);
      expect(result.matched.received).toBe(2);
      expect(result.matched.truncated).toBe(true);
    });
  }, 60_000);

  it("matches only a verified absence on op:absent, never an unmeasured cell", async () => {
    await withTestSchema(async ({ pool, db }) => {
      const rows = [
        { propId: "1", zoningState: "absent-verified", district: null },
        { propId: "2", zoningState: "unknown", district: null },
        { propId: "3", zoningState: "present", district: "SF-1" },
      ];
      for (const row of rows) {
        await db.execute(sql`
          insert into pe_parcel_constraint_index (
            county_fips, prop_id, parcel_node_id, built_at, build_run_id,
            acreage_state, land_use_state, city_limits_state, etj_state,
            zoning_district, zoning_state,
            flood_state, special_district_state, market_value_state,
            land_value_state, improvement_value_state, year_built_state
          ) values (
            '48021', ${row.propId}, ${"48021:" + row.propId}, now(), gen_random_uuid(),
            'unknown','unknown','unknown','unread',
            ${row.district}, ${row.zoningState},
            'unknown','unknown','unknown','unknown','unknown','unknown'
          )
        `);
      }
      const filters: ConstraintFilter[] = [{ rail: "zoningDistrict", op: "absent" }];
      const { text, params } = buildConstraintSearchSql({
        countyFips: "48021",
        filters,
        cap: 50,
      });
      const res = await pool.query(text, params);
      const result = assembleConstraintSearchResult({
        countyFips: "48021",
        filters,
        cap: 50,
        tally: res.rows[0].tally,
        page: res.rows[0].page,
        now: new Date(),
        unmeasuredRefuseAbovePct: null,
      });
      if ("refused" in result) throw new Error(`unexpected refusal ${result.code}`);
      expect(result.matched.parcels.map((p) => p.parcelNodeId)).toEqual(["48021:1"]);
      // The zoned parcel is a definite fail; the unmeasured one is not
      // evaluated. Two rows, two different answers, never merged.
      expect(result.excluded.count).toBe(1);
      expect(result.notEvaluated.count).toBe(1);
    });
  }, 60_000);
});
