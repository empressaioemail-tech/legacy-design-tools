/**
 * GET /api/submissions/:submissionId/sheets — PLR-7 sheet navigator
 * data source.
 *
 * Coverage:
 *   - returns sheets composed by the submission's contemporaneous
 *     snapshot (newest snapshot at-or-before submittedAt), so two
 *     submissions on the same engagement with different snapshots
 *     each see their own sheet set
 *   - sortOrder ascending
 *   - 404 for unknown submission
 *   - empty array when the engagement has no snapshots at all
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
        throw new Error("submission-sheets.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { engagements, snapshots, sheets, submissions } = await import(
  "@workspace/db"
);
const { resetAtomRegistryForTests } = await import("../atoms/registry");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeAll(() => {
  resetAtomRegistryForTests();
});

const TINY_PNG = Buffer.from([0]);

async function insertEngagement(name: string): Promise<string> {
  if (!ctx.schema) throw new Error("schema not ready");
  const db = ctx.schema.db;
  const [eng] = await db
    .insert(engagements)
    .values({
      name,
      nameLower: `${name.toLowerCase()}-${Math.random()
        .toString(36)
        .slice(2)}`,
      jurisdiction: "Moab, UT",
      address: "1 Atom St",
    })
    .returning({ id: engagements.id });
  return eng.id;
}

async function insertSnapshot(
  engagementId: string,
  receivedAt: Date,
  label: string,
): Promise<string> {
  const db = ctx.schema!.db;
  const [snap] = await db
    .insert(snapshots)
    .values({
      engagementId,
      projectName: label,
      payload: { sheets: [], rooms: [] },
      sheetCount: 0,
      roomCount: 0,
      levelCount: 0,
      wallCount: 0,
      receivedAt,
    })
    .returning({ id: snapshots.id });
  return snap.id;
}

async function insertSheet(
  snapshotId: string,
  engagementId: string,
  sheetNumber: string,
  sortOrder: number,
): Promise<string> {
  const db = ctx.schema!.db;
  const [s] = await db
    .insert(sheets)
    .values({
      snapshotId,
      engagementId,
      sheetNumber,
      sheetName: `Sheet ${sheetNumber}`,
      viewCount: 0,
      revisionNumber: null,
      revisionDate: null,
      thumbnailPng: TINY_PNG,
      thumbnailWidth: 64,
      thumbnailHeight: 48,
      fullPng: TINY_PNG,
      fullWidth: 800,
      fullHeight: 600,
      sortOrder,
    })
    .returning({ id: sheets.id });
  return s.id;
}

async function insertSubmission(
  engagementId: string,
  submittedAt: Date,
): Promise<string> {
  const db = ctx.schema!.db;
  const [sub] = await db
    .insert(submissions)
    .values({
      engagementId,
      jurisdiction: "Moab, UT",
      submittedAt,
    })
    .returning({ id: submissions.id });
  return sub.id;
}

describe("GET /api/submissions/:submissionId/sheets", () => {
  it("returns sheets from the submission's contemporaneous snapshot", async () => {
    const engagementId = await insertEngagement("PLR7 Multi");

    // Snapshot A — older, owns sheets that submission #1 captured.
    const snapA = await insertSnapshot(
      engagementId,
      new Date("2026-04-01T10:00:00Z"),
      "snap-A",
    );
    const a1 = await insertSheet(snapA, engagementId, "A-101", 0);
    const a2 = await insertSheet(snapA, engagementId, "A-102", 1);

    // Submission #1 was sent before snapshot B existed.
    const sub1 = await insertSubmission(
      engagementId,
      new Date("2026-04-02T12:00:00Z"),
    );

    // Snapshot B — newer, owns sheets that submission #2 captured.
    const snapB = await insertSnapshot(
      engagementId,
      new Date("2026-04-10T10:00:00Z"),
      "snap-B",
    );
    const b1 = await insertSheet(snapB, engagementId, "A-201", 0);

    // Submission #2 was sent after snapshot B landed.
    const sub2 = await insertSubmission(
      engagementId,
      new Date("2026-04-11T12:00:00Z"),
    );

    const r1 = await request(getApp()).get(`/api/submissions/${sub1}/sheets`);
    expect(r1.status).toBe(200);
    expect(r1.body.map((s: { id: string }) => s.id)).toEqual([a1, a2]);

    const r2 = await request(getApp()).get(`/api/submissions/${sub2}/sheets`);
    expect(r2.status).toBe(200);
    expect(r2.body.map((s: { id: string }) => s.id)).toEqual([b1]);
  });

  it("returns 404 for an unknown submission", async () => {
    const res = await request(getApp()).get(
      "/api/submissions/00000000-0000-0000-0000-000000000000/sheets",
    );
    expect(res.status).toBe(404);
  });

  it("returns [] when the engagement has no snapshots", async () => {
    const engagementId = await insertEngagement("PLR7 Empty");
    const sub = await insertSubmission(
      engagementId,
      new Date("2026-04-02T12:00:00Z"),
    );
    const res = await request(getApp()).get(
      `/api/submissions/${sub}/sheets`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
