/**
 * GET /api/engagements/:id/briefing and
 * POST /api/engagements/:id/briefing/sources — DA-PI-1B manual-QGIS
 * upload path.
 *
 * Covers the contract the route owns:
 *   - GET on a fresh engagement returns `{ briefing: null }` (no row
 *     created on read).
 *   - First POST creates the briefing row + the source row, emits
 *     `briefing-source.fetched` against the source.
 *   - Second POST with the same `layerKind` supersedes the prior
 *     source: the prior row's `superseded_by_id` points at the new
 *     row's id, the GET response only lists the new row.
 *   - Different `layerKind` values coexist (no false supersession).
 *   - 404 when the engagement does not exist.
 *   - 400 on invalid body shape.
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
        throw new Error("parcel-briefings.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const {
  engagements,
  parcelBriefings,
  briefingSources,
  atomEvents,
} = await import("@workspace/db");
const { eq, and, isNull } = await import("drizzle-orm");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

async function seedEngagement(name = "Briefing Engagement") {
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

function uploadFor(name: string, byteSize = 1234) {
  return {
    objectPath: `/objects/${name.replace(/[^a-z0-9]/gi, "-")}-${byteSize}`,
    originalFilename: name,
    contentType: "application/geo+json",
    byteSize,
  };
}

describe("GET /api/engagements/:id/briefing", () => {
  it("returns { briefing: null } before any upload", async () => {
    const eng = await seedEngagement();
    const res = await request(getApp()).get(
      `/api/engagements/${eng.id}/briefing`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ briefing: null });
  });

  it("404s when the engagement does not exist", async () => {
    const res = await request(getApp()).get(
      `/api/engagements/00000000-0000-0000-0000-000000000000/briefing`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("engagement_not_found");
  });
});

describe("POST /api/engagements/:id/briefing/sources", () => {
  it("first upload creates briefing + source and emits briefing-source.fetched", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const eng = await seedEngagement();

    const res = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({
        layerKind: "qgis-zoning",
        provider: "City of Boulder QGIS",
        note: "  initial export  ",
        upload: uploadFor("zoning.geojson", 4096),
      });

    expect(res.status).toBe(201);
    expect(res.body.briefing).toBeTruthy();
    expect(res.body.briefing.engagementId).toBe(eng.id);
    expect(res.body.briefing.sources).toHaveLength(1);
    expect(res.body.briefing.sources[0]).toMatchObject({
      layerKind: "qgis-zoning",
      sourceKind: "manual-upload",
      provider: "City of Boulder QGIS",
      // Whitespace-only / trimmed notes are preserved as their trimmed
      // form (and only nulled when the trim is empty — separately
      // covered).
      note: "initial export",
      uploadOriginalFilename: "zoning.geojson",
      uploadByteSize: 4096,
    });

    // Briefing row exists exactly once for this engagement.
    const briefings = await ctx.schema.db
      .select()
      .from(parcelBriefings)
      .where(eq(parcelBriefings.engagementId, eng.id));
    expect(briefings).toHaveLength(1);
    const briefing = briefings[0]!;

    // One source row, not superseded, attributed to the briefing.
    const sourceRows = await ctx.schema.db
      .select()
      .from(briefingSources)
      .where(eq(briefingSources.briefingId, briefing.id));
    expect(sourceRows).toHaveLength(1);
    expect(sourceRows[0]!.supersededById).toBeNull();
    expect(sourceRows[0]!.supersededAt).toBeNull();
    expect(sourceRows[0]!.layerKind).toBe("qgis-zoning");
    expect(sourceRows[0]!.sourceKind).toBe("manual-upload");

    // Best-effort event was anchored against the new source.
    const evRows = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(
        and(
          eq(atomEvents.entityType, "briefing-source"),
          eq(atomEvents.entityId, sourceRows[0]!.id),
        ),
      );
    expect(evRows).toHaveLength(1);
    expect(evRows[0]!.eventType).toBe("briefing-source.fetched");
    expect(evRows[0]!.actor).toEqual({
      kind: "system",
      id: "briefing-manual-upload",
    });
    expect(evRows[0]!.payload).toMatchObject({
      briefingId: briefing.id,
      engagementId: eng.id,
      layerKind: "qgis-zoning",
      sourceKind: "manual-upload",
      // First upload of this layer ⇒ no prior to supersede.
      supersededSourceId: null,
    });
  });

  it("coerces whitespace-only note to null", async () => {
    const eng = await seedEngagement();
    const res = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({
        layerKind: "qgis-parcel",
        note: "   \t  ",
        upload: uploadFor("parcel.geojson"),
      });
    expect(res.status).toBe(201);
    expect(res.body.briefing.sources[0].note).toBeNull();
  });

  it("second upload of the same layerKind supersedes the prior source", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const eng = await seedEngagement();

    const first = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({
        layerKind: "qgis-zoning",
        upload: uploadFor("zoning-v1.geojson", 1000),
      });
    expect(first.status).toBe(201);
    const firstSourceId = first.body.briefing.sources[0].id;

    const second = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({
        layerKind: "qgis-zoning",
        upload: uploadFor("zoning-v2.geojson", 2000),
      });
    expect(second.status).toBe(201);
    expect(second.body.briefing.sources).toHaveLength(1);
    const secondSourceId = second.body.briefing.sources[0].id;
    expect(secondSourceId).not.toBe(firstSourceId);
    expect(second.body.briefing.sources[0].uploadByteSize).toBe(2000);

    // Prior row still exists, now stamped as superseded.
    const allRows = await ctx.schema.db
      .select()
      .from(briefingSources)
      .where(eq(briefingSources.briefingId, second.body.briefing.id));
    expect(allRows).toHaveLength(2);
    const prior = allRows.find((r) => r.id === firstSourceId)!;
    expect(prior.supersededById).toBe(secondSourceId);
    expect(prior.supersededAt).toBeInstanceOf(Date);

    // Current view (the partial-unique slot, gated on supersededAt
    // IS NULL) holds exactly the new row.
    const current = await ctx.schema.db
      .select()
      .from(briefingSources)
      .where(
        and(
          eq(briefingSources.briefingId, second.body.briefing.id),
          isNull(briefingSources.supersededAt),
        ),
      );
    expect(current).toHaveLength(1);
    expect(current[0]!.id).toBe(secondSourceId);

    // The supersession id is reflected on the new event's payload so a
    // consumer can reconstruct the prior→new pointer from the event log
    // alone (no row peek required).
    const newEv = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(
        and(
          eq(atomEvents.entityType, "briefing-source"),
          eq(atomEvents.entityId, secondSourceId),
        ),
      );
    expect(newEv).toHaveLength(1);
    expect(newEv[0]!.payload).toMatchObject({
      supersededSourceId: firstSourceId,
    });
  });

  it("different layerKind values coexist (no false supersession)", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const eng = await seedEngagement();

    const a = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({
        layerKind: "qgis-zoning",
        upload: uploadFor("zoning.geojson"),
      });
    expect(a.status).toBe(201);

    const b = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({
        layerKind: "qgis-parcel",
        upload: uploadFor("parcel.geojson"),
      });
    expect(b.status).toBe(201);

    expect(b.body.briefing.id).toBe(a.body.briefing.id);
    expect(b.body.briefing.sources.map((s: { layerKind: string }) => s.layerKind).sort()).toEqual([
      "qgis-parcel",
      "qgis-zoning",
    ]);

    const allRows = await ctx.schema.db
      .select()
      .from(briefingSources)
      .where(eq(briefingSources.briefingId, a.body.briefing.id));
    expect(allRows.every((r) => r.supersededAt === null)).toBe(true);
    expect(allRows.every((r) => r.supersededById === null)).toBe(true);
  });

  it("404 when engagement does not exist", async () => {
    const res = await request(getApp())
      .post(
        `/api/engagements/00000000-0000-0000-0000-000000000000/briefing/sources`,
      )
      .send({
        layerKind: "qgis-zoning",
        upload: uploadFor("zoning.geojson"),
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("engagement_not_found");
  });

  it("400 on invalid body (missing upload)", async () => {
    const eng = await seedEngagement();
    const res = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({ layerKind: "qgis-zoning" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_briefing_source_body");
  });

  it("400 when layerKind is empty", async () => {
    const eng = await seedEngagement();
    const res = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({
        layerKind: "",
        upload: uploadFor("zoning.geojson"),
      });
    expect(res.status).toBe(400);
  });

  it("GET returns the briefing with current sources after upload", async () => {
    const eng = await seedEngagement();
    await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({
        layerKind: "qgis-zoning",
        upload: uploadFor("zoning.geojson"),
      });

    const res = await request(getApp()).get(
      `/api/engagements/${eng.id}/briefing`,
    );
    expect(res.status).toBe(200);
    expect(res.body.briefing).toBeTruthy();
    expect(res.body.briefing.engagementId).toBe(eng.id);
    expect(res.body.briefing.sources).toHaveLength(1);
    expect(res.body.briefing.sources[0].layerKind).toBe("qgis-zoning");
  });
});
