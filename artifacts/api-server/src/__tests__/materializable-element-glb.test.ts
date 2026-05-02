/**
 * GET /api/materializable-elements/:id/glb — Plan Review BIM viewport
 * bytes endpoint (Task #379).
 *
 * Mirrors the briefing-source GLB contract one for one — same ETag /
 * cache-header / If-None-Match handshake — but keyed by the
 * materializable-element row id. Pins the five shapes the
 * BimModelViewport relies on:
 *   - 403 when the caller is not architect-audience (V1-3 audience
 *     gate; the rest of the cases require the dev-only
 *     `x-audience: internal` header to bypass the gate);
 *   - 200 streams `model/gltf-binary` with a stable SHA-1 ETag and
 *     the `public, max-age=86400, immutable` cache header;
 *   - 304 when `If-None-Match` matches the stored bytes' ETag;
 *   - 404 when the element row is missing, or when the row exists but
 *     has no `glbObjectPath` attached (the inline-ring branch);
 *   - 404 when the row says it has bytes but storage has none (drift
 *     between the row and the bucket).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createHash } from "node:crypto";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("materializable-element-glb.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const getObjectEntityBytesMock = vi.fn<(rawPath: string) => Promise<Buffer>>();
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
    })),
    ObjectNotFoundError: ObjectNotFoundErrorClass,
  };
});

const { setupRouteTests } = await import("./setup");
const { engagements, parcelBriefings, materializableElements } = await import(
  "@workspace/db"
);

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

const FAKE_GLB_BYTES = Buffer.from("glTF\x02\x00\x00\x00fake-element-glb");
const EXPECTED_ETAG = `"${createHash("sha1")
  .update(FAKE_GLB_BYTES)
  .digest("hex")}"`;

beforeEach(() => {
  getObjectEntityBytesMock.mockReset();
  getObjectEntityBytesMock.mockResolvedValue(FAKE_GLB_BYTES);
});

/**
 * Send the dev-only `x-audience: internal` header so the architect-
 * audience guard on the GLB route lets the request through. Mirrors
 * the helper in `bim-models.test.ts`. The default applicant session
 * (no header) lands a 403 — covered by the dedicated test below.
 */
function asArchitect<T extends { set: (h: string, v: string) => T }>(req: T): T {
  return req.set("x-audience", "internal");
}

async function seedElement(opts: {
  glbObjectPath: string | null;
}): Promise<string> {
  if (!ctx.schema) throw new Error("ctx.schema not set");
  const [eng] = await ctx.schema.db
    .insert(engagements)
    .values({
      name: `Element Glb Engagement ${Math.random().toString(36).slice(2, 8)}`,
      nameLower: `element glb engagement ${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      jurisdiction: "Boulder, CO",
      address: "1 Pearl St",
      status: "active",
    })
    .returning();
  const [briefing] = await ctx.schema.db
    .insert(parcelBriefings)
    .values({ engagementId: eng.id })
    .returning();
  const [element] = await ctx.schema.db
    .insert(materializableElements)
    .values({
      briefingId: briefing.id,
      elementKind: "neighbor-mass",
      label: "Architect-supplied mesh",
      geometry: {},
      glbObjectPath: opts.glbObjectPath,
    })
    .returning();
  return element.id;
}

describe("GET /api/materializable-elements/:id/glb", () => {
  it("403s when the caller is not architect-audience (default applicant session)", async () => {
    // No `x-audience: internal` header → the request lands as the
    // anonymous applicant default the sessionMiddleware emits, and
    // the architect-scoped guard refuses to surface the bytes
    // (V1-3). The handler must short-circuit before the row lookup,
    // so the storage mock should never be called.
    const id = await seedElement({ glbObjectPath: "/objects/element-mesh-1" });
    const res = await request(getApp()).get(
      `/api/materializable-elements/${id}/glb`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("bim_model_requires_architect_audience");
    expect(getObjectEntityBytesMock).not.toHaveBeenCalled();
  });

  it("200 streams model/gltf-binary with SHA-1 ETag + immutable cache header", async () => {
    const id = await seedElement({ glbObjectPath: "/objects/element-mesh-1" });

    const res = await asArchitect(
      request(getApp()).get(`/api/materializable-elements/${id}/glb`),
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("model/gltf-binary");
    expect(res.headers["content-length"]).toBe(String(FAKE_GLB_BYTES.length));
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=86400, immutable",
    );
    expect(res.headers["etag"]).toBe(EXPECTED_ETAG);
    expect(getObjectEntityBytesMock).toHaveBeenCalledWith(
      "/objects/element-mesh-1",
    );
  });

  it("304 when If-None-Match matches the stored bytes' ETag", async () => {
    const id = await seedElement({ glbObjectPath: "/objects/element-mesh-1" });

    const res = await asArchitect(
      request(getApp()).get(`/api/materializable-elements/${id}/glb`),
    ).set("If-None-Match", EXPECTED_ETAG);

    expect(res.status).toBe(304);
    expect(res.text === "" || res.text === undefined).toBe(true);
  });

  it("200 when If-None-Match has a different value", async () => {
    const id = await seedElement({ glbObjectPath: "/objects/element-mesh-1" });

    const res = await asArchitect(
      request(getApp()).get(`/api/materializable-elements/${id}/glb`),
    ).set("If-None-Match", '"stale-etag"');

    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toBe(EXPECTED_ETAG);
  });

  it("404 materializable_element_not_found when the row id is unknown", async () => {
    const res = await asArchitect(
      request(getApp()).get(
        `/api/materializable-elements/00000000-0000-0000-0000-000000000000/glb`,
      ),
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("materializable_element_not_found");
    expect(getObjectEntityBytesMock).not.toHaveBeenCalled();
  });

  it("404 glb_not_attached when the element row has no glbObjectPath (inline-ring branch)", async () => {
    // An element backed only by inline `geometry` (e.g. setback plane,
    // buildable-envelope ring) has no glb to fetch — the viewer
    // shouldn't have asked, but the route must collapse to a uniform
    // 404 so the client renders its single fallback branch.
    const id = await seedElement({ glbObjectPath: null });
    const res = await asArchitect(
      request(getApp()).get(`/api/materializable-elements/${id}/glb`),
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("glb_not_attached");
    expect(getObjectEntityBytesMock).not.toHaveBeenCalled();
  });

  it("404 glb_bytes_missing when row points at a glb the bucket no longer holds", async () => {
    const id = await seedElement({ glbObjectPath: "/objects/glb-vanished" });
    getObjectEntityBytesMock.mockReset();
    getObjectEntityBytesMock.mockRejectedValueOnce(
      new ObjectNotFoundErrorClass(),
    );

    const res = await asArchitect(
      request(getApp()).get(`/api/materializable-elements/${id}/glb`),
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("glb_bytes_missing");
  });

});
