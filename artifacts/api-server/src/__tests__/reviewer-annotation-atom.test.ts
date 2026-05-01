/**
 * Reviewer-annotation atom contract test (Wave 2 Sprint C / Spec 307).
 *
 * Two suites:
 *   1. `runAtomContractTests` against a seeded `reviewer_annotations`
 *      row. Every concrete child target type the composition declares
 *      (submission, briefing-source, materializable-element,
 *      briefing-divergence, sheet, parcel-briefing) plus their own
 *      transitively-required children is registered in the test
 *      registry so the contract suite's "composition references
 *      resolve" step passes.
 *   2. Registration-shape assertions covering the Spec 307 event
 *      vocabulary, all-five render modes, and the six-target
 *      composition surface.
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
        throw new Error("reviewer-annotation-atom.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { createTestSchema, dropTestSchema } = await import(
  "@workspace/db/testing"
);
const dbModule = await import("@workspace/db");
const { engagements, submissions, reviewerAnnotations } = dbModule;
const { runAtomContractTests } = await import(
  "@workspace/empressa-atom/testing"
);
const {
  makeReviewerAnnotationAtom,
  REVIEWER_ANNOTATION_EVENT_TYPES,
  REVIEWER_ANNOTATION_SUPPORTED_MODES,
} = await import("../atoms/reviewer-annotation.atom");
const { makeSubmissionAtom } = await import("../atoms/submission.atom");
const { makeSheetAtom } = await import("../atoms/sheet.atom");
const { makeBriefingSourceAtom } = await import(
  "../atoms/briefing-source.atom"
);
const { makeParcelBriefingAtom } = await import(
  "../atoms/parcel-briefing.atom"
);
const { makeIntentAtom } = await import("../atoms/intent.atom");
const { makeMaterializableElementAtom } = await import(
  "../atoms/materializable-element.atom"
);
const { makeBriefingDivergenceAtom } = await import(
  "../atoms/briefing-divergence.atom"
);
const { makeBimModelAtom } = await import("../atoms/bim-model.atom");
const { makeEngagementAtom } = await import("../atoms/engagement.atom");
const { makeSnapshotAtom } = await import("../atoms/snapshot.atom");

const lazyDb = new Proxy({} as typeof dbModule.db, {
  get: (_t, prop) => Reflect.get(dbModule.db as object, prop, dbModule.db),
});

const ENGAGEMENT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SUBMISSION_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ANNOTATION_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

async function seed(): Promise<void> {
  if (!ctx.schema)
    throw new Error("reviewer-annotation-atom.test: ctx.schema not set");
  const db = ctx.schema.db;
  await db.insert(engagements).values({
    id: ENGAGEMENT_ID,
    name: "Reviewer Annotation Atom Contract",
    nameLower: "reviewer-annotation-atom-contract",
    jurisdiction: "Moab, UT",
    jurisdictionCity: "Moab",
    jurisdictionState: "UT",
    address: "1 Reviewer Way",
  });
  await db.insert(submissions).values({
    id: SUBMISSION_ID,
    engagementId: ENGAGEMENT_ID,
    jurisdiction: "Moab, UT",
    jurisdictionCity: "Moab",
    jurisdictionState: "UT",
    jurisdictionFips: "4950150",
    note: "Permit set v1.",
  });
  await db.insert(reviewerAnnotations).values({
    id: ANNOTATION_ID,
    submissionId: SUBMISSION_ID,
    targetEntityType: "submission",
    targetEntityId: SUBMISSION_ID,
    reviewerId: "reviewer-1",
    body: "Need clarification on setback override.",
    category: "concern",
  });
}

describe("reviewer-annotation atom (contract)", () => {
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

  const annotationAtom = makeReviewerAnnotationAtom({ db: lazyDb });

  // The composition declares all six target atom types as concrete
  // children; register every one of them (plus the transitively-
  // required leaves like `intent` for parcel-briefing) so the
  // contract suite's "composition references resolve" check passes.
  runAtomContractTests(annotationAtom, {
    withFixture: { entityId: ANNOTATION_ID },
    alsoRegister: [
      makeSubmissionAtom({ db: lazyDb }),
      makeSheetAtom({ db: lazyDb }),
      makeBriefingSourceAtom(),
      makeParcelBriefingAtom(),
      makeIntentAtom(),
      makeMaterializableElementAtom({ db: lazyDb }),
      makeBriefingDivergenceAtom({ db: lazyDb }),
      // briefing-divergence composes bim-model concretely; bim-model
      // composes engagement; engagement composes snapshot. Pull the
      // whole transitive set so the registry validator's "every
      // non-forwardRef edge resolves" pass succeeds.
      makeBimModelAtom({ db: lazyDb }),
      makeEngagementAtom({ db: lazyDb }),
      makeSnapshotAtom({ db: lazyDb }),
    ],
  });
});

describe("reviewer-annotation atom (registration shape)", () => {
  it("declares the Spec 307 event vocabulary", () => {
    const atom = makeReviewerAnnotationAtom({ db: lazyDb });
    expect(atom.eventTypes).toEqual([...REVIEWER_ANNOTATION_EVENT_TYPES]);
    expect(atom.eventTypes).toContain("reviewer-annotation.created");
    expect(atom.eventTypes).toContain("reviewer-annotation.replied");
    expect(atom.eventTypes).toContain("reviewer-annotation.promoted");
  });

  it("declares all five render modes per Spec 20 §10", () => {
    const atom = makeReviewerAnnotationAtom({ db: lazyDb });
    expect(atom.supportedModes).toEqual([
      ...REVIEWER_ANNOTATION_SUPPORTED_MODES,
    ]);
    expect(atom.supportedModes).toHaveLength(5);
    // defaultMode is `compact` so the atom appears as a line item
    // inside its parent target's side panel.
    expect(atom.defaultMode).toBe("compact");
  });

  it("composes every Spec 307 target type as a concrete child edge", () => {
    const atom = makeReviewerAnnotationAtom({ db: lazyDb });
    const byType = new Map(
      atom.composition.map((c) => [c.childEntityType, c]),
    );
    for (const t of [
      "submission",
      "briefing-source",
      "materializable-element",
      "briefing-divergence",
      "sheet",
      "parcel-briefing",
    ] as const) {
      const edge = byType.get(t);
      expect(edge, `composition missing target ${t}`).toBeDefined();
      // None of the target edges are forward-refs — the atom
      // contract test relies on every composition row resolving
      // against an already-registered child.
      expect(edge?.forwardRef).toBeFalsy();
    }
    expect(atom.composition).toHaveLength(6);
  });

  it("entityType and domain match Spec 307 contract", () => {
    const atom = makeReviewerAnnotationAtom({ db: lazyDb });
    expect(atom.entityType).toBe("reviewer-annotation");
    expect(atom.domain).toBe("plan-review");
  });
});
