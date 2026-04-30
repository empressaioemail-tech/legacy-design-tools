/**
 * /api/atoms/:slug/:id/summary — the FE-facing endpoint that exposes
 * an atom's four-layer ContextSummary over HTTP (Spec 20 §F).
 *
 * Coverage:
 *   - happy path: registered slug returns the typed payload + provenance
 *   - unknown slug: 404 with `atom_type_not_registered`
 *   - not-found id: 200 with `typed.found = false` (atom-defined behavior,
 *     not an error path — the chat layer often references stale ids)
 *   - malformed `scope` query: falls back to `defaultScope()` rather than
 *     400ing (server stance: scope unknown → assume internal)
 *
 * The route resolves through the singleton registry, so the test must
 * call `resetAtomRegistryForTests()` in `beforeAll` AFTER the schema is
 * created — otherwise the registry would cache a closure over a `db`
 * binding that points at no schema.
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
      if (!ctx.schema) throw new Error("atoms-route.test: ctx.schema not set");
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
  // The registry is a process-wide singleton that captures the live `db`
  // binding the first time it's built. Drop the cache so the registry
  // (re)builds against the test schema's drizzle instance the first time
  // a request lands here.
  resetAtomRegistryForTests();
});

const TINY_PNG = Buffer.from([0]);

async function seedSheet(): Promise<{ sheetId: string }> {
  if (!ctx.schema) throw new Error("schema not ready");
  const db = ctx.schema.db;
  const [eng] = await db
    .insert(engagements)
    .values({
      name: "Atoms Route Test",
      nameLower: `atoms-route-${Math.random().toString(36).slice(2)}`,
      jurisdiction: "Moab, UT",
      address: "1 Atom St",
    })
    .returning({ id: engagements.id });
  const [snap] = await db
    .insert(snapshots)
    .values({
      engagementId: eng.id,
      projectName: "Atoms Route Test",
      payload: { sheets: [], rooms: [] },
      sheetCount: 1,
      roomCount: 0,
      levelCount: 0,
      wallCount: 0,
    })
    .returning({ id: snapshots.id });
  const [sheet] = await db
    .insert(sheets)
    .values({
      snapshotId: snap.id,
      engagementId: eng.id,
      sheetNumber: "A102",
      sheetName: "Cover Sheet",
      viewCount: 1,
      revisionNumber: null,
      revisionDate: null,
      thumbnailPng: TINY_PNG,
      thumbnailWidth: 64,
      thumbnailHeight: 48,
      fullPng: TINY_PNG,
      fullWidth: 800,
      fullHeight: 600,
      sortOrder: 0,
    })
    .returning({ id: sheets.id });
  return { sheetId: sheet.id };
}

describe("GET /api/atoms/:slug/:id/summary", () => {
  it("happy path: returns the four-layer ContextSummary for a registered atom", async () => {
    const { sheetId } = await seedSheet();
    const res = await request(getApp()).get(
      `/api/atoms/sheet/${sheetId}/summary`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      typed: {
        id: sheetId,
        found: true,
        sheetNumber: "A102",
        sheetName: "Cover Sheet",
      },
      scopeFiltered: false,
    });
    expect(typeof res.body.prose).toBe("string");
    expect(res.body.prose).toContain("A102");
    expect(Array.isArray(res.body.keyMetrics)).toBe(true);
    expect(typeof res.body.historyProvenance.latestEventId).toBe("string");
    expect(typeof res.body.historyProvenance.latestEventAt).toBe("string");
  });

  it("404s when the slug is not a registered atom type", async () => {
    const res = await request(getApp()).get(
      "/api/atoms/no-such-atom/anything/summary",
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: "atom_type_not_registered",
      slug: "no-such-atom",
    });
  });

  it("returns 200 with typed.found=false for an unknown id (not an error)", async () => {
    const res = await request(getApp()).get(
      "/api/atoms/sheet/00000000-0000-0000-0000-000000000000/summary",
    );
    expect(res.status).toBe(200);
    expect(res.body.typed).toEqual({
      id: "00000000-0000-0000-0000-000000000000",
      found: false,
    });
    expect(res.body.scopeFiltered).toBe(false);
  });

  it("falls back to defaultScope when the scope query param is malformed", async () => {
    const { sheetId } = await seedSheet();
    const res = await request(getApp())
      .get(`/api/atoms/sheet/${sheetId}/summary`)
      .query({ scope: "%not-json%" });
    // The request must succeed (server stance: scope unknown → assume
    // internal) rather than returning a 4xx for a bad client param.
    expect(res.status).toBe(200);
    expect(res.body.typed.found).toBe(true);
  });
});
