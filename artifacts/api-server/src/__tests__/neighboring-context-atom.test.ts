/**
 * Neighboring-context atom contract test (DA-PI-1 sprint, shape-only).
 *
 * No Postgres schema needed — neighboring-context is registration-only
 * this sprint; the radius-walk implementation lands later.
 *
 * `alsoRegister` includes `briefing-source` (the only non-forward-ref
 * edge from neighboring-context). briefing-source itself requires
 * `parcel-briefing`, which requires `intent`, so the full transitive
 * closure is [intent, parcel-briefing, briefing-source] for validate()
 * to pass.
 */

import { describe, it, expect } from "vitest";
import {
  runAtomContractTests,
  createInMemoryEventService,
} from "@workspace/empressa-atom/testing";
import {
  makeNeighboringContextAtom,
  NEIGHBORING_CONTEXT_EVENT_TYPES,
  NEIGHBORING_CONTEXT_SUPPORTED_MODES,
} from "../atoms/neighboring-context.atom";
import { makeBriefingSourceAtom } from "../atoms/briefing-source.atom";
import { makeParcelBriefingAtom } from "../atoms/parcel-briefing.atom";
import { makeIntentAtom } from "../atoms/intent.atom";

describe("neighboring-context atom (contract)", () => {
  const atom = makeNeighboringContextAtom({
    history: createInMemoryEventService(),
  });

  runAtomContractTests(atom, {
    // Real-shape Spec 51a §2.13 entityId:
    // `neighboring-context:{parcelId}:{radiusFt}`.
    withFixture: { entityId: "neighboring-context:p-001:500" },
    alsoRegister: [
      makeIntentAtom(),
      makeParcelBriefingAtom(),
      makeBriefingSourceAtom(),
    ],
  });
});

describe("neighboring-context atom (registration shape)", () => {
  it("declares the Spec 51a §2.13 event vocabulary", () => {
    const atom = makeNeighboringContextAtom();
    expect(atom.eventTypes).toEqual([...NEIGHBORING_CONTEXT_EVENT_TYPES]);
  });

  it("declares all five render modes per Spec 20 §10", () => {
    const atom = makeNeighboringContextAtom();
    expect(atom.supportedModes).toEqual([
      ...NEIGHBORING_CONTEXT_SUPPORTED_MODES,
    ]);
    expect(atom.supportedModes).toHaveLength(5);
    // defaultMode is `compact` per Spec 51a §2.13's "compact (line in
    // briefing)" presentation guidance — neighboring context surfaces
    // as an inline line within a parent briefing.
    expect(atom.defaultMode).toBe("compact");
  });

  it("composition: briefing-source concrete; parcel forwardRef", () => {
    const atom = makeNeighboringContextAtom();
    const byKey = new Map(atom.composition.map((c) => [c.childEntityType, c]));
    expect(byKey.get("briefing-source")?.forwardRef).toBeFalsy();
    expect(byKey.get("parcel")?.forwardRef).toBe(true);
  });
});
