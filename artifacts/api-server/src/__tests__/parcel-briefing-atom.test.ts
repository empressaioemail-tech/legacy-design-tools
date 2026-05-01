/**
 * Parcel-briefing atom contract test (DA-PI-1 sprint, shape-only).
 *
 * Mirrors the layout of `engagement-atom.test.ts` for consistency,
 * but does NOT need a Postgres test schema: parcel-briefing is
 * registration-only this sprint (no DB lookup), so `contextSummary`
 * always returns the structural not-found envelope. Skipping the
 * schema setup keeps the test fast and avoids burning a per-file
 * Postgres schema on a no-op data path.
 *
 * Coverage:
 *   - `runAtomContractTests` — four-layer shape, defaultMode/
 *     supportedModes (all 5), composition resolution against a
 *     registry that includes the non-forward-ref children
 *     (intent, briefing-source). Forward-ref edges (parcel,
 *     code-section) are skipped by `validate()` per design.
 *   - The contract suite's "unknown id returns the not-found
 *     envelope" check is what proves DA-PI-1's deferred-engine
 *     contract — there is no other code path because no engine
 *     exists yet.
 */

import { describe, it, expect } from "vitest";
import {
  runAtomContractTests,
  createInMemoryEventService,
} from "@workspace/empressa-atom/testing";
import {
  makeParcelBriefingAtom,
  PARCEL_BRIEFING_EVENT_TYPES,
  PARCEL_BRIEFING_SUPPORTED_MODES,
} from "../atoms/parcel-briefing.atom";
import { makeIntentAtom } from "../atoms/intent.atom";
import { makeBriefingSourceAtom } from "../atoms/briefing-source.atom";

describe("parcel-briefing atom (contract)", () => {
  const atom = makeParcelBriefingAtom({
    history: createInMemoryEventService(),
  });

  // Both non-forward-ref children must be present so the contract
  // suite's `composition references resolve in the registry` step
  // passes. The forward-ref edges (`parcel`, `code-section`) are
  // skipped by validate() — no stubs needed.
  runAtomContractTests(atom, {
    // Real-shape Spec 51 §5 entityId: `parcel-briefing:{parcelId}:{intentHash}`.
    // The contract suite round-trips this through the inline-reference
    // serializer; the `|` token delimiter (DA-PI-1F1) is what makes the
    // colons inside the id survive that round-trip.
    withFixture: { entityId: "parcel-briefing:p-001:hash-abc" },
    alsoRegister: [makeIntentAtom(), makeBriefingSourceAtom()],
  });
});

describe("parcel-briefing atom (registration shape)", () => {
  it("declares the Spec 51 §5 event vocabulary", () => {
    const atom = makeParcelBriefingAtom();
    expect(atom.eventTypes).toEqual([...PARCEL_BRIEFING_EVENT_TYPES]);
    // Spot-check the canonical-precedence wording: Spec 51 §5 includes
    // `materialized-revit` (Spec 51a omits it). The §1.4 precedence
    // rule names Spec 51 as the winner.
    expect(atom.eventTypes).toContain("parcel-briefing.materialized-revit");
  });

  it("declares all five render modes per Spec 20 §10", () => {
    const atom = makeParcelBriefingAtom();
    expect(atom.supportedModes).toEqual([...PARCEL_BRIEFING_SUPPORTED_MODES]);
    expect(atom.supportedModes).toHaveLength(5);
    expect(atom.defaultMode).toBe("card");
  });

  it("composition: parcel + code-section are forwardRef; intent + briefing-source are concrete", () => {
    const atom = makeParcelBriefingAtom();
    const byKey = new Map(atom.composition.map((c) => [c.childEntityType, c]));
    expect(byKey.get("parcel")?.forwardRef).toBe(true);
    expect(byKey.get("code-section")?.forwardRef).toBe(true);
    // Concrete edges must NOT be marked forwardRef so validate()
    // catches missing registrations at boot.
    expect(byKey.get("intent")?.forwardRef).toBeFalsy();
    expect(byKey.get("briefing-source")?.forwardRef).toBeFalsy();
  });
});
