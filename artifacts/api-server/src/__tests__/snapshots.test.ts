/**
 * POST /api/snapshots — A04.7 contract.
 *
 * Verifies the new discriminated body shape:
 *   - existing-engagement branch (engagementId)
 *   - new-engagement branch (createNewEngagement: true)
 *   - sticky address/GUID/path on rebind
 *   - GUID race idempotency (23505 → refetch & bind)
 *   - validation + 404 + auth error paths
 *
 * Geocoding is mocked to return null so the create-new branch's best-effort
 * geocode kickoff doesn't try to hit the real network. The warmup enqueue is
 * also a no-op when there's no jurisdiction.
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
      if (!ctx.schema) throw new Error("snapshots.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

vi.mock("@workspace/site-context/server", () => ({
  geocodeAddress: vi.fn(async () => null),
}));

vi.mock("@workspace/codes", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/codes")>("@workspace/codes");
  return {
    ...actual,
    keyFromEngagement: () => null,
    enqueueWarmupForJurisdiction: vi.fn(async () => ({
      enqueued: 0,
      skipped: 0,
    })),
  };
});

const { setupRouteTests } = await import("./setup");
const { engagements, snapshots, atomEvents } = await import("@workspace/db");
const { eq, and, asc } = await import("drizzle-orm");

const SECRET = process.env["SNAPSHOT_SECRET"]!;

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

async function seedEngagement(overrides: Partial<{
  name: string;
  address: string | null;
  jurisdiction: string | null;
  revitCentralGuid: string | null;
  revitDocumentPath: string | null;
}> = {}): Promise<typeof engagements.$inferSelect> {
  if (!ctx.schema) throw new Error("schema not ready");
  const name = overrides.name ?? "Existing Engagement";
  const [eng] = await ctx.schema.db
    .insert(engagements)
    .values({
      name,
      nameLower: name.trim().toLowerCase(),
      jurisdiction: overrides.jurisdiction ?? "Moab, UT",
      address: overrides.address ?? "123 Main St",
      revitCentralGuid: overrides.revitCentralGuid ?? null,
      revitDocumentPath: overrides.revitDocumentPath ?? null,
    })
    .returning();
  return eng;
}

describe("POST /api/snapshots — A04.7", () => {
  it("401s on missing/invalid secret", async () => {
    const res = await request(getApp())
      .post("/api/snapshots")
      .send({ engagementId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(401);
  });

  it("400s when body matches neither shape", async () => {
    // Just a projectName (the OLD contract) is no longer valid.
    const res = await request(getApp())
      .post("/api/snapshots")
      .set("x-snapshot-secret", SECRET)
      .send({ projectName: "House" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_snapshot_body" });
  });

  it("400s on completely empty body", async () => {
    const res = await request(getApp())
      .post("/api/snapshots")
      .set("x-snapshot-secret", SECRET)
      .send({});
    expect(res.status).toBe(400);
  });

  it("404s when engagementId points at a nonexistent row", async () => {
    const res = await request(getApp())
      .post("/api/snapshots")
      .set("x-snapshot-secret", SECRET)
      .send({
        engagementId: "00000000-0000-0000-0000-000000000000",
        sheets: [],
      });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "engagement_not_found" });
  });

  it("existing branch: attaches snapshot, advances updatedAt, leaves address sticky", async () => {
    const eng = await seedEngagement({
      address: "100 Original St",
      jurisdiction: "Moab, UT",
      revitCentralGuid: "ORIG-GUID",
      revitDocumentPath: "/orig/path.rvt",
    });
    const beforeUpdatedAt = eng.updatedAt;

    // Wait 5ms so the timestamp comparison is meaningful.
    await new Promise((r) => setTimeout(r, 5));

    const res = await request(getApp())
      .post("/api/snapshots")
      .set("x-snapshot-secret", SECRET)
      .send({
        engagementId: eng.id,
        sheets: [{ id: 1 }, { id: 2 }],
        rooms: [{ id: 1 }],
        // Note: even if the add-in includes projectInformation.address, the
        // existing branch must IGNORE it.
        projectInformation: { address: "999 NEW DIFFERENT St" },
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      engagementId: eng.id,
      engagementName: "Existing Engagement",
      autoCreated: false,
    });

    // Sticky checks: address, jurisdiction, GUID, path all unchanged.
    if (!ctx.schema) throw new Error("ctx");
    const [after] = await ctx.schema.db
      .select()
      .from(engagements)
      .where(eq(engagements.id, eng.id));
    expect(after.address).toBe("100 Original St");
    expect(after.jurisdiction).toBe("Moab, UT");
    expect(after.revitCentralGuid).toBe("ORIG-GUID");
    expect(after.revitDocumentPath).toBe("/orig/path.rvt");
    expect(after.updatedAt.getTime()).toBeGreaterThan(
      beforeUpdatedAt.getTime(),
    );

    // Snapshot was created with derived counts.
    const snaps = await ctx.schema.db
      .select()
      .from(snapshots)
      .where(eq(snapshots.engagementId, eng.id));
    expect(snaps).toHaveLength(1);
    expect(snaps[0].sheetCount).toBe(2);
    expect(snaps[0].roomCount).toBe(1);

    // Lifecycle event was persisted into atom_events: exactly one
    // `snapshot.created` row anchored at the new snapshot. No
    // `snapshot.replaced` since this is the engagement's first snapshot.
    const evRows = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(
        and(
          eq(atomEvents.entityType, "snapshot"),
          eq(atomEvents.entityId, snaps[0].id),
        ),
      );
    expect(evRows).toHaveLength(1);
    expect(evRows[0]!.eventType).toBe("snapshot.created");
    expect(evRows[0]!.actor).toEqual({
      kind: "system",
      id: "snapshot-ingest",
    });
    expect(evRows[0]!.payload).toMatchObject({
      engagementId: eng.id,
      engagementName: "Existing Engagement",
      autoCreated: false,
      // No prior snapshot for this engagement, so the replaced ref is null.
      replacedSnapshotId: null,
    });
  });

  it("createNewEngagement branch: persists GUID + path on the new engagement", async () => {
    const res = await request(getApp())
      .post("/api/snapshots")
      .set("x-snapshot-secret", SECRET)
      .send({
        createNewEngagement: true,
        projectName: "Brand New Project",
        revitCentralGuid: "NEW-GUID-123",
        revitDocumentPath: "C:/projects/new.rvt",
        sheets: [],
        projectInformation: { address: "42 Wallaby Way" },
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      engagementName: "Brand New Project",
      autoCreated: true,
    });

    if (!ctx.schema) throw new Error("ctx");
    const [eng] = await ctx.schema.db
      .select()
      .from(engagements)
      .where(eq(engagements.id, res.body.engagementId));
    expect(eng.revitCentralGuid).toBe("NEW-GUID-123");
    expect(eng.revitDocumentPath).toBe("C:/projects/new.rvt");
    expect(eng.address).toBe("42 Wallaby Way");
    expect(eng.nameLower).toBe("brand new project");
  });

  it("createNewEngagement branch: GUID + path null when not supplied", async () => {
    const res = await request(getApp())
      .post("/api/snapshots")
      .set("x-snapshot-secret", SECRET)
      .send({
        createNewEngagement: true,
        projectName: "Plain Project",
        sheets: [],
      });

    expect(res.status).toBe(201);
    if (!ctx.schema) throw new Error("ctx");
    const [eng] = await ctx.schema.db
      .select()
      .from(engagements)
      .where(eq(engagements.id, res.body.engagementId));
    expect(eng.revitCentralGuid).toBeNull();
    expect(eng.revitDocumentPath).toBeNull();
  });

  it("name collisions are now ALLOWED at the DB level (no UNIQUE constraint)", async () => {
    // Two distinct create-new requests with the same projectName both succeed.
    // This is the explicit A04.7 outcome — the dropdown layer is the user-
    // facing dedup, not the DB.
    const r1 = await request(getApp())
      .post("/api/snapshots")
      .set("x-snapshot-secret", SECRET)
      .send({
        createNewEngagement: true,
        projectName: "House",
        revitCentralGuid: "GUID-A",
        sheets: [],
      });
    expect(r1.status).toBe(201);

    const r2 = await request(getApp())
      .post("/api/snapshots")
      .set("x-snapshot-secret", SECRET)
      .send({
        createNewEngagement: true,
        projectName: "House",
        revitCentralGuid: "GUID-B",
        sheets: [],
      });
    expect(r2.status).toBe(201);

    // Two distinct engagements, same name.
    expect(r1.body.engagementId).not.toBe(r2.body.engagementId);
  });

  it("GUID race: a second create-new with the same GUID idempotently binds to the first engagement", async () => {
    // First request creates the engagement and seizes the GUID.
    const r1 = await request(getApp())
      .post("/api/snapshots")
      .set("x-snapshot-secret", SECRET)
      .send({
        createNewEngagement: true,
        projectName: "Racey",
        revitCentralGuid: "RACE-GUID",
        sheets: [{ id: 1 }],
      });
    expect(r1.status).toBe(201);
    expect(r1.body.autoCreated).toBe(true);

    // Second request also tries createNewEngagement with the same GUID.
    // The partial unique index rejects with 23505; the route should refetch
    // by GUID and attach the snapshot to the existing engagement.
    const r2 = await request(getApp())
      .post("/api/snapshots")
      .set("x-snapshot-secret", SECRET)
      .send({
        createNewEngagement: true,
        projectName: "Racey (renamed locally)",
        revitCentralGuid: "RACE-GUID",
        sheets: [{ id: 2 }],
      });
    expect(r2.status).toBe(201);
    expect(r2.body.engagementId).toBe(r1.body.engagementId);
    expect(r2.body.autoCreated).toBe(false);

    // Exactly one engagement, two snapshots.
    if (!ctx.schema) throw new Error("ctx");
    const allEngs = await ctx.schema.db.select().from(engagements);
    expect(allEngs).toHaveLength(1);
    const allSnaps = await ctx.schema.db.select().from(snapshots);
    expect(allSnaps).toHaveLength(2);

    // Engagement keeps its ORIGINAL name — sticky principle applies to the
    // GUID-race rebind path too.
    expect(allEngs[0].name).toBe("Racey");

    // Lifecycle events: the GUID-race rebind goes through the same
    // existing-engagement attach helper, so it must emit
    // `snapshot.replaced` against the prior latest (snap A) followed by
    // `snapshot.created` for the new latest (snap B). Snap A's chain
    // should also carry its own initial `snapshot.created`.
    const sortedSnaps = [...allSnaps].sort(
      (a, b) => a.receivedAt.getTime() - b.receivedAt.getTime(),
    );
    const snapA = sortedSnaps[0]!;
    const snapB = sortedSnaps[1]!;

    const aEvents = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(
        and(
          eq(atomEvents.entityType, "snapshot"),
          eq(atomEvents.entityId, snapA.id),
        ),
      )
      .orderBy(asc(atomEvents.recordedAt));
    expect(aEvents.map((e) => e.eventType)).toEqual([
      "snapshot.created",
      "snapshot.replaced",
    ]);
    // The `snapshot.replaced` event is anchored on snap A's chain
    // (entityId = snapA.id) and points forward to snap B via the
    // `replacedBySnapshotId` payload field.
    expect(aEvents[1]!.payload).toMatchObject({
      replacedBySnapshotId: snapB.id,
      engagementId: allEngs[0].id,
    });

    const bEvents = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(
        and(
          eq(atomEvents.entityType, "snapshot"),
          eq(atomEvents.entityId, snapB.id),
        ),
      );
    expect(bEvents).toHaveLength(1);
    expect(bEvents[0]!.eventType).toBe("snapshot.created");
  });
});
