/**
 * Polling-worker integration tests for `runRenderPolling` — Step 8.5.
 *
 * The worker is fire-and-forget from the route handler's perspective,
 * but exporting it (Step 8.5) lets tests await the full lifecycle
 * directly. We still run against a real per-suite test schema (the
 * `vi.mock("@workspace/db")` getter + `ctx.schema` bridge from
 * `test-context.ts`) so SQL filters and transactions exercise the
 * actual drizzle path, not a hand-mocked chain.
 *
 * External boundaries (capture / mirror / mnml) are stubbed at the
 * module level — no real puppeteer, ffmpeg, GCS, or network. The
 * polling timer chain runs against vitest fake timers; tests step
 * through the cadence with `vi.advanceTimersByTimeAsync(...)` so the
 * polling loop exits in microseconds rather than seconds.
 *
 * Coverage (the four scenarios the V1-4 PR commits to per Phase 1A
 * + the user's Step 8.5 dispatch):
 *   1. Still happy path: capture → trigger → poll-rendering →
 *      poll-ready → mirror → status='ready' + render_outputs[0]
 *   2. Still trigger fails (mnml validation error) → status='failed'
 *      with error_code='mnml_validation'; no mirror call
 *   3. Elevation-set happy path: 4 triggers + 4 captures + 4 polls
 *      + 4 mirrors → status='ready' + 4 render_outputs (one per
 *      cardinal role)
 *   4. Cancellation observed mid-poll: row updated to 'cancelled'
 *      out-of-band; worker bails on next iteration (no further mnml
 *      calls, no mirror)
 *
 * NOT covered here (still on the V1-4 deferred list):
 *   - Elevation-set partial-debit (insufficient_credits_partial)
 *   - Polling timeout (would require advancing 10 minutes of fake
 *     time + an unhealthy mnml fake — covers in Step 10 e2e)
 *   - Atom event emission contents (history.appendEvent is best-
 *     effort and tested indirectly via the row state assertions)
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ctx } from "./test-context";
import { createTestSchema, dropTestSchema, truncateAll } from "@workspace/db/testing";

// ─────────────────────────────────────────────────────────────────────
// Module-level mocks — must come before any imports that consume them.
// ─────────────────────────────────────────────────────────────────────

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("renders-worker.test: ctx.schema not set");
      return ctx.schema.db;
    },
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
    sizeBytes: 1024,
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

// ─────────────────────────────────────────────────────────────────────
// Now import the worker + workspace modules (vi.mock factories above).
// ─────────────────────────────────────────────────────────────────────

const { runRenderPolling } = await import("../routes/renders");
const {
  bimModels,
  engagements,
  parcelBriefings,
  renderOutputs,
  viewpointRenders,
} = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const { setMnmlClient, MnmlError } = await import("@workspace/mnml-client");
const { resetAtomRegistryForTests } = await import("../atoms/registry");

// ─────────────────────────────────────────────────────────────────────
// Test mnml client — vi.fn-backed so each test pre-loads the response sequence
// ─────────────────────────────────────────────────────────────────────

interface FakeMnml {
  triggerRender: ReturnType<typeof vi.fn>;
  getRenderStatus: ReturnType<typeof vi.fn>;
}

function makeFakeMnml(): FakeMnml {
  return {
    triggerRender: vi.fn(),
    getRenderStatus: vi.fn(),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  ctx.schema = await createTestSchema();
  // The atom registry caches a closure over the prod db at first
  // touch; resetting after schema setup ensures it captures the
  // mocked db instead.
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
  vi.useRealTimers();
});

afterAll(async () => {
  if (ctx.schema) {
    await dropTestSchema(ctx.schema);
    ctx.schema = null;
  }
});

// ─────────────────────────────────────────────────────────────────────
// Seeding helpers
// ─────────────────────────────────────────────────────────────────────

async function seedFixture() {
  const [eng] = await ctx.schema!.db
    .insert(engagements)
    .values({
      name: "Test Project",
      nameLower: "test project",
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
  return { engagement: eng!, briefing: briefing!, bimModel: bim! };
}

async function seedQueuedRender(args: {
  engagementId: string;
  briefingId: string;
  bimModelId: string;
  kind: "still" | "elevation-set" | "video";
}) {
  const [row] = await ctx.schema!.db
    .insert(viewpointRenders)
    .values({
      engagementId: args.engagementId,
      briefingId: args.briefingId,
      bimModelId: args.bimModelId,
      kind: args.kind,
      requestPayload: {},
      status: "queued",
      requestedBy: "user:test",
    })
    .returning();
  return row!;
}

async function readRender(id: string) {
  const [row] = await ctx.schema!.db
    .select()
    .from(viewpointRenders)
    .where(eq(viewpointRenders.id, id))
    .limit(1);
  return row;
}

async function readOutputs(viewpointRenderId: string) {
  return ctx.schema!.db
    .select()
    .from(renderOutputs)
    .where(eq(renderOutputs.viewpointRenderId, viewpointRenderId));
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe("runRenderPolling — still happy path", () => {
  it("walks capture → trigger → poll-rendering → poll-ready → mirror → status=ready", async () => {
    // Real timers — fake timers introduced a race between the test's
    // advanceTimersByTimeAsync calls and the polling reaching its
    // first await delay(). Polling drives itself with real 3s/5s
    // delays; total wall-clock ~8s, well under the 20s test timeout.
    const fixture = await seedFixture();
    const row = await seedQueuedRender({
      engagementId: fixture.engagement.id,
      briefingId: fixture.briefing.id,
      bimModelId: fixture.bimModel.id,
      kind: "still",
    });

    const fake = makeFakeMnml();
    fake.triggerRender.mockResolvedValue({
      renderId: "mnml-still-1",
      remainingCredits: 997,
    });
    fake.getRenderStatus
      .mockResolvedValueOnce({ renderId: "mnml-still-1", status: "rendering" })
      .mockResolvedValueOnce({
        renderId: "mnml-still-1",
        status: "ready",
        outputUrls: ["https://api.mnmlai.dev/v1/images/abc.png"],
        seed: 42,
      });
    setMnmlClient(fake);

    const polling = runRenderPolling({
      viewpointRenderId: row.id,
      body: {
        kind: "still",
        glbUrl: "https://example.test/model.glb",
        prompt: "test still",
        cameraPosition: { x: 0, y: 5, z: 10 },
        cameraTarget: { x: 0, y: 0, z: 0 },
      },
    });

    // Real-timer drive: polling does delay(3000) → first poll seeing
    // "rendering" → delay(5000) → second poll seeing "ready" → mirror →
    // resolve. Total ~8s real wall-clock.
    await polling;

    const final = await readRender(row.id);
    expect(final?.status).toBe("ready");
    expect(final?.mnmlJobId).toBe("mnml-still-1");
    expect(final?.completedAt).toBeTruthy();

    const outputs = await readOutputs(row.id);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      role: "primary",
      format: "png",
      mirroredObjectKey: expect.stringContaining(`renders/${row.id}/primary`),
    });

    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(fake.triggerRender).toHaveBeenCalledTimes(1);
    expect(fake.getRenderStatus).toHaveBeenCalledTimes(2);
    expect(mirrorMock).toHaveBeenCalledTimes(1);
  });
});

describe("runRenderPolling — still trigger validation failure", () => {
  it("records status=failed with error_code=mnml_validation when mnml rejects the trigger", async () => {
    const fixture = await seedFixture();
    const row = await seedQueuedRender({
      engagementId: fixture.engagement.id,
      briefingId: fixture.briefing.id,
      bimModelId: fixture.bimModel.id,
      kind: "still",
    });

    const fake = makeFakeMnml();
    fake.triggerRender.mockRejectedValue(
      new MnmlError("validation", "INVALID_IMAGE_TYPE", "image format not supported"),
    );
    setMnmlClient(fake);

    await runRenderPolling({
      viewpointRenderId: row.id,
      body: {
        kind: "still",
        glbUrl: "https://example.test/model.glb",
        prompt: "test still",
        cameraPosition: { x: 0, y: 5, z: 10 },
        cameraTarget: { x: 0, y: 0, z: 0 },
      },
    });

    const final = await readRender(row.id);
    expect(final?.status).toBe("failed");
    expect(final?.errorCode).toBe("mnml_validation");
    expect(final?.errorMessage).toContain("image format not supported");
    expect(mirrorMock).not.toHaveBeenCalled();
    // Trigger was attempted exactly once; getRenderStatus never called
    // because trigger threw before the poll loop started.
    expect(fake.triggerRender).toHaveBeenCalledTimes(1);
    expect(fake.getRenderStatus).not.toHaveBeenCalled();
  });
});

describe("runRenderPolling — elevation-set happy path", () => {
  it("captures + triggers + polls + mirrors all 4 children, persists 4 render_outputs", async () => {
    // Real timers (see still-happy-path comment for rationale). All
    // 4 child polls return "ready" on the first iteration (mocked),
    // so wall-clock is just the first delay (~3s).
    const fixture = await seedFixture();
    const row = await seedQueuedRender({
      engagementId: fixture.engagement.id,
      briefingId: fixture.briefing.id,
      bimModelId: fixture.bimModel.id,
      kind: "elevation-set",
    });

    const fake = makeFakeMnml();
    // 4 triggers, each returning a distinct mnml id.
    fake.triggerRender
      .mockResolvedValueOnce({ renderId: "mnml-n", remainingCredits: 100 })
      .mockResolvedValueOnce({ renderId: "mnml-e", remainingCredits: 97 })
      .mockResolvedValueOnce({ renderId: "mnml-s", remainingCredits: 94 })
      .mockResolvedValueOnce({ renderId: "mnml-w", remainingCredits: 91 });
    // Each getRenderStatus → ready immediately (the route's poll loop
    // touches each child once per iteration).
    fake.getRenderStatus.mockImplementation(async (id: string) => ({
      renderId: id,
      status: "ready",
      outputUrls: [`https://api.mnmlai.dev/v1/images/${id}.png`],
    }));
    setMnmlClient(fake);

    const polling = runRenderPolling({
      viewpointRenderId: row.id,
      body: {
        kind: "elevation-set",
        glbUrl: "https://example.test/model.glb",
        prompt: "elevations",
        buildingCenter: { x: 0, y: 0, z: 0 },
        cameraDistance: 30,
        cameraHeight: 10,
      },
    });

    await polling;

    const final = await readRender(row.id);
    expect(final?.status).toBe("ready");

    const outputs = await readOutputs(row.id);
    const roles = outputs.map((o) => o.role).sort();
    expect(roles).toEqual([
      "elevation-e",
      "elevation-n",
      "elevation-s",
      "elevation-w",
    ]);
    expect(captureMock).toHaveBeenCalledTimes(4); // one per direction
    expect(fake.triggerRender).toHaveBeenCalledTimes(4);
    expect(mirrorMock).toHaveBeenCalledTimes(4);
  });
});

describe("runRenderPolling — cancellation observed mid-poll", () => {
  it("bails when an out-of-band UPDATE flips status='cancelled' between polls", async () => {
    // Real timers (see still-happy-path comment for rationale). Test
    // coordinates timing with a real-setTimeout sleep between the
    // first poll completing and the OOB cancel UPDATE.
    const fixture = await seedFixture();
    const row = await seedQueuedRender({
      engagementId: fixture.engagement.id,
      briefingId: fixture.briefing.id,
      bimModelId: fixture.bimModel.id,
      kind: "still",
    });

    const fake = makeFakeMnml();
    fake.triggerRender.mockResolvedValue({
      renderId: "mnml-cancel-1",
      remainingCredits: 100,
    });
    // Worker would normally see 'rendering' → 'ready', but we
    // intercept after the first poll by flipping the row to
    // cancelled. The worker's per-iteration cancellation check then
    // bails before calling getRenderStatus a second time.
    fake.getRenderStatus.mockResolvedValueOnce({
      renderId: "mnml-cancel-1",
      status: "rendering",
    });
    setMnmlClient(fake);

    const polling = runRenderPolling({
      viewpointRenderId: row.id,
      body: {
        kind: "still",
        glbUrl: "https://example.test/model.glb",
        prompt: "test still",
        cameraPosition: { x: 0, y: 5, z: 10 },
        cameraTarget: { x: 0, y: 0, z: 0 },
      },
    });

    // Wait for the first poll to fire (3s delay) and complete its
    // "rendering" state update before issuing the OOB cancel. 4s
    // of real wall-clock gives 1s of buffer past the polling's
    // first delay + first poll's tiny DB-op duration.
    await new Promise((resolve) => setTimeout(resolve, 4_000));

    // Out-of-band cancel (simulating POST /api/renders/:id/cancel).
    await ctx.schema!.db
      .update(viewpointRenders)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(eq(viewpointRenders.id, row.id));

    // Polling waits the second 5s delay, sees status='cancelled' on
    // its cancellation check, returns without calling mnml again.
    await polling;

    const final = await readRender(row.id);
    expect(final?.status).toBe("cancelled");
    // getRenderStatus was called exactly once (the first poll) —
    // the cancellation check on the second poll bailed before
    // calling mnml again.
    expect(fake.getRenderStatus).toHaveBeenCalledTimes(1);
    // Mirror NEVER called — the render never reached 'ready' here.
    expect(mirrorMock).not.toHaveBeenCalled();
  });
});
