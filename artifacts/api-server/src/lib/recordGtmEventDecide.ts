/**
 * P-100 item 5 — the consent decision for a server-internal GTM event.
 *
 * Pure. Imports no database, so every refusal below is testable without
 * Postgres. Mirrors the peActivationEventsValidate / peActivationEvents split
 * already used in this codebase: the logic lives here, the query lives in
 * `recordGtmEvent.ts`.
 *
 * WHY THIS EXISTS. `recordGtmEvent` stamped `consentVersion` from
 * `input.consentVersion ?? null`, and none of its fourteen call sites passed
 * one. 741 of 11,518 rows in production therefore carry a null consent
 * (measured 2026-09-01). The locked year-zero rule is that a consent flag
 * cannot be retrofitted, so every one of those rows is a permanent hole: the
 * event happened, and whether its subject had agreed to be measured is now
 * unknowable. A default produced that. Nothing else did.
 *
 * WHY THE STORE AND NOT THE CALLER. The obvious fix — make `consentVersion` a
 * required parameter — moves the claim to the caller, and a caller-supplied
 * consent version is a client assertion with extra steps. `gtm_consent` is
 * the authority: it is written by the two consent routes, keyed on the same
 * install id the event carries, and it is a SECOND, INDEPENDENTLY DERIVED
 * input rather than another field in the same payload. That is what makes
 * this a meaning-shaped check instead of a presence-shaped one.
 *
 * WHY AN EMPTY VERSION IS A REFUSAL. A consent row whose version is the empty
 * string satisfies NOT NULL and satisfies "a consent row exists". It carries
 * no information about what was agreed to. A check that a sentinel can pass
 * is the wrong check, so the sentinel is refused here rather than stamped.
 *
 * WHAT REFUSING COSTS, STATED. Refusing means the event is not recorded.
 * Measured against production at the time of writing: 62% of currently-null
 * events belong to installs that DO have a consent row and would now be
 * stamped correctly; 38% (94 distinct installs) would be refused. The refusal
 * is written to `gtm_event_refusals` so that 38% is a number somebody can
 * read, not a rail that quietly goes flat.
 */

import type { GtmEventRefusalReason } from "@workspace/db";

/** What `gtm_consent` holds for an install, or `null` when it holds nothing. */
export type GtmConsentSnapshot = {
  consentVersion: string;
  graphOptIn: boolean;
} | null;

export type GtmWriteDecision =
  | {
      action: "insert";
      consentVersion: string;
      /** `gtm_events.graph_opt_in` is a text column, not a boolean. */
      graphOptIn: "true" | "false";
    }
  | { action: "refuse"; reason: GtmEventRefusalReason };

/**
 * Decide whether a server-internal event may be written.
 *
 * There is no third answer and no defaulted middle. Either the store knows
 * what this install agreed to, or the event does not get written.
 */
export function decideGtmEventWrite(
  consent: GtmConsentSnapshot,
): GtmWriteDecision {
  if (consent === null) {
    return { action: "refuse", reason: "consent_absent" };
  }
  // A blank version passes NOT NULL and says nothing. Refuse the sentinel.
  if (typeof consent.consentVersion !== "string" || consent.consentVersion.trim() === "") {
    return { action: "refuse", reason: "consent_absent" };
  }
  return {
    action: "insert",
    consentVersion: consent.consentVersion,
    graphOptIn: consent.graphOptIn ? "true" : "false",
  };
}
