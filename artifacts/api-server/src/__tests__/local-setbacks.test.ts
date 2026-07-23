/**
 * GET /api/local/setbacks/:jurisdictionKey — DA-PI-3 thin HTTP shim
 * over the adapter-owned setback tables. The Site Context tab's
 * "View layer details" expander relies on this contract:
 *
 *   - 200 + `{ jurisdictionKey, jurisdictionDisplayName, note, districts[] }`
 *     for a known key (the route re-projects each district explicitly so
 *     the wire shape can't drift if the adapter schema grows).
 *   - 404 + `{ error: "setback_table_not_found" }` for an unknown key
 *     (the FE expander treats a 404 as "no codified table for this
 *     jurisdiction" and falls back to the raw adapter payload).
 *
 * Endpoint is DB-free, but we still go through the standard test harness
 * so future routing/middleware changes are exercised the same way as
 * every other route test.
 */

import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("local-setbacks.test: ctx.schema not initialized");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

describe("GET /api/local/setbacks/:jurisdictionKey", () => {
  it("returns 200 with the projected districts shape for a known key", async () => {
    const res = await request(getApp()).get("/api/local/setbacks/grand-county-ut");
    expect(res.status).toBe(200);
    expect(res.body.jurisdictionKey).toBe("grand-county-ut");
    expect(res.body.jurisdictionDisplayName).toBe(
      "Grand County, UT (Moab area)",
    );
    // `note` is always present on the wire — null when the source JSON
    // omits it (the route does `note ?? null`).
    expect(res.body).toHaveProperty("note");
    expect(Array.isArray(res.body.districts)).toBe(true);
    expect(res.body.districts.length).toBeGreaterThan(0);

    // Every district row exposes exactly the projected keys — no extra
    // adapter-side fields leak onto the wire.
    const expectedKeys = [
      "district_name",
      "front_ft",
      "rear_ft",
      "side_ft",
      "side_corner_ft",
      "max_height_ft",
      "max_lot_coverage_pct",
      "max_impervious_pct",
      "citation_url",
    ].sort();
    for (const district of res.body.districts) {
      expect(Object.keys(district).sort()).toEqual(expectedKeys);
    }

    // Spot-check a known fixture row so a silent reshuffle of the
    // adapter JSON would also fail this test.
    const rr1 = res.body.districts.find(
      (d: { district_name: string }) => d.district_name === "RR-1 Rural Residential",
    );
    expect(rr1).toBeDefined();
    expect(rr1).toMatchObject({
      front_ft: 30,
      rear_ft: 25,
      side_ft: 15,
      side_corner_ft: 25,
      max_height_ft: 32,
      max_lot_coverage_pct: 30,
      max_impervious_pct: 40,
    });
    expect(typeof rr1.citation_url).toBe("string");
    expect(rr1.citation_url.length).toBeGreaterThan(0);
  });

  it("returns 404 + setback_table_not_found for an unknown key", async () => {
    const res = await request(getApp()).get(
      "/api/local/setbacks/nowhere-county-zz",
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "setback_table_not_found" });
  });

  it("normalizes jurisdiction keys: underscores→hyphens, uppercase→lowercase", async () => {
    const bastropUnderscore = await request(getApp()).get(
      "/api/local/setbacks/bastrop_tx",
    );
    expect(bastropUnderscore.status).toBe(200);
    expect(bastropUnderscore.body.jurisdictionKey).toBe("bastrop-tx");

    const bastropUppercase = await request(getApp()).get(
      "/api/local/setbacks/BASTROP-TX",
    );
    expect(bastropUppercase.status).toBe(200);
    expect(bastropUppercase.body.jurisdictionKey).toBe("bastrop-tx");

    const bastropCanonical = await request(getApp()).get(
      "/api/local/setbacks/bastrop-tx",
    );
    expect(bastropCanonical.status).toBe(200);
    expect(bastropCanonical.body.jurisdictionKey).toBe("bastrop-tx");

    const unknownNormalized = await request(getApp()).get(
      "/api/local/setbacks/UNKNOWN_KEY",
    );
    expect(unknownNormalized.status).toBe(404);
  });

  it("San Marcos serves its cited, populated table, not 404", async () => {
    // Direct ZONECODE rows extracted from the City's Development Code are
    // served with per-value provenance; unresolved district codes remain
    // explicitly listed as gaps in the table note.
    const res = await request(getApp()).get(
      "/api/local/setbacks/san-marcos-tx",
    );
    expect(res.status).toBe(200);
    expect(res.body.jurisdictionKey).toBe("san-marcos-tx");
    expect(Array.isArray(res.body.districts)).toBe(true);
    expect(res.body.districts).toHaveLength(8);
    expect(res.body.districts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          district_name: "SF-6 Single Family 6",
          front_ft: 25,
          rear_ft: 20,
        }),
        expect.objectContaining({
          district_name: "MU Mixed Use (legacy)",
          front_ft: 25,
          side_ft: 7.5,
        }),
      ]),
    );
    expect(res.body.note).toMatch(/OMITTED.*MF-/i);

    // The underscore form resolves through the same key normalization.
    const underscore = await request(getApp()).get(
      "/api/local/setbacks/san_marcos_tx",
    );
    expect(underscore.status).toBe(200);
    expect(underscore.body.jurisdictionKey).toBe("san-marcos-tx");
  });
});
