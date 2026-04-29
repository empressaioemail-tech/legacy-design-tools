/**
 * /api/engagements/match — A04.7.
 *
 * Verifies the precedence ladder:
 *   GUID exact → path exact → name_lower collision → create-new.
 * Plus auth + body-validation error paths.
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
      if (!ctx.schema) throw new Error("match.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { engagements, snapshots } = await import("@workspace/db");

const SECRET = process.env["SNAPSHOT_SECRET"]!;

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

interface SeedSpec {
  name: string;
  revitCentralGuid?: string | null;
  revitDocumentPath?: string | null;
  /** Optional: how many snapshot rows to attach. */
  snapshotCount?: number;
  /** Optional: pin updatedAt for ordering tests. */
  updatedAt?: Date;
}

async function seedEngagement(spec: SeedSpec): Promise<{ id: string }> {
  if (!ctx.schema) throw new Error("schema not ready");
  const [eng] = await ctx.schema.db
    .insert(engagements)
    .values({
      name: spec.name,
      nameLower: spec.name.trim().toLowerCase(),
      jurisdiction: null,
      address: null,
      revitCentralGuid: spec.revitCentralGuid ?? null,
      revitDocumentPath: spec.revitDocumentPath ?? null,
      ...(spec.updatedAt ? { updatedAt: spec.updatedAt } : {}),
    })
    .returning();
  if (spec.snapshotCount && spec.snapshotCount > 0) {
    for (let i = 0; i < spec.snapshotCount; i++) {
      await ctx.schema.db.insert(snapshots).values({
        engagementId: eng.id,
        projectName: spec.name,
        payload: {},
        sheetCount: 0,
        roomCount: 0,
        levelCount: 0,
        wallCount: 0,
      });
    }
  }
  return { id: eng.id };
}

describe("POST /api/engagements/match", () => {
  it("401s when the snapshot secret is missing or wrong", async () => {
    const res = await request(getApp())
      .post("/api/engagements/match")
      .send({ projectName: "House" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid snapshot secret" });

    const res2 = await request(getApp())
      .post("/api/engagements/match")
      .set("x-snapshot-secret", "wrong")
      .send({ projectName: "House" });
    expect(res2.status).toBe(401);
  });

  it("400s when projectName is missing", async () => {
    const res = await request(getApp())
      .post("/api/engagements/match")
      .set("x-snapshot-secret", SECRET)
      .send({ revitCentralGuid: "abc" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "projectName is required" });
  });

  it("auto-binds when revitCentralGuid matches an existing engagement", async () => {
    const guid = "11111111-aaaa-bbbb-cccc-222222222222";
    const { id } = await seedEngagement({
      name: "Project One",
      revitCentralGuid: guid,
      revitDocumentPath: "C:/orig/path.rvt",
    });

    const res = await request(getApp())
      .post("/api/engagements/match")
      .set("x-snapshot-secret", SECRET)
      .send({
        projectName: "Some Other Name", // intentionally different
        revitCentralGuid: guid,
        revitDocumentPath: "C:/different/path.rvt",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      action: "auto-bind",
      engagementId: id,
      engagementName: "Project One",
      matchedBy: "revitCentralGuid",
    });
  });

  it("auto-binds by revitDocumentPath when no GUID match", async () => {
    const path = "//server/share/HOUSE.rvt";
    const { id } = await seedEngagement({
      name: "House",
      revitCentralGuid: null,
      revitDocumentPath: path,
    });

    const res = await request(getApp())
      .post("/api/engagements/match")
      .set("x-snapshot-secret", SECRET)
      .send({
        projectName: "House",
        revitDocumentPath: path,
        // GUID supplied but no engagement holds it
        revitCentralGuid: "no-such-guid",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      action: "auto-bind",
      engagementId: id,
      engagementName: "House",
      matchedBy: "revitDocumentPath",
    });
  });

  it("returns 'choose' on case-insensitive name collision (single candidate)", async () => {
    const { id } = await seedEngagement({
      name: "Smith Residence",
      snapshotCount: 2,
    });

    const res = await request(getApp())
      .post("/api/engagements/match")
      .set("x-snapshot-secret", SECRET)
      .send({ projectName: "  smith RESIDENCE  " }); // exercises trim+lower

    expect(res.status).toBe(200);
    expect(res.body.action).toBe("choose");
    expect(res.body.candidates).toHaveLength(1);
    expect(res.body.candidates[0]).toMatchObject({
      id,
      name: "Smith Residence",
      snapshotCount: 2,
      address: null,
      jurisdiction: null,
      revitCentralGuid: null,
      revitDocumentPath: null,
    });
    expect(typeof res.body.candidates[0].updatedAt).toBe("string");
  });

  it("returns 'choose' with multiple candidates ordered by updatedAt desc", async () => {
    const older = await seedEngagement({
      name: "House",
      updatedAt: new Date("2024-01-01T00:00:00Z"),
    });
    const middle = await seedEngagement({
      name: "House",
      updatedAt: new Date("2024-06-01T00:00:00Z"),
    });
    const newer = await seedEngagement({
      name: "House",
      updatedAt: new Date("2024-12-01T00:00:00Z"),
    });

    const res = await request(getApp())
      .post("/api/engagements/match")
      .set("x-snapshot-secret", SECRET)
      .send({ projectName: "House" });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe("choose");
    expect(res.body.candidates.map((c: { id: string }) => c.id)).toEqual([
      newer.id,
      middle.id,
      older.id,
    ]);
  });

  it("returns 'choose' on name collision EVEN WHEN GUID is supplied but matches nothing", async () => {
    // Locked decision #2: dropdown ALWAYS triggers on name_lower collision,
    // regardless of GUID presence.
    await seedEngagement({ name: "Project1" });

    const res = await request(getApp())
      .post("/api/engagements/match")
      .set("x-snapshot-secret", SECRET)
      .send({
        projectName: "Project1",
        revitCentralGuid: "guid-that-matches-no-row",
        revitDocumentPath: "/path/that/matches/no/row",
      });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe("choose");
    expect(res.body.candidates).toHaveLength(1);
  });

  it("returns 'create-new' when nothing matches at all", async () => {
    await seedEngagement({ name: "Existing Different Name" });

    const res = await request(getApp())
      .post("/api/engagements/match")
      .set("x-snapshot-secret", SECRET)
      .send({
        projectName: "Brand New Project",
        revitCentralGuid: "fresh-guid",
        revitDocumentPath: "/fresh/path.rvt",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ action: "create-new" });
  });
});
