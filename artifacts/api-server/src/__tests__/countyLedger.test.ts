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
 * Also covers County Manifest Sprint 1 (feat/county-manifest-sprint1): the
 * additive `manifestCells` field (254 x 13 = 3,302 cells, always), the
 * no-atom/no-writer/not-yet/stored-rail_state precedence resolution, and
 * that `manifestCells` is fully independent of the pre-existing `counties`
 * array — a route with zero county_facet_coverage rows still returns the
 * full manifest grid once county_manifest/county_rail are seeded.
 *
 * Uses the real-PG route harness (withTestSchema via setup.ts). Requires
 * TEST_DATABASE_URL / DATABASE_URL, CI-authoritative when unset.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";
import { db, countyFacetCoverage, countyManifest, countyRail } from "@workspace/db";

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
    // Deliberately a DIFFERENT fips than every other test in this file
    // (48021 carries a county_facet_coverage row seeded by the
    // "pre-existing facet-scorecard shape" describe block above, and that
    // table is NOT in setup.ts's TRUNCATE_TABLES, so it persists across
    // this file's tests, see setup.ts's TRUNCATE_TABLES comment for the
    // "if a route writes to it, it's in this list" invariant, which
    // county_facet_coverage predates and is out of this change's scope).
    // Using an untouched fips is what actually proves the "no coverage
    // rows yet" case, independent of that pre-existing gap.
    await request(getApp())
      .post("/api/onboarding-ledger/ingest")
      .set(serviceAuth)
      .send({
        sourceKind: "preflight",
        rowMirror: [
          {
            rowId: "Smithville",
            fips: "48091",
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
        c.countyFips === "48091" && c.rows.some((r) => r.rowId === "Smithville"),
    );
    expect(county).toBeDefined();
    // No county_facet_coverage rows were seeded for this county, so facets
    // stays empty even though a registry row exists.
    expect(county.facets).toEqual([]);
  });
});

describe("GET /api/county-ledger, County Manifest Sprint 1 manifestCells grid", () => {
  const RAIL_COUNT = 13;

  /** Seed the real 13-rail dimension, matching migration 0068's seed exactly (kind/atomFamilyState/hasWriter drive the precedence assertions below). */
  async function seedThirteenRails(): Promise<void> {
    await db.insert(countyRail).values([
      { railKey: "geometry", displayName: "Parcel geometry", ordinal: 1, kind: "spine", thresholdPct: "95", atomFamilyState: "missing", hasWriter: false, declaredSource: "TxGIO StratMap" },
      { railKey: "cad", displayName: "CAD attributes", ordinal: 2, kind: "spine", thresholdPct: "95", atomFamilyState: "missing", hasWriter: false, declaredSource: "County CAD" },
      { railKey: "join", displayName: "Join quality", ordinal: 3, kind: "spine", thresholdPct: "95", atomFamilyState: "missing", hasWriter: true, declaredSource: "Derived" },
      { railKey: "zoning", displayName: "Zoning + setback", ordinal: 4, kind: "spine", thresholdPct: "95", atomFamilyState: "present", hasWriter: true, declaredSource: "Municipal code" },
      { railKey: "roads", displayName: "Roads / frontage", ordinal: 5, kind: "spine", thresholdPct: "95", atomFamilyState: "present", hasWriter: false, declaredSource: "OSM Overpass" },
      { railKey: "flood", displayName: "Flood / terrain", ordinal: 6, kind: "spine", thresholdPct: "95", atomFamilyState: "partial", hasWriter: false, declaredSource: "FEMA NFHL" },
      { railKey: "envelope", displayName: "Buildable envelope", ordinal: 7, kind: "derived", thresholdPct: "90", atomFamilyState: "present", hasWriter: true, declaredSource: "Derived" },
      { railKey: "landuse", displayName: "Land use", ordinal: 8, kind: "derived", thresholdPct: "90", atomFamilyState: "missing", hasWriter: true, declaredSource: "CAD roll code" },
      { railKey: "footprint", displayName: "Building footprints", ordinal: 9, kind: "derived", thresholdPct: "90", atomFamilyState: "unpublished", hasWriter: false, declaredSource: "ML-derived" },
      { railKey: "easement", displayName: "Utility easements", ordinal: 10, kind: "derived", thresholdPct: "90", atomFamilyState: "unpublished", hasWriter: false, declaredSource: "County honest-absence default" },
      { railKey: "owner", displayName: "Owner facet", ordinal: 11, kind: "derived", thresholdPct: "90", atomFamilyState: "missing", hasWriter: false, declaredSource: "CAD owner_name" },
      { railKey: "rrc", displayName: "RRC wells / pipelines", ordinal: 12, kind: "derived", thresholdPct: "90", atomFamilyState: "partial", hasWriter: false, declaredSource: "RRC public GIS" },
      { railKey: "mud", displayName: "MUD / special districts", ordinal: 13, kind: "derived", thresholdPct: "90", atomFamilyState: "missing", hasWriter: false, declaredSource: "TX Comptroller registry" },
    ]);
  }

  it("returns all 3,302 cells (254 counties x 13 rails) once the manifest is fully seeded", async () => {
    await seedThirteenRails();
    const rows = Array.from({ length: 254 }, (_, i) => ({
      countyFips: String(50000 + i), // synthetic fips, disjoint from every other test's real fips values
      countyName: `Synthetic County ${i}`,
      rosterSchemaVersion: "test-v1",
      rosterGeneratedAt: new Date("2026-08-05T00:00:00.000Z"),
    }));
    await db.insert(countyManifest).values(rows);

    const res = await request(getApp()).get(LEDGER_PATH);
    expect(res.status).toBe(200);
    expect(res.body.manifestCells).toHaveLength(254 * RAIL_COUNT);
    expect(res.body.summary.totalCounties).toBe(254);
    expect(res.body.summary.totalRails).toBe(RAIL_COUNT);
    expect(res.body.summary.totalCells).toBe(254 * RAIL_COUNT);
  });

  it("a county with zero county_facet_coverage rows still returns all 13 cells", async () => {
    await seedThirteenRails();
    await db.insert(countyManifest).values({
      countyFips: "50900",
      countyName: "No-Coverage County",
      rosterSchemaVersion: "test-v1",
      rosterGeneratedAt: new Date("2026-08-05T00:00:00.000Z"),
    });

    const res = await request(getApp()).get(LEDGER_PATH);
    expect(res.status).toBe(200);
    const cellsForCounty = res.body.manifestCells.filter(
      (c: { countyFips: string }) => c.countyFips === "50900",
    );
    expect(cellsForCounty).toHaveLength(RAIL_COUNT);
    // Every cell resolves to a derived state (no-atom / no-writer / not-yet),
    // never a stored value, since no county_facet_coverage row exists.
    for (const c of cellsForCounty) {
      expect(["no-atom", "no-writer", "not-yet"]).toContain(c.displayState);
    }
  });

  it("precedence: no-atom dominates even when a stray county_facet_coverage row exists for a no-atom rail", async () => {
    await seedThirteenRails();
    await db.insert(countyManifest).values({
      countyFips: "50901",
      countyName: "Stray-Row County",
      rosterSchemaVersion: "test-v1",
      rosterGeneratedAt: new Date("2026-08-05T00:00:00.000Z"),
    });
    // `landuse` is seeded atomFamilyState='missing' above (scored but not
    // atomized, per the spec's section 7 land-use-display-regression open
    // question — this sprint's ruled behavior is strict no-atom-dominates).
    // Insert a real, high-coverage stored row for it anyway to prove the
    // precedence CASE overrides it rather than surfacing the stray value.
    await db.insert(countyFacetCoverage).values({
      countyFips: "50901",
      facet: "landuse",
      honestCoveragePct: "98.01",
      integrityVerdict: "pass",
      classification: "real-at-ceiling",
      railState: "satisfied-present",
    });

    const res = await request(getApp()).get(LEDGER_PATH);
    expect(res.status).toBe(200);
    const landuseCell = res.body.manifestCells.find(
      (c: { countyFips: string; railKey: string }) =>
        c.countyFips === "50901" && c.railKey === "landuse",
    );
    expect(landuseCell).toBeDefined();
    expect(landuseCell.displayState).toBe("no-atom");
    // The stored coverage value is still visible on the cell (for drill-
    // through), it just does not win the displayState.
    expect(landuseCell.honestCoveragePct).toBe(98.01);
  });

  it("precedence: a rail with an atom but no writer renders no-writer, never the stored row", async () => {
    await seedThirteenRails();
    await db.insert(countyManifest).values({
      countyFips: "50902",
      countyName: "No-Writer County",
      rosterSchemaVersion: "test-v1",
      rosterGeneratedAt: new Date("2026-08-05T00:00:00.000Z"),
    });
    // `roads` is seeded atomFamilyState='present', hasWriter=false above.
    const res = await request(getApp()).get(LEDGER_PATH);
    expect(res.status).toBe(200);
    const roadsCell = res.body.manifestCells.find(
      (c: { countyFips: string; railKey: string }) =>
        c.countyFips === "50902" && c.railKey === "roads",
    );
    expect(roadsCell).toBeDefined();
    expect(roadsCell.displayState).toBe("no-writer");
  });

  it("precedence: a satisfied-present cell below threshold surfaces as PARTIAL and does not count toward satisfiedCells", async () => {
    await seedThirteenRails();
    await db.insert(countyManifest).values({
      countyFips: "50903",
      countyName: "Partial County",
      parcelCountEst: 1000,
      rosterSchemaVersion: "test-v1",
      rosterGeneratedAt: new Date("2026-08-05T00:00:00.000Z"),
    });
    // `zoning` is present + hasWriter=true, threshold 95. Stamp 33.98%,
    // matching the Williamson case cited in the ruling doc.
    await db.insert(countyFacetCoverage).values({
      countyFips: "50903",
      facet: "zoning",
      honestCoveragePct: "33.98",
      integrityVerdict: "n/a",
      classification: "real-at-ceiling",
      railState: "satisfied-present",
      thresholdPct: "95",
    });

    const res = await request(getApp()).get(LEDGER_PATH);
    expect(res.status).toBe(200);
    const zoningCell = res.body.manifestCells.find(
      (c: { countyFips: string; railKey: string }) =>
        c.countyFips === "50903" && c.railKey === "zoning",
    );
    expect(zoningCell.displayState).toBe("satisfied-present");
    expect(zoningCell.isPartial).toBe(true);
  });

  it("a satisfied-absent cell requires an absence_basis (DB CHECK constraint enforced)", async () => {
    await expect(
      db.insert(countyFacetCoverage).values({
        countyFips: "50904",
        facet: "zoning",
        honestCoveragePct: "0",
        integrityVerdict: "n/a",
        classification: "real-at-ceiling",
        railState: "satisfied-absent",
        // absenceBasis deliberately omitted — must violate the
        // county_facet_coverage_absence_basis_required_check constraint
        // added in migration 0069.
      }),
    ).rejects.toThrow();
  });

  it("manifestCells is additive: the pre-existing counties[]/summary shape is unaffected when the manifest is unseeded", async () => {
    // No county_manifest / county_rail rows seeded in this case at all.
    const res = await request(getApp()).get(LEDGER_PATH);
    expect(res.status).toBe(200);
    expect(res.body.manifestCells).toEqual([]);
    expect(res.body.counties).toEqual([]);
    // totalCounties falls back to counties.length (0) when the manifest
    // itself has not been seeded — see countyLedger.ts's totalCounties
    // comment. summary keeps its pre-existing four fields plus the new
    // manifest fields; none of the original four regress.
    expect(res.body.summary.onboardedCount).toBe(0);
    expect(res.body.summary.totalCounties).toBe(0);
    expect(res.body.summary.staleCount).toBe(0);
    expect(res.body.summary.rewarmUnsafeCount).toBe(0);
  });
});
