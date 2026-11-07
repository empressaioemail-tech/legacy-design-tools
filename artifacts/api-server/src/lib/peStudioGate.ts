/**
 * P-101 — the Studio route gate.
 *
 * Operator ruling 2026-08-31 (`_decisions/2026-08-31_smartsite_ladder_recut_
 * studio_works_a_list.md`): Solo answers one parcel, Studio works a list of
 * them. Screens and boards move from ungated to Studio-or-Team. Call 1 of the
 * same ruling keeps the READ side open: `GET /screens` and
 * `GET /screens/:screenId` are not gated, so a free connector user still
 * mounts the Smart Site panel and meets an upgrade prompt in context rather
 * than meeting nothing. Nothing is given away, because a free account can
 * never have built a screen and its list is empty.
 *
 * WHY THIS LIVES ON THE ROUTE AND NOT IN A PREDICATE.
 *
 * The ruling claims "the gate is applied at the TIER and both the workbench
 * and the connector inherit it". That claim is structurally true ONLY for a
 * route gate. `subscriptionTierGrantsStudio` already exists THREE times with
 * no shared module — `peEntitlement.ts:52` here, `smartsite-mcp/src/
 * entitlement.ts:27`, and `hauska-map apps/property-explorer/src/lib/
 * entitlementClient.ts:90` — and a predicate-level gate in the MCP would have
 * been a fourth. This module adds none: it IMPORTS the api-server predicate.
 * The count of definitions is 3 before this file and 3 after it.
 *
 * The inheritance is real rather than asserted. The MCP reaches these routes
 * on the trusted-service path, which requires SERVICE_API_KEY plus
 * `X-PE-User-Id` (`peServiceUserId.ts`), and `resolvePeEntitlement` then reads
 * the rung from `pe_user_entitlements` for that user id. The tier is never
 * taken from a header, so a connector cannot declare itself Studio.
 *
 * The shipped precedent is `get_smart_site`: no local MCP gate, enforced
 * upstream, refusal surfaced by the connector.
 *
 * DEV ROLE needs no special case. `resolvePeEntitlement` maps `devRole` to
 * `subscriptionTier: "team"`, so an operator account clears this gate through
 * the one predicate rather than through a second bypass.
 *
 * THE REFUSAL BODY IS SHAPED FOR THE PANEL. `smartsite-mcp`'s
 * `declareUpstreamNonOk` reads the upstream body's own `reason` first and
 * `error` second, so a named `reason` travels intact to the connector and the
 * panel can say which capability was refused instead of printing a generic
 * "Not returned". That is a positive determination carried by the refusing
 * party, not the panel inferring the capability from context.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

import {
  resolvePeEntitlement,
  subscriptionTierGrantsStudio,
} from "./peEntitlement";

/**
 * The `reason` on a screens refusal. The connector panel keys its screen
 * upgrade line off this exact string; changing it silently degrades that line
 * back to the generic upstream-error rendering, so it is a shared constant
 * rather than a literal at the call site.
 */
export const STUDIO_SCREENS_REFUSAL_REASON = "studio_screens";

export const STUDIO_SCREENS_REFUSAL_MESSAGE =
  "Studio or Team is required to build a screen. Solo answers one parcel; Studio works a list of them.";

export type StudioGateCapability = {
  /** Machine-readable capability name, carried to the connector verbatim. */
  reason: string;
  /** Human sentence. Names the capability, never a bare "upgrade required". */
  message: string;
};

/**
 * Requires a Studio or Team rung. 401 when the caller is not an authenticated
 * Property Explorer account, 402 with a named reason otherwise.
 *
 * Fails closed: an unauthenticated caller is refused rather than being read as
 * free-and-therefore-denied-for-a-different-reason, and no rung is defaulted.
 * A paid row with no stored rung reads as `solo` inside
 * `resolvePeEntitlement`, never silently as studio.
 */
export function requirePeStudio(
  capability: StudioGateCapability,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const snap = await resolvePeEntitlement(req);
    if (!snap.authenticated) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    if (subscriptionTierGrantsStudio(snap.subscriptionTier)) {
      next();
      return;
    }
    res.status(402).json({
      error: "upgrade_required",
      reason: capability.reason,
      message: capability.message,
      tier: snap.tier,
      subscriptionTier: snap.subscriptionTier,
    });
  };
}

/** The screens capability (P-101 call 1): build a screen, add to a screen. */
export const requirePeStudioScreens: RequestHandler = requirePeStudio({
  reason: STUDIO_SCREENS_REFUSAL_REASON,
  message: STUDIO_SCREENS_REFUSAL_MESSAGE,
});
