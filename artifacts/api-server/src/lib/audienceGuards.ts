/**
 * Shared audience guard for internal-only routes.
 *
 * The `sessionMiddleware` fails closed in production: every
 * unverified caller lands as `audience: "user"` regardless of any
 * client-supplied cookie or header (see `middlewares/session.ts`
 * for the rationale). An audience check at the route boundary is
 * therefore the gate that keeps internal-only payloads — Revit
 * binding details on the bim-model surface, materialized GLB bytes
 * on the briefing-source / materializable-element surfaces,
 * reviewer scratch notes on the reviewer-annotation surface —
 * inside the architect-facing surface.
 *
 * `errorCode` is the route-specific 403 error string each call
 * site supplies so logs and telemetry can attribute a 403 back to
 * the route that emitted it (e.g.
 * `"bim_model_requires_architect_audience"`,
 * `"briefing_source_requires_architect_audience"`,
 * `"reviewer_annotations_require_internal_audience"`). Existing
 * test suites assert on these strings, so the per-route divergence
 * is part of the wire contract.
 *
 * Returns `true` once the guard sent a 403 so the caller can
 * early-return without further work.
 */

import type { Request, Response } from "express";

export function requireArchitectAudience(
  req: Request,
  res: Response,
  errorCode: string,
): boolean {
  if (req.session.audience === "internal") return false;
  res.status(403).json({ error: errorCode });
  return true;
}
