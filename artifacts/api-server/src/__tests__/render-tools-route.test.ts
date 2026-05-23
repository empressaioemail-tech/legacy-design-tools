/**
 * doc 40e A.2 — power-tool route HTTP contract tests.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("render-tools-route.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { setMnmlClient, MockMnmlClient } = await import("@workspace/mnml-client");
const {
  engagements,
  parcelBriefings,
  bimModels,
  viewpointRenders,
  renderOutputs,
} = await import("@workspace/db");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeEach(() => {
  setMnmlClient(null);
});

afterAll(() => {
  setMnmlClient(null);
});

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4" +
    "890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082",
  "hex",
);

async function seedReadyParentOutput() {
  const [eng] = await ctx.schema!.db
    .insert(engagements)
    .values({
      name: "Tool Test",
      nameLower: "tool test",
      jurisdiction: "Boulder, CO",
      address: "1 Pearl St",
      status: "active",
    })
    .returning();
  const [briefing] = await ctx.schema!.db
    .insert(parcelBriefings)
    .values({ engagementId: eng!.id })
    .returning();
  const [bim] = await ctx.schema!.db
    .insert(bimModels)
    .values({ engagementId: eng!.id, briefingVersion: 1 })
    .returning();
  const [render] = await ctx.schema!.db
    .insert(viewpointRenders)
    .values({
      engagementId: eng!.id,
      briefingId: briefing!.id,
      bimModelId: bim!.id,
      kind: "still",
      sourceType: "model-capture",
      requestPayload: {},
      status: "ready",
      requestedBy: "user:test",
      completedAt: new Date(),
    })
    .returning();
  const [output] = await ctx.schema!.db
    .insert(renderOutputs)
    .values({
      viewpointRenderId: render!.id,
      role: "primary",
      format: "png",
      sourceUrl: "https://mnml.ai/mock/primary.png",
      mirroredObjectKey: "renders/test/primary.png",
    })
    .returning();
  return { parentOutputId: output!.id, renderId: render!.id };
}

describe("POST /api/render-outputs/:parentId/enhance", () => {
  it("202s with renderId + cost on valid multipart", async () => {
    setMnmlClient(new MockMnmlClient());
    const { parentOutputId } = await seedReadyParentOutput();
    const res = await request(getApp())
      .post(`/api/render-outputs/${parentOutputId}/enhance`)
      .attach("image", PNG_BYTES, "source.png")
      .field("prompt", "refine glass facade");
    expect(res.status).toBe(202);
    expect(res.body.renderId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(res.body.sourceType).toBe("enhance");
    expect(res.body.parentRenderOutputId).toBe(parentOutputId);
    expect(res.body.cost).toEqual({ credits: 1 });
  });

  it("404s when parent render output does not exist", async () => {
    const res = await request(getApp()).post(
      `/api/render-outputs/00000000-0000-0000-0000-000000000099/enhance`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("parent_render_output_not_found");
  });

  it("400s when parent render is not ready", async () => {
    const { parentOutputId, renderId } = await seedReadyParentOutput();
    await ctx.schema!.db
      .update(viewpointRenders)
      .set({ status: "rendering" })
      .where(eq(viewpointRenders.id, renderId));
    const res = await request(getApp())
      .post(`/api/render-outputs/${parentOutputId}/enhance`)
      .attach("image", PNG_BYTES, "source.png")
      .field("prompt", "refine");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("parent_render_not_ready");
  });

  it("415s when body is not multipart", async () => {
    const { parentOutputId } = await seedReadyParentOutput();
    const res = await request(getApp())
      .post(`/api/render-outputs/${parentOutputId}/enhance`)
      .send({ prompt: "x" });
    expect(res.status).toBe(415);
    expect(res.body.error).toBe("expected_multipart");
  });

  it("400s when prompt field is missing", async () => {
    const { parentOutputId } = await seedReadyParentOutput();
    const res = await request(getApp())
      .post(`/api/render-outputs/${parentOutputId}/enhance`)
      .attach("image", PNG_BYTES, "source.png");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_prompt");
  });

});

describe("POST /api/render-outputs/:parentId/upscale", () => {
  it("202s with renderId on valid image upload", async () => {
    setMnmlClient(new MockMnmlClient());
    const { parentOutputId } = await seedReadyParentOutput();
    const res = await request(getApp())
      .post(`/api/render-outputs/${parentOutputId}/upscale`)
      .attach("image", PNG_BYTES, "source.png")
      .field("scale", "4");
    expect(res.status).toBe(202);
    expect(res.body.sourceType).toBe("upscale");
  });
});

describe("POST /api/render-outputs/:parentId/erase", () => {
  it("400s when mask part is missing", async () => {
    const { parentOutputId } = await seedReadyParentOutput();
    const res = await request(getApp())
      .post(`/api/render-outputs/${parentOutputId}/erase`)
      .attach("image", PNG_BYTES, "source.png");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_mask_part");
  });
});
