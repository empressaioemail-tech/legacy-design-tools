/**
 * Unit-level coverage for the sheet event emission call sites
 * (Task #18 step 5; expanded by Task #20 to cover `sheet.updated`).
 *
 * Where the sibling `sheet-events-ingest.test.ts` exercises the
 * producer end-to-end against a real history service, this file
 * isolates the call site by fully mocking `../atoms/registry` at the
 * module boundary. The route then receives a vi.fn-backed
 * `EventAnchoringService` whose `appendEvent` we can introspect
 * directly — no `atom_events` round-trip required.
 *
 * Coverage:
 *   1. Exactly one `appendEvent` call per newly-inserted row, with the
 *      canonical payload shape (`sheetNumber`, `sheetName`,
 *      `snapshotId`, `engagementId`), `entityType:"sheet"`,
 *      `eventType:"sheet.created"`, and the system actor.
 *   2. Re-uploading the same `(snapshotId, sheetNumber)` pair emits
 *      `sheet.updated` (Task #20) with a `changes` diff payload,
 *      while the `sheet.created` for the original insert is preserved.
 *   3. An `appendEvent` rejection is swallowed: the HTTP response is
 *      still 200 with `uploaded: 1`, and the sheet row is queryable.
 *
 * The DB itself is real (test schema) because mocking drizzle's full
 * surface would dwarf the test it's hiding behind. The contract
 * verified here is purely "the route calls the registry's accessor
 * with the right args, and tolerates failure".
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
        throw new Error("sheet-events-emit-unit.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

// Module-boundary mock: every consumer that imports
// `getHistoryService` from `../atoms/registry` (the sheet ingest route
// in particular) sees this stub instead of the real Postgres-backed
// singleton. We keep `resetAtomRegistryForTests` as a passthrough so
// other suites' beforeAll hooks remain valid if this file is loaded
// alongside them.
const appendEventMock = vi.fn();
vi.mock("../atoms/registry", async () => {
  const actual =
    await vi.importActual<typeof import("../atoms/registry")>(
      "../atoms/registry",
    );
  return {
    ...actual,
    getHistoryService: () => ({
      appendEvent: appendEventMock,
      readHistory: vi.fn(),
      latestEvent: vi.fn(),
    }),
  };
});

const { setupRouteTests } = await import("./setup");
const { engagements, snapshots, sheets } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");

const SECRET = process.env["SNAPSHOT_SECRET"]!;

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeAll(() => {
  appendEventMock.mockReset();
});

const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

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
      address: "1 Unit Test Way",
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

async function uploadOneSheet(
  app: Express,
  snapshotId: string,
  spec: { sheetNumber: string; sheetName: string },
): Promise<request.Response> {
  return await request(app)
    .post(`/api/snapshots/${snapshotId}/sheets`)
    .set("x-snapshot-secret", SECRET)
    .field(
      "metadata",
      JSON.stringify([
        {
          index: 0,
          sheetNumber: spec.sheetNumber,
          sheetName: spec.sheetName,
          thumbnailWidth: 1,
          thumbnailHeight: 1,
          fullWidth: 1,
          fullHeight: 1,
        },
      ]),
    )
    .attach("sheet_0_thumb", TINY_PNG, {
      filename: "0_thumb.png",
      contentType: "image/png",
    })
    .attach("sheet_0_full", TINY_PNG, {
      filename: "0_full.png",
      contentType: "image/png",
    });
}

describe("sheet ingest emission call site (unit, mocked registry)", () => {
  it("calls appendEvent exactly once per newly-inserted row with the canonical payload", async () => {
    appendEventMock.mockReset();
    appendEventMock.mockResolvedValue({
      id: "evt-fake",
      chainHash: "x".repeat(64),
    });
    const { engagementId, snapshotId } = await seedSnapshot("Unit Canonical");

    const res = await uploadOneSheet(getApp(), snapshotId, {
      sheetNumber: "A201",
      sheetName: "Unit Test Sheet",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uploaded: 1, skipped: 0, failed: 0 });
    expect(appendEventMock).toHaveBeenCalledTimes(1);

    const arg = appendEventMock.mock.calls[0]![0];
    // Find the sheet id we expect to see in the call args.
    if (!ctx.schema) throw new Error("schema not ready");
    const [{ id: sheetId }] = await ctx.schema.db
      .select({ id: sheets.id })
      .from(sheets)
      .where(eq(sheets.snapshotId, snapshotId));

    expect(arg).toEqual({
      entityType: "sheet",
      entityId: sheetId,
      eventType: "sheet.created",
      actor: { kind: "system", id: "snapshot-ingest" },
      payload: {
        sheetNumber: "A201",
        sheetName: "Unit Test Sheet",
        snapshotId,
        engagementId,
      },
    });
    // No `occurredAt` — the producer must let the service stamp now().
    expect(arg).not.toHaveProperty("occurredAt");
  });

  it("emits sheet.updated (NOT a second sheet.created) when an upload hits onConflictDoUpdate, with a field-level diff", async () => {
    // Task #20 expanded the producer: re-uploading the same
    // (snapshotId, sheetNumber) pair triggers the upsert-update
    // branch (xmax != 0) and must emit a `sheet.updated` event with a
    // `changes` diff payload — NOT a duplicate `sheet.created`.
    appendEventMock.mockReset();
    appendEventMock.mockResolvedValue({
      id: "evt-fake",
      chainHash: "x".repeat(64),
    });
    const { engagementId, snapshotId } =
      await seedSnapshot("Unit Conflict Update");

    const first = await uploadOneSheet(getApp(), snapshotId, {
      sheetNumber: "A300",
      sheetName: "Original Name",
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ uploaded: 1 });
    expect(appendEventMock).toHaveBeenCalledTimes(1);
    expect(appendEventMock.mock.calls[0]![0].eventType).toBe("sheet.created");

    // Same snapshot, same sheet number, different sheet name — this
    // hits the `onConflictDoUpdate` branch (xmax != 0) and must emit
    // exactly one `sheet.updated` event (no second `sheet.created`).
    const second = await uploadOneSheet(getApp(), snapshotId, {
      sheetNumber: "A300",
      sheetName: "Renamed In Re-upload",
    });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ uploaded: 1 });
    // Now there must be exactly two appendEvent calls total: one
    // `sheet.created` from the first upload + one `sheet.updated`
    // from the re-upload. The producer must NOT issue a second
    // `sheet.created`.
    expect(appendEventMock).toHaveBeenCalledTimes(2);
    const updatedCallArg = appendEventMock.mock.calls[1]![0];

    // Locate the row id we expect the update event to reference.
    if (!ctx.schema) throw new Error("schema not ready");
    const [{ id: sheetId }] = await ctx.schema.db
      .select({ id: sheets.id, sheetName: sheets.sheetName })
      .from(sheets)
      .where(eq(sheets.snapshotId, snapshotId));

    expect(updatedCallArg).toEqual({
      entityType: "sheet",
      entityId: sheetId,
      eventType: "sheet.updated",
      actor: { kind: "system", id: "snapshot-ingest" },
      payload: {
        sheetNumber: "A300",
        snapshotId,
        engagementId,
        changes: {
          sheetName: { from: "Original Name", to: "Renamed In Re-upload" },
        },
      },
    });
    // No `occurredAt` — the producer lets the service stamp now().
    expect(updatedCallArg).not.toHaveProperty("occurredAt");

    // And the row was indeed updated (not a no-op): the sheetName
    // changed in place, confirming we exercised the conflict-update
    // branch rather than a fresh insert.
    const rows = await ctx.schema.db
      .select({ id: sheets.id, sheetName: sheets.sheetName })
      .from(sheets)
      .where(eq(sheets.snapshotId, snapshotId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sheetName).toBe("Renamed In Re-upload");
  });

  it("rejects from appendEvent are swallowed: response stays 200 and the row remains committed", async () => {
    appendEventMock.mockReset();
    appendEventMock.mockRejectedValue(new Error("simulated outage"));
    const { snapshotId } = await seedSnapshot("Unit Failure");

    const res = await uploadOneSheet(getApp(), snapshotId, {
      sheetNumber: "A202",
      sheetName: "Failure Path Sheet",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uploaded: 1, skipped: 0, failed: 0 });
    expect(appendEventMock).toHaveBeenCalledTimes(1);

    if (!ctx.schema) throw new Error("schema not ready");
    const rows = await ctx.schema.db
      .select({ id: sheets.id })
      .from(sheets)
      .where(eq(sheets.snapshotId, snapshotId));
    expect(rows).toHaveLength(1);
  });
});
