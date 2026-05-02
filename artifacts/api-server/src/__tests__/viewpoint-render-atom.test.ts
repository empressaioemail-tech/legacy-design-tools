/**
 * Viewpoint-render atom contract test (DA-RP-0 sprint, shape-only).
 *
 * No Postgres schema needed — viewpoint-render is registration-only
 * this sprint; the renders persistence layer ships in DA-RP-1.
 *
 * `alsoRegister` includes every non-forward-ref child atom the
 * viewpoint-render composition declares (engagement, parcel-briefing,
 * bim-model, neighboring-context) plus the transitive non-forward-ref
 * children those atoms in turn declare so the contract suite's
 * "composition references resolve in the registry" step passes when
 * the test registry's `validate()` runs.
 *
 * The factory dependencies (db / history) are passed where required;
 * the registrations don't actually issue queries at module-load time
 * thanks to the lazy `register()` contract — the contract suite only
 * walks the composition graph, not the data fetcher.
 */

import { describe, it, expect } from "vitest";
import {
  runAtomContractTests,
  createInMemoryEventService,
} from "@workspace/empressa-atom/testing";
import { db } from "@workspace/db";
import {
  makeViewpointRenderAtom,
  VIEWPOINT_RENDER_EVENT_TYPES,
  VIEWPOINT_RENDER_SUPPORTED_MODES,
} from "../atoms/viewpoint-render.atom";
import { makeEngagementAtom } from "../atoms/engagement.atom";
import { makeSnapshotAtom } from "../atoms/snapshot.atom";
import { makeSheetAtom } from "../atoms/sheet.atom";
import { makeSubmissionAtom } from "../atoms/submission.atom";
import { makeParcelBriefingAtom } from "../atoms/parcel-briefing.atom";
import { makeIntentAtom } from "../atoms/intent.atom";
import { makeBriefingSourceAtom } from "../atoms/briefing-source.atom";
import { makeNeighboringContextAtom } from "../atoms/neighboring-context.atom";
import { makeBimModelAtom } from "../atoms/bim-model.atom";
import { makeMaterializableElementAtom } from "../atoms/materializable-element.atom";
import { makeBriefingDivergenceAtom } from "../atoms/briefing-divergence.atom";
import { makeRenderOutputAtom } from "../atoms/render-output.atom";

describe("viewpoint-render atom (contract)", () => {
  const atom = makeViewpointRenderAtom({
    history: createInMemoryEventService(),
  });

  runAtomContractTests(atom, {
    // Real-shape Spec 54 §3 entityId pattern:
    // `viewpoint-render:{engagementId}:{ulid}`.
    withFixture: {
      entityId:
        "viewpoint-render:eng-001:01HZZZZZZZZZZZZZZZZZZZZZZZ",
    },
    alsoRegister: [
      // viewpoint-render's direct concrete children:
      makeEngagementAtom({ db }),
      makeParcelBriefingAtom(),
      makeBimModelAtom({ db }),
      makeNeighboringContextAtom(),
      // Transitive concrete children needed for validate():
      //   - engagement composes snapshot, submission, parcel-briefing,
      //     viewpoint-render (this atom)
      //   - snapshot composes sheet
      //   - parcel-briefing composes intent + briefing-source (concrete)
      //   - bim-model composes materializable-element + briefing-divergence
      //     (concrete)
      //   - briefing-divergence composes materializable-element (already
      //     registered) and parcel-briefing
      makeSheetAtom({ db }),
      makeSnapshotAtom({ db }),
      makeSubmissionAtom({ db }),
      makeIntentAtom(),
      makeBriefingSourceAtom(),
      makeMaterializableElementAtom({ db }),
      makeBriefingDivergenceAtom({ db }),
      // V1-4 DA-RP-1: viewpoint-render composes render-output.
      makeRenderOutputAtom(),
    ],
  });
});

describe("viewpoint-render atom (registration shape)", () => {
  it("declares the Spec 54 §3 event vocabulary plus V1-4 audit event", () => {
    const atom = makeViewpointRenderAtom();
    expect(atom.eventTypes).toEqual([...VIEWPOINT_RENDER_EVENT_TYPES]);
    // Eight Spec 54 §3 event types + the V1-4 Phase 1A
    // `unexpected-output-shape` audit event = 9.
    expect(atom.eventTypes).toHaveLength(9);
  });

  it("declares all five render modes per Spec 20 §10", () => {
    const atom = makeViewpointRenderAtom();
    expect(atom.supportedModes).toEqual([...VIEWPOINT_RENDER_SUPPORTED_MODES]);
    expect(atom.supportedModes).toHaveLength(5);
    // defaultMode is `card` per the catalog's "card-as-primary"
    // convention for surface atoms (Spec 54 §3 lists card as the
    // primary view).
    expect(atom.defaultMode).toBe("card");
  });

  it("composition: engagement / briefingAtRender / bimModelAtRender / neighboringContextAtRender all concrete", () => {
    const atom = makeViewpointRenderAtom();
    const byKey = new Map(
      atom.composition.map((c) => [c.childEntityType, c]),
    );
    const engagement = byKey.get("engagement");
    const briefing = byKey.get("parcel-briefing");
    const bimModel = byKey.get("bim-model");
    const neighboring = byKey.get("neighboring-context");
    expect(engagement?.forwardRef).toBeFalsy();
    expect(briefing?.forwardRef).toBeFalsy();
    expect(bimModel?.forwardRef).toBeFalsy();
    expect(neighboring?.forwardRef).toBeFalsy();
    // Snapshot semantics (Spec 54 §6) live in the dataKey naming so
    // the renders persistence layer can wire `briefingAtRender` /
    // `bimModelAtRender` / `neighboringContextAtRender` directly.
    expect(briefing?.dataKey).toBe("briefingAtRender");
    expect(bimModel?.dataKey).toBe("bimModelAtRender");
    expect(neighboring?.dataKey).toBe("neighboringContextAtRender");
  });

  it("contextSummary returns the not-found envelope on any id", async () => {
    const atom = makeViewpointRenderAtom();
    const summary = await atom.contextSummary(
      "viewpoint-render:eng-001:never-rendered",
      { audience: "internal" },
    );
    expect(summary.typed).toEqual({
      id: "viewpoint-render:eng-001:never-rendered",
      found: false,
    });
    expect(summary.relatedAtoms).toEqual([]);
    expect(summary.keyMetrics).toEqual([]);
    expect(summary.scopeFiltered).toBe(false);
    expect(typeof summary.prose).toBe("string");
    expect(summary.prose.length).toBeGreaterThan(0);
  });

  it("integrates with render-output as that atom's required parent", () => {
    // Sanity check that the render-output → viewpoint-render edge
    // continues to point at this atom's entityType. A rename of
    // `viewpoint-render` would surface here as well as in the catalog
    // assertions.
    const renderOutput = makeRenderOutputAtom();
    const viewpointRender = makeViewpointRenderAtom();
    const edge = renderOutput.composition.find(
      (c) => c.childEntityType === viewpointRender.entityType,
    );
    expect(edge).toBeDefined();
    expect(edge?.forwardRef).toBeFalsy();
  });
});
