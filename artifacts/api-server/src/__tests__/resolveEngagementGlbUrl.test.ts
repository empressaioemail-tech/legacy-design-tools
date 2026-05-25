/**
 * V1-5 — resolveEngagementGlbSignedUrl priority + error codes.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";
import { createTestSchema, dropTestSchema, truncateAll } from "@workspace/db/testing";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("resolveEngagementGlbUrl.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const signMock = vi.fn(async (path: string) => `https://signed.test${path}`);
vi.mock("../lib/objectStorage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/objectStorage")>();
  return {
    ...actual,
    signObjectEntityGetUrl: signMock,
  };
});

const {
  engagements,
  parcelBriefings,
  bimModels,
  materializableElements,
  briefingSources,
} = await import("@workspace/db");
const {
  EngagementGlbResolveError,
  resolveEngagementGlbSignedUrl,
} = await import("../lib/resolveEngagementGlbUrl");

describe("resolveEngagementGlbSignedUrl", () => {
  beforeAll(async () => {
    ctx.schema = await createTestSchema();
  }, 120_000);

  afterAll(async () => {
    if (ctx.schema) await dropTestSchema(ctx.schema);
    ctx.schema = null;
  });

  beforeEach(async () => {
    await truncateAll(ctx.schema!.pool, [
      "briefing_sources",
      "materializable_elements",
      "bim_models",
      "parcel_briefings",
      "engagements",
    ]);
    signMock.mockClear();
  });

  async function seedEngagement() {
    const [eng] = await ctx.schema!.db
      .insert(engagements)
      .values({
        name: "GLB resolve test",
        nameLower: "glb resolve test",
        jurisdiction: "Test",
        address: "1 Main",
        status: "active",
      })
      .returning();
    const [briefing] = await ctx.schema!.db
      .insert(parcelBriefings)
      .values({ engagementId: eng!.id })
      .returning();
    const [bim] = await ctx.schema!.db
      .insert(bimModels)
      .values({
        engagementId: eng!.id,
        briefingVersion: 1,
        activeBriefingId: briefing!.id,
      })
      .returning();
    return { eng: eng!, briefing: briefing!, bim: bim! };
  }

  it("prefers materializable element glbObjectPath over briefing source", async () => {
    const { eng, briefing } = await seedEngagement();
    const sourceId = randomUUID();
    await ctx.schema!.db.insert(briefingSources).values({
      id: sourceId,
      briefingId: briefing.id,
      layerKind: "terrain",
      sourceKind: "manual-upload",
      uploadObjectPath: "/objects/dxf-source",
      uploadOriginalFilename: "terrain.dxf",
      uploadContentType: "application/octet-stream",
      uploadByteSize: 4096,
      dxfObjectPath: "/objects/dxf-source",
      glbObjectPath: "/objects/uploads/source-mesh",
      conversionStatus: "ready",
    });
    await ctx.schema!.db.insert(materializableElements).values({
      briefingId: briefing.id,
      engagementId: eng.id,
      elementKind: "neighbor-mass",
      sourceKind: "briefing-derived",
      label: "mesh",
      geometry: {},
      briefingSourceId: sourceId,
      glbObjectPath: "/objects/uploads/architect-mesh",
    });

    const url = await resolveEngagementGlbSignedUrl(eng.id);
    expect(url).toBe("https://signed.test/objects/uploads/architect-mesh");
    expect(signMock).toHaveBeenCalledWith("/objects/uploads/architect-mesh", 1800);
  });

  it("falls back to briefing source GLB when no element mesh", async () => {
    const { eng, briefing } = await seedEngagement();
    const sourceId = randomUUID();
    await ctx.schema!.db.insert(briefingSources).values({
      id: sourceId,
      briefingId: briefing.id,
      layerKind: "terrain",
      sourceKind: "manual-upload",
      uploadObjectPath: "/objects/dxf-source",
      uploadOriginalFilename: "terrain.dxf",
      uploadContentType: "application/octet-stream",
      uploadByteSize: 4096,
      dxfObjectPath: "/objects/dxf-source",
      glbObjectPath: "/objects/uploads/source-only.glb",
      conversionStatus: "ready",
    });
    await ctx.schema!.db.insert(materializableElements).values({
      briefingId: briefing.id,
      engagementId: eng.id,
      elementKind: "neighbor-mass",
      sourceKind: "briefing-derived",
      label: "building",
      geometry: {},
      briefingSourceId: sourceId,
      glbObjectPath: null,
    });

    const url = await resolveEngagementGlbSignedUrl(eng.id);
    expect(url).toBe("https://signed.test/objects/uploads/source-only.glb");
  });

  it("throws glb_not_attached when no paths exist", async () => {
    const { eng, briefing } = await seedEngagement();
    await ctx.schema!.db.insert(materializableElements).values({
      briefingId: briefing.id,
      engagementId: eng.id,
      elementKind: "neighbor-mass",
      sourceKind: "briefing-derived",
      label: "empty",
      geometry: {},
      glbObjectPath: null,
      briefingSourceId: null,
    });

    await expect(resolveEngagementGlbSignedUrl(eng.id)).rejects.toMatchObject({
      code: "glb_not_attached",
    });
  });

  it("throws no_bim_model when engagement has no bim row", async () => {
    const { eng } = await seedEngagement();
    await ctx.schema!.db
      .delete(bimModels)
      .where(eq(bimModels.engagementId, eng.id));

    await expect(resolveEngagementGlbSignedUrl(eng.id)).rejects.toBeInstanceOf(
      EngagementGlbResolveError,
    );
  });
});
