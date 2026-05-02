/**
 * Reviewer-request atom contract test (Wave 2 Sprint D / V1-2).
 *
 * Two suites:
 *   1. `runAtomContractTests` against a seeded `reviewer_requests`
 *      row. Every concrete child target type the composition declares
 *      (engagement, briefing-source, bim-model, parcel-briefing) plus
 *      their own transitively-required children is registered in the
 *      test registry so the contract suite's "composition references
 *      resolve" step passes.
 *   2. Registration-shape assertions covering the V1-2 event
 *      vocabulary (3 .requested + 3 .dismissed, no .honored), all
 *      five render modes, and the four-edge composition surface
 *      (engagement parent + 3 polymorphic targets).
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
        throw new Error("reviewer-request-atom.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { createTestSchema, dropTestSchema } = await import(
  "@workspace/db/testing"
);
const dbModule = await import("@workspace/db");
const { engagements, reviewerRequests } = dbModule;
const { runAtomContractTests } = await import(
  "@workspace/empressa-atom/testing"
);
const {
  makeReviewerRequestAtom,
  REVIEWER_REQUEST_EVENT_TYPES,
  REVIEWER_REQUEST_SUPPORTED_MODES,
  REVIEWER_REQUEST_KIND_TO_TARGET_TYPE,
} = await import("../atoms/reviewer-request.atom");
const { makeBriefingSourceAtom } = await import(
  "../atoms/briefing-source.atom"
);
const { makeParcelBriefingAtom } = await import(
  "../atoms/parcel-briefing.atom"
);
const { makeIntentAtom } = await import("../atoms/intent.atom");
const { makeBimModelAtom } = await import("../atoms/bim-model.atom");
const { makeMaterializableElementAtom } = await import(
  "../atoms/materializable-element.atom"
);
const { makeBriefingDivergenceAtom } = await import(
  "../atoms/briefing-divergence.atom"
);
const { makeEngagementAtom } = await import("../atoms/engagement.atom");
const { makeSnapshotAtom } = await import("../atoms/snapshot.atom");
const { makeNeighboringContextAtom } = await import(
  "../atoms/neighboring-context.atom"
);
const { makeViewpointRenderAtom } = await import(
  "../atoms/viewpoint-render.atom"
);
const { makeRenderOutputAtom } = await import(
  "../atoms/render-output.atom"
);
const { makeSubmissionAtom } = await import("../atoms/submission.atom");
const { makeSheetAtom } = await import("../atoms/sheet.atom");

const lazyDb = new Proxy({} as typeof dbModule.db, {
  get: (_t, prop) => Reflect.get(dbModule.db as object, prop, dbModule.db),
});

const ENGAGEMENT_ID = "11111111-1111-1111-1111-111111111111";
const REQUEST_ID = "22222222-2222-2222-2222-222222222222";
const TARGET_BRIEFING_SOURCE_ID = "33333333-3333-3333-3333-333333333333";

async function seed(): Promise<void> {
  if (!ctx.schema)
    throw new Error("reviewer-request-atom.test: ctx.schema not set");
  const db = ctx.schema.db;
  await db.insert(engagements).values({
    id: ENGAGEMENT_ID,
    name: "Reviewer Request Atom Contract",
    nameLower: "reviewer-request-atom-contract",
    jurisdiction: "Moab, UT",
    jurisdictionCity: "Moab",
    jurisdictionState: "UT",
    address: "1 Reviewer Way",
  });
  await db.insert(reviewerRequests).values({
    id: REQUEST_ID,
    engagementId: ENGAGEMENT_ID,
    requestKind: "refresh-briefing-source",
    targetEntityType: "briefing-source",
    targetEntityId: TARGET_BRIEFING_SOURCE_ID,
    reason: "Source PDF appears outdated.",
    status: "pending",
    requestedBy: {
      kind: "user",
      id: "reviewer-1",
      displayName: "Alex Reviewer",
    },
  });
}

describe("reviewer-request atom (contract)", () => {
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

  const requestAtom = makeReviewerRequestAtom({ db: lazyDb });

  // The composition declares engagement + the three target atom
  // types (briefing-source, bim-model, parcel-briefing). Pull every
  // transitive dependency into the registry so the contract suite's
  // "every non-forwardRef edge resolves" pass succeeds.
  runAtomContractTests(requestAtom, {
    withFixture: { entityId: REQUEST_ID },
    alsoRegister: [
      // Direct target edges.
      makeBriefingSourceAtom(),
      makeBimModelAtom({ db: lazyDb }),
      makeParcelBriefingAtom(),
      // Transitive: engagement is the parent edge AND parcel-briefing
      // composes intent which composes engagement, so engagement +
      // intent are required.
      makeEngagementAtom({ db: lazyDb }),
      makeIntentAtom(),
      // Transitive from bim-model: materializable-element +
      // briefing-divergence + snapshot + neighboring-context +
      // viewpoint-render — same chain reviewer-annotation pulls.
      makeMaterializableElementAtom({ db: lazyDb }),
      makeBriefingDivergenceAtom({ db: lazyDb }),
      makeSnapshotAtom({ db: lazyDb }),
      makeNeighboringContextAtom(),
      makeViewpointRenderAtom(),
      // V1-4 DA-RP-1: viewpoint-render composes render-output transitively.
      makeRenderOutputAtom(),
      // V1-2: reviewer-request → engagement → submission, and
      // engagement → snapshot → sheet. Both leaves must be
      // registered for validate() to succeed; sibling
      // reviewer-annotation already registers them.
      makeSubmissionAtom({ db: lazyDb }),
      makeSheetAtom({ db: lazyDb }),
    ],
  });
});

describe("reviewer-request atom (registration shape)", () => {
  it("declares the V1-2 event vocabulary (6 types: 3 .requested + 3 .dismissed)", () => {
    const atom = makeReviewerRequestAtom({ db: lazyDb });
    expect(atom.eventTypes).toEqual([...REVIEWER_REQUEST_EVENT_TYPES]);
    expect(atom.eventTypes).toHaveLength(6);
    // Three .requested per kind.
    expect(atom.eventTypes).toContain(
      "reviewer-request.refresh-briefing-source.requested",
    );
    expect(atom.eventTypes).toContain(
      "reviewer-request.refresh-bim-model.requested",
    );
    expect(atom.eventTypes).toContain(
      "reviewer-request.regenerate-briefing.requested",
    );
    // Three .dismissed per kind.
    expect(atom.eventTypes).toContain(
      "reviewer-request.refresh-briefing-source.dismissed",
    );
    expect(atom.eventTypes).toContain(
      "reviewer-request.refresh-bim-model.dismissed",
    );
    expect(atom.eventTypes).toContain(
      "reviewer-request.regenerate-briefing.dismissed",
    );
    // V1-2 minimum cut deliberately omits .honored — the matching
    // domain action's existing event (e.g. briefing-source.refreshed)
    // is the resolution signal, hooked by reviewerRequestResolution.ts.
    expect(
      (atom.eventTypes as readonly string[]).filter((t) => t.endsWith(".honored")),
    ).toEqual([]);
  });

  it("declares all five render modes per Spec 20 §10", () => {
    const atom = makeReviewerRequestAtom({ db: lazyDb });
    expect(atom.supportedModes).toEqual([
      ...REVIEWER_REQUEST_SUPPORTED_MODES,
    ]);
    expect(atom.supportedModes).toHaveLength(5);
    // defaultMode is `compact` so the atom appears as a line item
    // inside the architect's ReviewerRequestsStrip.
    expect(atom.defaultMode).toBe("compact");
  });

  it("composes engagement + the three target atom types declaratively", () => {
    const atom = makeReviewerRequestAtom({ db: lazyDb });
    const byType = new Map(
      atom.composition.map((c) => [c.childEntityType, c]),
    );
    // Engagement parent — always populated.
    expect(byType.get("engagement"), "missing engagement parent").toBeDefined();
    // Three polymorphic target edges.
    for (const t of [
      "briefing-source",
      "bim-model",
      "parcel-briefing",
    ] as const) {
      const edge = byType.get(t);
      expect(edge, `composition missing target ${t}`).toBeDefined();
      // None of the target edges are forward-refs — the atom contract
      // test relies on every composition row resolving against an
      // already-registered child.
      expect(edge?.forwardRef).toBeFalsy();
    }
    // 4 total (1 parent + 3 targets).
    expect(atom.composition).toHaveLength(4);
  });

  it("kind→target-type mapping is 1:1 across the three V1-2 kinds", () => {
    expect(
      REVIEWER_REQUEST_KIND_TO_TARGET_TYPE["refresh-briefing-source"],
    ).toBe("briefing-source");
    expect(REVIEWER_REQUEST_KIND_TO_TARGET_TYPE["refresh-bim-model"]).toBe(
      "bim-model",
    );
    expect(REVIEWER_REQUEST_KIND_TO_TARGET_TYPE["regenerate-briefing"]).toBe(
      "parcel-briefing",
    );
    // Pinned to exactly three entries so a future kind addition
    // forces a sibling map update.
    expect(Object.keys(REVIEWER_REQUEST_KIND_TO_TARGET_TYPE)).toHaveLength(3);
  });

  it("entityType and domain match V1-2 contract", () => {
    const atom = makeReviewerRequestAtom({ db: lazyDb });
    expect(atom.entityType).toBe("reviewer-request");
    expect(atom.domain).toBe("plan-review");
  });
});
