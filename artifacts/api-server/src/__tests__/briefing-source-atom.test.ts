/**
 * Briefing-source atom contract test (DA-PI-1 sprint, shape-only).
 *
 * No Postgres schema needed — briefing-source is registration-only
 * this sprint; the fetch/refresh layer ships with the briefing
 * engine in DA-PI-3.
 *
 * `alsoRegister` includes `parcel-briefing` (the only non-forward-ref
 * edge from briefing-source). parcel-briefing in turn requires `intent`
 * to be present so its own validate() passes when the contract suite
 * runs `validate()` on the test registry, so we register intent too.
 */

import { describe, it, expect } from "vitest";
import {
  runAtomContractTests,
  createInMemoryEventService,
} from "@workspace/empressa-atom/testing";
import {
  makeBriefingSourceAtom,
  BRIEFING_SOURCE_EVENT_TYPES,
  BRIEFING_SOURCE_SUPPORTED_MODES,
} from "../atoms/briefing-source.atom";
import { makeParcelBriefingAtom } from "../atoms/parcel-briefing.atom";
import { makeIntentAtom } from "../atoms/intent.atom";

describe("briefing-source atom (contract)", () => {
  const atom = makeBriefingSourceAtom({
    history: createInMemoryEventService(),
  });

  runAtomContractTests(atom, {
    // Real-shape Spec 51a §2.12 entityId:
    // `briefing-source:{briefingId}:{overlayId}:{snapshotDate}`.
    withFixture: {
      entityId: "briefing-source:b-001:o-001:2026-04-28",
    },
    alsoRegister: [makeIntentAtom(), makeParcelBriefingAtom()],
  });
});

describe("briefing-source atom (registration shape)", () => {
  it("declares the Spec 51a §2.12 event vocabulary", () => {
    const atom = makeBriefingSourceAtom();
    expect(atom.eventTypes).toEqual([...BRIEFING_SOURCE_EVENT_TYPES]);
  });

  it("declares all five render modes per Spec 20 §10", () => {
    const atom = makeBriefingSourceAtom();
    expect(atom.supportedModes).toEqual([...BRIEFING_SOURCE_SUPPORTED_MODES]);
    expect(atom.supportedModes).toHaveLength(5);
    // defaultMode is `compact` per Spec 51a §2.12's "compact (in
    // briefing source list)" presentation guidance — a briefing
    // source is primarily a line item inside its parent briefing.
    expect(atom.defaultMode).toBe("compact");
  });

  it("composition: parcel-briefing concrete; parcel forwardRef", () => {
    const atom = makeBriefingSourceAtom();
    const byKey = new Map(atom.composition.map((c) => [c.childEntityType, c]));
    expect(byKey.get("parcel-briefing")?.forwardRef).toBeFalsy();
    expect(byKey.get("parcel")?.forwardRef).toBe(true);
  });
});
