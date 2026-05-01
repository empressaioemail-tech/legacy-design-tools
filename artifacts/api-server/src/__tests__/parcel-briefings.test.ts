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

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
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

/**
 * DA-MV-1 — Mock object storage. The QGIS branch never instantiates
 * ObjectStorageService (it just stores `upload.objectPath` verbatim),
 * so existing QGIS tests are unaffected. The DXF branch calls
 * `getObjectEntityBytes` (to feed the converter) and
 * `uploadObjectEntityFromBuffer` (to stash the converted glb), so
 * the new DXF-branch + retry-endpoint tests exercise these mocks.
 */
const getObjectEntityBytesMock = vi.fn<(rawPath: string) => Promise<Buffer>>();
const uploadObjectEntityFromBufferMock = vi.fn<
  (bytes: Buffer, contentType: string) => Promise<string>
>();
class ObjectNotFoundErrorClass extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
  }
}
vi.mock("../lib/objectStorage", () => {
  return {
    ObjectStorageService: vi.fn().mockImplementation(() => ({
      getObjectEntityBytes: getObjectEntityBytesMock,
      uploadObjectEntityFromBuffer: uploadObjectEntityFromBufferMock,
    })),
    ObjectNotFoundError: ObjectNotFoundErrorClass,
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
const {
  setConverterClient,
  MockConverterClient,
  ConverterError,
  DXF_LAYER_KINDS,
} = await import("../lib/converterClient");
type DxfLayerKind = (typeof DXF_LAYER_KINDS)[number];

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
    // The history-aware wire shape exposes supersededAt/By; the
    // current-source projection populates them with null.
    expect(res.body.briefing.sources[0].supersededAt).toBeNull();
    expect(res.body.briefing.sources[0].supersededById).toBeNull();
  });
});

describe("GET /api/engagements/:id/briefing/sources (history-aware)", () => {
  it("404 when the engagement does not exist", async () => {
    const res = await request(getApp())
      .get(`/api/engagements/00000000-0000-0000-0000-000000000000/briefing/sources`)
      .query({ layerKind: "qgis-zoning" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("engagement_not_found");
  });

  it("400 when layerKind is missing", async () => {
    const eng = await seedEngagement();
    const res = await request(getApp()).get(
      `/api/engagements/${eng.id}/briefing/sources`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query_parameters");
  });

  it("returns empty sources when the briefing does not exist yet", async () => {
    const eng = await seedEngagement();
    const res = await request(getApp())
      .get(`/api/engagements/${eng.id}/briefing/sources`)
      .query({ layerKind: "qgis-zoning" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sources: [] });
  });

  it("default lists only current source for the layer", async () => {
    const eng = await seedEngagement();
    await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({ layerKind: "qgis-zoning", upload: uploadFor("zoning-v1.geojson", 1000) });
    const second = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({ layerKind: "qgis-zoning", upload: uploadFor("zoning-v2.geojson", 2000) });
    expect(second.status).toBe(201);

    const res = await request(getApp())
      .get(`/api/engagements/${eng.id}/briefing/sources`)
      .query({ layerKind: "qgis-zoning" });
    expect(res.status).toBe(200);
    expect(res.body.sources).toHaveLength(1);
    expect(res.body.sources[0].uploadByteSize).toBe(2000);
    expect(res.body.sources[0].supersededAt).toBeNull();
  });

  it("includeSuperseded=true returns prior + current rows newest-first", async () => {
    const eng = await seedEngagement();
    const first = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({ layerKind: "qgis-zoning", upload: uploadFor("zoning-v1.geojson", 1000) });
    const firstSourceId = first.body.briefing.sources[0].id;

    const second = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({ layerKind: "qgis-zoning", upload: uploadFor("zoning-v2.geojson", 2000) });
    const secondSourceId = second.body.briefing.sources[0].id;

    const res = await request(getApp())
      .get(`/api/engagements/${eng.id}/briefing/sources`)
      .query({ layerKind: "qgis-zoning", includeSuperseded: "true" });
    expect(res.status).toBe(200);
    expect(res.body.sources).toHaveLength(2);
    // Newest first: the current source leads, the superseded prior follows.
    expect(res.body.sources[0].id).toBe(secondSourceId);
    expect(res.body.sources[0].supersededAt).toBeNull();
    expect(res.body.sources[1].id).toBe(firstSourceId);
    expect(res.body.sources[1].supersededAt).not.toBeNull();
    expect(res.body.sources[1].supersededById).toBe(secondSourceId);
  });

  it("includeSuperseded=false returns only the current row", async () => {
    const eng = await seedEngagement();
    await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({ layerKind: "qgis-zoning", upload: uploadFor("zoning-v1.geojson", 1000) });
    const second = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({ layerKind: "qgis-zoning", upload: uploadFor("zoning-v2.geojson", 2000) });
    const currentId = second.body.briefing.sources[0].id;

    const res = await request(getApp())
      .get(`/api/engagements/${eng.id}/briefing/sources`)
      .query({ layerKind: "qgis-zoning", includeSuperseded: "false" });
    expect(res.status).toBe(200);
    expect(res.body.sources).toHaveLength(1);
    expect(res.body.sources[0].id).toBe(currentId);
    expect(res.body.sources[0].supersededAt).toBeNull();
  });

  it("400 when includeSuperseded is not 'true' or 'false'", async () => {
    const eng = await seedEngagement();
    const res = await request(getApp())
      .get(`/api/engagements/${eng.id}/briefing/sources`)
      .query({ layerKind: "qgis-zoning", includeSuperseded: "yes" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query_parameters");
  });

  it("scopes results to the requested layer", async () => {
    const eng = await seedEngagement();
    await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({ layerKind: "qgis-zoning", upload: uploadFor("zoning.geojson") });
    await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({ layerKind: "qgis-parcel", upload: uploadFor("parcel.geojson") });

    const res = await request(getApp())
      .get(`/api/engagements/${eng.id}/briefing/sources`)
      .query({ layerKind: "qgis-parcel", includeSuperseded: "true" });
    expect(res.status).toBe(200);
    expect(res.body.sources).toHaveLength(1);
    expect(res.body.sources[0].layerKind).toBe("qgis-parcel");
  });
});

describe("POST /api/engagements/:id/briefing/sources/:sourceId/restore", () => {
  it("404 when engagement does not exist", async () => {
    const res = await request(getApp()).post(
      `/api/engagements/00000000-0000-0000-0000-000000000000/briefing/sources/00000000-0000-0000-0000-000000000001/restore`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("engagement_not_found");
  });

  it("404 when source does not exist", async () => {
    const eng = await seedEngagement();
    // Engagement exists but no briefing yet — surface as not-found
    // because the source can't possibly belong to a non-existent
    // briefing.
    const res = await request(getApp()).post(
      `/api/engagements/${eng.id}/briefing/sources/00000000-0000-0000-0000-000000000001/restore`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("briefing_source_not_found");
  });

  it("restores a superseded row and demotes the current row", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const eng = await seedEngagement();
    const first = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({ layerKind: "qgis-zoning", upload: uploadFor("zoning-v1.geojson", 1000) });
    const firstSourceId = first.body.briefing.sources[0].id;

    const second = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({ layerKind: "qgis-zoning", upload: uploadFor("zoning-v2.geojson", 2000) });
    const secondSourceId = second.body.briefing.sources[0].id;

    const restore = await request(getApp()).post(
      `/api/engagements/${eng.id}/briefing/sources/${firstSourceId}/restore`,
    );
    expect(restore.status).toBe(200);
    expect(restore.body.briefing.sources).toHaveLength(1);
    expect(restore.body.briefing.sources[0].id).toBe(firstSourceId);
    expect(restore.body.briefing.sources[0].uploadByteSize).toBe(1000);

    // Row state in the database: target is current, prior current is superseded by target.
    const all = await ctx.schema.db
      .select()
      .from(briefingSources)
      .where(eq(briefingSources.briefingId, restore.body.briefing.id));
    const target = all.find((r) => r.id === firstSourceId)!;
    const prior = all.find((r) => r.id === secondSourceId)!;
    expect(target.supersededAt).toBeNull();
    expect(target.supersededById).toBeNull();
    expect(prior.supersededAt).toBeInstanceOf(Date);
    expect(prior.supersededById).toBe(firstSourceId);

    // Partial-unique slot holds exactly the restored row.
    const current = await ctx.schema.db
      .select()
      .from(briefingSources)
      .where(
        and(
          eq(briefingSources.briefingId, restore.body.briefing.id),
          isNull(briefingSources.supersededAt),
        ),
      );
    expect(current).toHaveLength(1);
    expect(current[0]!.id).toBe(firstSourceId);
  });

  it("is idempotent on a row that is already current", async () => {
    const eng = await seedEngagement();
    const first = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({ layerKind: "qgis-zoning", upload: uploadFor("zoning.geojson") });
    const sourceId = first.body.briefing.sources[0].id;

    const restore = await request(getApp()).post(
      `/api/engagements/${eng.id}/briefing/sources/${sourceId}/restore`,
    );
    expect(restore.status).toBe(200);
    expect(restore.body.briefing.sources).toHaveLength(1);
    expect(restore.body.briefing.sources[0].id).toBe(sourceId);
  });

  it("400 when the source belongs to a different engagement", async () => {
    const engA = await seedEngagement("Engagement A");
    const engB = await seedEngagement("Engagement B");
    const a = await request(getApp())
      .post(`/api/engagements/${engA.id}/briefing/sources`)
      .send({ layerKind: "qgis-zoning", upload: uploadFor("a.geojson") });
    const sourceFromA = a.body.briefing.sources[0].id;

    // Seed a briefing on B as well so the engagement-has-briefing
    // guard does not short-circuit before the mismatch check.
    await request(getApp())
      .post(`/api/engagements/${engB.id}/briefing/sources`)
      .send({ layerKind: "qgis-zoning", upload: uploadFor("b.geojson") });

    const res = await request(getApp()).post(
      `/api/engagements/${engB.id}/briefing/sources/${sourceFromA}/restore`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("briefing_source_engagement_mismatch");
  });
});

/**
 * DA-MV-1 — DXF upload branch (Stream B).
 *
 * The DXF branch differs from the QGIS branch in three ways:
 *   1. it accepts only the seven Spec 52 §2 layer kinds (gated by
 *      `isDxfLayerKind` against `body.layerKind`);
 *   2. it stamps `dxfObjectPath` from the upload, then runs the
 *      converter and stamps `glbObjectPath` + `conversionStatus` +
 *      `conversionError` from the outcome;
 *   3. converter failures translate to a `failed` row (not a 5xx) so
 *      the architect can hit the retry endpoint without re-uploading.
 *
 * Object-storage and the converter client are both stubbed at the
 * module level so the route exercises its full transactional path
 * without any network or sidecar I/O.
 */
function dxfUploadFor(name: string, byteSize = 4096) {
  return {
    objectPath: `/objects/dxf-${name.replace(/[^a-z0-9]/gi, "-")}-${byteSize}`,
    originalFilename: name,
    contentType: "application/octet-stream",
    byteSize,
    kind: "dxf" as const,
  };
}

describe("POST /api/engagements/:id/briefing/sources — DXF branch (DA-MV-1)", () => {
  beforeEach(() => {
    getObjectEntityBytesMock.mockReset();
    getObjectEntityBytesMock.mockResolvedValue(Buffer.from("FAKE-DXF-BYTES"));
    uploadObjectEntityFromBufferMock.mockReset();
    uploadObjectEntityFromBufferMock.mockResolvedValue(
      "/objects/glb-from-converter",
    );
    setConverterClient(new MockConverterClient({ fixedRequestId: "req-test" }));
  });

  afterAll(() => {
    setConverterClient(null);
  });

  it("happy path: stamps dxfObjectPath, glbObjectPath, conversionStatus=ready", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const eng = await seedEngagement();

    const res = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({
        layerKind: "terrain",
        provider: "Surveyor",
        upload: dxfUploadFor("terrain.dxf", 8192),
      });

    expect(res.status).toBe(201);
    expect(res.body.briefing.sources).toHaveLength(1);
    const src = res.body.briefing.sources[0];
    expect(src).toMatchObject({
      layerKind: "terrain",
      sourceKind: "manual-upload",
      uploadOriginalFilename: "terrain.dxf",
      conversionStatus: "ready",
      dxfObjectPath: "/objects/dxf-terrain-dxf-8192",
      glbObjectPath: "/objects/glb-from-converter",
      conversionError: null,
    });

    expect(getObjectEntityBytesMock).toHaveBeenCalledWith(
      "/objects/dxf-terrain-dxf-8192",
    );
    expect(uploadObjectEntityFromBufferMock).toHaveBeenCalledTimes(1);
    const [glbBytesArg, ctypeArg] =
      uploadObjectEntityFromBufferMock.mock.calls[0]!;
    expect(Buffer.isBuffer(glbBytesArg)).toBe(true);
    expect(glbBytesArg.subarray(0, 4).toString("ascii")).toBe("glTF");
    expect(ctypeArg).toBe("model/gltf-binary");

    // DB row carries all four new DA-MV-1 columns.
    const rows = await ctx.schema.db
      .select()
      .from(briefingSources)
      .where(eq(briefingSources.id, src.id));
    expect(rows[0]!.dxfObjectPath).toBe("/objects/dxf-terrain-dxf-8192");
    expect(rows[0]!.glbObjectPath).toBe("/objects/glb-from-converter");
    expect(rows[0]!.conversionStatus).toBe("ready");
    expect(rows[0]!.conversionError).toBeNull();
  });

  it("converter failure: row inserted with conversionStatus=failed and error message", async () => {
    if (!ctx.schema) throw new Error("ctx");
    setConverterClient(new MockConverterClient({ alwaysFail: true }));
    const eng = await seedEngagement();

    const res = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({
        layerKind: "buildable-envelope",
        upload: dxfUploadFor("envelope.dxf", 2048),
      });

    expect(res.status).toBe(201);
    const src = res.body.briefing.sources[0];
    expect(src.conversionStatus).toBe("failed");
    expect(src.glbObjectPath).toBeNull();
    expect(src.dxfObjectPath).toBe("/objects/dxf-envelope-dxf-2048");
    expect(src.conversionError).toMatch(/MockConverterClient: forced failure/);

    // Storage upload is never called when the converter throws.
    expect(uploadObjectEntityFromBufferMock).not.toHaveBeenCalled();

    // Atom event still emitted so the timeline reflects the upload.
    const evRows = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(
        and(
          eq(atomEvents.entityType, "briefing-source"),
          eq(atomEvents.entityId, src.id),
        ),
      );
    expect(evRows).toHaveLength(1);
    expect(evRows[0]!.eventType).toBe("briefing-source.fetched");
  });

  it("400 invalid_dxf_layer_kind when upload.kind=dxf but layerKind is qgis-*", async () => {
    const eng = await seedEngagement();
    const res = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({
        layerKind: "qgis-zoning",
        upload: dxfUploadFor("nope.dxf"),
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_dxf_layer_kind");
    expect(getObjectEntityBytesMock).not.toHaveBeenCalled();
  });

  it("400 dxf_layer_kind_requires_dxf_upload when upload.kind=qgis but layerKind is a DXF kind", async () => {
    const eng = await seedEngagement();
    const res = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({
        layerKind: "terrain",
        upload: { ...uploadFor("terrain.geojson"), kind: "qgis" as const },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("dxf_layer_kind_requires_dxf_upload");
  });

  it("rejects every Spec 52 §2 DXF layer kind without an explicit kind=dxf", async () => {
    const eng = await seedEngagement();
    for (const kind of DXF_LAYER_KINDS as readonly DxfLayerKind[]) {
      const res = await request(getApp())
        .post(`/api/engagements/${eng.id}/briefing/sources`)
        .send({
          layerKind: kind,
          upload: uploadFor(`${kind}.geojson`),
        });
      expect(res.status, `kind=${kind}`).toBe(400);
      expect(res.body.error).toBe("dxf_layer_kind_requires_dxf_upload");
    }
  });
});

describe("POST /api/engagements/:id/briefing/sources/:sourceId/retry-conversion", () => {
  beforeEach(() => {
    getObjectEntityBytesMock.mockReset();
    getObjectEntityBytesMock.mockResolvedValue(Buffer.from("FAKE-DXF-BYTES"));
    uploadObjectEntityFromBufferMock.mockReset();
    uploadObjectEntityFromBufferMock.mockResolvedValue(
      "/objects/glb-from-retry",
    );
    setConverterClient(new MockConverterClient());
  });

  afterAll(() => {
    setConverterClient(null);
  });

  async function seedFailedDxfRow(eng: { id: string }) {
    setConverterClient(new MockConverterClient({ alwaysFail: true }));
    const res = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({
        layerKind: "terrain",
        upload: dxfUploadFor("terrain-v1.dxf"),
      });
    expect(res.status).toBe(201);
    expect(res.body.briefing.sources[0].conversionStatus).toBe("failed");
    return res.body.briefing.sources[0].id as string;
  }

  it("flips a failed row to ready without inserting a new row", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const eng = await seedEngagement();
    const sourceId = await seedFailedDxfRow(eng);

    // Reset converter to success for the retry call.
    setConverterClient(new MockConverterClient());
    uploadObjectEntityFromBufferMock.mockReset();
    uploadObjectEntityFromBufferMock.mockResolvedValue(
      "/objects/glb-from-retry",
    );

    const res = await request(getApp()).post(
      `/api/engagements/${eng.id}/briefing/sources/${sourceId}/retry-conversion`,
    );
    expect(res.status).toBe(200);
    expect(res.body.briefing.sources).toHaveLength(1);
    const src = res.body.briefing.sources[0];
    expect(src.id).toBe(sourceId);
    expect(src.conversionStatus).toBe("ready");
    expect(src.glbObjectPath).toBe("/objects/glb-from-retry");
    expect(src.conversionError).toBeNull();

    // Row count unchanged — the same row was updated in-place.
    const allRows = await ctx.schema.db
      .select()
      .from(briefingSources)
      .where(eq(briefingSources.briefingId, res.body.briefing.id));
    expect(allRows).toHaveLength(1);
    expect(allRows[0]!.id).toBe(sourceId);
    expect(allRows[0]!.supersededAt).toBeNull();
  });

  it("a second consecutive failure leaves the row stamped failed with the new error", async () => {
    const eng = await seedEngagement();
    const sourceId = await seedFailedDxfRow(eng);

    setConverterClient({
      async convert() {
        throw new ConverterError("converter_timeout", "retry timeout");
      },
    });

    const res = await request(getApp()).post(
      `/api/engagements/${eng.id}/briefing/sources/${sourceId}/retry-conversion`,
    );
    expect(res.status).toBe(200);
    const src = res.body.briefing.sources[0];
    expect(src.conversionStatus).toBe("failed");
    expect(src.conversionError).toBe("retry timeout");
    expect(src.glbObjectPath).toBeNull();
  });

  it("400 not_a_dxf_briefing_source on a QGIS row", async () => {
    const eng = await seedEngagement();
    const created = await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({
        layerKind: "qgis-zoning",
        upload: uploadFor("zoning.geojson"),
      });
    const sourceId = created.body.briefing.sources[0].id;

    const res = await request(getApp()).post(
      `/api/engagements/${eng.id}/briefing/sources/${sourceId}/retry-conversion`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("not_a_dxf_briefing_source");
  });

  it("404 engagement_not_found when engagement does not exist", async () => {
    const res = await request(getApp()).post(
      `/api/engagements/00000000-0000-0000-0000-000000000000/briefing/sources/00000000-0000-0000-0000-000000000001/retry-conversion`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("engagement_not_found");
  });

  it("404 briefing_source_not_found when source does not exist", async () => {
    const eng = await seedEngagement();
    // Seed any briefing so the briefing-row guard passes.
    await request(getApp())
      .post(`/api/engagements/${eng.id}/briefing/sources`)
      .send({
        layerKind: "qgis-zoning",
        upload: uploadFor("zoning.geojson"),
      });
    const res = await request(getApp()).post(
      `/api/engagements/${eng.id}/briefing/sources/00000000-0000-0000-0000-000000000099/retry-conversion`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("briefing_source_not_found");
  });

  it("400 briefing_source_engagement_mismatch when source belongs to a different engagement", async () => {
    const engA = await seedEngagement("Eng A");
    const engB = await seedEngagement("Eng B");
    const a = await request(getApp())
      .post(`/api/engagements/${engA.id}/briefing/sources`)
      .send({
        layerKind: "terrain",
        upload: dxfUploadFor("a.dxf"),
      });
    const sourceFromA = a.body.briefing.sources[0].id;

    // Seed a briefing on B so the briefing-row guard does not short-circuit.
    await request(getApp())
      .post(`/api/engagements/${engB.id}/briefing/sources`)
      .send({
        layerKind: "terrain",
        upload: dxfUploadFor("b.dxf"),
      });

    const res = await request(getApp()).post(
      `/api/engagements/${engB.id}/briefing/sources/${sourceFromA}/retry-conversion`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("briefing_source_engagement_mismatch");
  });
});
