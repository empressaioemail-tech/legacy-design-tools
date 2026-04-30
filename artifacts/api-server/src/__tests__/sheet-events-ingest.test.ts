/**
 * Sheet ingest → atom event emission (Task #18 + Task #20).
 *
 * Wires the snapshot ingest path onto the empressa-atom history
 * primitive: every sheet mutation in the ingest path must produce a
 * matching event in `atom_events`, appended through the registry's
 * history service (NOT a direct DB write).
 *
 * Event types produced by the ingest path (Task #20 expanded #18):
 *   - `sheet.created`: emitted on a fresh upsert (xmax = 0).
 *   - `sheet.updated`: emitted when an upsert hits `onConflictDoUpdate`
 *     (xmax != 0) for the same `(snapshotId, sheetNumber)` pair, with
 *     a field-level `changes` diff payload.
 *   - `sheet.removed`: emitted for any sheet that lived in the prior
 *     snapshot for the same engagement but is missing from the current
 *     upload. Attaches to the prior snapshot's sheet row (so the
 *     entity's chain grows by one event).
 *
 * Coverage:
 *   1. Single multipart upload with one sheet → exactly one `sheet.created`
 *      event, with the canonical payload shape and a non-null
 *      `chain_hash` / null `prev_hash` (chain initialization).
 *   2. The `GET /api/atoms/sheet/<id>/summary` route surfaces the
 *      real event id + timestamp via `historyProvenance`, not the
 *      `1970-01-01T...` placeholder.
 *   3. Two snapshots for the same engagement that BOTH contain the same
 *      sheet number produce two distinct sheet rows (the ingest upsert
 *      key is `(snapshotId, sheetNumber)`) — each with its own
 *      `sheet.created` chain root. No `sheet.removed` is emitted
 *      because the sheet number is present in the new upload.
 *   4. Re-uploading to the same `(snapshotId, sheetNumber)` pair with
 *      changed metadata grows the chain: a `sheet.updated` event is
 *      appended whose `prev_hash` chains to the prior `sheet.created`
 *      and whose payload carries the field-level diff.
 *   5. A two-snapshot ingest where a sheet drops out of the newer
 *      snapshot grows the dropped sheet's chain with a `sheet.removed`
 *      event whose `prev_hash` links back to the original
 *      `sheet.created`. Replaces the old "manual stand-in append"
 *      coverage with a real cross-snapshot ingest sequence.
 *   6. An `appendEvent` failure does NOT roll back or fail the sheet
 *      row insert — the `uploaded` counter still increments and the
 *      row is queryable. (Locked decision #5: events are observability,
 *      rows are the source of truth.)
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

  it("re-uploading the same (snapshotId, sheetNumber) emits sheet.updated chained onto sheet.created with a field-level diff", async () => {
    // Real-ingest replacement for the manual chain-mechanics
    // stand-in: the second upload to the same snapshot+sheetNumber
    // triggers `onConflictDoUpdate` (xmax != 0), which the producer
    // now translates into a `sheet.updated` event with a `changes`
    // payload diff (Task #20).
    if (!ctx.schema) throw new Error("schema not ready");
    const db = ctx.schema.db;
    const { engagementId, snapshotId } = await seedSnapshot("Update Snapshot");

    // First upload — establishes the chain root.
    await uploadSheets(getApp(), snapshotId, [
      { sheetNumber: "A103", sheetName: "Roof Plan" },
    ]);
    const [{ id: sheetId }] = await db
      .select({ id: sheets.id })
      .from(sheets)
      .where(eq(sheets.snapshotId, snapshotId));

    // Second upload — same (snapshotId, sheetNumber), different
    // sheetName. Hits the upsert-update branch.
    const res2 = await uploadSheets(getApp(), snapshotId, [
      { sheetNumber: "A103", sheetName: "Roof Plan (rev B)" },
    ]);
    expect(res2.status).toBe(200);
    expect(res2.body).toMatchObject({ uploaded: 1, skipped: 0, failed: 0 });

    // Still exactly one sheet row — the upsert mutated in place.
    const sheetRows = await db
      .select({ id: sheets.id, sheetName: sheets.sheetName })
      .from(sheets)
      .where(eq(sheets.snapshotId, snapshotId));
    expect(sheetRows).toHaveLength(1);
    expect(sheetRows[0]!.id).toBe(sheetId);
    expect(sheetRows[0]!.sheetName).toBe("Roof Plan (rev B)");

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
    expect(events[1]!.actor).toEqual({
      kind: "system",
      id: "snapshot-ingest",
    });
    expect(events[1]!.payload).toMatchObject({
      sheetNumber: "A103",
      snapshotId,
      engagementId,
      changes: {
        sheetName: { from: "Roof Plan", to: "Roof Plan (rev B)" },
      },
    });
    // Unchanged fields (PNG bytes, dimensions) should NOT show up in
    // the diff.
    const changes = (events[1]!.payload as { changes: Record<string, unknown> })
      .changes;
    expect(Object.keys(changes)).toEqual(["sheetName"]);
  });

  it("two-snapshot ingest where a sheet drops out emits sheet.removed chained onto the original sheet.created", async () => {
    // Replaces the prior manual `appendEvent` stand-in with a real
    // cross-snapshot ingest. Snapshot A has sheets {A201, A202}.
    // Snapshot B (later) has only {A201}. The producer must emit a
    // `sheet.removed` event against snapshot A's A202 row, growing
    // that entity's chain from one event to two and linking the new
    // `prev_hash` to the original `sheet.created`'s `chain_hash`.
    if (!ctx.schema) throw new Error("schema not ready");
    const db = ctx.schema.db;
    const { engagementId, snapshotId: snapshotIdA } =
      await seedSnapshot("Removal Snapshot A");

    await uploadSheets(getApp(), snapshotIdA, [
      { sheetNumber: "A201", sheetName: "Floor 1" },
      { sheetNumber: "A202", sheetName: "Floor 2" },
    ]);

    // Find the row id for A202 — that's the chain we expect to grow.
    const [a202Row] = await db
      .select({ id: sheets.id })
      .from(sheets)
      .where(
        and(
          eq(sheets.snapshotId, snapshotIdA),
          eq(sheets.sheetNumber, "A202"),
        ),
      );
    const a202Id = a202Row!.id;

    // Create a strictly-later snapshot B for the same engagement.
    // `received_at` defaults to `now()`; a microsecond delay isn't
    // strictly necessary in practice but a tiny advisory wait avoids
    // any flake risk if the test machine's clock granularity is
    // unusually coarse.
    await new Promise((r) => setTimeout(r, 5));
    const [snapB] = await db
      .insert(snapshots)
      .values({
        engagementId,
        projectName: "Removal Snapshot B",
        payload: { sheets: [], rooms: [] },
      })
      .returning({ id: snapshots.id });
    const snapshotIdB = snapB.id;

    // Snapshot B's upload is missing A202 — it should be marked
    // removed against the prior snapshot's row.
    await uploadSheets(getApp(), snapshotIdB, [
      { sheetNumber: "A201", sheetName: "Floor 1 (rev)" },
    ]);

    const events = await db
      .select()
      .from(atomEvents)
      .where(
        and(
          eq(atomEvents.entityType, "sheet"),
          eq(atomEvents.entityId, a202Id),
        ),
      )
      .orderBy(asc(atomEvents.recordedAt));
    expect(events).toHaveLength(2);
    expect(events[0]!.eventType).toBe("sheet.created");
    expect(events[0]!.prevHash).toBeNull();
    expect(events[1]!.eventType).toBe("sheet.removed");
    // Real chain growth via the ingest path: prev_hash links the
    // removal back to the creation event for the same entity.
    expect(events[1]!.prevHash).toBe(events[0]!.chainHash);
    expect(events[1]!.chainHash).not.toBe(events[0]!.chainHash);
    expect(events[1]!.actor).toEqual({
      kind: "system",
      id: "snapshot-ingest",
    });
    expect(events[1]!.payload).toMatchObject({
      sheetNumber: "A202",
      sheetName: "Floor 2",
      snapshotId: snapshotIdA,
      engagementId,
      missingFromSnapshotId: snapshotIdB,
    });

    // Idempotency: a second ingest into snapshot B that still omits
    // A202 must NOT append another `sheet.removed` (the latest event
    // on the chain is already a removal).
    await uploadSheets(getApp(), snapshotIdB, [
      { sheetNumber: "A201", sheetName: "Floor 1 (rev 2)" },
    ]);
    const eventsAfter = await db
      .select()
      .from(atomEvents)
      .where(
        and(
          eq(atomEvents.entityType, "sheet"),
          eq(atomEvents.entityId, a202Id),
        ),
      );
    expect(eventsAfter).toHaveLength(2);
  });

  it("appendEvent failure is swallowed: the row insert still commits and the request still 200s", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const db = ctx.schema.db;
    const { snapshotId } = await seedSnapshot("Append Failure Snapshot");

    // Patch the singleton's appendEvent to throw on the next call,
    // then restore. Spying on the live singleton (not re-mocking the
    // module) is the cleanest way to exercise the producer's
    // try/catch without disturbing the rest of the suite.
    //
    // The route emits TWO events per upload: one `sheet.created` per
    // inserted row + one trailing `snapshot.sheets_attached`. We force
    // the FIRST call (the per-sheet event) to reject so the failure
    // path under test is the one that matters for "row insert kept" —
    // the second call (snapshot-level event) is allowed to succeed and
    // is asserted separately below.
    const history = getHistoryService();
    const spy = vi
      .spyOn(history, "appendEvent")
      .mockRejectedValueOnce(new Error("simulated history outage"));

    const res = await uploadSheets(getApp(), snapshotId, [
      { sheetNumber: "A104", sheetName: "Site Plan" },
    ]);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uploaded: 1, skipped: 0, failed: 0 });

    // Two appendEvent invocations: the rejected `sheet.created` and the
    // trailing `snapshot.sheets_attached`. We assert the per-sheet call
    // is what tripped the simulated outage; the snapshot-level call ran
    // afterwards through the real history service.
    const sheetCreatedCalls = spy.mock.calls.filter(
      (c) => c[0]?.eventType === "sheet.created",
    );
    expect(sheetCreatedCalls).toHaveLength(1);
    expect(sheetCreatedCalls[0]![0]).toMatchObject({
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

    // No `sheet`-scoped event row was written (the failed appendEvent
    // never made it to the atom_events table). The
    // `snapshot.sheets_attached` row is on a different entityType chain
    // and is not in scope for this assertion.
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
