/**
 * Site-drainage atom contract test (Phase 2D.2/2D.3).
 */

import { describe, it, expect } from "vitest";
import {
  runAtomContractTests,
  createInMemoryEventService,
} from "@hauska/atom-contract/testing";
import * as dbModule from "@workspace/db";
import {
  makeSiteDrainageAtom,
  SITE_DRAINAGE_EVENT_TYPES,
  SITE_DRAINAGE_SUPPORTED_MODES,
} from "../atoms/site-drainage.atom";
import { makeSiteTopographyAtom } from "../atoms/site-topography.atom";
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

const lazyDb = new Proxy({} as typeof dbModule.db, {
  get: (_t, prop) => Reflect.get(dbModule.db as object, prop, dbModule.db),
});

describe("site-drainage atom (contract)", () => {
  const history = createInMemoryEventService();
  const atom = makeSiteDrainageAtom({ history });

  runAtomContractTests(atom, {
    withFixture: {
      entityId: "site-drainage:01HXYZABCDEFGHJKMNPQRSTVWX",
    },
    alsoRegister: [
      makeSiteTopographyAtom({ history }),
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

  it("declares the Phase 2D.2/2D.3 event vocabulary", () => {
    expect(SITE_DRAINAGE_EVENT_TYPES).toEqual([
      "site-drainage.computed",
      "site-drainage.refreshed",
      "site-drainage.superseded",
    ]);
  });

  it("supports all five render modes", () => {
    expect(SITE_DRAINAGE_SUPPORTED_MODES).toHaveLength(5);
  });
});
