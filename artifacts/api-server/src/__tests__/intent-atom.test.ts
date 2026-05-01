/**
 * Intent atom contract test (DA-PI-1 sprint, shape-only).
 *
 * No Postgres schema needed — intent has no DB lookup yet (data layer
 * lands in a future sprint). The contract suite exercises the
 * structural envelope, the forward-ref `parcel` edge, and the event
 * vocabulary.
 */

import { describe, it, expect } from "vitest";
import {
  runAtomContractTests,
  createInMemoryEventService,
} from "@workspace/empressa-atom/testing";
import {
  makeIntentAtom,
  INTENT_EVENT_TYPES,
  INTENT_SUPPORTED_MODES,
} from "../atoms/intent.atom";

describe("intent atom (contract)", () => {
  const atom = makeIntentAtom({ history: createInMemoryEventService() });

  // The only composition edge (`parcel`) is forwardRef, so
  // alsoRegister is empty — validate() skips the edge.
  runAtomContractTests(atom, {
    // Real-shape Spec 51a §2.11 entityId: `intent:{parcelId}:{ulid}`.
    withFixture: { entityId: "intent:p-001:01HXYZABCDEFGHJKMNPQRSTVWX" },
    alsoRegister: [],
  });
});

describe("intent atom (registration shape)", () => {
  it("declares the Spec 51a §2.11 event vocabulary", () => {
    const atom = makeIntentAtom();
    expect(atom.eventTypes).toEqual([...INTENT_EVENT_TYPES]);
  });

  it("declares all five render modes per Spec 20 §10", () => {
    const atom = makeIntentAtom();
    expect(atom.supportedModes).toEqual([...INTENT_SUPPORTED_MODES]);
    expect(atom.supportedModes).toHaveLength(5);
    expect(atom.defaultMode).toBe("card");
  });

  it("composition: only edge is `parcel`, declared forwardRef", () => {
    const atom = makeIntentAtom();
    expect(atom.composition).toHaveLength(1);
    expect(atom.composition[0]?.childEntityType).toBe("parcel");
    expect(atom.composition[0]?.forwardRef).toBe(true);
  });
});
