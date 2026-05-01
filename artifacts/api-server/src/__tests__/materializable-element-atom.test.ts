/**
 * Materializable-element atom contract test.
 *
 * Two suites:
 *   1. `runAtomContractTests` against a seeded `materializable_elements`
 *      row in a per-file Postgres test schema. The concrete child atoms
 *      (`parcel-briefing`, `briefing-source`, `briefing-divergence`)
 *      plus their own concrete children are also registered so the
 *      contract suite's "composition references resolve in the
 *      registry" step passes.
 *   2. Registration-shape assertions covering the Spec 51 §6 / Task #175
 *      event vocabulary (`materializable-element.identified` is the
 *      first entry — the briefing-generate route emits it via
 *      `MATERIALIZABLE_ELEMENT_EVENT_TYPES[0]`), the all-five render
 *      modes, and the parcel-briefing/briefing-source/briefing-divergence
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
        throw new Error("materializable-element-atom.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { createTestSchema, dropTestSchema } = await import(
  "@workspace/db/testing"
);
const dbModule = await import("@workspace/db");
const { engagements, parcelBriefings, materializableElements } = dbModule;
const { runAtomContractTests } = await import(
  "@workspace/empressa-atom/testing"
);
const {
  makeMaterializableElementAtom,
  MATERIALIZABLE_ELEMENT_EVENT_TYPES,
  MATERIALIZABLE_ELEMENT_SUPPORTED_MODES,
} = await import("../atoms/materializable-element.atom");
const { makeParcelBriefingAtom } = await import(
  "../atoms/parcel-briefing.atom"
);
const { makeIntentAtom } = await import("../atoms/intent.atom");
const { makeBriefingSourceAtom } = await import(
  "../atoms/briefing-source.atom"
);
const { makeBriefingDivergenceAtom } = await import(
  "../atoms/briefing-divergence.atom"
);
const { makeBimModelAtom } = await import("../atoms/bim-model.atom");
const { makeEngagementAtom } = await import("../atoms/engagement.atom");
const { makeSheetAtom } = await import("../atoms/sheet.atom");
const { makeSnapshotAtom } = await import("../atoms/snapshot.atom");
const { makeSubmissionAtom } = await import("../atoms/submission.atom");

const lazyDb = new Proxy({} as typeof dbModule.db, {
  get: (_t, prop) => Reflect.get(dbModule.db as object, prop, dbModule.db),
});

const ENGAGEMENT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BRIEFING_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ELEMENT_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

async function seed(): Promise<void> {
  if (!ctx.schema)
    throw new Error("materializable-element-atom.test: ctx.schema not set");
  const db = ctx.schema.db;

  await db.insert(engagements).values({
    id: ENGAGEMENT_ID,
    name: "Materializable Element Atom Contract",
    nameLower: "materializable-element-atom-contract",
    jurisdiction: "Boulder, CO",
    address: "1 Pearl St",
    status: "active",
  });

  await db.insert(parcelBriefings).values({
    id: BRIEFING_ID,
    engagementId: ENGAGEMENT_ID,
  });

  await db.insert(materializableElements).values({
    id: ELEMENT_ID,
    briefingId: BRIEFING_ID,
    elementKind: "buildable-envelope",
    label: "Test envelope",
    geometry: { ring: [] },
  });
}

describe("materializable-element atom (contract)", () => {
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

  const atom = makeMaterializableElementAtom({ db: lazyDb });

  // The non-forward-ref edges from materializable-element are
  // `parcel-briefing`, `briefing-source`, and `briefing-divergence`.
  // briefing-divergence in turn has concrete edges to `bim-model`,
  // `materializable-element`, and `parcel-briefing`; bim-model has
  // concrete edges to `engagement` (which pulls in sheet/snapshot/
  // submission), `parcel-briefing`, and `briefing-divergence`.
  // parcel-briefing pulls in intent and briefing-source.
  runAtomContractTests(atom, {
    withFixture: { entityId: ELEMENT_ID },
    alsoRegister: [
      makeParcelBriefingAtom(),
      makeBriefingSourceAtom(),
      makeBriefingDivergenceAtom({ db: lazyDb }),
      makeBimModelAtom({ db: lazyDb }),
      makeEngagementAtom({ db: lazyDb }),
      makeIntentAtom(),
      makeSheetAtom({ db: lazyDb }),
      makeSnapshotAtom({ db: lazyDb }),
      makeSubmissionAtom({ db: lazyDb }),
    ],
  });
});

describe("materializable-element atom (registration shape)", () => {
  it("declares the Task #175 / Spec 51 §6 event vocabulary with `.identified` at index 0", () => {
    const atom = makeMaterializableElementAtom({ db: lazyDb });
    expect(atom.eventTypes).toEqual([...MATERIALIZABLE_ELEMENT_EVENT_TYPES]);
    expect(atom.eventTypes?.[0]).toBe("materializable-element.identified");
    expect(atom.eventTypes).toContain("materializable-element.materialized");
    expect(atom.eventTypes).toContain("materializable-element.emitted");
    expect(atom.eventTypes).toContain("materializable-element.refreshed");
  });

  it("declares all five render modes per Spec 20 §10", () => {
    const atom = makeMaterializableElementAtom({ db: lazyDb });
    expect(atom.supportedModes).toEqual([
      ...MATERIALIZABLE_ELEMENT_SUPPORTED_MODES,
    ]);
    expect(atom.supportedModes).toHaveLength(5);
    // Per Spec 51a §2.14 — "compact (line in requirement list)" is the
    // primary presentation mode for a materializable element.
    expect(atom.defaultMode).toBe("compact");
  });

  it("composition: parcel-briefing + briefing-source + briefing-divergence concrete edges", () => {
    const atom = makeMaterializableElementAtom({ db: lazyDb });
    const byKey = new Map(atom.composition.map((c) => [c.childEntityType, c]));
    expect(byKey.get("parcel-briefing")?.forwardRef).toBeFalsy();
    expect(byKey.get("briefing-source")?.forwardRef).toBeFalsy();
    expect(byKey.get("briefing-divergence")?.forwardRef).toBeFalsy();
  });
});
