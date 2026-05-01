/**
 * Shared adapter-eligibility helpers — the single source of truth for
 * "given an engagement's resolved jurisdiction, which adapters would
 * the runner actually invoke?"
 *
 * Both `artifacts/api-server/src/routes/generateLayers.ts` (the POST
 * route that returns the 422 `no_applicable_adapters` envelope) and
 * `artifacts/design-tools/src/pages/EngagementDetail.tsx` (the Site
 * Context tab that disables the Generate Layers button + renders the
 * empty-pilot banner proactively) call into here, so an additional
 * pilot jurisdiction added to the registry / resolver flips the FE
 * pre-flight gate and the BE 422 in lockstep — they cannot disagree.
 *
 * The filter wraps each adapter's `appliesTo(ctx)` in try/catch
 * because a thrown adapter (e.g. a future variant that consults a
 * remote feature flag) must not destabilize the gate. A throw is
 * conservatively treated as "does not apply" so the only way to opt
 * an adapter into a jurisdiction is an explicit positive return.
 *
 * The message helper centralizes the human-readable copy the route's
 * 422 body and the FE banner share so a copy tweak doesn't have to
 * be made in two places.
 */

import { ALL_ADAPTERS } from "./registry";
import type { Adapter, AdapterContext, AdapterJurisdiction } from "./types";

/**
 * Filter `adapters` (default: every adapter the runner ships with)
 * down to the ones whose `appliesTo(ctx)` returns true. A thrown
 * `appliesTo` is treated as a non-match so the gate stays a pure
 * function of the resolved jurisdiction even if an adapter author
 * forgets to handle a missing field.
 */
export function filterApplicableAdapters(
  ctx: AdapterContext,
  adapters: ReadonlyArray<Adapter> = ALL_ADAPTERS,
): Adapter[] {
  return adapters.filter((a) => {
    try {
      return a.appliesTo(ctx);
    } catch {
      return false;
    }
  });
}

/**
 * Convenience wrapper for callers that only need a yes/no answer
 * (the FE pre-flight gate uses this to decide whether to disable the
 * Generate Layers button and proactively render the empty-pilot
 * banner).
 */
export function hasApplicableAdapters(
  ctx: AdapterContext,
  adapters: ReadonlyArray<Adapter> = ALL_ADAPTERS,
): boolean {
  return filterApplicableAdapters(ctx, adapters).length > 0;
}

/**
 * The human-readable copy the route's 422 envelope and the FE empty-
 * pilot banner both surface. Two phrasings, branched on whether the
 * resolver landed on a state slug at all:
 *
 *   - `stateKey` set: the engagement is *in* a recognized state but
 *     no adapter has been registered for it (or its local key) yet.
 *     The architect's next step is "wait for an adapter / upload
 *     manually" — we name the slug so they can correlate with the
 *     adapter registry.
 *   - `stateKey` null: we couldn't resolve the engagement to any
 *     pilot state at all, usually because the city/state columns
 *     are blank. The architect's next step is "fill in city + state
 *     on Site Context" — the message names that explicit fix.
 */
export function noApplicableAdaptersMessage(j: AdapterJurisdiction): string {
  return j.stateKey
    ? `No adapters configured for jurisdiction "${j.stateKey}"${j.localKey ? ` / ${j.localKey}` : ""}.`
    : "Could not resolve a pilot jurisdiction from this engagement's site context (city/state/address). Add a city + state and try again.";
}
