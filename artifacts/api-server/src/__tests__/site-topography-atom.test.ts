/**
 * Site-topography atom contract test (Phase 2D.1.3, shape-only).
 *
 * No Postgres schema needed — site-topography has no DB lookup yet
 * (data layer lands with the Phase 2D.1.2 DEM ingest worker, stacked
 * on the USGS 3DEP client in PR #98). The contract suite exercises
 * the structural envelope, the concrete `engagement` edge, and the
 * event vocabulary.
 */

import { describe, it, expect } from "vitest";
import {
  runAtomContractTests,
  createInMemoryEventService,
} from "@hauska/atom-contract/testing";
import * as dbModule from "@workspace/db";
import {
  makeSiteTopographyAtom,
  SITE_TOPOGRAPHY_EVENT_TYPES,
  SITE_TOPOGRAPHY_SUPPORTED_MODES,
} from "../atoms/site-topography.atom";
import { makeEngagementAtom } from "../atoms/engagement.atom";
import { makeSheetAtom } from "../atoms/sheet.atom";
import { makeSnapshotAtom } from "../atoms/snapshot.atom";
import { makeSubmissionAtom } from "../atoms/submission.atom";
import { makeIntentAtom } from "../atoms/intent.atom";
import { makeBriefingSourceAtom } from "../atoms/briefing-source.atom";
import { makeParcelBriefingAtom } from "../atoms/parcel-briefing.atom";
import { makeViewpointRenderAtom } from "../atoms/viewpoint-render.atom";
import { makeBimModelAtom } from "../atoms/bim-model.atom";
import { makeNeighboringContextAtom } from "../atoms/neighboring-context.atom";
import { makeBriefingDivergenceAtom } from "../atoms/briefing-divergence.atom";
import { makeMaterializableElementAtom } from "../atoms/materializable-element.atom";
import { makeRenderOutputAtom } from "../atoms/render-output.atom";

// Same lazyDb Proxy pattern used by bim-model-atom.test.ts and the
// other atom contract tests: defers `db` property resolution until
// first access so the registrations are constructible without
// touching a live Pool. The contract suite never exercises
// `contextSummary` for the registered-only atoms (it only needs them
// present so the composition edges resolve), so the Proxy is never
// triggered in practice.
const lazyDb = new Proxy({} as typeof dbModule.db, {
  get: (_t, prop) => Reflect.get(dbModule.db as object, prop, dbModule.db),
});

describe("site-topography atom (contract)", () => {
  const history = createInMemoryEventService();
  const atom = makeSiteTopographyAtom({ history });

  // site-topography composes `engagement` concretely. The contract
  // suite validates the full transitive concrete-edge closure, so we
  // register engagement plus the entire transitive set engagement
  // pulls in (sheet / snapshot / submission / parcel-briefing /
  // viewpoint-render / bim-model / neighboring-context / and the
  // bim-model + viewpoint-render branches' downstream concrete
  // children). Mirrors the alsoRegister list used by
  // engagement-atom.test.ts so a future refactor to engagement's
  // composition surfaces here as a mechanical update.
  runAtomContractTests(atom, {
    // Real-shape entityId per the file docstring's identity convention:
    //   site-topography:{engagementId}
    withFixture: {
      entityId: "site-topography:01HXYZABCDEFGHJKMNPQRSTVWX",
    },
    alsoRegister: [
      makeEngagementAtom({ db: lazyDb }),
      makeSheetAtom({ db: lazyDb }),
      makeSnapshotAtom({ db: lazyDb }),
      makeSubmissionAtom({ db: lazyDb }),
      makeIntentAtom(),
      makeBriefingSourceAtom(),
      makeParcelBriefingAtom(),
      makeViewpointRenderAtom(),
      makeBimModelAtom({ db: lazyDb }),
      makeNeighboringContextAtom(),
      makeBriefingDivergenceAtom({ db: lazyDb }),
      makeMaterializableElementAtom({ db: lazyDb }),
      makeRenderOutputAtom(),
    ],
  });
});

describe("site-topography atom (registration shape)", () => {
  it("declares the Phase 2D.1.3 event vocabulary", () => {
    const atom = makeSiteTopographyAtom();
    expect(atom.eventTypes).toEqual([...SITE_TOPOGRAPHY_EVENT_TYPES]);
    // Three events: ingested / refreshed / superseded.
    expect(atom.eventTypes).toHaveLength(3);
    expect(atom.eventTypes).toContain("site-topography.ingested");
    expect(atom.eventTypes).toContain("site-topography.refreshed");
    expect(atom.eventTypes).toContain("site-topography.superseded");
  });

  it("declares all five render modes per Spec 20 §10", () => {
    const atom = makeSiteTopographyAtom();
    expect(atom.supportedModes).toEqual([...SITE_TOPOGRAPHY_SUPPORTED_MODES]);
    expect(atom.supportedModes).toHaveLength(5);
    expect(atom.defaultMode).toBe("card");
  });

  it("composition: single concrete edge to `engagement`", () => {
    const atom = makeSiteTopographyAtom();
    expect(atom.composition).toHaveLength(1);
    expect(atom.composition[0]?.childEntityType).toBe("engagement");
    // CONCRETE edge — engagement registers earlier in the boot order so
    // validate() can resolve it without a forwardRef opt-out.
    expect(atom.composition[0]?.forwardRef).toBeFalsy();
    expect(atom.composition[0]?.dataKey).toBe("engagement");
  });

  it("registers under the plan-review domain", () => {
    const atom = makeSiteTopographyAtom();
    expect(atom.domain).toBe("plan-review");
    expect(atom.entityType).toBe("site-topography");
  });
});

