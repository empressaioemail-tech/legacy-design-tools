/**
 * Bim-model atom contract test (DA-PI-5).
 *
 * Mirrors the snapshot-atom layout: one per-file Postgres test
 * schema, `vi.mock("@workspace/db")` proxies `db` to the schema's
 * drizzle instance, and the atom factory is constructed with a
 * lazy `db` proxy so the contract suite's contextSummary call lands
 * against the live test schema.
 *
 * Coverage:
 *   - `runAtomContractTests` against a found bim-model row, with the
 *     concrete child atoms (`engagement`, `parcel-briefing`,
 *     `briefing-divergence`) registered so the contract suite's
 *     composition-resolution step passes. `materializable-element`
 *     is a forwardRef edge per the atom registration so it is not
 *     required in `alsoRegister`.
 *   - Behavioral cases beyond the contract suite:
 *       1. Refresh-status `current` when `materializedAt` is newer
 *          than the active briefing's `updatedAt`.
 *       2. Refresh-status `stale` when the briefing has been
 *          updated since materialization.
 *       3. Refresh-status `not-pushed` when `materializedAt` is null.
 *       4. Divergence count surfaces in `keyMetrics`.
 *       5. Unknown id returns the `typed.found: false` envelope.
 */

import { describe, beforeAll, afterAll, it, expect, vi } from "vitest";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("bim-model-atom.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { createTestSchema, dropTestSchema } = await import(
  "@workspace/db/testing"
);
const dbModule = await import("@workspace/db");
const {
  engagements,
  parcelBriefings,
  bimModels,
  materializableElements,
  briefingDivergences,
} = dbModule;
const { runAtomContractTests } = await import(
  "@workspace/empressa-atom/testing"
);
const { makeBimModelAtom } = await import("../atoms/bim-model.atom");
const { makeMaterializableElementAtom } = await import(
  "../atoms/materializable-element.atom"
);
const { makeBriefingDivergenceAtom } = await import(
  "../atoms/briefing-divergence.atom"
);
const { makeEngagementAtom } = await import("../atoms/engagement.atom");
const { makeParcelBriefingAtom } = await import(
  "../atoms/parcel-briefing.atom"
);
const { makeIntentAtom } = await import("../atoms/intent.atom");
const { makeBriefingSourceAtom } = await import(
  "../atoms/briefing-source.atom"
);
const { makeSheetAtom } = await import("../atoms/sheet.atom");
const { makeSnapshotAtom } = await import("../atoms/snapshot.atom");
const { makeSubmissionAtom } = await import("../atoms/submission.atom");
const { makeViewpointRenderAtom } = await import(
  "../atoms/viewpoint-render.atom"
);
const { makeNeighboringContextAtom } = await import(
  "../atoms/neighboring-context.atom"
);
const { makeRenderOutputAtom } = await import(
  "../atoms/render-output.atom"
);

const lazyDb = new Proxy({} as typeof dbModule.db, {
  get: (_t, prop) => Reflect.get(dbModule.db as object, prop, dbModule.db),
});

const ENGAGEMENT_ID = "11111111-1111-1111-1111-111111111111";
const BRIEFING_ID = "22222222-2222-2222-2222-222222222222";
const BIM_MODEL_ID = "33333333-3333-3333-3333-333333333333";
const STALE_BRIEFING_ID = "44444444-4444-4444-4444-444444444444";
const STALE_BIM_MODEL_ID = "55555555-5555-5555-5555-555555555555";
const NEVER_PUSHED_BRIEFING_ID = "66666666-6666-6666-6666-666666666666";
const NEVER_PUSHED_BIM_MODEL_ID = "77777777-7777-7777-7777-777777777777";
const ELEMENT_ID = "88888888-8888-8888-8888-888888888881";
const DIVERGENCE_ID = "99999999-9999-9999-9999-999999999991";

async function seed(): Promise<void> {
  if (!ctx.schema) throw new Error("bim-model-atom.test: ctx.schema not set");
  const db = ctx.schema.db;

  await db.insert(engagements).values({
    id: ENGAGEMENT_ID,
    name: "Bim-Model Atom Contract",
    nameLower: "bim-model-atom-contract",
    jurisdiction: "Boulder, CO",
    address: "1 Pearl St",
    status: "active",
  });

  // Three briefings, each owned by the same engagement on the wire
  // but pinned to different bim-models below by id. The unique
  // constraint on `bim_models.engagement_id` blocks reusing the
  // engagement for three bim-models, so we create two extra
  // engagements for the stale + never-pushed cases.
  const STALE_ENGAGEMENT_ID = "11111111-1111-1111-1111-111111111112";
  const NEVER_PUSHED_ENGAGEMENT_ID = "11111111-1111-1111-1111-111111111113";

  await db.insert(engagements).values([
    {
      id: STALE_ENGAGEMENT_ID,
      name: "Bim-Model Atom Contract (stale)",
      nameLower: "bim-model-atom-contract-stale",
      jurisdiction: "Boulder, CO",
      address: "2 Pearl St",
      status: "active",
    },
    {
      id: NEVER_PUSHED_ENGAGEMENT_ID,
      name: "Bim-Model Atom Contract (never)",
      nameLower: "bim-model-atom-contract-never",
      jurisdiction: "Boulder, CO",
      address: "3 Pearl St",
      status: "active",
    },
  ]);

  // Briefing for the "current" case: updatedAt strictly older than
  // the bim-model's materializedAt.
  await db.insert(parcelBriefings).values([
    {
      id: BRIEFING_ID,
      engagementId: ENGAGEMENT_ID,
      updatedAt: new Date("2026-04-01T00:00:00Z"),
    },
    {
      id: STALE_BRIEFING_ID,
      engagementId: STALE_ENGAGEMENT_ID,
      updatedAt: new Date("2026-04-15T12:00:00Z"),
    },
    {
      id: NEVER_PUSHED_BRIEFING_ID,
      engagementId: NEVER_PUSHED_ENGAGEMENT_ID,
      updatedAt: new Date("2026-04-15T12:00:00Z"),
    },
  ]);

  await db.insert(bimModels).values([
    {
      id: BIM_MODEL_ID,
      engagementId: ENGAGEMENT_ID,
      activeBriefingId: BRIEFING_ID,
      materializedAt: new Date("2026-04-10T00:00:00Z"),
      revitDocumentPath: "/projects/contract.rvt",
    },
    {
      id: STALE_BIM_MODEL_ID,
      engagementId: STALE_ENGAGEMENT_ID,
      activeBriefingId: STALE_BRIEFING_ID,
      // Materialized BEFORE the briefing's updatedAt → stale.
      materializedAt: new Date("2026-04-10T00:00:00Z"),
    },
    {
      id: NEVER_PUSHED_BIM_MODEL_ID,
      engagementId: NEVER_PUSHED_ENGAGEMENT_ID,
      activeBriefingId: NEVER_PUSHED_BRIEFING_ID,
      // No materializedAt → not-pushed.
      materializedAt: null,
    },
  ]);

  await db.insert(materializableElements).values({
    id: ELEMENT_ID,
    briefingId: BRIEFING_ID,
    elementKind: "buildable-envelope",
    label: "Test envelope",
    geometry: { ring: [] },
  });

  // One divergence on the "current" bim-model so the keyMetrics
  // count assertion has a non-zero floor.
  await db.insert(briefingDivergences).values({
    id: DIVERGENCE_ID,
    bimModelId: BIM_MODEL_ID,
    materializableElementId: ELEMENT_ID,
    briefingId: BRIEFING_ID,
    reason: "geometry-edited",
    note: "moved a vertex",
  });
}

describe("bim-model atom (contract)", () => {
  beforeAll(async () => {
    ctx.schema = await createTestSchema();
    await seed();
  });

  afterAll(async () => {
    if (ctx.schema) {
      await dropTestSchema(ctx.schema);
      ctx.schema = null;
    }
  });

  const atom = makeBimModelAtom({ db: lazyDb });

  runAtomContractTests(atom, {
    withFixture: { entityId: BIM_MODEL_ID },
    // The non-forward-ref edges from bim-model are `engagement`,
    // `parcel-briefing`, and `briefing-divergence`. parcel-briefing
    // in turn has its own non-forward-ref children (intent and
    // briefing-source) so `validate()` requires them too. As of
    // DA-RP-0, `engagement` also composes `viewpoint-render`, which
    // in turn references `neighboring-context` — both must be
    // registered for `validate()` to succeed.
    alsoRegister: [
      // bim-model's direct concrete edges:
      makeEngagementAtom({ db: lazyDb }),
      makeParcelBriefingAtom(),
      makeBriefingDivergenceAtom({ db: lazyDb }),
      // briefing-divergence and parcel-briefing in turn require:
      makeMaterializableElementAtom({ db: lazyDb }),
      makeIntentAtom(),
      makeBriefingSourceAtom(),
      // engagement requires:
      makeSheetAtom({ db: lazyDb }),
      makeSnapshotAtom({ db: lazyDb }),
      makeSubmissionAtom({ db: lazyDb }),
      // DA-RP-0: engagement composes viewpoint-render, which in turn
      // composes neighboring-context (bim-model + parcel-briefing
      // are already in this list above).
      makeViewpointRenderAtom(),
      makeNeighboringContextAtom(),
      // V1-4 DA-RP-1: viewpoint-render composes render-output.
      makeRenderOutputAtom(),
    ],
  });
});

describe("bim-model atom (refresh-status behavior)", () => {
  beforeAll(async () => {
    if (!ctx.schema) {
      ctx.schema = await createTestSchema();
      await seed();
    }
  });

  afterAll(async () => {
    if (ctx.schema) {
      await dropTestSchema(ctx.schema);
      ctx.schema = null;
    }
  });

  it("returns current when materializedAt is newer than briefing.updatedAt", async () => {
    const atom = makeBimModelAtom({ db: lazyDb });
    const summary = await atom.contextSummary(BIM_MODEL_ID, {
      audience: "internal",
    });
    expect(
      (summary.typed as { refreshStatus?: string }).refreshStatus,
    ).toBe("current");
    expect(summary.keyMetrics).toContainEqual({
      label: "Refresh status",
      value: "current",
    });
  });

  it("returns stale when briefing.updatedAt is newer than materializedAt", async () => {
    const atom = makeBimModelAtom({ db: lazyDb });
    const summary = await atom.contextSummary(STALE_BIM_MODEL_ID, {
      audience: "internal",
    });
    expect(
      (summary.typed as { refreshStatus?: string }).refreshStatus,
    ).toBe("stale");
    expect(summary.prose).toContain("re-push needed");
  });

  it("returns not-pushed when materializedAt is null", async () => {
    const atom = makeBimModelAtom({ db: lazyDb });
    const summary = await atom.contextSummary(NEVER_PUSHED_BIM_MODEL_ID, {
      audience: "internal",
    });
    expect(
      (summary.typed as { refreshStatus?: string }).refreshStatus,
    ).toBe("not-pushed");
    expect(summary.prose).toContain("Not yet pushed to Revit");
  });

  it("surfaces divergence count in keyMetrics", async () => {
    const atom = makeBimModelAtom({ db: lazyDb });
    const summary = await atom.contextSummary(BIM_MODEL_ID, {
      audience: "internal",
    });
    expect(summary.keyMetrics).toContainEqual({
      label: "Divergences",
      value: 1,
    });
    expect(
      (summary.typed as { divergenceCount?: number }).divergenceCount,
    ).toBe(1);
  });

  it("returns the not-found envelope for an unknown id", async () => {
    const atom = makeBimModelAtom({ db: lazyDb });
    const summary = await atom.contextSummary(
      "00000000-0000-0000-0000-000000000000",
      { audience: "internal" },
    );
    expect((summary.typed as { found?: boolean }).found).toBe(false);
    expect(summary.prose).toContain("could not be found");
  });
});
