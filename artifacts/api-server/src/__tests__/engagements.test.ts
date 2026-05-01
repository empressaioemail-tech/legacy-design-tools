/**
 * /api/engagements — lifecycle event emission (Task #49).
 *
 * Verifies that the PATCH and POST regeocode handlers emit the two new
 * producers wired off `engagement.address-updated` and
 * `engagement.jurisdiction-resolved`, alongside their normal row-update
 * behavior. The engagement timeline (`GET /api/atoms/engagement/:id/history`)
 * is exercised end-to-end so the test catches regressions in either the
 * emit code or the generic history endpoint's resolution of the
 * `engagement` slug.
 *
 * Geocoding is mocked per-test so the create-new branch's best-effort
 * geocode kickoff does not hit the real network. Mocks return a
 * deterministic Geocode shape that the producers can route into the
 * jurisdiction-resolved payload.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("engagements.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

vi.mock("@workspace/site-context/server", () => ({
  geocodeAddress: vi.fn(),
}));

vi.mock("@workspace/codes", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/codes")>("@workspace/codes");
  return {
    // Keep the REAL `keyFromEngagement` so the engagement.jurisdiction-resolved
    // helper can derive the canonical jurisdiction key from the registry — the
    // payload field needs the real key for the tests to be meaningful. Only
    // the warmup enqueue is stubbed to avoid network/queue side effects.
    ...actual,
    enqueueWarmupForJurisdiction: vi.fn(async () => ({
      enqueued: 0,
      skipped: 0,
    })),
  };
});

const { setupRouteTests } = await import("./setup");
const { engagements, atomEvents } = await import("@workspace/db");
const { eq, and, asc } = await import("drizzle-orm");
const { geocodeAddress } = await import("@workspace/site-context/server");
const registryModule = await import("../atoms/registry");
const { resetAtomRegistryForTests } = registryModule;

const SECRET = process.env["SNAPSHOT_SECRET"]!;

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeAll(() => {
  // The history singleton captures `db` at construction time; reset
  // so `getHistoryService()` rebuilds against the test schema's
  // drizzle instance once `ctx.schema` is set in `setupRouteTests`'s
  // beforeAll. Mirrors the pattern used by `sheet-events-ingest.test.ts`.
  resetAtomRegistryForTests();
});

const mockedGeocodeAddress = vi.mocked(geocodeAddress);

beforeEach(() => {
  // Reset queued `mockResolvedValueOnce` returns so a test that does
  // NOT call geocode does not pick up a leftover from the prior test.
  mockedGeocodeAddress.mockReset();
});

async function seedEngagement(overrides: Partial<{
  name: string;
  address: string | null;
  jurisdictionCity: string | null;
  jurisdictionState: string | null;
  jurisdictionFips: string | null;
}> = {}): Promise<typeof engagements.$inferSelect> {
  if (!ctx.schema) throw new Error("schema not ready");
  const name = overrides.name ?? "Test Engagement";
  const [eng] = await ctx.schema.db
    .insert(engagements)
    .values({
      name,
      nameLower: name.trim().toLowerCase(),
      address: overrides.address ?? "100 Original St",
      jurisdictionCity: overrides.jurisdictionCity ?? null,
      jurisdictionState: overrides.jurisdictionState ?? null,
      jurisdictionFips: overrides.jurisdictionFips ?? null,
    })
    .returning();
  return eng;
}

async function readEngagementEvents(engagementId: string) {
  if (!ctx.schema) throw new Error("schema not ready");
  return ctx.schema.db
    .select()
    .from(atomEvents)
    .where(
      and(
        eq(atomEvents.entityType, "engagement"),
        eq(atomEvents.entityId, engagementId),
      ),
    )
    .orderBy(asc(atomEvents.recordedAt));
}

describe("PATCH /api/engagements/:id — lifecycle events", () => {
  it("emits engagement.address-updated when the address changes (no geocode hit)", async () => {
    mockedGeocodeAddress.mockResolvedValueOnce(null);
    const eng = await seedEngagement({ address: "100 Original St" });

    const res = await request(getApp())
      .patch(`/api/engagements/${eng.id}`)
      .send({ address: "200 New Ave" });
    expect(res.status).toBe(200);
    expect(res.body.address).toBe("200 New Ave");

    const events = await readEngagementEvents(eng.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("engagement.address-updated");
    expect(events[0]!.actor).toEqual({
      kind: "system",
      id: "engagement-edit",
    });
    expect(events[0]!.payload).toMatchObject({
      fromAddress: "100 Original St",
      toAddress: "200 New Ave",
    });
  });

  it("attributes the event to the session user when one is attached (x-requestor)", async () => {
    // The PATCH/regeocode handlers used to hard-code the system actor
    // `engagement-edit` because there was no session-bound user identity
    // wired through. Now that `sessionMiddleware` runs for every
    // request, route handlers should pull `req.session.requestor` and
    // attribute the audit event to that user — falling back to the
    // system actor only when no session user is attached. The
    // `x-requestor` dev override is the same opt-in used by the chat
    // route tests; in production this will be replaced by a verified
    // cookie/JWT, but the route handler reads from `req.session`
    // either way so the contract is identical.
    mockedGeocodeAddress.mockResolvedValueOnce(null);
    const eng = await seedEngagement({ address: "100 Original St" });

    const res = await request(getApp())
      .patch(`/api/engagements/${eng.id}`)
      .set("x-requestor", "user:teammate-42")
      .send({ address: "200 New Ave" });
    expect(res.status).toBe(200);

    const events = await readEngagementEvents(eng.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("engagement.address-updated");
    expect(events[0]!.actor).toEqual({
      kind: "user",
      id: "teammate-42",
    });
  });

  it("does NOT emit when the same address is PATCHed (no-op)", async () => {
    const eng = await seedEngagement({ address: "300 Same St" });

    const res = await request(getApp())
      .patch(`/api/engagements/${eng.id}`)
      .send({ address: "300 Same St" });
    expect(res.status).toBe(200);

    const events = await readEngagementEvents(eng.id);
    expect(events).toHaveLength(0);
    // No geocode either — same-value PATCH short-circuits before the
    // geocode call.
    expect(mockedGeocodeAddress).not.toHaveBeenCalled();
  });

  it("emits engagement.jurisdiction-resolved alongside address-updated when geocode yields a city/state", async () => {
    mockedGeocodeAddress.mockResolvedValueOnce({
      latitude: 40.0,
      longitude: -111.0,
      jurisdictionCity: "Provo",
      jurisdictionState: "UT",
      jurisdictionFips: "4962470",
      source: "nominatim",
      geocodedAt: new Date().toISOString(),
    });
    const eng = await seedEngagement({
      address: "100 Original St",
      jurisdictionCity: null,
      jurisdictionState: null,
    });

    const res = await request(getApp())
      .patch(`/api/engagements/${eng.id}`)
      .send({ address: "1 Provo Way" });
    expect(res.status).toBe(200);

    const events = await readEngagementEvents(eng.id);
    const types = events.map((e) => e.eventType);
    expect(types).toEqual([
      "engagement.address-updated",
      "engagement.jurisdiction-resolved",
    ]);

    const jurisdictionEvent = events[1]!;
    expect(jurisdictionEvent.actor).toEqual({
      kind: "system",
      id: "engagement-edit",
    });
    expect(jurisdictionEvent.payload).toMatchObject({
      // Provo is not a registered jurisdiction in the codes registry,
      // so the canonical key derives to null. The field is still
      // present in the payload (vs. the city/state pair being absent
      // entirely, which would have short-circuited the emit) so
      // downstream consumers can distinguish "resolved but uncovered"
      // from "geocoder produced no jurisdiction".
      jurisdictionKey: null,
      jurisdictionCity: "Provo",
      jurisdictionState: "UT",
      jurisdictionFips: "4962470",
      previousJurisdictionKey: null,
      previousJurisdictionCity: null,
      previousJurisdictionState: null,
    });

    // Chain hashes are populated and link the second event to the first
    // so the engagement's timeline is a real append-only chain (not two
    // independent root events).
    expect(events[0]!.prevHash).toBeNull();
    expect(events[1]!.prevHash).toBe(events[0]!.chainHash);
  });

  it("does NOT emit jurisdiction-resolved when the geocode yields the same city/state already on the row", async () => {
    mockedGeocodeAddress.mockResolvedValueOnce({
      latitude: 40.0,
      longitude: -111.0,
      jurisdictionCity: "Provo",
      jurisdictionState: "UT",
      jurisdictionFips: "4962470",
      source: "nominatim",
      geocodedAt: new Date().toISOString(),
    });
    const eng = await seedEngagement({
      address: "100 Original St",
      jurisdictionCity: "Provo",
      jurisdictionState: "UT",
    });

    const res = await request(getApp())
      .patch(`/api/engagements/${eng.id}`)
      .send({ address: "5 Provo Way" });
    expect(res.status).toBe(200);

    const events = await readEngagementEvents(eng.id);
    expect(events.map((e) => e.eventType)).toEqual([
      "engagement.address-updated",
    ]);
  });

  it("GET /api/atoms/engagement/:id/history surfaces the new events newest-first", async () => {
    mockedGeocodeAddress.mockResolvedValueOnce({
      latitude: 40.0,
      longitude: -111.0,
      jurisdictionCity: "Moab",
      jurisdictionState: "UT",
      jurisdictionFips: "4950150",
      source: "nominatim",
      geocodedAt: new Date().toISOString(),
    });
    const eng = await seedEngagement({ address: "100 Original St" });

    await request(getApp())
      .patch(`/api/engagements/${eng.id}`)
      .send({ address: "1 Moab Way" });

    const histRes = await request(getApp()).get(
      `/api/atoms/engagement/${eng.id}/history`,
    );
    expect(histRes.status).toBe(200);
    const types = (
      histRes.body.events as Array<{ eventType: string }>
    ).map((e) => e.eventType);
    // Newest-first per the route contract.
    expect(types[0]).toBe("engagement.jurisdiction-resolved");
    expect(types).toContain("engagement.address-updated");
  });
});

describe("POST /api/engagements/:id/geocode — lifecycle events", () => {
  it("emits engagement.jurisdiction-resolved when regeocode yields a new city/state", async () => {
    mockedGeocodeAddress.mockResolvedValueOnce({
      latitude: 40.7,
      longitude: -111.9,
      jurisdictionCity: "Salt Lake City",
      jurisdictionState: "UT",
      jurisdictionFips: "4967000",
      source: "nominatim",
      geocodedAt: new Date().toISOString(),
    });
    const eng = await seedEngagement({
      address: "1 Existing Ave",
      jurisdictionCity: null,
      jurisdictionState: null,
    });

    const res = await request(getApp()).post(
      `/api/engagements/${eng.id}/geocode`,
    );
    expect(res.status).toBe(200);

    const events = await readEngagementEvents(eng.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("engagement.jurisdiction-resolved");
    expect(events[0]!.actor).toEqual({
      kind: "system",
      id: "engagement-edit",
    });
    expect(events[0]!.payload).toMatchObject({
      // Salt Lake City is not a registered jurisdiction in the codes
      // registry, so the canonical key derives to null. Assert the
      // field is present so a future registration would auto-update
      // the timeline without a code change here.
      jurisdictionKey: null,
      jurisdictionCity: "Salt Lake City",
      jurisdictionState: "UT",
      jurisdictionFips: "4967000",
      previousJurisdictionKey: null,
      previousJurisdictionCity: null,
      previousJurisdictionState: null,
    });
  });

  it("attributes the regeocode jurisdiction event to the session user when one is attached (x-requestor)", async () => {
    // Mirror of the PATCH-handler attribution test against the
    // separate regeocode entry point. Keeps the user-actor flow
    // covered for both engagement-edit producers so a future refactor
    // that drops `actorFromRequest` from one route only fails loudly.
    mockedGeocodeAddress.mockResolvedValueOnce({
      latitude: 40.7,
      longitude: -111.9,
      jurisdictionCity: "Salt Lake City",
      jurisdictionState: "UT",
      jurisdictionFips: "4967000",
      source: "nominatim",
      geocodedAt: new Date().toISOString(),
    });
    const eng = await seedEngagement({
      address: "1 Existing Ave",
      jurisdictionCity: null,
      jurisdictionState: null,
    });

    const res = await request(getApp())
      .post(`/api/engagements/${eng.id}/geocode`)
      .set("x-requestor", "user:teammate-7");
    expect(res.status).toBe(200);

    const events = await readEngagementEvents(eng.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("engagement.jurisdiction-resolved");
    expect(events[0]!.actor).toEqual({
      kind: "user",
      id: "teammate-7",
    });
  });

  it("does NOT re-emit when the regeocode resolves the same city/state already on the row", async () => {
    mockedGeocodeAddress.mockResolvedValueOnce({
      latitude: 40.7,
      longitude: -111.9,
      jurisdictionCity: "Salt Lake City",
      jurisdictionState: "UT",
      jurisdictionFips: "4967000",
      source: "nominatim",
      geocodedAt: new Date().toISOString(),
    });
    const eng = await seedEngagement({
      address: "1 Existing Ave",
      jurisdictionCity: "Salt Lake City",
      jurisdictionState: "UT",
    });

    const res = await request(getApp()).post(
      `/api/engagements/${eng.id}/geocode`,
    );
    expect(res.status).toBe(200);

    const events = await readEngagementEvents(eng.id);
    expect(events).toHaveLength(0);
  });
});

describe("POST /api/engagements/:id/submissions — engagement.submitted", () => {
  it("emits engagement.submitted and surfaces it on the engagement timeline", async () => {
    const eng = await seedEngagement({
      address: "123 Submitted Way",
      jurisdictionCity: "Moab",
      jurisdictionState: "UT",
      jurisdictionFips: "4950150",
    });

    const res = await request(getApp())
      .post(`/api/engagements/${eng.id}/submissions`)
      .send({ note: "Permit set v1, all sheets cleaned." });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ engagementId: eng.id });
    expect(typeof res.body.submissionId).toBe("string");
    expect(typeof res.body.submittedAt).toBe("string");

    // Underlying atom_event row carries the canonical payload + actor.
    const events = await readEngagementEvents(eng.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("engagement.submitted");
    expect(events[0]!.actor).toEqual({
      kind: "system",
      id: "submission-ingest",
    });
    expect(events[0]!.payload).toMatchObject({
      submissionId: res.body.submissionId,
      jurisdictionCity: "Moab",
      jurisdictionState: "UT",
      note: "Permit set v1, all sheets cleaned.",
    });

    // Contract-level assertion: the same event must surface on the
    // public history endpoint, not just the underlying atom_events row.
    // This guards against the timeline route accidentally hiding
    // submission-ingest-attributed events from the engagement timeline.
    const histRes = await request(getApp()).get(
      `/api/atoms/engagement/${eng.id}/history`,
    );
    expect(histRes.status).toBe(200);
    const histTypes = (
      histRes.body.events as Array<{ eventType: string }>
    ).map((e) => e.eventType);
    expect(histTypes).toContain("engagement.submitted");
  });

  it("404s when the engagement does not exist (no event emitted)", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await request(getApp())
      .post(`/api/engagements/${fakeId}/submissions`)
      .send({});
    expect(res.status).toBe(404);

    const events = await readEngagementEvents(fakeId);
    expect(events).toHaveLength(0);
  });

  it("accepts a body with no note (note coerced to null on the event)", async () => {
    const eng = await seedEngagement({
      address: "456 Quiet Submission Lane",
      jurisdictionCity: null,
      jurisdictionState: null,
    });

    const res = await request(getApp())
      .post(`/api/engagements/${eng.id}/submissions`)
      .send({});
    expect(res.status).toBe(201);

    const events = await readEngagementEvents(eng.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      note: null,
      jurisdictionCity: null,
      jurisdictionState: null,
    });
  });
});

describe("POST /api/snapshots create-new — fireGeocodeAndWarmup emits jurisdiction-resolved", () => {
  it("emits engagement.jurisdiction-resolved on the create-new branch when geocode resolves a city/state", async () => {
    mockedGeocodeAddress.mockResolvedValueOnce({
      latitude: 38.5,
      longitude: -109.5,
      jurisdictionCity: "Moab",
      jurisdictionState: "UT",
      jurisdictionFips: "4950150",
      source: "nominatim",
      geocodedAt: new Date().toISOString(),
    });

    const res = await request(getApp())
      .post("/api/snapshots")
      .set("x-snapshot-secret", SECRET)
      .send({
        createNewEngagement: true,
        projectName: "Geocode Wired Project",
        sheets: [],
        projectInformation: { address: "1 Geocode Way" },
      });
    expect(res.status).toBe(201);

    // The warmup fires after the response is sent; poll briefly for the
    // event row instead of asserting synchronously. The emit is awaited
    // inside the IIFE so a 200ms ceiling is generous.
    const engagementId = res.body.engagementId;
    const deadline = Date.now() + 2000;
    let events: Awaited<ReturnType<typeof readEngagementEvents>> = [];
    while (Date.now() < deadline) {
      events = await readEngagementEvents(engagementId);
      if (events.some((e) => e.eventType === "engagement.jurisdiction-resolved")) {
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    const types = events.map((e) => e.eventType);
    expect(types).toContain("engagement.created");
    expect(types).toContain("engagement.jurisdiction-resolved");

    const juris = events.find(
      (e) => e.eventType === "engagement.jurisdiction-resolved",
    )!;
    expect(juris.actor).toEqual({ kind: "system", id: "snapshot-ingest" });
    expect(juris.payload).toMatchObject({
      // Moab IS registered in the codes jurisdiction registry (it is
      // the canonical Grand County, UT entry), so the payload carries
      // the real key here. This is the positive case that proves the
      // jurisdiction key derivation actually wires through and isn't
      // just always-null.
      jurisdictionKey: "grand_county_ut",
      jurisdictionCity: "Moab",
      jurisdictionState: "UT",
      jurisdictionFips: "4950150",
      previousJurisdictionKey: null,
      previousJurisdictionCity: null,
      previousJurisdictionState: null,
    });

    // Contract-level assertion: the same event must also surface on the
    // public history endpoint, not just the underlying atom_events row.
    // This guards against the route-level filter / serializer
    // accidentally hiding snapshot-ingest-attributed events from the
    // engagement timeline.
    const histRes = await request(getApp()).get(
      `/api/atoms/engagement/${engagementId}/history`,
    );
    expect(histRes.status).toBe(200);
    const histTypes = (
      histRes.body.events as Array<{ eventType: string }>
    ).map((e) => e.eventType);
    expect(histTypes).toContain("engagement.jurisdiction-resolved");
  });
});
