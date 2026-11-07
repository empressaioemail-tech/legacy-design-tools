/**
 * P-106 route surface. The refusals are 422 `serve_refused` bodies, the same
 * envelope radius-search and street-search already use, so the MCP tool's
 * `declarePlaceSearchRefusal` reads them without a second shape. A refusal is
 * never a 500 and never an empty 200.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import {
  brokeragePlaceConstraintSearchRouter,
  resetConstraintSearchQueryableForTests,
  setConstraintSearchQueryableForTests,
} from "../routes/brokeragePlaceConstraintSearch";

function buildApp() {
  const app = express();
  app.use("/api/brokerage/v1/place", brokeragePlaceConstraintSearchRouter);
  return app;
}

const TALLY = {
  county_parcels: "1704",
  matched: "412",
  excluded: "89",
  not_evaluated: "1203",
  built_at_max: new Date(),
  ne_acreage_0: "10",
  ne_flood_1: "1203",
  ex_acreage_0: "89",
  ex_flood_1: "0",
  un_acreage_0: "10",
  un_flood_1: "1300",
};

const FILTERS = JSON.stringify([
  { rail: "acreage", op: "gte", number: 2 },
  { rail: "flood", op: "is_false" },
]);

beforeEach(() => {
  setConstraintSearchQueryableForTests({
    // The seam is generic (`query<T>`), so a concrete fixture is handed back
    // through the generic rather than widening the interface for a test.
    query: async <T extends Record<string, unknown>>() => ({
      rows: [{ tally: TALLY, page: [] }] as unknown as T[],
    }),
  });
  delete process.env.CONSTRAINT_SEARCH_UNMEASURED_REFUSE_ABOVE_PCT;
});

afterEach(() => {
  resetConstraintSearchQueryableForTests();
  delete process.env.CONSTRAINT_SEARCH_UNMEASURED_REFUSE_ABOVE_PCT;
});

describe("GET /api/brokerage/v1/place/constraint-search", () => {
  it("returns all three sets", async () => {
    const res = await request(buildApp())
      .get("/api/brokerage/v1/place/constraint-search")
      .query({ countyFips: "48021", filters: FILTERS });
    expect(res.status).toBe(200);
    expect(res.body.matched.count).toBe(412);
    expect(res.body.excluded.count).toBe(89);
    expect(res.body.notEvaluated.count).toBe(1203);
    expect(res.body.notEvaluated.byRail).toEqual({ acreage: 10, flood: 1203 });
    expect(res.body.countingRule).toMatch(/every parcel in exactly one set/);
  });

  it("refuses a missing county as 422 serve_refused, not 400 and not an empty 200", async () => {
    const res = await request(buildApp())
      .get("/api/brokerage/v1/place/constraint-search")
      .query({ filters: FILTERS });
    expect(res.status).toBe(422);
    expect(res.body.errorClass).toBe("serve_refused");
    expect(res.body.error).toBe("constraint_bound_missing");
  });

  it("refuses an out-of-scope county rather than answering it empty", async () => {
    const res = await request(buildApp())
      .get("/api/brokerage/v1/place/constraint-search")
      .query({ countyFips: "48201", filters: FILTERS });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("constraint_county_out_of_scope");
    expect(res.body.message).toMatch(/Refusing rather than returning an empty set/);
  });

  it("carries the measured percentage in the refusal's detail", async () => {
    process.env.CONSTRAINT_SEARCH_UNMEASURED_REFUSE_ABOVE_PCT = "50";
    const res = await request(buildApp())
      .get("/api/brokerage/v1/place/constraint-search")
      .query({ countyFips: "48021", filters: FILTERS });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("constraint_rail_unmeasured");
    expect(res.body.detail).toMatchObject({
      rail: "flood",
      unmeasuredPct: 76.3,
      ceilingPct: 50,
      countyParcels: 1704,
      unmeasuredParcels: 1300,
    });
  });

  it("applies no ceiling at all when the operator has ruled none", async () => {
    const res = await request(buildApp())
      .get("/api/brokerage/v1/place/constraint-search")
      .query({ countyFips: "48021", filters: FILTERS });
    expect(res.status).toBe(200);
    // Coverage is still reported. Unset means "no gate", never "hide it".
    expect(res.body.unmeasuredPctByRail).toEqual({ acreage: 0.6, flood: 76.3 });
  });

  it("rejects a filter shape it does not recognise at the boundary", async () => {
    const res = await request(buildApp())
      .get("/api/brokerage/v1/place/constraint-search")
      .query({
        countyFips: "48021",
        filters: JSON.stringify([{ rail: "acreage", op: "roughly", number: 2 }]),
      });
    expect(res.status).toBe(400);
    expect(res.body.errorClass).toBe("validation_error");
  });

  it("says the store is not configured rather than claiming no parcels match", async () => {
    setConstraintSearchQueryableForTests(null);
    const res = await request(buildApp())
      .get("/api/brokerage/v1/place/constraint-search")
      .query({ countyFips: "48021", filters: FILTERS });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("store_not_configured");
  });
});
