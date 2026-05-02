/**
 * V1-4 / DA-RP-1 — pure cost-estimate helper.
 *
 * Spec 54 v2 §4 names the per-operation credit costs as a static
 * lookup table — no `quoteRender` call to mnml. The api-server uses
 * this helper:
 *
 *   1. At kickoff time, to surface "this render will cost N credits"
 *      in the 202 response so the FE can render a confirmation chip
 *      ("Render: 3 credits") before the architect commits. DA-RP-2
 *      owns the full credit-balance UI; V1-4 just exposes the static
 *      pre-kickoff figure.
 *
 *   2. At elevation-set partial-debit detection time, to compute how
 *      many credits the failed-after-trigger children consumed.
 *      mnml debits at request time, not on success — so a child that
 *      triggered cleanly but rendered into `failed` still drew
 *      credits.
 *
 * No external API calls. No async. No side effects. Tests cover the
 * full surface.
 *
 * The "domain kind" enum (`still | elevation-set | video`) is the
 * api-server's user-facing render taxonomy. It is distinct from the
 * mnml-client wire kind (`archdiffusion | video`) because
 * elevation-set is a 4-call fan-out concept that lives in the route,
 * not on the wire — Spec 54 v2 §6.2.
 */

/** Spec 54 v2 §4 — static per-operation credit cost. */
export const RENDER_COST_CREDITS = {
  archdiffusion: 3,
  video: 10,
} as const;

/** API-server domain render kinds. */
export type DomainRenderKind = "still" | "elevation-set" | "video";

/**
 * One bucket of the cost breakdown. An elevation-set's breakdown has
 * one entry with `count: 4` (four archdiffusion calls); a still's has
 * one entry with `count: 1`. Future kinds (e.g. a "compare set" of
 * one archdiffusion + one video) would surface as multiple entries.
 */
export interface RenderCostBreakdownEntry {
  kind: "archdiffusion" | "video";
  count: number;
  creditsPerCall: number;
  subtotal: number;
}

export interface RenderCostEstimate {
  credits: number;
  breakdown: ReadonlyArray<RenderCostBreakdownEntry>;
}

/**
 * Cost a kickoff before the request goes out. Pure function — caller
 * passes the domain kind, helper returns the credit total + a
 * breakdown the FE can render verbatim ("4 × archdiffusion @ 3 = 12").
 *
 * For unknown kinds the function throws — V1-4's three values are the
 * only domain kinds that exist; an unknown value signals upstream
 * validation drift and should fail loudly rather than return a
 * silent zero.
 */
export function estimateRenderCost(input: {
  kind: DomainRenderKind;
}): RenderCostEstimate {
  switch (input.kind) {
    case "still":
      return buildEstimate("archdiffusion", 1);
    case "elevation-set":
      return buildEstimate("archdiffusion", 4);
    case "video":
      return buildEstimate("video", 1);
  }
}

/**
 * Compute the actual credits debited given how many child mnml calls
 * succeeded at trigger time. Used by the route's elevation-set
 * partial-debit branch (Phase 1A approved): mnml debits each call's
 * cost at request acceptance, even if the render later fails. The
 * route reports `creditsConsumed` to the architect alongside the
 * `insufficient_credits_partial` error so they can see what was
 * billed before re-trigger.
 *
 * Caller passes the domain kind + the count of children whose
 * trigger calls returned successfully (i.e. did NOT throw with
 * `insufficient_credits` / `validation` at request time). Helper
 * returns `triggeredCount × creditsPerCall`.
 */
export function actualDebitedCredits(input: {
  kind: DomainRenderKind;
  triggeredCount: number;
}): { creditsConsumed: number } {
  if (input.triggeredCount < 0) {
    throw new RangeError(
      `actualDebitedCredits: triggeredCount must be ≥ 0, got ${input.triggeredCount}`,
    );
  }
  const perCall =
    input.kind === "video"
      ? RENDER_COST_CREDITS.video
      : RENDER_COST_CREDITS.archdiffusion;
  return { creditsConsumed: input.triggeredCount * perCall };
}

function buildEstimate(
  kind: "archdiffusion" | "video",
  count: number,
): RenderCostEstimate {
  const creditsPerCall = RENDER_COST_CREDITS[kind];
  const subtotal = creditsPerCall * count;
  return {
    credits: subtotal,
    breakdown: [{ kind, count, creditsPerCall, subtotal }],
  };
}
