/**
 * doc 40e A.5 — render source upload + upload-as-source still kickoff.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

const uploadStore = new Map<string, Buffer>();

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("renders-source-upload.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

vi.mock("../lib/objectStorage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/objectStorage")>();
  class TestObjectStorageService extends actual.ObjectStorageService {
    override async uploadObjectEntityFromBuffer(
      bytes: Buffer,
      _contentType: string,
    ): Promise<string> {
      const id = randomUUID();
      const path = `/objects/uploads/${id}`;
      uploadStore.set(path, bytes);
      return path;
    }
    override async getObjectEntityBytes(rawPath: string): Promise<Buffer> {
      const bytes = uploadStore.get(rawPath);
      if (!bytes) throw new actual.ObjectNotFoundError();
      return bytes;
    }
  }
  return {
    ...actual,
    ObjectStorageService: TestObjectStorageService,
  };
});

const captureMock = vi.fn(async () => ({
  pngBuffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  width: 1344,
  height: 896,
  durationMs: 50,
}));
vi.mock("../lib/bimViewportCapture", () => ({
  captureBimViewport: captureMock,
  BimViewportCaptureError: class BimViewportCaptureError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "BimViewportCaptureError";
    }
  },
}));

const mirrorMock = vi.fn(
  async (input: { renderId: string; role: string }) => ({
    mirroredUrl: `gs://test/renders/${input.renderId}/${input.role}.png`,
    mirroredObjectKey: `renders/${input.renderId}/${input.role}.png`,
    sha256: "deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567",
    sizeBytes: 512,
  }),
);
vi.mock("../lib/rendersObjectMirror", () => ({
  mirrorRenderOutput: mirrorMock,
  RenderMirrorError: class RenderMirrorError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "RenderMirrorError";
    }
  },
}));

const { setupRouteTests } = await import("./setup");
const { setMnmlClient, MockMnmlClient } = await import("@workspace/mnml-client");
const { resetRenderObjectStorageCacheForTests } = await import("../routes/renders");
const {
  engagements,
  parcelBriefings,
  bimModels,
  viewpointRenders,
} = await import("@workspace/db");
const { eq } = await import("drizzle-orm");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4" +
    "890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082",
  "hex",
);

beforeEach(() => {
  uploadStore.clear();
  resetRenderObjectStorageCacheForTests();
  setMnmlClient(null);
  captureMock.mockClear();
  mirrorMock.mockClear();
});

afterAll(() => {
  setMnmlClient(null);
});

async function seedEngagement() {
  const [eng] = await ctx.schema!.db
    .insert(engagements)
    .values({
      name: "Upload Test",
      nameLower: "upload test",
      jurisdiction: "Boulder, CO",
      address: "1 Pearl St",
      status: "active",
    })
    .returning();
  await ctx.schema!.db
    .insert(parcelBriefings)
    .values({ engagementId: eng!.id });
  await ctx.schema!.db
    .insert(bimModels)
    .values({ engagementId: eng!.id, briefingVersion: 1 });
  return eng!.id;
}

describe("POST /api/engagements/:id/renders/source-upload", () => {
  it("201s with a canonical /objects/uploads path", async () => {
    const engagementId = await seedEngagement();
    const res = await request(getApp())
      .post(`/api/engagements/${engagementId}/renders/source-upload`)
      .attach("image", PNG_BYTES, "sketch.png");
    expect(res.status).toBe(201);
    expect(res.body.sourceUploadUrl).toMatch(/^\/objects\/uploads\//);
    expect(uploadStore.has(res.body.sourceUploadUrl)).toBe(true);
  });

  it("415s when not multipart", async () => {
    const engagementId = await seedEngagement();
    const res = await request(getApp())
      .post(`/api/engagements/${engagementId}/renders/source-upload`)
      .send({ image: "nope" });
    expect(res.status).toBe(415);
  });
});

describe("POST /api/engagements/:id/renders — still upload source", () => {
  it("202s and persists source_type=upload without GLB capture", async () => {
    setMnmlClient(new MockMnmlClient());
    const engagementId = await seedEngagement();
    const uploadRes = await request(getApp())
      .post(`/api/engagements/${engagementId}/renders/source-upload`)
      .attach("image", PNG_BYTES, "sketch.png");
    expect(uploadRes.status).toBe(201);

    const kickoffRes = await request(getApp())
      .post(`/api/engagements/${engagementId}/renders`)
      .send({
        kind: "still",
        sourceUploadUrl: uploadRes.body.sourceUploadUrl,
        prompt: "modern courtyard house",
      });
    expect(kickoffRes.status).toBe(202);
    expect(captureMock).not.toHaveBeenCalled();

    const [row] = await ctx.schema!.db
      .select()
      .from(viewpointRenders)
      .where(eq(viewpointRenders.id, kickoffRes.body.renderId))
      .limit(1);
    expect(row?.sourceType).toBe("upload");
    expect(row?.sourceUploadUrl).toBe(uploadRes.body.sourceUploadUrl);
  }, 30_000);

  it("walks upload → trigger → ready without capture", async () => {
    setMnmlClient(new MockMnmlClient());
    const engagementId = await seedEngagement();
    const uploadRes = await request(getApp())
      .post(`/api/engagements/${engagementId}/renders/source-upload`)
      .attach("image", PNG_BYTES, "sketch.png");

    const kickoffRes = await request(getApp())
      .post(`/api/engagements/${engagementId}/renders`)
      .send({
        kind: "still",
        sourceUploadUrl: uploadRes.body.sourceUploadUrl,
        prompt: "courtyard",
      });

    await vi.waitFor(
      async () => {
        const [row] = await ctx.schema!.db
          .select()
          .from(viewpointRenders)
          .where(eq(viewpointRenders.id, kickoffRes.body.renderId))
          .limit(1);
        expect(row?.status).toBe("ready");
      },
      { timeout: 20_000 },
    );

    const [row] = await ctx.schema!.db
      .select()
      .from(viewpointRenders)
      .where(eq(viewpointRenders.id, kickoffRes.body.renderId))
      .limit(1);
    expect(row?.status).toBe("ready");
    expect(captureMock).not.toHaveBeenCalled();
    expect(mirrorMock).toHaveBeenCalled();
  }, 30_000);
});
