/**
 * P-293: the pinned `parcel_gate_verdict.verdict` vocabulary.
 *
 * WHY THIS FILE EXISTS. `parcel_gate_verdict` is written by hauska-factory
 * (PARCEL-B-GATE-SCHED and successors) and read here. The set of strings
 * that column may hold is therefore NOT this repo's to choose -- it is a
 * cross-repo contract with no dependency edge to enforce it. On 2026-09-16
 * the factory widened it (P-201 / A-153, migration 0011a) and this repo's
 * reader went on accepting only the original three, which silently turned
 * every new string into "no usable verdict" (see `parcelGateVerdictRead.ts`
 * and the P-293 close for the serve-state consequence).
 *
 * PATTERN FOLLOWED: this is the same shape as
 * `lib/db/src/schema/contractPropertyTypesSnapshot.ts` -- a checked-in
 * `*_SNAPSHOT` const carrying its upstream version/path, plus a derived
 * `*Set()` helper -- and it inherits that file's honesty about its own
 * limits, restated in `countyRailDimension.ts`: a declaration like this
 * "cannot detect upstream drift it has no dependency edge to observe -- it
 * guards internal consistency of this file, not freshness against" the
 * upstream. Freshness is a HUMAN step, recorded by the stamp below. Re-read
 * the three upstream paths below whenever the stamp is refreshed; if the
 * factory widens the CHECK a third time and nobody re-reads it, this pin
 * and the test that mirrors it stay internally consistent and stay WRONG
 * together. That is a known, accepted, named limitation, not a control.
 *
 * WHERE THE LIST LIVES. `accepted` below is the ONE copy the running code
 * consumes: the reader's predicate and the allowlist's parameter type are
 * both derived from it, never restated. The vocabulary test holds a SECOND,
 * deliberately independent transcription of the same three upstream files,
 * and asserts the two agree -- that is the divergence tripwire, and it is
 * the only other copy of this list permitted in this repo.
 */

export const PARCEL_GATE_VERDICT_VOCABULARY_PIN = {
  /** Upstream, read-only: this is the factory's contract, not ours. */
  factoryRepo: "empressaioemail-tech/hauska-factory",
  factorySha: "91712795ea2a1eb7c27f7328cf7f52fcb7810b59",
  factoryShaShort: "9171279",
  cardRows: ["P-201", "A-153", "P-293"],
  /** Re-read these three to refresh the stamp. The first two are the CHECK constraint's history; the third is the writer's own constant list. */
  factoryPaths: [
    "migrations/0009_parcel_gate_verdict.sql",
    "migrations/0011a_parcel_gate_verdict_excluded_kinds.sql",
    "src/lib/gate-exclusion-classifier.mjs",
  ],
  /** The factory commit above is the merge of P-201, which is where 0011a landed. */
  verifiedAt: "2026-09-16",
  verifiedBy: "claude-p293",
  /**
   * Exactly these six. Migration 0009 wrote the CHECK as
   * `IN ('pass', 'refuse', 'excluded')`; 0011a re-wrote it ALONGSIDE the
   * legacy three rather than replacing them, because existing rows still
   * carry a bare 'excluded' and a not-yet-updated writer must still be able
   * to write one.
   *
   * NOTE THE SHAPE, because the next person's instinct will be wrong here:
   * 'excluded' is the excluded- PREFIX with no suffix, so a predicate
   * written `startsWith("excluded")` would accept both families for the
   * wrong reason and would silently admit any future `excluded-anything`.
   * The list is explicit and closed; the test asserts an invented
   * `excluded-*` string is still UNRECOGNISED.
   */
  accepted: [
    "pass",
    "refuse",
    "excluded",
    "excluded-not-applicable",
    "excluded-mid-cutover",
    "excluded-no-acquisition-path",
  ],
  /**
   * The P-201 refinement of the bare 'excluded' -- the factory now says WHY
   * a rail was excluded. Carried here as data so the vocabulary test can
   * assert the family is a strict subset of `accepted` and that each member
   * actually wears the prefix; the reader does not branch on it, because
   * this repo's decision table treats every recognised non-pass verdict
   * identically (see `resolveAllowlistState`).
   */
  excludedKinds: [
    "excluded-not-applicable",
    "excluded-mid-cutover",
    "excluded-no-acquisition-path",
  ],
} as const;

/** The six strings above, as a union. Derived, never re-typed. */
export type ParcelGateVerdictKind =
  (typeof PARCEL_GATE_VERDICT_VOCABULARY_PIN.accepted)[number];

export type ParcelGateVerdictVocabularyPin = typeof PARCEL_GATE_VERDICT_VOCABULARY_PIN;

/** The accepted set as a lookup. Pass a pin to check a different stamp. */
export function acceptedParcelGateVerdictKinds(
  pin: ParcelGateVerdictVocabularyPin = PARCEL_GATE_VERDICT_VOCABULARY_PIN,
): ReadonlySet<string> {
  return new Set<string>(pin.accepted as readonly string[]);
}

export const ACCEPTED_PARCEL_GATE_VERDICT_KINDS: ReadonlySet<string> =
  acceptedParcelGateVerdictKinds();

/**
 * The one place a raw column string is judged. `unrecognised` carries the
 * raw string back out so a caller can log the exact offending value instead
 * of a guess.
 */
export type ParcelGateVerdictClassification =
  | { state: "accepted"; kind: ParcelGateVerdictKind }
  | { state: "unrecognised"; raw: string };

export function classifyParcelGateVerdictKind(raw: string): ParcelGateVerdictClassification {
  return ACCEPTED_PARCEL_GATE_VERDICT_KINDS.has(raw)
    ? { state: "accepted", kind: raw as ParcelGateVerdictKind }
    : { state: "unrecognised", raw };
}

export function isAcceptedParcelGateVerdictKind(v: string): v is ParcelGateVerdictKind {
  return ACCEPTED_PARCEL_GATE_VERDICT_KINDS.has(v);
}
