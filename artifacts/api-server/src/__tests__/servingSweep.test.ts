/**
 * Serving-sweep endpoint (SS-W7 / P-44), the route Command Center was already
 * probing before it existed.
 *
 * What these tests are for, beyond the happy path: the two failure shapes on
 * this surface are opposite findings that must never render the same. "No
 * sweep has been ingested for this county" and "this county was swept and
 * everything is absent" are different worlds; an empty envelope collapses
 * them. So the not-ingested and not-swept cases are pinned as NAMED states
 * with their own status codes, and a malformed ingest is asserted to leave the
 * store untouched rather than half-written.
 *
 * Uses the real-PG route harness (withTestSchema via setup.ts). Requires
 * TEST_DATABASE_URL / DATABASE_URL; CI-authoritative when unset.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";
import { db, servingSweepCounty } from "@workspace/db";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("servingSweep.test: ctx.schema not set");
      }
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { __resetServiceApiKeyCacheForTests } = await import("../lib/serviceToken");
const { FIELD_KEYS } = await import("../servingSweepRecord");

const TEST_SERVICE_TOKEN = "test-serving-sweep-service-token-xyz";
const serviceAuth = { Authorization: `Bearer ${TEST_SERVICE_TOKEN}` };

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeEach(() => {
  process.env.SERVICE_API_KEY = TEST_SERVICE_TOKEN;
  __resetServiceApiKeyCacheForTests();
});

const SWEEP_PATH = "/api/serving-sweep";
const INGEST_PATH = "/api/serving-sweep/ingest";

type Tally = {
  present: number;
  absentCovered: number;
  absentUncovered: number;
  unresolved: number;
};

function tally(present = 0, absentUncovered = 0): Tally {
  return { present, absentCovered: 0, absentUncovered, unresolved: 0 };
}

function fields(overrides: Record<string, Tally> = {}): Record<string, Tally> {
  return {
    ...Object.fromEntries(FIELD_KEYS.map((k) => [k, tally()])),
    ...overrides,
  };
}

function countyBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    countyFips: "48021",
    countyName: "Bastrop",
    sweptAt: "2026-08-19T00:00:48.244Z",
    resolverVersion: "ss-w5/1.0.0",
    parcelsTotal: 62399,
    parcelsUnresolvable: 0,
    fields: fields({ geometry: tally(3931, 58468) }),
    singleFamily: { parcelsTotal: 32269, fields: fields() },
    contradictions: [
      {
        kind: "flood-zone-disagreement",
        count: 5424,
        exampleParcelNodeIds: ["48021:36521"],
      },
    ],
    multiZoneFloodParcels: 5424,
    absenceClusters: [
      {
        field: "situsAddress",
        label: "unincorporated southeast",
        parcelCount: 2570,
        bbox: [-97.35, 30.0, -97.25, 30.1],
      },
    ],
    sourcesByField: {
      geometry: { source: "txgio_parcel", vintage: "stratmap25" },
      flood: { source: "fema-nfhl", vintage: null },
    },
    ...overrides,
  };
}

async function countRows(): Promise<number> {
  const rows = await db.select().from(servingSweepCounty);
  return rows.length;
}

describe("GET /api/serving-sweep, nothing ingested", () => {
  it("answers 503 with a NAMED not-ingested reason, never an empty envelope", async () => {
    const res = await request(getApp()).get(SWEEP_PATH);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("serving_sweep_not_ingested");
    // The distinction the status code exists to protect.
    expect(res.body.message).toContain("not a sweep that found nothing");
    expect(res.body.servedAt).toEqual(expect.any(String));
    expect(res.body.counties).toBeUndefined();
  });

  it("answers a per-county read with 404 county_not_swept, not an empty sweep", async () => {
    const res = await request(getApp()).get(`${SWEEP_PATH}/48453`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("county_not_swept");
    expect(res.body.countyFips).toBe("48453");
    expect(res.body.message).toContain("not a sweep that found nothing");
  });

  it("rejects a malformed county fips with a named 400 rather than a lookup", async () => {
    const res = await request(getApp()).get(`${SWEEP_PATH}/bastrop`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_county_fips");
    expect(res.body.received).toBe("bastrop");
  });

  it("serves an empty county index rather than 503 — 'which counties' has an answer", async () => {
    const res = await request(getApp()).get(`${SWEEP_PATH}/counties`);
    expect(res.status).toBe(200);
    expect(res.body.countiesSwept).toBe(0);
    expect(res.body.counties).toEqual([]);
  });
});

describe("POST /api/serving-sweep/ingest", () => {
  it("requires the service token — an unauthenticated post writes nothing", async () => {
    const res = await request(getApp()).post(INGEST_PATH).send(countyBody());
    expect(res.status).toBe(401);
    expect(await countRows()).toBe(0);
  });

  it("rejects a wrong service token", async () => {
    const res = await request(getApp())
      .post(INGEST_PATH)
      .set({ Authorization: "Bearer not-the-token" })
      .send(countyBody());
    expect(res.status).toBe(401);
    expect(await countRows()).toBe(0);
  });

  it("stores one county and reports it as added", async () => {
    const res = await request(getApp())
      .post(INGEST_PATH)
      .set(serviceAuth)
      .send(countyBody());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.shapeRead).toBe("county");
    expect(res.body.countiesIngested).toBe(1);
    expect(res.body.added).toEqual(["48021"]);
    expect(res.body.replaced).toEqual([]);
    expect(await countRows()).toBe(1);
  });

  it("derives the scalar columns FROM THE PAYLOAD, never from a separate claim", async () => {
    await request(getApp()).post(INGEST_PATH).set(serviceAuth).send(countyBody());
    const rows = await db.select().from(servingSweepCounty);
    const row = rows[0] as unknown as {
      countyFips: string;
      countyName: string;
      resolverVersion: string;
      parcelsTotal: number;
      sweptAt: Date;
      payload: Record<string, unknown>;
    };
    expect(row.countyName).toBe(row.payload.countyName);
    expect(row.resolverVersion).toBe(row.payload.resolverVersion);
    expect(row.parcelsTotal).toBe(row.payload.parcelsTotal);
    expect(row.sweptAt.toISOString()).toBe(row.payload.sweptAt);
  });

  it("replaces an existing county rather than accumulating sweeps", async () => {
    await request(getApp()).post(INGEST_PATH).set(serviceAuth).send(countyBody());
    const res = await request(getApp())
      .post(INGEST_PATH)
      .set(serviceAuth)
      .send(countyBody({ sweptAt: "2026-08-20T00:00:00.000Z", parcelsTotal: 62400 }));
    expect(res.status).toBe(200);
    expect(res.body.added).toEqual([]);
    expect(res.body.replaced).toEqual(["48021"]);
    expect(await countRows()).toBe(1);

    const sweep = await request(getApp()).get(SWEEP_PATH);
    expect(sweep.body.counties[0].parcelsTotal).toBe(62400);
  });

  it("accepts a whole statewide body and explodes it into county rows", async () => {
    const res = await request(getApp())
      .post(INGEST_PATH)
      .set(serviceAuth)
      .send({
        sweptAt: "2026-08-19T00:01:03.846Z",
        resolverVersion: "ss-w5/1.0.0",
        countiesTotal: 254,
        countiesSwept: 2,
        parcelsTotal: 866857,
        counties: [
          countyBody(),
          countyBody({
            countyFips: "48453",
            countyName: "Travis",
            sweptAt: "2026-08-19T00:01:00.000Z",
            parcelsTotal: 804458,
          }),
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.shapeRead).toBe("statewide");
    expect(res.body.countiesIngested).toBe(2);
    expect(await countRows()).toBe(2);
  });

  it("rejects a malformed sweep with problems BY PATH and stores nothing", async () => {
    const broken = countyBody();
    delete (broken.fields as Record<string, unknown>).frontage;
    const res = await request(getApp())
      .post(INGEST_PATH)
      .set(serviceAuth)
      .send(broken);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_serving_sweep");
    expect(res.body.problems.join("\n")).toContain("root.fields.frontage");
    expect(res.body.message).toContain("nothing was stored");
    expect(await countRows()).toBe(0);
  });

  it("a statewide body with one bad county stores NONE of it", async () => {
    const badCounty = countyBody({ countyFips: "48453", countyName: "Travis" });
    (badCounty.contradictions as unknown[]) = [
      { kind: "not-a-real-kind", count: 1, exampleParcelNodeIds: [] },
    ];
    const res = await request(getApp())
      .post(INGEST_PATH)
      .set(serviceAuth)
      .send({
        sweptAt: "2026-08-19T00:01:03.846Z",
        resolverVersion: "ss-w5/1.0.0",
        countiesTotal: 254,
        countiesSwept: 2,
        parcelsTotal: 2,
        counties: [countyBody(), badCounty],
      });
    expect(res.status).toBe(400);
    expect(await countRows()).toBe(0);
  });
});

describe("GET /api/serving-sweep, assembled envelope", () => {
  beforeEach(async () => {
    await request(getApp()).post(INGEST_PATH).set(serviceAuth).send(countyBody());
    await request(getApp())
      .post(INGEST_PATH)
      .set(serviceAuth)
      .send(
        countyBody({
          countyFips: "48453",
          countyName: "Travis",
          sweptAt: "2026-08-19T00:01:00.000Z",
          parcelsTotal: 804458,
        }),
      );
  });

  it("serves the frozen shape with countiesSwept measured from the array", async () => {
    const res = await request(getApp()).get(SWEEP_PATH);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.countiesSwept).toBe(res.body.counties.length);
    expect(res.body.countiesSwept).toBe(2);
    expect(res.body.countiesTotal).toBe(254);
    expect(res.body.parcelsTotal).toBe(62399 + 804458);
    expect(res.body.counties.map((c: { countyFips: string }) => c.countyFips)).toEqual([
      "48021",
      "48453",
    ]);
  });

  it("carries no key the frozen record does not have", async () => {
    const res = await request(getApp()).get(SWEEP_PATH);
    expect(Object.keys(res.body).sort()).toEqual([
      "counties",
      "countiesSwept",
      "countiesTotal",
      "parcelsTotal",
      "resolverVersion",
      "sweptAt",
    ]);
    expect(Object.keys(res.body.counties[0]).sort()).toEqual([
      "absenceClusters",
      "contradictions",
      "countyFips",
      "countyName",
      "fields",
      "multiZoneFloodParcels",
      "parcelsTotal",
      "parcelsUnresolvable",
      "resolverVersion",
      "singleFamily",
      "sourcesByField",
      "sweptAt",
    ]);
  });

  it("dates the envelope from the newest county sweep, never from the read clock", async () => {
    const res = await request(getApp()).get(SWEEP_PATH);
    expect(res.body.sweptAt).toBe("2026-08-19T00:01:00.000Z");
    // The read clock is available, but in a header where it cannot be
    // mistaken for the sweep's own freshness.
    const assembledAt = res.headers["x-sweep-assembled-at"];
    expect(assembledAt).toEqual(expect.any(String));
    expect(Date.parse(assembledAt)).toBeGreaterThan(Date.parse(res.body.sweptAt));
  });

  it("reports every FieldKey on every county, so a renderer can iterate the union", async () => {
    const res = await request(getApp()).get(SWEEP_PATH);
    for (const county of res.body.counties) {
      expect(Object.keys(county.fields).sort()).toEqual([...FIELD_KEYS].sort());
      expect(Object.keys(county.singleFamily.fields).sort()).toEqual(
        [...FIELD_KEYS].sort(),
      );
    }
  });

  it("keeps unresolved as its own class on the wire — failure is not an absence", async () => {
    const res = await request(getApp()).get(SWEEP_PATH);
    const geometry = res.body.counties[0].fields.geometry;
    expect(Object.keys(geometry).sort()).toEqual([
      "absentCovered",
      "absentUncovered",
      "present",
      "unresolved",
    ]);
    expect(geometry.present + geometry.absentCovered + geometry.absentUncovered + geometry.unresolved).toBe(
      res.body.counties[0].parcelsTotal,
    );
  });

  it("addresses one county directly and returns exactly that county's record", async () => {
    const res = await request(getApp()).get(`${SWEEP_PATH}/48453`);
    expect(res.status).toBe(200);
    expect(res.body.countyFips).toBe("48453");
    expect(res.body.countyName).toBe("Travis");
    expect(res.body.parcelsTotal).toBe(804458);
    expect(res.headers["x-sweep-swept-at"]).toBe("2026-08-19T00:01:00.000Z");
  });

  it("lists the swept counties with sweptAt and ingestedAt kept apart", async () => {
    const res = await request(getApp()).get(`${SWEEP_PATH}/counties`);
    expect(res.status).toBe(200);
    expect(res.body.countiesSwept).toBe(2);
    const bastrop = res.body.counties[0];
    expect(bastrop.countyFips).toBe("48021");
    expect(bastrop.sweptAt).toBe("2026-08-19T00:00:48.244Z");
    // Different facts. The ingest clock is later than the sweep clock here,
    // and conflating them is how a stale ingest of a fresh sweep hides.
    expect(Date.parse(bastrop.ingestedAt)).toBeGreaterThan(
      Date.parse(bastrop.sweptAt),
    );
  });

  it("a swept county and an unswept county do not render the same", async () => {
    const swept = await request(getApp()).get(`${SWEEP_PATH}/48021`);
    const unswept = await request(getApp()).get(`${SWEEP_PATH}/48113`);
    expect(swept.status).toBe(200);
    expect(unswept.status).toBe(404);
    expect(unswept.body.error).toBe("county_not_swept");
  });
});
