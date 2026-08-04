/**
 * County ledger endpoint (R-FND-6, OPS-6), read-only GET /api/county-ledger.
 *
 * Covers the pre-existing facet-scorecard grouping (no test file existed
 * for this route before) plus the OPS-9 S1 additive extension: countyName +
 * per-registry-row `rows` (gate, cert, openDefectClasses, focusedFixCount),
 * joined from jurisdiction_registry_row_mirror / county_gate_cert_state /
 * onboarding_ledger_event. Asserts the extension never mutates the existing
 * facet/summary shape.
 *
 * Uses the real-PG route harness (withTestSchema via setup.ts). Requires
 * TEST_DATABASE_URL / DATABASE_URL, CI-authoritative when unset.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";
import { db, countyFacetCoverage } from "@workspace/db";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("countyLedger.test: ctx.schema not set");
      }
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { __resetServiceApiKeyCacheForTests } = await import(
  "../lib/serviceToken"
);

const TEST_SERVICE_TOKEN = "test-county-ledger-service-token-xyz";
const serviceAuth = { Authorization: `Bearer ${TEST_SERVICE_TOKEN}` };

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeEach(() => {
  process.env.SERVICE_API_KEY = TEST_SERVICE_TOKEN;
  __resetServiceApiKeyCacheForTests();
});

const LEDGER_PATH = "/api/county-ledger";

describe("GET /api/county-ledger, pre-existing facet-scorecard shape", () => {
  it("returns an empty ledger with zeroed summary when nothing has been scored", async () => {
    const res = await request(getApp()).get(LEDGER_PATH);
    expect(res.status).toBe(200);
    expect(res.body.counties).toEqual([]);
    expect(res.body.summary).toEqual({
      onboardedCount: 0,
      totalCounties: 0,
      staleCount: 0,
      rewarmUnsafeCount: 0,
    });
  });

  it("groups facet rows by countyFips and rolls up onboarded/stale/rewarmUnsafe", async () => {
    await db.insert(countyFacetCoverage).values({
      countyFips: "48021",
      facet: "zoning",
      honestCoveragePct: "98.01",
      integrityVerdict: "pass",
      classification: "real-at-ceiling",
      onboarded: true,
      stalenessFlag: false,
      rewarmUnsafe: false,
    });

    const res = await request(getApp()).get(LEDGER_PATH);
    expect(res.status).toBe(200);
    expect(res.body.counties).toHaveLength(1);
    const county = res.body.counties[0];
    expect(county.countyFips).toBe("48021");
    expect(county.onboarded).toBe(true);
    expect(county.facets).toHaveLength(1);
    expect(county.facets[0].honestCoveragePct).toBe(98.01);
    expect(res.body.summary.onboardedCount).toBe(1);
  });
});

describe("GET /api/county-ledger, OPS-9 S1 additive extension", () => {
  it("attaches countyName + a per-row gate/cert view from the mirror tables", async () => {
    await request(getApp())
      .post("/api/onboarding-ledger/ingest")
      .set(serviceAuth)
      .send({
        sourceKind: "preflight",
        rowMirror: [
          {
            rowId: "Elgin",
            fips: "48021",
            countyName: "Elgin",
            status: "pre-flight-pending",
            zoningRegime: "euclidean-zoned",
          },
        ],
        events: [
          {
            ts: "2026-08-03T00:00:00.000Z",
            fips: "48021",
            rowId: "Elgin",
            railOrCheck: "railASourceReachable",
            defectClass: "ADAPTER-NEEDED",
            declineReason: "source unreachable, needs adapter: no Rail A layer wired for this row",
          },
        ],
        gateSummary: {
          rowId: "Elgin",
          fips: "48021",
          passCount: 2,
          declineCount: 1,
          checks: [{ id: "railASourceReachable", outcome: "DECLINE", reason: "no Rail A layer wired" }],
        },
      });

    const res = await request(getApp()).get(LEDGER_PATH);
    expect(res.status).toBe(200);
    const county = res.body.counties.find((c: { countyFips: string }) => c.countyFips === "48021");
    expect(county).toBeDefined();
    expect(county.countyName).toBe("Elgin");
    expect(county.rows).toHaveLength(1);
    const row = county.rows[0];
    expect(row.rowId).toBe("Elgin");
    expect(row.gate).toMatchObject({ passCount: 2, declineCount: 1 });
    expect(row.openDefectClasses).toEqual([{ defectClass: "ADAPTER-NEEDED", count: 1 }]);
    expect(row.focusedFixCount).toBe(1);
  });

  it("creates a county entry from a registry mirror row even with no county_facet_coverage rows yet", async () => {
    await request(getApp())
      .post("/api/onboarding-ledger/ingest")
      .set(serviceAuth)
      .send({
        sourceKind: "preflight",
        rowMirror: [
          {
            rowId: "Smithville",
            fips: "48021",
            countyName: "Smithville",
            status: "pre-flight-pending",
            zoningRegime: "euclidean-zoned",
          },
        ],
        events: [],
      });

    const res = await request(getApp()).get(LEDGER_PATH);
    expect(res.status).toBe(200);
    const county = res.body.counties.find(
      (c: { countyFips: string; rows: Array<{ rowId: string }> }) =>
        c.countyFips === "48021" && c.rows.some((r) => r.rowId === "Smithville"),
    );
    expect(county).toBeDefined();
    // No county_facet_coverage rows were seeded for this county, so facets
    // stays empty even though a registry row exists.
    expect(county.facets).toEqual([]);
  });
});
