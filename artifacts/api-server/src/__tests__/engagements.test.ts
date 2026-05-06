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
    // Stub the embeddings-backed retrieval boundary so the auto-trigger
    // (Task #447) finding-engine path is deterministic without standing
    // up the embeddings service. Same precedent as findings-route.test.ts.
    retrieveAtomsForQuestion: vi.fn(async () => []),
  };
});

// Task #447 — auto-trigger AI plan review on submission.created. The
// auto-trigger fires the same finding-engine path the manual generate
// endpoint uses; we wrap `generateFindings` in a spy that defaults to
// the real implementation so most tests in this file are unaffected,
// and the failure-path test below can swap in a throwing impl.
const generateFindingsMock = vi.hoisted(() => vi.fn());
vi.mock("@workspace/finding-engine", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/finding-engine")>(
      "@workspace/finding-engine",
    );
  return {
    ...actual,
    generateFindings: generateFindingsMock,
  };
});

const { setupRouteTests } = await import("./setup");
const {
  engagements,
  atomEvents,
  submissions,
  parcelBriefings,
  briefingSources,
  findings,
  findingRuns,
} = await import("@workspace/db");
const { eq, and, asc, desc } = await import("drizzle-orm");
const { geocodeAddress } = await import("@workspace/site-context/server");
const registryModule = await import("../atoms/registry");
const { resetAtomRegistryForTests } = registryModule;
const findingEngineActual = await vi.importActual<
  typeof import("@workspace/finding-engine")
>("@workspace/finding-engine");

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
  // Default `generateFindings` to the real engine impl so the rest of
  // the suite is unaffected; the auto-trigger failure test below
  // overrides per-call to force a deterministic failure.
  generateFindingsMock.mockReset();
  generateFindingsMock.mockImplementation(findingEngineActual.generateFindings);
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

describe("GET /api/engagements/:id/submissions — list past submissions", () => {
  it("returns the engagement's submissions newest-first with id / submittedAt / jurisdiction / note", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const eng = await seedEngagement({
      address: "789 Past Submissions Way",
      jurisdictionCity: "Moab",
      jurisdictionState: "UT",
      jurisdictionFips: "4950150",
    });

    // Insert two submissions directly so we can pin distinct
    // submittedAt timestamps and assert on ordering — driving them
    // through the POST handler would also work but would couple this
    // test to the create route's clock and event-emit behavior, which
    // is not what we're verifying here.
    const earlier = new Date("2025-01-01T10:00:00Z");
    const later = new Date("2025-02-01T10:00:00Z");
    const [first] = await ctx.schema.db
      .insert(submissions)
      .values({
        engagementId: eng.id,
        jurisdiction: "Moab, UT",
        jurisdictionCity: "Moab",
        jurisdictionState: "UT",
        jurisdictionFips: "4950150",
        note: "First package",
        submittedAt: earlier,
      })
      .returning();
    const [second] = await ctx.schema.db
      .insert(submissions)
      .values({
        engagementId: eng.id,
        jurisdiction: "Moab, UT",
        jurisdictionCity: "Moab",
        jurisdictionState: "UT",
        jurisdictionFips: "4950150",
        note: null,
        submittedAt: later,
      })
      .returning();

    const res = await request(getApp()).get(
      `/api/engagements/${eng.id}/submissions`,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);

    // Newest-first: the later submission should be at index 0.
    // Both rows are still pending (no response recorded), so
    // status defaults to "pending" and the response fields are null.
    expect(res.body[0]).toEqual({
      id: second!.id,
      submittedAt: later.toISOString(),
      jurisdiction: "Moab, UT",
      note: null,
      discipline: null,
      status: "pending",
      reviewerComment: null,
      respondedAt: null,
      // Pending rows have never been responded to, so the
      // server-stamped recording timestamp (Task #106) stays null
      // until the response route commits an update.
      responseRecordedAt: null,
    });
    expect(res.body[1]).toEqual({
      id: first!.id,
      submittedAt: earlier.toISOString(),
      jurisdiction: "Moab, UT",
      note: "First package",
      discipline: null,
      status: "pending",
      reviewerComment: null,
      respondedAt: null,
      responseRecordedAt: null,
    });
  });

  it("surfaces the recorded jurisdiction response (status, reviewer comment, responded-at) for submissions that have been replied to", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const eng = await seedEngagement({
      address: "1 Response Way",
      jurisdictionCity: "Moab",
      jurisdictionState: "UT",
      jurisdictionFips: "4950150",
    });
    const respondedAt = new Date("2025-03-01T15:30:00Z");
    const [row] = await ctx.schema.db
      .insert(submissions)
      .values({
        engagementId: eng.id,
        jurisdiction: "Moab, UT",
        jurisdictionCity: "Moab",
        jurisdictionState: "UT",
        jurisdictionFips: "4950150",
        note: null,
        status: "corrections_requested",
        reviewerComment: "Please update the egress sheet.",
        respondedAt,
      })
      .returning();

    const res = await request(getApp()).get(
      `/api/engagements/${eng.id}/submissions`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: row!.id,
      status: "corrections_requested",
      reviewerComment: "Please update the egress sheet.",
      respondedAt: respondedAt.toISOString(),
    });
  });

  it("returns an empty array when the engagement has no submissions yet", async () => {
    const eng = await seedEngagement({ address: "1 Empty Lane" });

    const res = await request(getApp()).get(
      `/api/engagements/${eng.id}/submissions`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("404s when the engagement does not exist", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await request(getApp()).get(
      `/api/engagements/${fakeId}/submissions`,
    );
    expect(res.status).toBe(404);
  });

  it("scopes the list to the requested engagement (does not leak siblings)", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const a = await seedEngagement({ name: "Engagement A" });
    const b = await seedEngagement({ name: "Engagement B" });

    await ctx.schema.db.insert(submissions).values({
      engagementId: a.id,
      jurisdiction: null,
      note: "for A",
    });
    await ctx.schema.db.insert(submissions).values({
      engagementId: b.id,
      jurisdiction: null,
      note: "for B",
    });

    const resA = await request(getApp()).get(
      `/api/engagements/${a.id}/submissions`,
    );
    expect(resA.status).toBe(200);
    expect(resA.body).toHaveLength(1);
    expect(resA.body[0].note).toBe("for A");
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

describe("POST /api/engagements/:id/submissions — auto AI plan review", () => {
  // Auto-trigger fires after the 201 returns, so the run row
  // appears asynchronously — poll until it reaches the terminal
  // state we care about.
  async function waitForRunState(
    submissionId: string,
    expected: "completed" | "failed",
    timeoutMs = 3000,
  ): Promise<{ id: string; state: string; error: string | null }> {
    if (!ctx.schema) throw new Error("schema not ready");
    const deadline = Date.now() + timeoutMs;
    let last: { id: string; state: string; error: string | null } | null = null;
    while (Date.now() < deadline) {
      const [row] = await ctx.schema.db
        .select({
          id: findingRuns.id,
          state: findingRuns.state,
          error: findingRuns.error,
        })
        .from(findingRuns)
        .where(eq(findingRuns.submissionId, submissionId))
        .orderBy(desc(findingRuns.startedAt))
        .limit(1);
      if (row) {
        last = row;
        if (row.state === expected) return row;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(
      `finding_runs row for submission ${submissionId} did not reach ${expected} within ${timeoutMs}ms; last=${JSON.stringify(last)}`,
    );
  }

  async function seedBriefing(engagementId: string) {
    if (!ctx.schema) throw new Error("schema not ready");
    const [briefing] = await ctx.schema.db
      .insert(parcelBriefings)
      .values({ engagementId })
      .returning();
    await ctx.schema.db.insert(briefingSources).values({
      briefingId: briefing!.id,
      layerKind: "qgis-zoning",
      sourceKind: "manual-upload",
      provider: "Bastrop UDC",
      note: "auto-trigger test seed",
      uploadObjectPath: "/objects/zoning",
      uploadOriginalFilename: "zoning.geojson",
      uploadContentType: "application/geo+json",
      uploadByteSize: 1024,
      snapshotDate: new Date("2026-01-01T00:00:00Z"),
    });
  }

  it("auto-fires the shared finding-engine path after submission insert", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const eng = await seedEngagement({
      address: "1 Auto-Trigger Way",
      jurisdictionCity: "Bastrop",
      jurisdictionState: "TX",
    });
    await seedBriefing(eng.id);

    const res = await request(getApp())
      .post(`/api/engagements/${eng.id}/submissions`)
      .send({ note: "auto-trigger smoke" });
    expect(res.status).toBe(201);
    const submissionId = res.body.submissionId as string;

    const run = await waitForRunState(submissionId, "completed");
    expect(run.error).toBeNull();

    const rows = await ctx.schema.db
      .select()
      .from(findings)
      .where(eq(findings.submissionId, submissionId));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.findingRunId).toBe(run.id);
      expect(r.status).toBe("ai-produced");
    }
    expect(generateFindingsMock).toHaveBeenCalled();
  });

  it("swallows engine failures, returns 201, and logs structured { submissionId, error }", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const { logger } = await import("../lib/logger");
    const errSpy = vi.spyOn(logger, "error");

    const eng = await seedEngagement({
      address: "2 Failure Path Ave",
      jurisdictionCity: "Bastrop",
      jurisdictionState: "TX",
    });
    await seedBriefing(eng.id);

    generateFindingsMock.mockImplementationOnce(async () => {
      throw new Error("forced engine failure for auto-trigger test");
    });

    const res = await request(getApp())
      .post(`/api/engagements/${eng.id}/submissions`)
      .send({});
    expect(res.status).toBe(201);
    const submissionId = res.body.submissionId as string;

    const run = await waitForRunState(submissionId, "failed");
    expect(run.error).not.toBeNull();

    const rows = await ctx.schema.db
      .select()
      .from(findings)
      .where(eq(findings.submissionId, submissionId));
    expect(rows).toHaveLength(0);

    // Required structured-fields contract: at least one error log
    // carries both `submissionId` and `error` so observability can
    // diagnose auto-trigger AI failures without scraping free text.
    const matched = errSpy.mock.calls.some(
      ([fields]) =>
        typeof fields === "object" &&
        fields !== null &&
        (fields as Record<string, unknown>)["submissionId"] === submissionId &&
        typeof (fields as Record<string, unknown>)["error"] === "string",
    );
    expect(matched).toBe(true);
    errSpy.mockRestore();
  });
});
