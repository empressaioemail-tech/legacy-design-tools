/**
 * Sheet ingest → `sheet.created` event emission (Task #18).
 *
 * Wires the first real event producer onto the empressa-atom history
 * primitive: every newly-inserted sheet row in the snapshot ingest path
 * must produce exactly one `sheet.created` event in `atom_events`,
 * appended through the registry's history service (NOT a direct DB
 * write).
 *
 * Coverage:
 *   1. Single multipart upload with one sheet → exactly one `sheet.created`
 *      event, with the canonical payload shape and a non-null
 *      `chain_hash` / null `prev_hash` (chain initialization).
 *   2. The `GET /api/atoms/sheet/<id>/summary` route surfaces the
 *      real event id + timestamp via `historyProvenance`, not the
 *      `1970-01-01T...` placeholder.
 *   3. Two snapshots for the same engagement that share a sheet
 *      number produce two distinct sheet rows (the ingest upsert key
 *      is `(snapshotId, sheetNumber)` — see open-question note below)
 *      and therefore two events on SEPARATE chains, each rooted with
 *      `prev_hash = NULL`.
 *   4. Chain mechanics still hold for a single chain: a manual second
 *      `appendEvent` for the same sheet id correctly chains its
 *      `prev_hash` to the first event's `chain_hash`. This stands in
 *      for future `sheet.updated`/`sheet.removed` producers (out of
 *      scope for this task) and confirms the consumer-side hookup is
 *      correct end-to-end.
 *   5. An `appendEvent` failure does NOT roll back or fail the sheet
 *      row insert — the `uploaded` counter still increments and the
 *      row is queryable. (Locked decision #5: events are observability,
 *      rows are the source of truth.)
 *
 * Open question resolution (task #18 step 6 note): The sheet ingest
 * upsert key is `(snapshotId, sheetNumber)`, not
 * `(engagementId, sheetNumber)`. A second snapshot under the same
 * engagement therefore creates a NEW sheet row (different uuid) for the
 * same sheet number, so each sheet's chain is single-event under the
 * ingest path alone. The cross-snapshot chain-linkage assertion in the
 * task brief assumed a row-level upsert and doesn't apply as-stated;
 * test (4) covers the same chain-hash invariant by appending a second
 * event directly to the history service, which is what the future
 * `sheet.updated` producer will do.
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
        throw new Error("sheet-events-ingest.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { engagements, snapshots, sheets, atomEvents } = await import(
  "@workspace/db"
);
const { eq, and, asc } = await import("drizzle-orm");
const registryModule = await import("../atoms/registry");
const { resetAtomRegistryForTests, getHistoryService } = registryModule;

const SECRET = process.env["SNAPSHOT_SECRET"]!;

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeAll(() => {
  // The registry singleton captures `db` at construction time; reset
  // so the (re)build happens against the test schema's drizzle instance.
  resetAtomRegistryForTests();
});

/**
 * Smallest valid PNG (1×1, all transparent). The route only checks the
 * Content-Type and stores bytes verbatim, so any non-empty buffer with
 * an `image/png` content type satisfies the upload contract.
 */
const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

/**
 * Seed an engagement + an empty snapshot directly via the test schema.
 * The sheet ingest route requires a pre-existing snapshot row to attach
 * to (it doesn't create snapshots itself — that's the `/api/snapshots`
 * route's job).
 */
async function seedSnapshot(name: string): Promise<{
  engagementId: string;
  snapshotId: string;
}> {
  if (!ctx.schema) throw new Error("schema not ready");
  const db = ctx.schema.db;
  const [eng] = await db
    .insert(engagements)
    .values({
      name,
      nameLower: name.toLowerCase(),
      jurisdiction: "Moab, UT",
      address: "1 Sheet Events Way",
    })
    .returning({ id: engagements.id });
  const [snap] = await db
    .insert(snapshots)
    .values({
      engagementId: eng.id,
      projectName: name,
      payload: { sheets: [], rooms: [] },
    })
    .returning({ id: snapshots.id });
  return { engagementId: eng.id, snapshotId: snap.id };
}

interface UploadSheetSpec {
  sheetNumber: string;
  sheetName: string;
}

/**
 * POST a multipart `/api/snapshots/:snapshotId/sheets` upload with the
 * provided sheets. Each sheet ships the same `TINY_PNG` for both the
 * thumbnail and the full image — bytes are opaque to the producer logic.
 */
async function uploadSheets(
  app: Express,
  snapshotId: string,
  specs: UploadSheetSpec[],
): Promise<request.Response> {
  const metadata = specs.map((s, i) => ({
    index: i,
    sheetNumber: s.sheetNumber,
    sheetName: s.sheetName,
    thumbnailWidth: 1,
    thumbnailHeight: 1,
    fullWidth: 1,
    fullHeight: 1,
  }));
  let req = request(app)
    .post(`/api/snapshots/${snapshotId}/sheets`)
    .set("x-snapshot-secret", SECRET)
    .field("metadata", JSON.stringify(metadata));
  for (let i = 0; i < specs.length; i++) {
    req = req
      .attach(`sheet_${i}_thumb`, TINY_PNG, {
        filename: `${i}_thumb.png`,
        contentType: "image/png",
      })
      .attach(`sheet_${i}_full`, TINY_PNG, {
        filename: `${i}_full.png`,
        contentType: "image/png",
      });
  }
  return await req;
}

describe("snapshot sheet ingest emits sheet.created events (Task #18)", () => {
  it("emits exactly one sheet.created event per newly-inserted row with the canonical payload", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const db = ctx.schema.db;
    const { engagementId, snapshotId } = await seedSnapshot("Single Snapshot");

    const res = await uploadSheets(getApp(), snapshotId, [
      { sheetNumber: "A101", sheetName: "First Floor Plan" },
    ]);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uploaded: 1, skipped: 0, failed: 0 });

    // The sheet row exists.
    const sheetRows = await db
      .select({ id: sheets.id, sheetNumber: sheets.sheetNumber })
      .from(sheets)
      .where(eq(sheets.snapshotId, snapshotId));
    expect(sheetRows).toHaveLength(1);
    const sheetId = sheetRows[0]!.id;

    // Exactly one atom_events row for this sheet, with the expected
    // canonical payload + a chain-init prev_hash and a stable
    // system actor.
    const events = await db
      .select()
      .from(atomEvents)
      .where(
        and(
          eq(atomEvents.entityType, "sheet"),
          eq(atomEvents.entityId, sheetId),
        ),
      )
      .orderBy(asc(atomEvents.recordedAt));
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.eventType).toBe("sheet.created");
    expect(ev.prevHash).toBeNull();
    expect(typeof ev.chainHash).toBe("string");
    expect(ev.chainHash.length).toBe(64); // sha256 hex
    expect(ev.actor).toEqual({ kind: "system", id: "snapshot-ingest" });
    expect(ev.payload).toEqual({
      sheetNumber: "A101",
      sheetName: "First Floor Plan",
      snapshotId,
      engagementId,
    });
  });

  it("/api/atoms/sheet/:id/summary returns historyProvenance pointing at the real event (no 1970 epoch)", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const db = ctx.schema.db;
    const { snapshotId } = await seedSnapshot("Summary Snapshot");

    await uploadSheets(getApp(), snapshotId, [
      { sheetNumber: "A102", sheetName: "Cover Sheet" },
    ]);
    const [{ id: sheetId }] = await db
      .select({ id: sheets.id })
      .from(sheets)
      .where(eq(sheets.snapshotId, snapshotId));

    const summary = await request(getApp()).get(
      `/api/atoms/sheet/${sheetId}/summary`,
    );
    expect(summary.status).toBe(200);
    expect(summary.body.historyProvenance.latestEventId).not.toBe("");
    expect(typeof summary.body.historyProvenance.latestEventId).toBe("string");
    const at = new Date(summary.body.historyProvenance.latestEventAt);
    // Must be a recent event — anything in 2026+ trivially clears the
    // 1970 placeholder bar. Be generous and just assert "after 2024".
    expect(at.getFullYear()).toBeGreaterThan(2024);
  });

  it("two snapshots sharing a sheet number produce two new rows on SEPARATE chains (upsert key is snapshotId+sheetNumber)", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const db = ctx.schema.db;
    const { engagementId } = await seedSnapshot("Engagement Two-Snap A");
    // Reuse the engagement for snapshot B by inserting a second snapshot
    // row directly (we don't have the engagement id from `seedSnapshot`'s
    // first return without a second helper).
    const [snapB] = await db
      .insert(snapshots)
      .values({
        engagementId,
        projectName: "Engagement Two-Snap A",
        payload: { sheets: [], rooms: [] },
      })
      .returning({ id: snapshots.id });
    const snapshotIdB = snapB.id;
    // First snapshot id — refetch (we need both).
    const [snapA] = await db
      .select({ id: snapshots.id })
      .from(snapshots)
      .where(eq(snapshots.engagementId, engagementId))
      .orderBy(asc(snapshots.receivedAt));
    const snapshotIdA = snapA.id;

    await uploadSheets(getApp(), snapshotIdA, [
      { sheetNumber: "A101", sheetName: "First Floor Plan" },
    ]);
    await uploadSheets(getApp(), snapshotIdB, [
      { sheetNumber: "A101", sheetName: "First Floor Plan (rev)" },
    ]);

    const allSheets = await db
      .select({ id: sheets.id, snapshotId: sheets.snapshotId })
      .from(sheets)
      .where(eq(sheets.engagementId, engagementId))
      .orderBy(asc(sheets.createdAt));
    expect(allSheets).toHaveLength(2);
    expect(allSheets[0]!.id).not.toBe(allSheets[1]!.id);

    // Two events, one per sheet, each on its own chain (prev_hash null).
    const allEvents = await db
      .select()
      .from(atomEvents)
      .where(eq(atomEvents.entityType, "sheet"))
      .orderBy(asc(atomEvents.recordedAt));
    expect(allEvents).toHaveLength(2);
    expect(allEvents[0]!.prevHash).toBeNull();
    expect(allEvents[1]!.prevHash).toBeNull();
    expect(allEvents[0]!.entityId).not.toBe(allEvents[1]!.entityId);
    expect(allEvents[0]!.chainHash).not.toBe(allEvents[1]!.chainHash);
  });

  it("chain mechanics: appending a second event to an existing sheet's chain links prev_hash → first.chain_hash", async () => {
    // Stand-in for the future `sheet.updated` producer. Confirms the
    // history service the route uses correctly chains hashes when the
    // same (entityType, entityId) pair sees a second append.
    if (!ctx.schema) throw new Error("schema not ready");
    const db = ctx.schema.db;
    const { snapshotId } = await seedSnapshot("Chain Mechanics");

    await uploadSheets(getApp(), snapshotId, [
      { sheetNumber: "A103", sheetName: "Roof Plan" },
    ]);
    const [{ id: sheetId }] = await db
      .select({ id: sheets.id })
      .from(sheets)
      .where(eq(sheets.snapshotId, snapshotId));

    // Manually append a second event through the same singleton the
    // route uses.
    const history = getHistoryService();
    await history.appendEvent({
      entityType: "sheet",
      entityId: sheetId,
      eventType: "sheet.updated",
      actor: { kind: "system", id: "test-suite" },
      payload: { reason: "chain mechanics check" },
    });

    const events = await db
      .select()
      .from(atomEvents)
      .where(
        and(
          eq(atomEvents.entityType, "sheet"),
          eq(atomEvents.entityId, sheetId),
        ),
      )
      .orderBy(asc(atomEvents.recordedAt));
    expect(events).toHaveLength(2);
    expect(events[0]!.eventType).toBe("sheet.created");
    expect(events[0]!.prevHash).toBeNull();
    expect(events[1]!.eventType).toBe("sheet.updated");
    // Linkage: second event's prev_hash MUST equal first event's chain_hash.
    expect(events[1]!.prevHash).toBe(events[0]!.chainHash);
    expect(events[1]!.chainHash).not.toBe(events[0]!.chainHash);
  });

  it("appendEvent failure is swallowed: the row insert still commits and the request still 200s", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const db = ctx.schema.db;
    const { snapshotId } = await seedSnapshot("Append Failure Snapshot");

    // Patch the singleton's appendEvent to throw on the next call,
    // then restore. Spying on the live singleton (not re-mocking the
    // module) is the cleanest way to exercise the producer's
    // try/catch without disturbing the rest of the suite.
    const history = getHistoryService();
    const spy = vi
      .spyOn(history, "appendEvent")
      .mockRejectedValueOnce(new Error("simulated history outage"));

    const res = await uploadSheets(getApp(), snapshotId, [
      { sheetNumber: "A104", sheetName: "Site Plan" },
    ]);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uploaded: 1, skipped: 0, failed: 0 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({
      entityType: "sheet",
      eventType: "sheet.created",
      payload: expect.objectContaining({
        sheetNumber: "A104",
        sheetName: "Site Plan",
      }),
    });

    // The row insert remained committed.
    const rows = await db
      .select({ id: sheets.id })
      .from(sheets)
      .where(eq(sheets.snapshotId, snapshotId));
    expect(rows).toHaveLength(1);

    // No event row was written.
    const events = await db
      .select()
      .from(atomEvents)
      .where(
        and(
          eq(atomEvents.entityType, "sheet"),
          eq(atomEvents.entityId, rows[0]!.id),
        ),
      );
    expect(events).toHaveLength(0);

    spy.mockRestore();
  });
});
