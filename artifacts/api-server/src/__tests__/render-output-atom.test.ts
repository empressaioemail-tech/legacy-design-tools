/**
 * Render-output atom contract test (DA-RP-0 sprint, shape-only).
 *
 * No Postgres schema needed — render-output is registration-only this
 * sprint; the render_outputs persistence layer ships in DA-RP-1.
 *
 * `alsoRegister` includes the only non-forward-ref child the
 * render-output composition declares (viewpoint-render) plus the
 * transitive non-forward-ref children that atom in turn requires
 * (engagement, parcel-briefing, bim-model, neighboring-context, and
 * their own concrete children) so the contract suite's
 * "composition references resolve in the registry" step passes.
 */

import { describe, it, expect } from "vitest";
import {
  runAtomContractTests,
  createInMemoryEventService,
} from "@workspace/empressa-atom/testing";
import { db } from "@workspace/db";
import {
  makeRenderOutputAtom,
  RENDER_OUTPUT_EVENT_TYPES,
  RENDER_OUTPUT_SUPPORTED_MODES,
} from "../atoms/render-output.atom";
import { makeViewpointRenderAtom } from "../atoms/viewpoint-render.atom";
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

describe("render-output atom (contract)", () => {
  const atom = makeRenderOutputAtom({
    history: createInMemoryEventService(),
  });

  runAtomContractTests(atom, {
    // Real-shape Spec 54 §3 entityId pattern:
    // `render-output:{viewpointRenderId}:{ulid}`.
    withFixture: {
      entityId:
        "render-output:viewpoint-render:eng-001:01HZZZZZZZZZZZZZZZZZZZZZZZ:01HYYYYYYYYYYYYYYYYYYYYYYY",
    },
    alsoRegister: [
      // Direct concrete child:
      makeViewpointRenderAtom(),
      // Transitive concrete children needed for validate(): see
      // viewpoint-render-atom.test.ts for the same dependency list.
      makeEngagementAtom({ db }),
      makeSheetAtom({ db }),
      makeSnapshotAtom({ db }),
      makeSubmissionAtom({ db }),
      makeIntentAtom(),
      makeBriefingSourceAtom(),
      makeParcelBriefingAtom(),
      makeNeighboringContextAtom(),
      makeBimModelAtom({ db }),
      makeMaterializableElementAtom({ db }),
      makeBriefingDivergenceAtom({ db }),
    ],
  });
});

describe("render-output atom (registration shape)", () => {
  it("declares the Spec 54 §3 event vocabulary", () => {
    const atom = makeRenderOutputAtom();
    expect(atom.eventTypes).toEqual([...RENDER_OUTPUT_EVENT_TYPES]);
    expect(atom.eventTypes).toHaveLength(3);
  });

  it("declares all five render modes per Spec 20 §10", () => {
    const atom = makeRenderOutputAtom();
    expect(atom.supportedModes).toEqual([...RENDER_OUTPUT_SUPPORTED_MODES]);
    expect(atom.supportedModes).toHaveLength(5);
    // defaultMode is `compact` per Spec 54 §3's
    // "compact (thumbnail in galleries)" presentation guidance — a
    // render-output primarily appears as a thumbnail in its parent
    // viewpoint-render's output list.
    expect(atom.defaultMode).toBe("compact");
  });

  it("composition: viewpoint-render concrete (single required parent)", () => {
    const atom = makeRenderOutputAtom();
    expect(atom.composition).toHaveLength(1);
    const edge = atom.composition[0];
    expect(edge?.childEntityType).toBe("viewpoint-render");
    expect(edge?.forwardRef).toBeFalsy();
  });

  it("contextSummary returns the not-found envelope on any id", async () => {
    const atom = makeRenderOutputAtom();
    const summary = await atom.contextSummary(
      "render-output:viewpoint-render:eng-001:fake:never-persisted",
      { audience: "internal" },
    );
    expect(summary.typed).toEqual({
      id: "render-output:viewpoint-render:eng-001:fake:never-persisted",
      found: false,
    });
    expect(summary.relatedAtoms).toEqual([]);
    expect(summary.keyMetrics).toEqual([]);
    expect(summary.scopeFiltered).toBe(false);
    expect(typeof summary.prose).toBe("string");
    expect(summary.prose.length).toBeGreaterThan(0);
  });
});
