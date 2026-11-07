/**
 * P-293. The tripwire for the pinned `parcel_gate_verdict` vocabulary.
 *
 * The transcription below is deliberately INDEPENDENT of the pin in
 * `parcelGateVerdictVocabulary.ts`: it was copied by hand from
 * hauska-factory's two migration files (and its own writer-side constants)
 * at the SHA recorded here, and the first test asserts the pin agrees with
 * it. That independence is the whole point -- a test that derived its
 * expectation from the pin could never fail for the reason it exists.
 *
 * What this buys: editing the pin alone fails here, and editing this
 * transcription alone fails here in the other direction. Either edit forces
 * the author to have re-read upstream, which is the only mechanism a pin
 * with no dependency edge to the factory has (see the module header).
 *
 * What it does NOT buy: it cannot notice the factory widening the CHECK a
 * third time, because both copies would then be wrong together. That is
 * recorded as a named limitation in the module, not hidden.
 */

import { describe, expect, it } from "vitest";
import {
  ACCEPTED_PARCEL_GATE_VERDICT_KINDS,
  classifyParcelGateVerdictKind,
  PARCEL_GATE_VERDICT_VOCABULARY_PIN,
  isAcceptedParcelGateVerdictKind,
} from "./parcelGateVerdictVocabulary";
import { PARCEL_RECORD_SLATE, resolveAllowlistState } from "./parcelRecordAllowlist";

/** The factory commit the transcription below was read at (factory main on 2026-09-16 == the merge of P-201). */
const TRANSCRIBED_FACTORY_SHA = "91712795ea2a1eb7c27f7328cf7f52fcb7810b59";

// migrations/0009_parcel_gate_verdict.sql
//   verdict text NOT NULL CHECK (verdict IN ('pass', 'refuse', 'excluded'))
// migrations/0011a_parcel_gate_verdict_excluded_kinds.sql
//   ADD CONSTRAINT parcel_gate_verdict_verdict_check CHECK (verdict IN (
//     'pass', 'refuse', 'excluded',
//     'excluded-not-applicable', 'excluded-mid-cutover', 'excluded-no-acquisition-path'
//   ));
// src/lib/gate-exclusion-classifier.mjs
//   EXCLUDED_NOT_APPLICABLE / EXCLUDED_MID_CUTOVER / EXCLUDED_NO_ACQUISITION_PATH
const TRANSCRIBED_ACCEPTED = [
  "pass",
  "refuse",
  "excluded",
  "excluded-not-applicable",
  "excluded-mid-cutover",
  "excluded-no-acquisition-path",
] as const;

const TRANSCRIBED_EXCLUDED_KINDS = [
  "excluded-not-applicable",
  "excluded-mid-cutover",
  "excluded-no-acquisition-path",
] as const;

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

describe("the pin vs. the factory at source", () => {
  it("DIVERGENCE TRIPWIRE: the accepted list equals a hand transcription of migration 0009 + 0011a, and the pin names the same factory commit", () => {
    expect(PARCEL_GATE_VERDICT_VOCABULARY_PIN.factorySha).toBe(TRANSCRIBED_FACTORY_SHA);
    expect(PARCEL_GATE_VERDICT_VOCABULARY_PIN.factorySha.startsWith("9171279")).toBe(true);
    expect(sorted(PARCEL_GATE_VERDICT_VOCABULARY_PIN.accepted)).toEqual(
      sorted(TRANSCRIBED_ACCEPTED),
    );
    expect(sorted(PARCEL_GATE_VERDICT_VOCABULARY_PIN.excludedKinds)).toEqual(
      sorted(TRANSCRIBED_EXCLUDED_KINDS),
    );
    // No duplicates, and never an empty list: a pin that silently emptied
    // itself would make every verdict unrecognised (fail-closed, so not a
    // serve hazard, but a silent total loss of the reader's function).
    expect(new Set(PARCEL_GATE_VERDICT_VOCABULARY_PIN.accepted).size).toBe(
      PARCEL_GATE_VERDICT_VOCABULARY_PIN.accepted.length,
    );
    expect(PARCEL_GATE_VERDICT_VOCABULARY_PIN.accepted.length).toBeGreaterThan(0);
  });

  it("the stamp carries the files a human has to re-read to refresh it, including both CHECK-constraint migrations", () => {
    expect(PARCEL_GATE_VERDICT_VOCABULARY_PIN.factoryPaths).toContain(
      "migrations/0009_parcel_gate_verdict.sql",
    );
    expect(PARCEL_GATE_VERDICT_VOCABULARY_PIN.factoryPaths).toContain(
      "migrations/0011a_parcel_gate_verdict_excluded_kinds.sql",
    );
    expect(PARCEL_GATE_VERDICT_VOCABULARY_PIN.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(PARCEL_GATE_VERDICT_VOCABULARY_PIN.verifiedBy.length).toBeGreaterThan(0);
  });

  it("the excluded-* family is a strict subset of accepted, every member wears the prefix, and the bare 'excluded' is not a member of it", () => {
    for (const kind of PARCEL_GATE_VERDICT_VOCABULARY_PIN.excludedKinds) {
      expect(ACCEPTED_PARCEL_GATE_VERDICT_KINDS.has(kind)).toBe(true);
      expect(kind.startsWith("excluded-")).toBe(true);
    }
    expect(PARCEL_GATE_VERDICT_VOCABULARY_PIN.excludedKinds).not.toContain("excluded");
    // The P-201 family is exactly the three the migration lists -- not "everything excluded-*".
    expect(new Set(PARCEL_GATE_VERDICT_VOCABULARY_PIN.excludedKinds).size).toBe(
      TRANSCRIBED_EXCLUDED_KINDS.length,
    );
  });
});

describe("classifyParcelGateVerdictKind", () => {
  it("accepts each of the six and round-trips the string unchanged", () => {
    for (const raw of TRANSCRIBED_ACCEPTED) {
      expect(classifyParcelGateVerdictKind(raw)).toEqual({ state: "accepted", kind: raw });
      expect(isAcceptedParcelGateVerdictKind(raw)).toBe(true);
    }
  });

  it("FALSIFIER: the list is CLOSED, not a prefix match -- an invented excluded-* string is unrecognised and comes back verbatim", () => {
    for (const raw of [
      "excluded-made-up-state",
      "excluded-",
      "excluded-not-applicable ", // trailing space: no trimming, so this is NOT a match
      "EXCLUDED",
      "passed",
      "",
    ]) {
      expect(classifyParcelGateVerdictKind(raw)).toEqual({ state: "unrecognised", raw });
      expect(isAcceptedParcelGateVerdictKind(raw)).toBe(false);
    }
  });
});

describe("every accepted verdict through the real decision function", () => {
  /** A real slated pair, taken from the slate itself rather than hardcoded, so this test cannot pass against a slate that no longer contains the pair. */
  const [countyFips, railKey] = [...PARCEL_RECORD_SLATE][0].split(":").slice(0, 2);

  it("FALSIFIER: a slated pair on pass serves 'record', and on EVERY other accepted verdict serves 'refused' -- the three P-201 excluded-* kinds included", () => {
    expect(resolveAllowlistState(countyFips, railKey, { verdict: "pass" })).toBe("record");
    for (const kind of TRANSCRIBED_ACCEPTED) {
      if (kind === "pass") continue;
      expect(resolveAllowlistState(countyFips, railKey, { verdict: kind })).toBe("refused");
    }
  });

  it("an unslated pair stays legacy on every accepted verdict, including the new ones", () => {
    for (const kind of TRANSCRIBED_ACCEPTED) {
      expect(resolveAllowlistState("00000", "notARail", { verdict: kind })).toBe("legacy");
    }
  });

  it("no verdict at all stays legacy (fail-closed), which is where the reader sends anything unrecognised", () => {
    expect(resolveAllowlistState(countyFips, railKey, null)).toBe("legacy");
  });
});
