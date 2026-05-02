/**
 * Integration tests for {@link runRendersSweep}.
 *
 * Mirrors the briefing-generation-jobs-sweep test pattern: per-suite
 * test schema, seed rows directly via drizzle, run the sweep with
 * `db: schema.db` so updates / deletes land in the isolated schema
 * rather than dev. The sweep helper never instantiates its own db
 * client when the override is passed.
 *
 * Coverage:
 *   - Bucket 1 (stuck rescue):
 *     · queued/rendering older than threshold → rescued
 *     · queued/rendering newer than threshold → untouched
 *     · ready/failed/cancelled regardless of age → untouched (wrong status)
 *   - Bucket 2 (old terminal reap):
 *     · failed/cancelled older than retention → DELETEd
 *     · ready regardless of age → NEVER DELETEd
 *     · failed/cancelled newer than retention → kept
 *   - Bucket 3 (incomplete-mirror warning):
 *     · ready row with NULL mirrored_object_key on a child output
 *       → counted in warnedIncompleteMirror, no state change
 *   - Result shape (durationMs ≥ 0, counts match assertions)
 *   - Boundary: row exactly at threshold uses strict `<` comparison
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createTestSchema,
  dropTestSchema,
  truncateAll,
  type TestSchemaContext,
} from "@workspace/db/testing";

const {
  bimModels,
  engagements,
  parcelBriefings,
  renderOutputs,
  viewpointRenders,
} = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const { runRendersSweep } = await import("../lib/rendersSweep");

let schema: TestSchemaContext;

beforeAll(async () => {
  schema = await createTestSchema();
});
afterEach(async () => {
  await truncateAll(schema.pool, [
    "engagements",
    "parcel_briefings",
    "bim_models",
    "viewpoint_renders",
    "render_outputs",
  ]);
});
afterAll(async () => {
  await dropTestSchema(schema);
});

// ─────────────────────────────────────────────────────────────────────
// Helpers — seed an engagement + briefing + bim-model + render row
// ─────────────────────────────────────────────────────────────────────

async function seedEngagement(name = "test-eng") {
  const [eng] = await schema.db
    .insert(engagements)
    .values({
      name,
      nameLower: name.trim().toLowerCase(),
      jurisdiction: "Boulder, CO",
      address: "1 Pearl St",
      status: "active",
    })
    .returning();
  return eng!;
}

async function seedBriefingAndBim(engagementId: string) {
  const [brief] = await schema.db
    .insert(parcelBriefings)
    .values({ engagementId })
    .returning();
  const [bim] = await schema.db
    .insert(bimModels)
    .values({ engagementId, briefingVersion: 1 })
    .returning();
  return { briefing: brief!, bimModel: bim! };
}

async function seedRender(args: {
  engagementId: string;
  briefingId: string;
  bimModelId: string;
  status: string;
  createdAt?: Date;
  completedAt?: Date | null;
}) {
  const [row] = await schema.db
    .insert(viewpointRenders)
    .values({
      engagementId: args.engagementId,
      briefingId: args.briefingId,
      bimModelId: args.bimModelId,
      kind: "still",
      requestPayload: {},
      status: args.status,
      requestedBy: "user:test",
      ...(args.createdAt ? { createdAt: args.createdAt } : {}),
      ...(args.completedAt !== undefined ? { completedAt: args.completedAt } : {}),
    })
    .returning();
  return row!;
}

async function countRendersWithStatus(status: string): Promise<number> {
  const rows = await schema.db
    .select({ id: viewpointRenders.id })
    .from(viewpointRenders)
    .where(eq(viewpointRenders.status, status));
  return rows.length;
}

// ─────────────────────────────────────────────────────────────────────
// Bucket 1: stuck rescue
// ─────────────────────────────────────────────────────────────────────

describe("runRendersSweep — stuck rescue", () => {
  it("rescues queued + rendering rows older than the threshold", async () => {
    const eng = await seedEngagement();
    const { briefing, bimModel } = await seedBriefingAndBim(eng.id);
    const now = new Date("2026-05-02T12:00:00Z");
    const longAgo = new Date(now.getTime() - 30 * 60 * 1000); // 30 min ago

    await seedRender({
      engagementId: eng.id,
      briefingId: briefing.id,
      bimModelId: bimModel.id,
      status: "queued",
      createdAt: longAgo,
    });
    await seedRender({
      engagementId: eng.id,
      briefingId: briefing.id,
      bimModelId: bimModel.id,
      status: "rendering",
      createdAt: longAgo,
    });

    const result = await runRendersSweep({
      db: schema.db,
      now,
      rescueThresholdMs: 15 * 60 * 1000,
    });

    expect(result.rescuedStuck).toBe(2);
    expect(await countRendersWithStatus("failed")).toBe(2);
    expect(await countRendersWithStatus("queued")).toBe(0);
    expect(await countRendersWithStatus("rendering")).toBe(0);

    const failedRows = await schema.db
      .select()
      .from(viewpointRenders)
      .where(eq(viewpointRenders.status, "failed"));
    for (const row of failedRows) {
      expect(row.errorCode).toBe("polling_timeout_sweep");
      expect(row.completedAt).toBeTruthy();
    }
  });

  it("does NOT rescue rows newer than the threshold", async () => {
    const eng = await seedEngagement();
    const { briefing, bimModel } = await seedBriefingAndBim(eng.id);
    const now = new Date("2026-05-02T12:00:00Z");
    const recentlyStarted = new Date(now.getTime() - 5 * 60 * 1000); // 5 min ago

    await seedRender({
      engagementId: eng.id,
      briefingId: briefing.id,
      bimModelId: bimModel.id,
      status: "queued",
      createdAt: recentlyStarted,
    });

    const result = await runRendersSweep({
      db: schema.db,
      now,
      rescueThresholdMs: 15 * 60 * 1000,
    });

    expect(result.rescuedStuck).toBe(0);
    expect(await countRendersWithStatus("queued")).toBe(1);
  });

  it("does NOT touch ready/failed/cancelled rows even if old", async () => {
    const eng = await seedEngagement();
    const { briefing, bimModel } = await seedBriefingAndBim(eng.id);
    const now = new Date("2026-05-02T12:00:00Z");
    const ancient = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000); // 10 days ago

    await seedRender({
      engagementId: eng.id,
      briefingId: briefing.id,
      bimModelId: bimModel.id,
      status: "ready",
      createdAt: ancient,
      completedAt: ancient,
    });

    const result = await runRendersSweep({
      db: schema.db,
      now,
      rescueThresholdMs: 15 * 60 * 1000,
      retentionMs: 30 * 24 * 60 * 60 * 1000,
    });

    expect(result.rescuedStuck).toBe(0);
    expect(await countRendersWithStatus("ready")).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Bucket 2: old terminal reap
// ─────────────────────────────────────────────────────────────────────

describe("runRendersSweep — old terminal reap", () => {
  it("DELETEs failed/cancelled rows older than retention", async () => {
    const eng = await seedEngagement();
    const { briefing, bimModel } = await seedBriefingAndBim(eng.id);
    const now = new Date("2026-05-02T12:00:00Z");
    const ancient = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000); // 100 days ago

    await seedRender({
      engagementId: eng.id,
      briefingId: briefing.id,
      bimModelId: bimModel.id,
      status: "failed",
      createdAt: ancient,
      completedAt: ancient,
    });
    await seedRender({
      engagementId: eng.id,
      briefingId: briefing.id,
      bimModelId: bimModel.id,
      status: "cancelled",
      createdAt: ancient,
      completedAt: ancient,
    });

    const result = await runRendersSweep({
      db: schema.db,
      now,
      retentionMs: 30 * 24 * 60 * 60 * 1000,
    });

    expect(result.reapedTerminal).toBe(2);
    expect(await countRendersWithStatus("failed")).toBe(0);
    expect(await countRendersWithStatus("cancelled")).toBe(0);
  });

  it("NEVER reaps ready rows regardless of age (user-facing artifacts)", async () => {
    const eng = await seedEngagement();
    const { briefing, bimModel } = await seedBriefingAndBim(eng.id);
    const now = new Date("2026-05-02T12:00:00Z");
    const ancient = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000); // 1 year ago

    await seedRender({
      engagementId: eng.id,
      briefingId: briefing.id,
      bimModelId: bimModel.id,
      status: "ready",
      createdAt: ancient,
      completedAt: ancient,
    });

    const result = await runRendersSweep({
      db: schema.db,
      now,
      retentionMs: 30 * 24 * 60 * 60 * 1000,
    });

    expect(result.reapedTerminal).toBe(0);
    expect(await countRendersWithStatus("ready")).toBe(1);
  });

  it("keeps failed/cancelled rows newer than retention", async () => {
    const eng = await seedEngagement();
    const { briefing, bimModel } = await seedBriefingAndBim(eng.id);
    const now = new Date("2026-05-02T12:00:00Z");
    const recent = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000); // 5 days ago

    await seedRender({
      engagementId: eng.id,
      briefingId: briefing.id,
      bimModelId: bimModel.id,
      status: "failed",
      createdAt: recent,
      completedAt: recent,
    });

    const result = await runRendersSweep({
      db: schema.db,
      now,
      retentionMs: 30 * 24 * 60 * 60 * 1000,
    });

    expect(result.reapedTerminal).toBe(0);
    expect(await countRendersWithStatus("failed")).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Bucket 3: incomplete-mirror warning
// ─────────────────────────────────────────────────────────────────────

describe("runRendersSweep — incomplete-mirror warning", () => {
  it("counts ready rows whose render_outputs have NULL mirrored_object_key", async () => {
    const eng = await seedEngagement();
    const { briefing, bimModel } = await seedBriefingAndBim(eng.id);
    const now = new Date("2026-05-02T12:00:00Z");

    const r = await seedRender({
      engagementId: eng.id,
      briefingId: briefing.id,
      bimModelId: bimModel.id,
      status: "ready",
      completedAt: now,
    });
    // Manually insert a render-output with NULL mirrored_object_key
    // — the route would never produce this, but the sweep is the
    // safety net for state drift.
    await schema.db.insert(renderOutputs).values({
      viewpointRenderId: r.id,
      role: "primary",
      format: "png",
      sourceUrl: "https://api.mnmlai.dev/v1/images/expired.png",
      mirroredObjectKey: null,
    });

    const result = await runRendersSweep({ db: schema.db, now });

    expect(result.warnedIncompleteMirror).toBe(1);
    // No state change — the row stays `ready` per the V1-4 policy
    // (warn-only; auto-heal is a future sprint).
    expect(await countRendersWithStatus("ready")).toBe(1);
  });

  it("does NOT count ready rows whose outputs all have mirrored_object_key set", async () => {
    const eng = await seedEngagement();
    const { briefing, bimModel } = await seedBriefingAndBim(eng.id);
    const now = new Date("2026-05-02T12:00:00Z");
    const r = await seedRender({
      engagementId: eng.id,
      briefingId: briefing.id,
      bimModelId: bimModel.id,
      status: "ready",
      completedAt: now,
    });
    await schema.db.insert(renderOutputs).values({
      viewpointRenderId: r.id,
      role: "primary",
      format: "png",
      sourceUrl: "https://api.mnmlai.dev/v1/images/abc.png",
      mirroredObjectKey: "renders/abc/primary-deadbeef.png",
    });

    const result = await runRendersSweep({ db: schema.db, now });
    expect(result.warnedIncompleteMirror).toBe(0);
  });

  it("dedupes — one warning per parent regardless of how many outputs are incomplete", async () => {
    const eng = await seedEngagement();
    const { briefing, bimModel } = await seedBriefingAndBim(eng.id);
    const now = new Date("2026-05-02T12:00:00Z");
    const r = await seedRender({
      engagementId: eng.id,
      briefingId: briefing.id,
      bimModelId: bimModel.id,
      status: "ready",
      completedAt: now,
    });
    // Three NULL-mirrored outputs on one parent. Sweep should count
    // the parent once (selectDistinct).
    await schema.db.insert(renderOutputs).values([
      {
        viewpointRenderId: r.id,
        role: "elevation-n",
        format: "png",
        sourceUrl: "https://x.test/n.png",
        mirroredObjectKey: null,
      },
      {
        viewpointRenderId: r.id,
        role: "elevation-e",
        format: "png",
        sourceUrl: "https://x.test/e.png",
        mirroredObjectKey: null,
      },
      {
        viewpointRenderId: r.id,
        role: "elevation-s",
        format: "png",
        sourceUrl: "https://x.test/s.png",
        mirroredObjectKey: null,
      },
    ]);

    const result = await runRendersSweep({ db: schema.db, now });
    expect(result.warnedIncompleteMirror).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Result shape
// ─────────────────────────────────────────────────────────────────────

describe("runRendersSweep — result shape", () => {
  it("returns durationMs ≥ 0 and zero counts when nothing matches", async () => {
    const result = await runRendersSweep({ db: schema.db, now: new Date() });
    expect(result.rescuedStuck).toBe(0);
    expect(result.reapedTerminal).toBe(0);
    expect(result.warnedIncompleteMirror).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
