/**
 * GET /api/snapshots/:id/sheet-history — snapshot-scoped batch variant
 * of the per-atom history endpoint that the plan-review /sheets page
 * uses to populate every card's inline mini-timeline in one round trip.
 *
 * Coverage:
 *   - happy path: events grouped per sheet, newest-first, isolated to
 *     the requested snapshot
 *   - empty entry per sheet that has no events (stable shape contract)
 *   - empty `histories` for a snapshot that has zero sheets (no SQL
 *     against atom_events)
 *   - `limit` clamp + malformed-limit fallback (mirrors per-atom history)
 *   - 404 for an unknown snapshot id
 *   - chain hash fields are stripped from the public response
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
        throw new Error("snapshot-sheet-history.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { engagements, snapshots, sheets } = await import("@workspace/db");
const { resetAtomRegistryForTests, getHistoryService } = await import(
  "../atoms/registry"
);

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeAll(() => {
  resetAtomRegistryForTests();
});

const TINY_PNG = Buffer.from([0]);

interface SeededSnapshot {
  engagementId: string;
  snapshotId: string;
  sheetIds: string[];
}

async function seedSnapshotWithSheets(
  sheetCount: number,
  nameSuffix: string,
): Promise<SeededSnapshot> {
  if (!ctx.schema) throw new Error("schema not ready");
  const db = ctx.schema.db;
  const [eng] = await db
    .insert(engagements)
    .values({
      name: `Snap History Test ${nameSuffix}`,
      nameLower: `snap-history-${nameSuffix}-${Math.random()
        .toString(36)
        .slice(2)}`,
      jurisdiction: "Moab, UT",
      address: "1 Atom St",
    })
    .returning({ id: engagements.id });
  const [snap] = await db
    .insert(snapshots)
    .values({
      engagementId: eng.id,
      projectName: `Snap History Test ${nameSuffix}`,
      payload: { sheets: [], rooms: [] },
      sheetCount,
      roomCount: 0,
      levelCount: 0,
      wallCount: 0,
    })
    .returning({ id: snapshots.id });

  const sheetIds: string[] = [];
  for (let i = 0; i < sheetCount; i++) {
    const [sheet] = await db
      .insert(sheets)
      .values({
        snapshotId: snap.id,
        engagementId: eng.id,
        sheetNumber: `A${100 + i}`,
        sheetName: `Sheet ${i}`,
        viewCount: 1,
        revisionNumber: null,
        revisionDate: null,
        thumbnailPng: TINY_PNG,
        thumbnailWidth: 64,
        thumbnailHeight: 48,
        fullPng: TINY_PNG,
        fullWidth: 800,
        fullHeight: 600,
        sortOrder: i,
      })
      .returning({ id: sheets.id });
    sheetIds.push(sheet.id);
  }
  return { engagementId: eng.id, snapshotId: snap.id, sheetIds };
}

describe("GET /api/snapshots/:id/sheet-history", () => {
  it("groups recent events per sheet, newest-first, scoped to the snapshot", async () => {
    const seed = await seedSnapshotWithSheets(2, "happy");
    const [sheetA, sheetB] = seed.sheetIds;
    // Seed a separate snapshot+sheet whose history MUST NOT leak into
    // the response — the scoping check is the whole point of the route.
    const other = await seedSnapshotWithSheets(1, "other");

    const history = getHistoryService();
    const t0 = new Date("2026-04-01T10:00:00Z");
    const t1 = new Date("2026-04-02T10:00:00Z");
    const t2 = new Date("2026-04-03T10:00:00Z");
    await history.appendEvent({
      entityType: "sheet",
      entityId: sheetA,
      eventType: "sheet.created",
      actor: { kind: "system", id: "test" },
      payload: {},
      occurredAt: t0,
    });
    await history.appendEvent({
      entityType: "sheet",
      entityId: sheetA,
      eventType: "sheet.updated",
      actor: { kind: "agent", id: "ingest" },
      payload: { revision: 1 },
      occurredAt: t2,
    });
    await history.appendEvent({
      entityType: "sheet",
      entityId: sheetB,
      eventType: "sheet.created",
      actor: { kind: "system", id: "test" },
      payload: {},
      occurredAt: t1,
    });
    await history.appendEvent({
      entityType: "sheet",
      entityId: other.sheetIds[0]!,
      eventType: "sheet.created",
      actor: { kind: "system", id: "test" },
      payload: { other: true },
      occurredAt: t0,
    });

    const res = await request(getApp()).get(
      `/api/snapshots/${seed.snapshotId}/sheet-history`,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.histories)).toBe(true);
    expect(res.body.histories).toHaveLength(2);

    const byId = new Map<
      string,
      { sheetId: string; events: Array<{ eventType: string; occurredAt: string }> }
    >(
      (
        res.body.histories as Array<{
          sheetId: string;
          events: Array<{ eventType: string; occurredAt: string }>;
        }>
      ).map((h) => [h.sheetId, h]),
    );

    const a = byId.get(sheetA);
    expect(a).toBeDefined();
    expect(a!.events).toHaveLength(2);
    // Newest-first within a sheet's slice.
    expect(a!.events[0].eventType).toBe("sheet.updated");
    expect(a!.events[0].occurredAt).toBe(t2.toISOString());
    expect(a!.events[1].eventType).toBe("sheet.created");
    expect(a!.events[1].occurredAt).toBe(t0.toISOString());

    const b = byId.get(sheetB);
    expect(b).toBeDefined();
    expect(b!.events).toHaveLength(1);
    expect(b!.events[0].occurredAt).toBe(t1.toISOString());

    // The other snapshot's event must not appear under either id.
    for (const entry of res.body.histories as Array<{
      events: Array<{ eventType: string; payload?: unknown }>;
    }>) {
      for (const evt of entry.events) {
        expect(evt).not.toHaveProperty("chainHash");
        expect(evt).not.toHaveProperty("prevHash");
      }
    }
  });

  it("returns an empty events array for sheets with no recorded history", async () => {
    const seed = await seedSnapshotWithSheets(2, "stable-shape");
    const [sheetA, sheetB] = seed.sheetIds;
    // Only sheetA has events.
    const history = getHistoryService();
    await history.appendEvent({
      entityType: "sheet",
      entityId: sheetA,
      eventType: "sheet.created",
      actor: { kind: "system", id: "test" },
      payload: {},
      occurredAt: new Date("2026-05-01T10:00:00Z"),
    });

    const res = await request(getApp()).get(
      `/api/snapshots/${seed.snapshotId}/sheet-history`,
    );
    expect(res.status).toBe(200);
    expect(res.body.histories).toHaveLength(2);
    const byId = new Map<string, { events: unknown[] }>(
      (res.body.histories as Array<{ sheetId: string; events: unknown[] }>).map(
        (h) => [h.sheetId, h],
      ),
    );
    expect(byId.get(sheetA)!.events).toHaveLength(1);
    expect(byId.get(sheetB)!.events).toEqual([]);
  });

  it("returns histories: [] for a snapshot that has no sheets", async () => {
    const seed = await seedSnapshotWithSheets(0, "empty");
    const res = await request(getApp()).get(
      `/api/snapshots/${seed.snapshotId}/sheet-history`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ histories: [] });
  });

  it("clamps the per-sheet page size with the limit query param", async () => {
    const seed = await seedSnapshotWithSheets(1, "limit");
    const [sheetA] = seed.sheetIds;
    const history = getHistoryService();
    for (let i = 0; i < 4; i++) {
      await history.appendEvent({
        entityType: "sheet",
        entityId: sheetA,
        eventType: "sheet.updated",
        actor: { kind: "system", id: "test" },
        payload: { i },
        occurredAt: new Date(Date.UTC(2026, 3, 10 + i)),
      });
    }
    const res = await request(getApp())
      .get(`/api/snapshots/${seed.snapshotId}/sheet-history`)
      .query({ limit: 2 });
    expect(res.status).toBe(200);
    const entry = res.body.histories[0];
    expect(entry.sheetId).toBe(sheetA);
    expect(entry.events).toHaveLength(2);
    // Newest first → last appended is at index 0.
    expect(entry.events[0].occurredAt).toBe(
      new Date(Date.UTC(2026, 3, 13)).toISOString(),
    );
  });

  it("falls back to the default limit when the query value is malformed", async () => {
    const seed = await seedSnapshotWithSheets(1, "bad-limit");
    const res = await request(getApp())
      .get(`/api/snapshots/${seed.snapshotId}/sheet-history`)
      .query({ limit: "not-a-number" });
    expect(res.status).toBe(200);
    expect(res.body.histories).toHaveLength(1);
  });

  it("404s when the snapshot id is unknown", async () => {
    const res = await request(getApp()).get(
      "/api/snapshots/00000000-0000-0000-0000-000000000000/sheet-history",
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Snapshot not found" });
  });
});
