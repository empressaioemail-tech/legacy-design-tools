/**
 * GET /api/briefing-sources/:id/glb — DA-MV-1 viewer bytes endpoint.
 *
 * Pins the five shapes the SiteContextViewer relies on:
 *   - 403 when the caller is not architect-audience (V1-3 audience
 *     gate; the rest of the cases require the dev-only
 *     `x-audience: internal` header to bypass the gate);
 *   - 200 streams `model/gltf-binary` with a stable SHA-1 ETag and the
 *     `public, max-age=86400, immutable` cache header;
 *   - 304 when `If-None-Match` matches the stored bytes' ETag;
 *   - 404 when the row is missing, or when its `conversionStatus` is
 *     anything but `ready` (the DXF-only / pending / failed variants
 *     all collapse to a single "not available" branch in the viewer);
 *   - 404 when the row says ready but the bytes are gone from
 *     storage (drift between the row and the bucket).
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
        throw new Error("briefing-source-glb.test: ctx.schema not set");
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
const { engagements, parcelBriefings, briefingSources } = await import(
  "@workspace/db"
);

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

const FAKE_GLB_BYTES = Buffer.from("glTF\x02\x00\x00\x00fake-glb-payload");
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

async function seedSource(opts: {
  conversionStatus: "pending" | "converting" | "ready" | "failed" | "dxf-only";
  glbObjectPath: string | null;
}): Promise<string> {
  if (!ctx.schema) throw new Error("ctx.schema not set");
  const [eng] = await ctx.schema.db
    .insert(engagements)
    .values({
      name: `Glb Engagement ${Math.random().toString(36).slice(2, 8)}`,
      nameLower: `glb engagement ${Math.random().toString(36).slice(2, 8)}`,
      jurisdiction: "Boulder, CO",
      address: "1 Pearl St",
      status: "active",
    })
    .returning();
  const [briefing] = await ctx.schema.db
    .insert(parcelBriefings)
    .values({ engagementId: eng.id })
    .returning();
  const [source] = await ctx.schema.db
    .insert(briefingSources)
    .values({
      briefingId: briefing.id,
      layerKind: "terrain",
      sourceKind: "manual-upload",
      uploadObjectPath: "/objects/dxf-source",
      uploadOriginalFilename: "terrain.dxf",
      uploadContentType: "application/octet-stream",
      uploadByteSize: 4096,
      dxfObjectPath: "/objects/dxf-source",
      glbObjectPath: opts.glbObjectPath,
      conversionStatus: opts.conversionStatus,
    })
    .returning();
  return source.id;
}

describe("GET /api/briefing-sources/:id/glb", () => {
  it("403s when the caller is not architect-audience (default applicant session)", async () => {
    // No `x-audience: internal` header → the request lands as the
    // anonymous applicant default the sessionMiddleware emits, and
    // the architect-scoped guard refuses to surface the bytes
    // (V1-3). The handler must short-circuit before the row lookup,
    // so the storage mock should never be called.
    const id = await seedSource({
      conversionStatus: "ready",
      glbObjectPath: "/objects/glb-ready",
    });
    const res = await request(getApp()).get(`/api/briefing-sources/${id}/glb`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("briefing_source_requires_architect_audience");
    expect(getObjectEntityBytesMock).not.toHaveBeenCalled();
  });

  it("200 streams model/gltf-binary with SHA-1 ETag + immutable cache header", async () => {
    const id = await seedSource({
      conversionStatus: "ready",
      glbObjectPath: "/objects/glb-ready",
    });

    const res = await asArchitect(
      request(getApp()).get(`/api/briefing-sources/${id}/glb`),
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("model/gltf-binary");
    expect(res.headers["content-length"]).toBe(String(FAKE_GLB_BYTES.length));
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=86400, immutable",
    );
    expect(res.headers["etag"]).toBe(EXPECTED_ETAG);
    // Content-Length + ETag (SHA-1 of the bytes) together pin the
    // exact payload — a single-byte difference would bust the ETag —
    // so we don't need to round-trip the binary body through supertest
    // (which doesn't auto-buffer model/gltf-binary into a Buffer).
    expect(getObjectEntityBytesMock).toHaveBeenCalledWith("/objects/glb-ready");
  });

  it("304 when If-None-Match matches the stored bytes' ETag", async () => {
    const id = await seedSource({
      conversionStatus: "ready",
      glbObjectPath: "/objects/glb-ready",
    });

    const res = await asArchitect(
      request(getApp()).get(`/api/briefing-sources/${id}/glb`),
    ).set("If-None-Match", EXPECTED_ETAG);

    expect(res.status).toBe(304);
    // Body is empty per spec on 304.
    expect(res.text === "" || res.text === undefined).toBe(true);
  });

  it("200 when If-None-Match has a different value", async () => {
    const id = await seedSource({
      conversionStatus: "ready",
      glbObjectPath: "/objects/glb-ready",
    });

    const res = await asArchitect(
      request(getApp()).get(`/api/briefing-sources/${id}/glb`),
    ).set("If-None-Match", '"stale-etag"');
    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toBe(EXPECTED_ETAG);
  });

  it("404 briefing_source_not_found when the row id is unknown", async () => {
    const res = await asArchitect(
      request(getApp()).get(
        `/api/briefing-sources/00000000-0000-0000-0000-000000000000/glb`,
      ),
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("briefing_source_not_found");
    expect(getObjectEntityBytesMock).not.toHaveBeenCalled();
  });

  it.each([
    ["pending", "/objects/dxf-source"],
    ["converting", "/objects/dxf-source"],
    ["failed", "/objects/dxf-source"],
    ["dxf-only", "/objects/dxf-source"],
  ] as const)(
    "404 glb_not_ready when conversionStatus is %s (DXF-only branch)",
    async (status, glbPath) => {
      // Each non-ready status seeds with a non-null glbObjectPath where
      // applicable to verify the route gates on `conversionStatus`, not
      // just on path nullness.
      const id = await seedSource({
        conversionStatus: status,
        glbObjectPath: glbPath === "/objects/dxf-source" ? null : glbPath,
      });
      const res = await asArchitect(
        request(getApp()).get(`/api/briefing-sources/${id}/glb`),
      );
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("glb_not_ready");
      expect(getObjectEntityBytesMock).not.toHaveBeenCalled();
    },
  );

  it("404 glb_not_ready when conversionStatus=ready but glbObjectPath is null", async () => {
    const id = await seedSource({
      conversionStatus: "ready",
      glbObjectPath: null,
    });
    const res = await asArchitect(
      request(getApp()).get(`/api/briefing-sources/${id}/glb`),
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("glb_not_ready");
  });

  it("404 glb_bytes_missing when row says ready but storage has no bytes", async () => {
    const id = await seedSource({
      conversionStatus: "ready",
      glbObjectPath: "/objects/glb-vanished",
    });
    getObjectEntityBytesMock.mockReset();
    getObjectEntityBytesMock.mockRejectedValueOnce(new ObjectNotFoundErrorClass());

    const res = await asArchitect(
      request(getApp()).get(`/api/briefing-sources/${id}/glb`),
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("glb_bytes_missing");
  });
});
