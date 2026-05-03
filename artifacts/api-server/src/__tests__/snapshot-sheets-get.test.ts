/**
 * GET /api/snapshots/:snapshotId/sheets — Task #477.
 *
 * Asserts that the response items expose the `contentBody` + `crossRefs`
 * fields required by the OpenAPI `SheetSummary` schema, including
 * extracting cross-references from the persisted body.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
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
        throw new Error("snapshot-sheets-get.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { engagements, snapshots, sheets } = await import("@workspace/db");
const { resetAtomRegistryForTests } = await import("../atoms/registry");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeAll(() => {
  resetAtomRegistryForTests();
});

const TINY_PNG = Buffer.from([0]);

describe("GET /api/snapshots/:snapshotId/sheets", () => {
  it("returns each sheet with contentBody + extracted crossRefs", async () => {
    const db = ctx.schema!.db;
    const [eng] = await db
      .insert(engagements)
      .values({
        name: "Snap Sheets Get",
        nameLower: `snap-sheets-get-${Math.random().toString(36).slice(2)}`,
        jurisdiction: "Moab, UT",
        address: "1 Snap Way",
      })
      .returning({ id: engagements.id });
    const [snap] = await db
      .insert(snapshots)
      .values({
        engagementId: eng.id,
        projectName: "Snap Sheets Get",
        payload: { sheets: [], rooms: [] },
      })
      .returning({ id: snapshots.id });

    await db.insert(sheets).values([
      {
        snapshotId: snap.id,
        engagementId: eng.id,
        sheetNumber: "A101",
        sheetName: "Floor Plan",
        thumbnailPng: TINY_PNG,
        thumbnailWidth: 1,
        thumbnailHeight: 1,
        fullPng: TINY_PNG,
        fullWidth: 1,
        fullHeight: 1,
        sortOrder: 0,
        contentBody: "GENERAL NOTES — SEE A-301 AND 5/A-501 FOR DETAILS.",
      },
      {
        snapshotId: snap.id,
        engagementId: eng.id,
        sheetNumber: "A102",
        sheetName: "Roof Plan",
        thumbnailPng: TINY_PNG,
        thumbnailWidth: 1,
        thumbnailHeight: 1,
        fullPng: TINY_PNG,
        fullWidth: 1,
        fullHeight: 1,
        sortOrder: 1,
        contentBody: null,
      },
    ]);

    const res = await request(getApp()).get(`/api/snapshots/${snap.id}/sheets`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);

    const a101 = res.body.find(
      (s: { sheetNumber: string }) => s.sheetNumber === "A101",
    );
    expect(a101).toBeDefined();
    expect(a101.contentBody).toContain("GENERAL NOTES");
    expect(Array.isArray(a101.crossRefs)).toBe(true);
    expect(a101.crossRefs.length).toBeGreaterThan(0);
    const refNumbers = (a101.crossRefs as { sheetNumber: string }[]).map(
      (r) => r.sheetNumber,
    );
    expect(refNumbers).toContain("A-301");
    expect(refNumbers).toContain("A-501");

    const a102 = res.body.find(
      (s: { sheetNumber: string }) => s.sheetNumber === "A102",
    );
    expect(a102.contentBody).toBeNull();
    expect(a102.crossRefs).toEqual([]);
  });
});
