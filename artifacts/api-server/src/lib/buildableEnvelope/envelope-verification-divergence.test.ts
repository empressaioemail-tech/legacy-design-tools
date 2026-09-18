/**
 * P-249 item 5 — THE DIVERGENCE TEST (legacy-design-tools leg).
 *
 * FOUR predicates in THREE repos read ONE fact: "is this parcel's buildable
 * envelope backed by a VERIFIED atom?" (A-184's trap.)
 *
 *   1. hauska-map          `isDepthWarmPromoted`       (api/_lib/atom-chain-to-facets.ts)
 *   2. legacy-design-tools `isEnvelopeAtomVerified`    (reconcileAtomEnvelope.ts)   ← THIS FILE
 *   3. legacy-design-tools `isMachineVerifyDiagnostic` (reconcileAtomEnvelope.ts, reason text) ← THIS FILE
 *   4. doc_repo            `scripts/envelope-draw-gap.mjs` (string and boolean forms)
 *
 * The fixture below is the shared declaration (`fixtureSet:
 * "envelope-verification-v1"`, byte-identical copy of hauska-map
 * apps/property-explorer/src/lib/__fixtures__/envelope-verification.json). A
 * predicate edited ALONE fails here, on the case whose declared answer it now
 * contradicts.
 *
 * P-331 (2026-09-18): "byte-identical" is now a CONTROL, not a claim — the
 * `envelope-verification-v1-fixture` row of
 * `scripts/check-cross-repo-literal-drift.mjs` hashes both files (CRLF
 * normalised, because the two repos apply different eol attributes on checkout)
 * and fails when they stop matching. This test keeps its own job: the
 * predicates, not the bytes.
 *
 * The two predicates answer DIFFERENT questions on purpose, and the fixture
 * keeps them apart: `verified` is read off the atom's promotion fields,
 * `machineVerifyDiagnostic` off the atom's reason TEXT. The unzoned /
 * not-onboarded / reason-less-zero cases are the ones that must be
 * unverified-but-not-diagnostic; the R32 case is the one that must be
 * diagnostic while unverified. A test that conflated the two would pass while
 * the real disagreement shipped.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isEnvelopeAtomVerified,
  isMachineVerifyDiagnostic,
} from "./reconcileAtomEnvelope";

type Case = {
  id: string;
  atom: { depthWarmPromotion?: string | null; sourceCitation?: string | null } | null;
  reason: string | null;
  verified: boolean;
  machineVerifyDiagnostic: boolean;
  note: string;
};

type Fixture = {
  fixtureSet: string;
  purpose: string;
  casesSha256: string;
  cases: Case[];
};

const fixture = JSON.parse(
  readFileSync(new URL("./__fixtures__/envelope-verification.json", import.meta.url), "utf8"),
) as Fixture;

describe("envelope-verification fixture — the shared declaration", () => {
  it("is the declared shared set, unedited (editing a case without updating casesSha256 fails)", () => {
    expect(fixture.fixtureSet).toBe("envelope-verification-v1");
    expect(createHash("sha256").update(JSON.stringify(fixture.cases)).digest("hex")).toBe(
      fixture.casesSha256,
    );
  });

  it("declares BOTH answers on every case", () => {
    for (const c of fixture.cases) {
      expect(typeof c.verified, `${c.id}.verified`).toBe("boolean");
      expect(typeof c.machineVerifyDiagnostic, `${c.id}.machineVerifyDiagnostic`).toBe("boolean");
    }
    // Not vacuous: at least one case on each side of each question, AND at
    // least one case where the two answers differ — which is the whole reason
    // they are separate columns.
    expect(fixture.cases.some((c) => c.verified)).toBe(true);
    expect(fixture.cases.some((c) => !c.verified)).toBe(true);
    expect(fixture.cases.some((c) => c.machineVerifyDiagnostic)).toBe(true);
    expect(fixture.cases.some((c) => !c.machineVerifyDiagnostic)).toBe(true);
    expect(
      fixture.cases.some((c) => !c.verified && c.machineVerifyDiagnostic),
    ).toBe(true);
  });
});

describe("legacy-design-tools isEnvelopeAtomVerified — agrees with every declared answer", () => {
  for (const c of fixture.cases) {
    it(`${c.id}: verified=${c.verified}`, () => {
      expect(isEnvelopeAtomVerified(c.atom)).toBe(c.verified);
    });
  }

  it("reads depthWarmPromotion — there is no depthWarmPromoted field on the atom", () => {
    expect(isEnvelopeAtomVerified({ depthWarmPromoted: true } as never)).toBe(false);
  });
});

describe("legacy-design-tools isMachineVerifyDiagnostic — agrees with every declared answer", () => {
  for (const c of fixture.cases) {
    it(`${c.id}: machineVerifyDiagnostic=${c.machineVerifyDiagnostic}`, () => {
      // The predicate only reads a reason; nothing is asserted about absent ones.
      expect(c.reason == null ? false : isMachineVerifyDiagnostic(c.reason)).toBe(
        c.machineVerifyDiagnostic,
      );
    });
  }
});
