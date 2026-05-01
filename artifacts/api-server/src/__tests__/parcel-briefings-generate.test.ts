/**
 * POST /api/engagements/:id/briefing/generate +
 * GET /api/engagements/:id/briefing/status — DA-PI-3 briefing engine
 * kickoff + status polling.
 *
 * Covers:
 *   - first-generation happy path (mock mode):
 *     * 202 + generationId on POST,
 *     * status flips pending → completed,
 *     * row's `section_a..g` + `generated_at` populated,
 *     * GET /briefing surfaces the narrative on the wire,
 *     * `parcel-briefing.generated` event anchored.
 *   - regeneration: previously-generated row gets backed up into
 *     `prior_section_*` columns and a `parcel-briefing.regenerated`
 *     event fires.
 *   - 400 when the engagement has no briefing row (no sources).
 *   - 404 when the engagement does not exist.
 *
 * The engine itself is mock-mode by default
 * (`BRIEFING_LLM_MODE=mock`), so no Anthropic mocking is required —
 * the deterministic `mockGenerator` writes the seven sections.
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
      if (!ctx.schema)
        throw new Error("parcel-briefings-generate.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const {
  engagements,
  parcelBriefings,
  briefingSources,
  briefingGenerationJobs,
  atomEvents,
} = await import("@workspace/db");
const { eq, and, desc } = await import("drizzle-orm");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

async function seedEngagement(name = "Briefing Generate Engagement") {
  if (!ctx.schema) throw new Error("schema not ready");
  const [eng] = await ctx.schema.db
    .insert(engagements)
    .values({
      name,
      nameLower: name.trim().toLowerCase(),
      jurisdiction: "Boulder, CO",
      address: "1 Pearl St",
      status: "active",
    })
    .returning();
  return eng;
}

/**
 * Seed a briefing row + one current source so the engine has
 * something to cite. The route's `loadCurrentSources` reads
 * `briefing_sources` directly, so we don't need to hit the upload
 * route — we go straight at the DB.
 */
async function seedBriefingWithSource(engagementId: string) {
  if (!ctx.schema) throw new Error("schema not ready");
  const [briefing] = await ctx.schema.db
    .insert(parcelBriefings)
    .values({ engagementId })
    .returning();
  const [source] = await ctx.schema.db
    .insert(briefingSources)
    .values({
      briefingId: briefing.id,
      layerKind: "qgis-zoning",
      sourceKind: "manual-upload",
      provider: "City of Boulder QGIS",
      note: "test seed",
      uploadObjectPath: "/objects/zoning",
      uploadOriginalFilename: "zoning.geojson",
      uploadContentType: "application/geo+json",
      uploadByteSize: 1024,
      snapshotDate: new Date("2026-01-01T00:00:00Z"),
    })
    .returning();
  return { briefing, source };
}

/**
 * Poll the status endpoint until it leaves `pending`. Mock-mode
 * generation completes synchronously inside the route's
 * fire-and-forget call, so a handful of 50ms intervals is plenty.
 */
async function waitForStatus(
  engagementId: string,
  expected: "completed" | "failed",
  timeoutMs = 2000,
): Promise<{ state: string; body: Record<string, unknown> }> {
  const deadline = Date.now() + timeoutMs;
  let last: { state: string; body: Record<string, unknown> } = {
    state: "pending",
    body: {},
  };
  while (Date.now() < deadline) {
    const res = await request(getApp()).get(
      `/api/engagements/${engagementId}/briefing/status`,
    );
    last = { state: res.body.state, body: res.body };
    if (res.body.state === expected) return last;
    if (res.body.state === "failed" && expected === "completed") {
      throw new Error(
        `briefing generation failed: ${JSON.stringify(res.body)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `briefing status did not reach ${expected} within ${timeoutMs}ms; last=${JSON.stringify(last)}`,
  );
}

describe("POST /api/engagements/:id/briefing/generate (mock mode)", () => {
  it("404s when the engagement does not exist", async () => {
    const res = await request(getApp())
      .post(
        `/api/engagements/00000000-0000-0000-0000-000000000000/briefing/generate`,
      )
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("engagement_not_found");
  });

  it("400s when the engagement has no briefing/sources to cite", async () => {
    const eng = await seedEngagement();
    const res = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/generate`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_briefing_sources_for_engagement");
  });

  it("kicks off, completes, populates section_a..g and emits generated event", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const eng = await seedEngagement();
    const { briefing } = await seedBriefingWithSource(eng.id);

    const kickoff = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/generate`)
      .send({});
    expect(kickoff.status).toBe(202);
    expect(kickoff.body).toMatchObject({ state: "pending" });
    expect(typeof kickoff.body.generationId).toBe("string");
    const generationId = kickoff.body.generationId as string;

    const completed = await waitForStatus(eng.id, "completed");
    expect(completed.body.generationId).toBe(generationId);
    expect(completed.body.invalidCitationCount).toBe(0);
    expect(completed.body.invalidCitations).toEqual([]);
    expect(completed.body.error).toBeNull();

    const rows = await ctx.schema.db
      .select()
      .from(parcelBriefings)
      .where(eq(parcelBriefings.id, briefing.id));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.sectionA).toBeTruthy();
    expect(row.sectionB).toBeTruthy();
    expect(row.sectionC).toBeTruthy();
    expect(row.sectionD).toBeTruthy();
    expect(row.sectionE).toBeTruthy();
    expect(row.sectionF).toBeTruthy();
    expect(row.sectionG).toBeTruthy();
    expect(row.generatedAt).toBeTruthy();
    expect(row.generatedBy).toBe("system:briefing-engine");
    // Task #281 — `persistGenerationResult` stamps the producing
    // job's id onto `parcel_briefings.generation_id` inside the
    // same transaction that overwrites the section columns. The
    // kickoff route returned that id as `kickoff.body.generationId`,
    // so the persisted row must carry the same value. The UI
    // matches "the narrative on screen" to "the row that
    // produced it" by direct id equality against this column,
    // so any drift here would silently mislabel the "Current"
    // pill in `BriefingRecentRunsPanel`.
    expect(row.generationId).toBe(generationId);
    // First-generation invariant: prior_* columns stay null until the
    // engine runs again.
    expect(row.priorSectionA).toBeNull();
    expect(row.priorGeneratedAt).toBeNull();

    const events = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(
        and(
          eq(atomEvents.entityType, "parcel-briefing"),
          eq(atomEvents.entityId, eng.id),
        ),
      );
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.eventType).toBe("parcel-briefing.generated");
    expect(events[0]!.payload).toMatchObject({
      briefingId: briefing.id,
      engagementId: eng.id,
      wasRegeneration: false,
    });

    // Wire shape: GET /briefing now surfaces the narrative envelope.
    const briefingRead = await request(getApp()).get(
      `/api/engagements/${eng.id}/briefing`,
    );
    expect(briefingRead.status).toBe(200);
    expect(briefingRead.body.briefing.narrative).toBeTruthy();
    expect(briefingRead.body.briefing.narrative.sectionA).toBe(row.sectionA);
    expect(briefingRead.body.briefing.narrative.generatedAt).toBeTruthy();
  });

  it("emits one materializable-element.identified event per requirement extracted from sections C/D/F", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const eng = await seedEngagement(
      "Materializable Element Generation Engagement",
    );
    // Seed three sources whose `layerKind` slugs are categorized into
    // sections C, D, and F respectively. The mock generator emits one
    // sentence per source in each of those sections (plus the gap-note
    // sentence for sections without a source — but here all three
    // target sections have one), so the engine extracts exactly three
    // materializable elements and the route emits exactly three
    // `materializable-element.identified` events.
    const [briefing] = await ctx.schema.db
      .insert(parcelBriefings)
      .values({ engagementId: eng.id })
      .returning();
    const sourceSeeds: Array<{
      layerKind: string;
      provider: string;
    }> = [
      { layerKind: "qgis-zoning", provider: "City of Boulder QGIS" }, // → c
      { layerKind: "city-water", provider: "City of Boulder Utilities" }, // → d
      { layerKind: "neighbor-massing", provider: "City of Boulder GIS" }, // → f
    ];
    for (const seed of sourceSeeds) {
      await ctx.schema.db.insert(briefingSources).values({
        briefingId: briefing.id,
        layerKind: seed.layerKind,
        sourceKind: "manual-upload",
        provider: seed.provider,
        note: "test seed",
        uploadObjectPath: `/objects/${seed.layerKind}`,
        uploadOriginalFilename: `${seed.layerKind}.geojson`,
        uploadContentType: "application/geo+json",
        uploadByteSize: 1024,
        snapshotDate: new Date("2026-01-01T00:00:00Z"),
      });
    }

    const kickoff = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/generate`)
      .send({});
    expect(kickoff.status).toBe(202);
    await waitForStatus(eng.id, "completed");

    // Pull every materializable-element.identified event for this
    // briefing. The atom's entityId is content-addressed within the
    // briefing — `materializable-element:{briefingId}:{section}:{index}`
    // — so we filter by entityType and then by the briefingId payload
    // field rather than by entityId equality.
    const allMatEvents = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(eq(atomEvents.entityType, "materializable-element"));
    const events = allMatEvents.filter(
      (e) =>
        (e.payload as { briefingId?: string } | null)?.briefingId ===
        briefing.id,
    );
    // Mock generator emits exactly one sentence per source in sections
    // C/D/F when each section has one source attached; the three-source
    // seed above wires one element per section.
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event.eventType).toBe("materializable-element.identified");
      const payload = event.payload as {
        briefingId: string;
        engagementId: string;
        section: string;
        index: number;
        text: string;
      };
      expect(payload.briefingId).toBe(briefing.id);
      expect(payload.engagementId).toBe(eng.id);
      expect(["c", "d", "f"]).toContain(payload.section);
      expect(payload.index).toBe(0);
      expect(payload.text.length).toBeGreaterThan(0);
      expect(event.entityId).toBe(
        `materializable-element:${briefing.id}:${payload.section}:${payload.index}`,
      );
    }
    // Each section appears exactly once across the three events.
    const sections = events
      .map((e) => (e.payload as { section: string }).section)
      .sort();
    expect(sections).toEqual(["c", "d", "f"]);
  });

  it("409s when a generation is already in flight for the engagement", async () => {
    const eng = await seedEngagement();
    await seedBriefingWithSource(eng.id);

    // Kick off twice in rapid succession. The first call seeds the
    // job map with state=pending before the engine call resolves
    // (mock generator is synchronous inside the fire-and-forget
    // microtask, but the second supertest request fires before that
    // microtask drains, so the second hit sees `pending`).
    const [first, second] = await Promise.all([
      request(getApp())
        .post(`/api/engagements/${eng.id}/briefing/generate`)
        .send({}),
      request(getApp())
        .post(`/api/engagements/${eng.id}/briefing/generate`)
        .send({}),
    ]);
    // Exactly one of the two requests should land 202; the other
    // should land 409. We don't assert ordering — supertest can
    // serialize the two requests in either order.
    const codes = [first.status, second.status].sort();
    expect(codes).toEqual([202, 409]);

    await waitForStatus(eng.id, "completed");
  });

  it("regeneration backs up sections into prior_* columns and emits regenerated event", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const eng = await seedEngagement();
    const { briefing } = await seedBriefingWithSource(eng.id);

    // First generation.
    await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/generate`)
      .send({});
    await waitForStatus(eng.id, "completed");
    const [afterFirst] = await ctx.schema.db
      .select()
      .from(parcelBriefings)
      .where(eq(parcelBriefings.id, briefing.id));
    expect(afterFirst.sectionA).toBeTruthy();
    const firstSectionA = afterFirst.sectionA;
    const firstGeneratedAt = afterFirst.generatedAt;

    // The first run's job row is now `completed`, so the partial
    // unique index on `(engagement_id) WHERE state = 'pending'`
    // permits a second `pending` insert without any reset hook —
    // the route's single-flight guard only fires on a still-pending
    // row.
    //
    // Second generation — explicit regenerate flag (informational
    // today; the route auto-detects).
    const second = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/generate`)
      .send({ regenerate: true });
    expect(second.status).toBe(202);
    const secondGenerationId = second.body.generationId as string;
    await waitForStatus(eng.id, "completed");
    const [afterSecond] = await ctx.schema.db
      .select()
      .from(parcelBriefings)
      .where(eq(parcelBriefings.id, briefing.id));
    // Task #281 — regeneration overwrites `generation_id` with the
    // *second* run's id, so the briefing always points at its
    // current producer (not the first run that wrote whatever now
    // lives in `prior_section_*`). This is the invariant the UI
    // relies on to flip the "Current" pill from one row to the
    // next when a regeneration completes.
    expect(afterSecond.generationId).toBe(secondGenerationId);
    expect(afterSecond.generationId).not.toBe(afterFirst.generationId);
    // Prior backup populated.
    expect(afterSecond.priorSectionA).toBe(firstSectionA);
    expect(afterSecond.priorGeneratedAt?.toISOString()).toBe(
      firstGeneratedAt!.toISOString(),
    );
    expect(afterSecond.priorGeneratedBy).toBe("system:briefing-engine");
    // Current narrative is freshly stamped — generatedAt strictly
    // greater than the first run's stamp.
    expect(afterSecond.generatedAt!.getTime()).toBeGreaterThanOrEqual(
      firstGeneratedAt!.getTime(),
    );

    // Two events total (generated + regenerated). The regenerated
    // event is the most recent.
    const events = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(
        and(
          eq(atomEvents.entityType, "parcel-briefing"),
          eq(atomEvents.entityId, eng.id),
        ),
      );
    const types = events.map((e) => e.eventType);
    expect(types).toContain("parcel-briefing.generated");
    expect(types).toContain("parcel-briefing.regenerated");
  });
});

describe("GET /api/engagements/:id/briefing/status idle path", () => {
  it("returns idle when no generation has ever been kicked off for this engagement", async () => {
    const eng = await seedEngagement();
    const res = await request(getApp()).get(
      `/api/engagements/${eng.id}/briefing/status`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      generationId: null,
      state: "idle",
      startedAt: null,
      completedAt: null,
      error: null,
      invalidCitationCount: null,
      invalidCitations: null,
    });
  });

  it("404s when the engagement does not exist", async () => {
    const res = await request(getApp()).get(
      `/api/engagements/00000000-0000-0000-0000-000000000000/briefing/status`,
    );
    expect(res.status).toBe(404);
  });
});

describe("briefing_generation_jobs persistence (DA-PI-3 durability)", () => {
  it("status endpoint reflects a row inserted directly into the DB (survives restart)", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const eng = await seedEngagement();

    // Simulate "another api-server instance ran the kickoff and then
    // this process restarted" by inserting a terminal job row
    // directly into the DB without ever calling the route. If the
    // status endpoint were still backed by an in-process Map, this
    // row would be invisible to the GET below — that was the bug
    // the briefing_generation_jobs table fixes.
    const completedAt = new Date("2026-04-01T12:00:00Z");
    const startedAt = new Date("2026-04-01T11:59:30Z");
    const [persisted] = await ctx.schema.db
      .insert(briefingGenerationJobs)
      .values({
        engagementId: eng.id,
        state: "completed",
        startedAt,
        completedAt,
        error: null,
        invalidCitationCount: 0,
      })
      .returning();

    const res = await request(getApp()).get(
      `/api/engagements/${eng.id}/briefing/status`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      generationId: persisted.id,
      state: "completed",
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      error: null,
      invalidCitationCount: 0,
    });
  });

  it("status endpoint returns the most recent job when multiple exist", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const eng = await seedEngagement();

    // Older completed run.
    await ctx.schema.db.insert(briefingGenerationJobs).values({
      engagementId: eng.id,
      state: "completed",
      startedAt: new Date("2026-04-01T10:00:00Z"),
      completedAt: new Date("2026-04-01T10:00:30Z"),
      invalidCitationCount: 0,
    });
    // Newer failed run — this is what the status endpoint should
    // surface, because the UI polls "what happened most recently?"
    const [recent] = await ctx.schema.db
      .insert(briefingGenerationJobs)
      .values({
        engagementId: eng.id,
        state: "failed",
        startedAt: new Date("2026-04-01T11:00:00Z"),
        completedAt: new Date("2026-04-01T11:00:05Z"),
        error: "engine timeout",
        invalidCitationCount: null,
      })
      .returning();

    const res = await request(getApp()).get(
      `/api/engagements/${eng.id}/briefing/status`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      generationId: recent.id,
      state: "failed",
      error: "engine timeout",
    });
  });

  it("kickoff persists the new pending job row to the DB", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const eng = await seedEngagement();
    await seedBriefingWithSource(eng.id);

    const kickoff = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/generate`)
      .send({});
    expect(kickoff.status).toBe(202);
    const generationId = kickoff.body.generationId as string;

    // Wait for completion so the assertion below is deterministic
    // (the row will have transitioned to `completed` by then).
    await waitForStatus(eng.id, "completed");

    const rows = await ctx.schema.db
      .select()
      .from(briefingGenerationJobs)
      .where(eq(briefingGenerationJobs.engagementId, eng.id))
      .orderBy(desc(briefingGenerationJobs.startedAt));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(generationId);
    expect(rows[0]!.state).toBe("completed");
    expect(rows[0]!.completedAt).toBeTruthy();
    expect(rows[0]!.invalidCitationCount).toBe(0);
  });
});

/**
 * GET /api/engagements/:id/briefing/runs — Task #230. The status
 * endpoint deliberately collapses to one row; this endpoint is the
 * comparison-window auditors actually need to see prior attempts
 * without SSHing into the database.
 *
 * Pinned behaviors:
 *   - 404 when the engagement does not exist (mirrors /status).
 *   - empty `runs: []` when no kickoff has ever happened.
 *   - rows are returned newest-first.
 *   - the response is capped at the sweep's keep-per-engagement
 *     value so the API surface and the prune contract cannot drift.
 *   - the field shape matches what the UI's "Recent runs" disclosure
 *     reads (id, state, timestamps, error, invalidCitationCount).
 */
describe("GET /api/engagements/:id/briefing/runs", () => {
  it("404s when the engagement does not exist", async () => {
    const res = await request(getApp()).get(
      `/api/engagements/00000000-0000-0000-0000-000000000000/briefing/runs`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("engagement_not_found");
  });

  it("returns an empty runs list when no generation has ever been kicked off", async () => {
    const eng = await seedEngagement();
    const res = await request(getApp()).get(
      `/api/engagements/${eng.id}/briefing/runs`,
    );
    expect(res.status).toBe(200);
    // Task #280 — the envelope also carries `priorNarrative` so the
    // FE disclosure can render the prior body inline. With no
    // briefing row at all, `priorNarrative` resolves to `null`
    // (there is nothing to back up from), keeping the FE's "Prior"
    // pill suppressed.
    expect(res.body).toEqual({ runs: [], priorNarrative: null });
  });

  it("returns recent runs newest-first with the auditor-facing field shape", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const eng = await seedEngagement();

    // Three terminal rows, deliberately seeded out-of-order so the
    // assertion proves the route's `ORDER BY started_at DESC` and
    // not the insertion order is what drives the wire shape.
    const oldStart = new Date("2026-04-01T10:00:00Z");
    const oldComplete = new Date("2026-04-01T10:00:30Z");
    const midStart = new Date("2026-04-01T11:00:00Z");
    const midComplete = new Date("2026-04-01T11:00:05Z");
    const newStart = new Date("2026-04-01T12:00:00Z");
    const newComplete = new Date("2026-04-01T12:00:45Z");
    await ctx.schema.db.insert(briefingGenerationJobs).values({
      engagementId: eng.id,
      state: "completed",
      startedAt: midStart,
      completedAt: midComplete,
      error: null,
      invalidCitationCount: 2,
      invalidCitations: ["sourceA", "sourceB"],
    });
    await ctx.schema.db.insert(briefingGenerationJobs).values({
      engagementId: eng.id,
      state: "completed",
      startedAt: oldStart,
      completedAt: oldComplete,
      error: null,
      invalidCitationCount: 0,
      invalidCitations: [],
    });
    await ctx.schema.db.insert(briefingGenerationJobs).values({
      engagementId: eng.id,
      state: "failed",
      startedAt: newStart,
      completedAt: newComplete,
      error: "engine timeout",
      invalidCitationCount: null,
    });

    const res = await request(getApp()).get(
      `/api/engagements/${eng.id}/briefing/runs`,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.runs)).toBe(true);
    expect(res.body.runs).toHaveLength(3);
    // Newest-first ordering — failed run leads, then mid completed,
    // then oldest completed at the bottom.
    expect(res.body.runs[0]).toMatchObject({
      state: "failed",
      startedAt: newStart.toISOString(),
      completedAt: newComplete.toISOString(),
      error: "engine timeout",
      invalidCitationCount: null,
    });
    expect(typeof res.body.runs[0].generationId).toBe("string");
    expect(res.body.runs[1]).toMatchObject({
      state: "completed",
      startedAt: midStart.toISOString(),
      completedAt: midComplete.toISOString(),
      error: null,
      invalidCitationCount: 2,
    });
    expect(res.body.runs[2]).toMatchObject({
      state: "completed",
      startedAt: oldStart.toISOString(),
      completedAt: oldComplete.toISOString(),
      error: null,
      invalidCitationCount: 0,
    });
    // Wire shape stays narrow — the runs payload deliberately does
    // NOT include the full `invalidCitations` array (that's a
    // /status concern for the in-flight banner; the recent-runs
    // disclosure renders a per-row count and lets the user click
    // through for detail).
    expect(res.body.runs[0]).not.toHaveProperty("invalidCitations");
  });

  it("caps the response at the sweep's keep-per-engagement value", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const eng = await seedEngagement();

    // Seed eight rows — well above the env-overridden keep cap of 3
    // we set for this test below — so we can prove the slice is
    // exactly `keepPerEngagement`, not a static 5/10/etc.
    const KEEP = 3;
    const prev = process.env["BRIEFING_GENERATION_JOB_KEEP_PER_ENGAGEMENT"];
    process.env["BRIEFING_GENERATION_JOB_KEEP_PER_ENGAGEMENT"] = String(KEEP);
    try {
      for (let i = 0; i < 8; i++) {
        await ctx.schema.db.insert(briefingGenerationJobs).values({
          engagementId: eng.id,
          state: "completed",
          // Distinct startedAt per row so the LIMIT slice is
          // deterministic and `desc(startedAt)` picks the i=7..5
          // window.
          startedAt: new Date(`2026-04-01T${10 + i}:00:00Z`),
          completedAt: new Date(`2026-04-01T${10 + i}:00:30Z`),
          invalidCitationCount: 0,
        });
      }
      const res = await request(getApp()).get(
        `/api/engagements/${eng.id}/briefing/runs`,
      );
      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(KEEP);
      // Top of the slice is the most recent (i=7 → 17:00:00Z).
      expect(res.body.runs[0].startedAt).toBe("2026-04-01T17:00:00.000Z");
      // Bottom of the KEEP=3 slice is i=5 → 15:00:00Z.
      expect(res.body.runs[KEEP - 1].startedAt).toBe(
        "2026-04-01T15:00:00.000Z",
      );
    } finally {
      if (prev === undefined)
        delete process.env["BRIEFING_GENERATION_JOB_KEEP_PER_ENGAGEMENT"];
      else process.env["BRIEFING_GENERATION_JOB_KEEP_PER_ENGAGEMENT"] = prev;
    }
  });

  it("surfaces the briefing's prior_section_* backup as priorNarrative after a regeneration (Task #280)", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const eng = await seedEngagement();
    await seedBriefingWithSource(eng.id);

    // First generation populates section_* + generated_at; the
    // regenerate flips that into prior_section_* + prior_generated_at
    // so the runs envelope can carry it back to the FE for the
    // "Prior" disclosure block.
    await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/generate`)
      .send({});
    await waitForStatus(eng.id, "completed");
    await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/generate`)
      .send({ regenerate: true });
    await waitForStatus(eng.id, "completed");

    const res = await request(getApp()).get(
      `/api/engagements/${eng.id}/briefing/runs`,
    );
    expect(res.status).toBe(200);
    expect(res.body.priorNarrative).toBeTruthy();
    expect(typeof res.body.priorNarrative.sectionA).toBe("string");
    expect(res.body.priorNarrative.sectionA.length).toBeGreaterThan(0);
    expect(typeof res.body.priorNarrative.generatedAt).toBe("string");
    expect(res.body.priorNarrative.generatedBy).toBe(
      "system:briefing-engine",
    );
  });

  it("returns priorNarrative=null when the briefing exists but has never been regenerated (Task #280)", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const eng = await seedEngagement();
    await seedBriefingWithSource(eng.id);
    await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/generate`)
      .send({});
    await waitForStatus(eng.id, "completed");

    const res = await request(getApp()).get(
      `/api/engagements/${eng.id}/briefing/runs`,
    );
    expect(res.status).toBe(200);
    // First-generation-only state — prior_generated_at is still
    // null on the briefing row, so the wire field collapses to
    // null and the FE never lights up the Prior pill.
    expect(res.body.priorNarrative).toBeNull();
  });

  it("scopes results to the requested engagement", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const a = await seedEngagement("Engagement A");
    const b = await seedEngagement("Engagement B");
    await ctx.schema.db.insert(briefingGenerationJobs).values({
      engagementId: a.id,
      state: "completed",
      startedAt: new Date("2026-04-01T10:00:00Z"),
      completedAt: new Date("2026-04-01T10:00:30Z"),
      invalidCitationCount: 0,
    });
    await ctx.schema.db.insert(briefingGenerationJobs).values({
      engagementId: b.id,
      state: "completed",
      startedAt: new Date("2026-04-01T11:00:00Z"),
      completedAt: new Date("2026-04-01T11:00:30Z"),
      invalidCitationCount: 0,
    });

    const res = await request(getApp()).get(
      `/api/engagements/${a.id}/briefing/runs`,
    );
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].startedAt).toBe("2026-04-01T10:00:00.000Z");
  });
});
