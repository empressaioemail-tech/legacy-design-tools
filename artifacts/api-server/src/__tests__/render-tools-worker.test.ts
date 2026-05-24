/**
 * doc 40e A.2 — `runToolPolling` integration tests.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ctx } from "./test-context";
import { createTestSchema, dropTestSchema, truncateAll } from "@workspace/db/testing";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("render-tools-worker.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const mirrorMock = vi.fn(
  async (input: { renderId: string; role: string }) => ({
    mirroredUrl: `gs://test/renders/${input.renderId}/${input.role}.png`,
    mirroredObjectKey: `renders/${input.renderId}/${input.role}.png`,
    sha256: "deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567",
    sizeBytes: 2048,
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

const { runToolPolling } = await import("../routes/render-tools");
const {
  engagements,
  parcelBriefings,
  bimModels,
  renderOutputs,
  viewpointRenders,
} = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const { setMnmlClient } = await import("@workspace/mnml-client");
const { resetAtomRegistryForTests } = await import("../atoms/registry");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

beforeAll(async () => {
  ctx.schema = await createTestSchema();
  resetAtomRegistryForTests();
});

afterEach(async () => {
  await truncateAll(ctx.schema!.pool, [
    "engagements",
    "parcel_briefings",
    "bim_models",
    "viewpoint_renders",
    "render_outputs",
    "atom_events",
  ]);
  setMnmlClient(null);
  vi.clearAllMocks();
});

afterAll(async () => {
  if (ctx.schema) {
    await dropTestSchema(ctx.schema);
    ctx.schema = null;
  }
});

async function seedQueuedToolRender() {
  const [eng] = await ctx.schema!.db
    .insert(engagements)
    .values({
      name: "Tool Worker",
      nameLower: "tool worker",
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
  const [parentRender] = await ctx.schema!.db
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
  const [parentOutput] = await ctx.schema!.db
    .insert(renderOutputs)
    .values({
      viewpointRenderId: parentRender!.id,
      role: "primary",
      format: "png",
      sourceUrl: "https://mnml.ai/mock/parent.png",
      mirroredObjectKey: "renders/parent/primary.png",
    })
    .returning();
  const [row] = await ctx.schema!.db
    .insert(viewpointRenders)
    .values({
      engagementId: eng!.id,
      briefingId: briefing!.id,
      bimModelId: bim!.id,
      kind: "still",
      sourceType: "enhance",
      parentRenderOutputId: parentOutput!.id,
      requestPayload: { tool: "enhance" },
      status: "queued",
      requestedBy: "user:test",
    })
    .returning();
  return row!;
}

describe("runToolPolling — enhance happy path", () => {
  it("trigger → poll → mirror → status=ready + primary output", async () => {
    const row = await seedQueuedToolRender();
    const { MockMnmlClient } = await import("@workspace/mnml-client");
    setMnmlClient(new MockMnmlClient());

    await runToolPolling({
      viewpointRenderId: row.id,
      sourceType: "enhance",
      trigger: {
        tool: "enhance",
        request: { image: PNG, prompt: "refine facade" },
      },
    });

    const [updated] = await ctx.schema!.db
      .select()
      .from(viewpointRenders)
      .where(eq(viewpointRenders.id, row.id))
      .limit(1);
    expect(updated?.status).toBe("ready");
    expect(updated?.mnmlJobId).toBeTruthy();

    const outputs = await ctx.schema!.db
      .select()
      .from(renderOutputs)
      .where(eq(renderOutputs.viewpointRenderId, row.id));
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.role).toBe("primary");
    expect(mirrorMock).toHaveBeenCalledTimes(1);
  }, 20_000);
});
