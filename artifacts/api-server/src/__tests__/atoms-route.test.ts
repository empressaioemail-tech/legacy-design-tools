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
const { engagements, snapshots, sheets, users } = await import("@workspace/db");
const { resetAtomRegistryForTests, getHistoryService } = await import(
  "../atoms/registry"
);
const { SHEET_EVENT_TYPES } = await import("../atoms/sheet.atom");
const { SNAPSHOT_EVENT_TYPES } = await import("../atoms/snapshot.atom");
const { ENGAGEMENT_EVENT_TYPES } = await import("../atoms/engagement.atom");
const { PARCEL_BRIEFING_EVENT_TYPES } = await import(
  "../atoms/parcel-briefing.atom"
);
const { INTENT_EVENT_TYPES } = await import("../atoms/intent.atom");
const { BRIEFING_SOURCE_EVENT_TYPES } = await import(
  "../atoms/briefing-source.atom"
);
const { BIM_MODEL_EVENT_TYPES } = await import("../atoms/bim-model.atom");
const { MATERIALIZABLE_ELEMENT_EVENT_TYPES } = await import(
  "../atoms/materializable-element.atom"
);
const { BRIEFING_DIVERGENCE_EVENT_TYPES } = await import(
  "../atoms/briefing-divergence.atom"
);
const { NEIGHBORING_CONTEXT_EVENT_TYPES } = await import(
  "../atoms/neighboring-context.atom"
);

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

async function seedSheet(): Promise<{
  sheetId: string;
  snapshotId: string;
  engagementId: string;
}> {
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
  return { sheetId: sheet.id, snapshotId: snap.id, engagementId: eng.id };
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

  // A2 sprint: snapshot is the second registered atom and the first
  // one with a non-empty composition. The route is atom-agnostic — these
  // cases prove the new registration flows through it without any
  // route-level change.
  it("returns the four-layer ContextSummary for a registered snapshot id with composition resolved", async () => {
    const { snapshotId, engagementId, sheetId } = await seedSheet();
    const res = await request(getApp()).get(
      `/api/atoms/snapshot/${snapshotId}/summary`,
    );
    expect(res.status).toBe(200);
    expect(res.body.typed).toMatchObject({
      id: snapshotId,
      found: true,
      engagementId,
      projectName: "Atoms Route Test",
    });
    // First related atom is the engagement parent ref; the rest are the
    // child sheets surfaced by the framework's composition resolver.
    expect(Array.isArray(res.body.relatedAtoms)).toBe(true);
    expect(res.body.relatedAtoms[0]).toMatchObject({
      kind: "atom",
      entityType: "engagement",
      entityId: engagementId,
    });
    const sheetRefs = res.body.relatedAtoms.slice(1);
    expect(sheetRefs).toHaveLength(1);
    expect(sheetRefs[0]).toMatchObject({
      kind: "atom",
      entityType: "sheet",
      entityId: sheetId,
      mode: "compact",
    });
    expect(typeof res.body.prose).toBe("string");
    expect(res.body.prose).toContain("Atoms Route Test");
    expect(res.body.scopeFiltered).toBe(false);
  });

  it("returns 200 with typed.found=false for an unknown snapshot id (not an error)", async () => {
    const res = await request(getApp()).get(
      "/api/atoms/snapshot/00000000-0000-0000-0000-000000000000/summary",
    );
    expect(res.status).toBe(200);
    expect(res.body.typed).toEqual({
      id: "00000000-0000-0000-0000-000000000000",
      found: false,
    });
    expect(res.body.relatedAtoms).toEqual([]);
    expect(res.body.scopeFiltered).toBe(false);
  });
});

describe("GET /api/atoms/:slug/:id/history", () => {
  it("returns recent events newest-first for a registered atom", async () => {
    const { sheetId } = await seedSheet();
    const history = getHistoryService();
    // Append three events with strictly-increasing occurredAt so the
    // ORDER BY is deterministic regardless of insertion races.
    const t0 = new Date("2026-04-01T10:00:00Z");
    const t1 = new Date("2026-04-02T10:00:00Z");
    const t2 = new Date("2026-04-03T10:00:00Z");
    await history.appendEvent({
      entityType: "sheet",
      entityId: sheetId,
      eventType: "sheet.created",
      actor: { kind: "system", id: "test" },
      payload: {},
      occurredAt: t0,
    });
    await history.appendEvent({
      entityType: "sheet",
      entityId: sheetId,
      eventType: "sheet.updated",
      actor: { kind: "agent", id: "ingest" },
      payload: { revision: 1 },
      occurredAt: t1,
    });
    await history.appendEvent({
      entityType: "sheet",
      entityId: sheetId,
      eventType: "sheet.updated",
      actor: { kind: "user", id: "u1" },
      payload: { revision: 2 },
      occurredAt: t2,
    });

    const res = await request(getApp()).get(
      `/api/atoms/sheet/${sheetId}/history`,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(res.body.events).toHaveLength(3);
    expect(res.body.events[0].eventType).toBe("sheet.updated");
    expect(res.body.events[0].occurredAt).toBe(t2.toISOString());
    expect(res.body.events[0].actor).toEqual({ kind: "user", id: "u1" });
    expect(res.body.events[2].eventType).toBe("sheet.created");
    // Chain hashes must NOT leak through the public response.
    expect(res.body.events[0]).not.toHaveProperty("chainHash");
    expect(res.body.events[0]).not.toHaveProperty("prevHash");
  });

  it("clamps the limit query parameter to at most 50 and caps the page", async () => {
    const { sheetId } = await seedSheet();
    const history = getHistoryService();
    for (let i = 0; i < 4; i++) {
      await history.appendEvent({
        entityType: "sheet",
        entityId: sheetId,
        eventType: "sheet.updated",
        actor: { kind: "system", id: "test" },
        payload: { i },
        occurredAt: new Date(Date.UTC(2026, 3, 10 + i)),
      });
    }
    const res = await request(getApp())
      .get(`/api/atoms/sheet/${sheetId}/history`)
      .query({ limit: 2 });
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
    // Newest first → last appended is at index 0.
    expect(res.body.events[0].occurredAt).toBe(
      new Date(Date.UTC(2026, 3, 13)).toISOString(),
    );
  });

  it("returns an empty list for an unknown id (atom_events is opaque)", async () => {
    const res = await request(getApp()).get(
      "/api/atoms/sheet/00000000-0000-0000-0000-000000000000/history",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [] });
  });

  it("404s when the slug is not a registered atom type", async () => {
    const res = await request(getApp()).get(
      "/api/atoms/no-such-atom/anything/history",
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: "atom_type_not_registered",
      slug: "no-such-atom",
    });
  });

  it("hydrates user-kind actors with displayName from the users table; agent/system actors pass through; unknown user ids degrade to no displayName", async () => {
    const { sheetId } = await seedSheet();
    if (!ctx.schema) throw new Error("schema not ready");
    // Two known profiles: u-known (Jane Doe) and u-no-email (no email/avatar).
    // A third event uses u-ghost which has no row — must come back without
    // a displayName so the FE can fall back to the raw id.
    await ctx.schema.db.insert(users).values([
      {
        id: "u-known",
        displayName: "Jane Doe",
        email: "jane@example.com",
        avatarUrl: "https://example.com/jane.png",
      },
      { id: "u-no-email", displayName: "Sam Author", email: null, avatarUrl: null },
    ]);

    const history = getHistoryService();
    const t0 = new Date("2026-04-01T10:00:00Z");
    const t1 = new Date("2026-04-02T10:00:00Z");
    const t2 = new Date("2026-04-03T10:00:00Z");
    const t3 = new Date("2026-04-04T10:00:00Z");
    await history.appendEvent({
      entityType: "sheet",
      entityId: sheetId,
      eventType: "sheet.created",
      actor: { kind: "system", id: "test" },
      payload: {},
      occurredAt: t0,
    });
    await history.appendEvent({
      entityType: "sheet",
      entityId: sheetId,
      eventType: "sheet.updated",
      actor: { kind: "user", id: "u-known" },
      payload: { revision: 1 },
      occurredAt: t1,
    });
    await history.appendEvent({
      entityType: "sheet",
      entityId: sheetId,
      eventType: "sheet.updated",
      actor: { kind: "user", id: "u-no-email" },
      payload: { revision: 2 },
      occurredAt: t2,
    });
    await history.appendEvent({
      entityType: "sheet",
      entityId: sheetId,
      eventType: "sheet.updated",
      actor: { kind: "user", id: "u-ghost" },
      payload: { revision: 3 },
      occurredAt: t3,
    });

    const res = await request(getApp()).get(
      `/api/atoms/sheet/${sheetId}/history`,
    );
    expect(res.status).toBe(200);
    const events = res.body.events as Array<{
      occurredAt: string;
      actor: {
        kind: string;
        id: string;
        displayName?: string;
        email?: string;
        avatarUrl?: string;
      };
    }>;
    const byOccurred = new Map(events.map((e) => [e.occurredAt, e.actor]));
    // Known profile gets displayName + email + avatarUrl.
    expect(byOccurred.get(t1.toISOString())).toEqual({
      kind: "user",
      id: "u-known",
      displayName: "Jane Doe",
      email: "jane@example.com",
      avatarUrl: "https://example.com/jane.png",
    });
    // Profile present but email/avatar nullable → only displayName surfaces.
    expect(byOccurred.get(t2.toISOString())).toEqual({
      kind: "user",
      id: "u-no-email",
      displayName: "Sam Author",
    });
    // Unknown user id → actor returned as-is (no displayName field).
    expect(byOccurred.get(t3.toISOString())).toEqual({
      kind: "user",
      id: "u-ghost",
    });
    // Non-user actor unchanged.
    expect(byOccurred.get(t0.toISOString())).toEqual({
      kind: "system",
      id: "test",
    });
  });

  it("hydrates user-kind actors on the engagement timeline (slug=engagement); falls back to the raw id when no profile row exists", async () => {
    // Smoke-test the same hydration contract as the sheet-slug case
    // above, but against the `engagement` slug — the route is
    // atom-agnostic, so this is the integration anchor for the
    // "engagement timeline shows real names" requirement (Task #82).
    // Without this case, a future refactor that special-cases hydration
    // on the slug would silently regress engagement timelines while the
    // sheet test stayed green.
    const { engagementId } = await seedSheet();
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values([
      {
        id: "u-eng-known",
        displayName: "Riley Reviewer",
        email: "riley@example.com",
        avatarUrl: "https://example.com/riley.png",
      },
    ]);

    const history = getHistoryService();
    const tKnown = new Date("2026-04-10T10:00:00Z");
    const tGhost = new Date("2026-04-11T10:00:00Z");
    await history.appendEvent({
      entityType: "engagement",
      entityId: engagementId,
      eventType: "engagement.address-updated",
      actor: { kind: "user", id: "u-eng-known" },
      payload: { fromAddress: null, toAddress: "1 Atom St" },
      occurredAt: tKnown,
    });
    await history.appendEvent({
      entityType: "engagement",
      entityId: engagementId,
      eventType: "engagement.address-updated",
      actor: { kind: "user", id: "u-eng-ghost" },
      payload: { fromAddress: "1 Atom St", toAddress: "2 Atom St" },
      occurredAt: tGhost,
    });

    const res = await request(getApp()).get(
      `/api/atoms/engagement/${engagementId}/history`,
    );
    expect(res.status).toBe(200);
    const events = res.body.events as Array<{
      occurredAt: string;
      actor: {
        kind: string;
        id: string;
        displayName?: string;
        email?: string;
        avatarUrl?: string;
      };
    }>;
    const byOccurred = new Map(events.map((e) => [e.occurredAt, e.actor]));
    expect(byOccurred.get(tKnown.toISOString())).toEqual({
      kind: "user",
      id: "u-eng-known",
      displayName: "Riley Reviewer",
      email: "riley@example.com",
      avatarUrl: "https://example.com/riley.png",
    });
    // No profile row → actor is returned as-is so the FE can fall back
    // to the raw id rather than silently dropping the attribution.
    expect(byOccurred.get(tGhost.toISOString())).toEqual({
      kind: "user",
      id: "u-eng-ghost",
    });
  });

  it("falls back to the default limit when the query value is malformed", async () => {
    const { sheetId } = await seedSheet();
    const res = await request(getApp())
      .get(`/api/atoms/sheet/${sheetId}/history`)
      .query({ limit: "not-a-number" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
  });
});

describe("GET /api/atoms/catalog", () => {
  it("returns every registered atom with its declared event vocabulary", async () => {
    // The catalog endpoint exists so the Dev Atoms Probe (and any other
    // operator surface) can introspect what's registered without a
    // grep — must include the `eventTypes` field surfaced by Task #26
    // for sheet and snapshot.
    const res = await request(getApp()).get("/api/atoms/catalog");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.atoms)).toBe(true);

    const byType = new Map<
      string,
      {
        entityType: string;
        domain: string;
        defaultMode: string;
        composes: string[];
        eventTypes: string[];
      }
    >(res.body.atoms.map((a: { entityType: string }) => [a.entityType, a]));

    // Assert against the authoritative `*_EVENT_TYPES` constants exported
    // by each atom module rather than re-typing the strings here. That way
    // a rename in the atom (the failure mode that caused Task #40) flows
    // straight into this test instead of needing a parallel edit.
    const sheet = byType.get("sheet");
    expect(sheet).toBeDefined();
    expect(sheet?.eventTypes).toEqual([...SHEET_EVENT_TYPES]);
    expect(sheet?.composes).toEqual([]);

    const snapshot = byType.get("snapshot");
    expect(snapshot).toBeDefined();
    expect(snapshot?.eventTypes).toEqual([...SNAPSHOT_EVENT_TYPES]);
    expect(snapshot?.composes).toEqual(["sheet"]);

    // Engagement now declares its event vocabulary via the registration
    // (Task #45 wired `ENGAGEMENT_EVENT_TYPES` onto the registration's
    // `eventTypes` field). Asserts against the constant — same pattern as
    // sheet/snapshot above — so a rename in the atom flows straight into
    // this test without a parallel edit.
    const engagement = byType.get("engagement");
    expect(engagement).toBeDefined();
    expect(engagement?.eventTypes).toEqual([...ENGAGEMENT_EVENT_TYPES]);
    // After DA-PI-1, engagement composes the new `parcel-briefing` atom
    // alongside its existing `snapshot` and forward-ref `submission`
    // edges. `composes` reflects the raw `childEntityType` order from the
    // composition array (forward-ref edges are NOT filtered — see
    // `describeForPrompt` in the framework registry).
    expect(engagement?.composes).toEqual([
      "snapshot",
      "submission",
      "parcel-briefing",
    ]);

    // DA-PI-1 parcel-intelligence atoms — assert the full registration
    // surface (eventTypes + composes order) so a registration drift
    // (e.g. accidentally swapping forwardRef on `parcel`) surfaces here
    // rather than being caught by an integration test downstream.

    const parcelBriefing = byType.get("parcel-briefing");
    expect(parcelBriefing).toBeDefined();
    expect(parcelBriefing?.eventTypes).toEqual([
      ...PARCEL_BRIEFING_EVENT_TYPES,
    ]);
    expect(parcelBriefing?.defaultMode).toBe("card");
    // Spec 51 wins on the 4th-child discrepancy — `code-section`,
    // forwardRef:true (Code Library catalog atom not yet shimmed).
    // Order matches the composition array: parcel, intent,
    // briefing-source, code-section.
    expect(parcelBriefing?.composes).toEqual([
      "parcel",
      "intent",
      "briefing-source",
      "code-section",
    ]);

    const intent = byType.get("intent");
    expect(intent).toBeDefined();
    expect(intent?.eventTypes).toEqual([...INTENT_EVENT_TYPES]);
    expect(intent?.defaultMode).toBe("card");
    expect(intent?.composes).toEqual(["parcel"]);

    const briefingSource = byType.get("briefing-source");
    expect(briefingSource).toBeDefined();
    expect(briefingSource?.eventTypes).toEqual([
      ...BRIEFING_SOURCE_EVENT_TYPES,
    ]);
    // briefing-source surfaces in lists — defaultMode is compact per
    // Spec 51a §2.12's "compact (in briefing source list)" guidance.
    expect(briefingSource?.defaultMode).toBe("compact");
    expect(briefingSource?.composes).toEqual(["parcel-briefing", "parcel"]);

    const neighboringContext = byType.get("neighboring-context");
    expect(neighboringContext).toBeDefined();
    expect(neighboringContext?.eventTypes).toEqual([
      ...NEIGHBORING_CONTEXT_EVENT_TYPES,
    ]);
    // neighboring-context surfaces inline — defaultMode is compact per
    // Spec 51a §2.13's "compact (line in briefing)" guidance.
    expect(neighboringContext?.defaultMode).toBe("compact");
    expect(neighboringContext?.composes).toEqual(["parcel", "briefing-source"]);

    // DA-PI-5 Revit-sensor materialization atoms — same drift-check
    // pattern as the DA-PI-1 quartet above. The bim-model registration
    // is the affordance the Push to Revit button hangs off of, so a
    // rename of any of its three event types or a reordering of its
    // composition would be caught here before shipping.

    const bimModel = byType.get("bim-model");
    expect(bimModel).toBeDefined();
    expect(bimModel?.eventTypes).toEqual([...BIM_MODEL_EVENT_TYPES]);
    expect(bimModel?.defaultMode).toBe("card");
    // Composition order from bim-model.atom: engagement,
    // parcel-briefing, materializable-element (forwardRef),
    // briefing-divergence, connector-binding (forwardRef).
    // forwardRef edges are NOT filtered from `composes` — they
    // reflect the raw childEntityType order. `connector-binding`
    // is declared by locked decision #2 even though the connector
    // atom lives in another service.
    expect(bimModel?.composes).toEqual([
      "engagement",
      "parcel-briefing",
      "materializable-element",
      "briefing-divergence",
      "connector-binding",
    ]);

    const materializableElement = byType.get("materializable-element");
    expect(materializableElement).toBeDefined();
    expect(materializableElement?.eventTypes).toEqual([
      ...MATERIALIZABLE_ELEMENT_EVENT_TYPES,
    ]);
    // materializable-element surfaces inline in element lists — same
    // compact default the briefing-source atom uses for the same
    // reason.
    expect(materializableElement?.defaultMode).toBe("compact");
    expect(materializableElement?.composes).toEqual([
      "parcel-briefing",
      "briefing-source",
      "briefing-divergence",
    ]);

    const briefingDivergence = byType.get("briefing-divergence");
    expect(briefingDivergence).toBeDefined();
    expect(briefingDivergence?.eventTypes).toEqual([
      ...BRIEFING_DIVERGENCE_EVENT_TYPES,
    ]);
    // briefing-divergence is a leaf row in the divergence list —
    // compact mode mirrors briefing-source / neighboring-context.
    expect(briefingDivergence?.defaultMode).toBe("compact");
    expect(briefingDivergence?.composes).toEqual([
      "bim-model",
      "materializable-element",
      "parcel-briefing",
    ]);
  });

  // The atoms route is fully dynamic (resolves through the registry),
  // so registering the four DA-PI-1 atoms automatically exposes their
  // /summary endpoints. These cases prove the new registrations flow
  // through the route without any route-level change, and that the
  // not-found envelope DA-PI-1 ships (data engine deferred to DA-PI-3
  // for parcel-briefing) is well-formed.
  describe("DA-PI-1 atoms surface through /api/atoms/:slug/:id/summary", () => {
    // Atoms whose data engine has not yet been wired (DA-PI-1 baseline)
    // — these still return the bare `{ id, found: false }` typed
    // envelope on a fixture id.
    it.each([
      ["intent"],
      ["briefing-source"],
      ["neighboring-context"],
    ] as const)(
      "%s: returns the four-layer not-found envelope (data engine pending)",
      async (slug) => {
        const opaqueId = `${slug}:test-fixture-id`;
        const res = await request(getApp()).get(
          `/api/atoms/${slug}/${encodeURIComponent(opaqueId)}/summary`,
        );
        expect(res.status).toBe(200);
        expect(res.body.typed).toEqual({ id: opaqueId, found: false });
        expect(res.body.relatedAtoms).toEqual([]);
        expect(res.body.keyMetrics).toEqual([]);
        expect(typeof res.body.prose).toBe("string");
        expect(res.body.prose.length).toBeGreaterThan(0);
        expect(typeof res.body.historyProvenance.latestEventId).toBe("string");
        expect(typeof res.body.historyProvenance.latestEventAt).toBe("string");
        expect(res.body.scopeFiltered).toBe(false);
      },
    );

    // parcel-briefing's data engine landed in DA-PI-3 — the typed
    // envelope is enriched with the seven nullable section slots +
    // generation metadata even on the not-found branch (a fixture id
    // resolves to no engagement and so no briefing row). All slots
    // are null until a generation has actually persisted them.
    it("parcel-briefing: returns the DA-PI-3 enriched not-found envelope", async () => {
      const opaqueId = "parcel-briefing:test-fixture-id";
      const res = await request(getApp()).get(
        `/api/atoms/parcel-briefing/${encodeURIComponent(opaqueId)}/summary`,
      );
      expect(res.status).toBe(200);
      expect(res.body.typed).toEqual({
        id: opaqueId,
        found: false,
        sectionA: null,
        sectionB: null,
        sectionC: null,
        sectionD: null,
        sectionE: null,
        sectionF: null,
        sectionG: null,
        generatedAt: null,
        generatedBy: null,
      });
      expect(res.body.relatedAtoms).toEqual([]);
      expect(res.body.keyMetrics).toEqual([]);
      expect(typeof res.body.prose).toBe("string");
      expect(res.body.prose.length).toBeGreaterThan(0);
      expect(typeof res.body.historyProvenance.latestEventId).toBe("string");
      expect(typeof res.body.historyProvenance.latestEventAt).toBe("string");
      expect(res.body.scopeFiltered).toBe(false);
    });
  });
});
