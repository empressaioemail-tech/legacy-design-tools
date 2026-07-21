/**
 * Baked node-facet READ endpoint — the map inspect-card's pure-read source.
 *
 *   GET /api/brokerage/v1/place/node/:parcelNodeId/facets
 *
 * Serves the Tier-1 node facets pre-computed by the node-facet bake
 * (`nodeFacetBakeTier1Cli.ts`) out of `place_layer_snapshots`, keyed by
 * `place_key = "node:{parcelNodeId}"` under `adapter_key = "node-facets:tier1"`.
 * The bake stored the CHEAP, DETERMINISTIC, GATE-PASSED facets (base facts,
 * land-use, zoning, setbacks/envelope) so this read is a PURE DB lookup:
 *
 *   - ZERO AI. No model call is on this path, ever. Browse stays anonymous.
 *   - ZERO live compute. No adapter / OSM / FEMA / 3DEP fetch. Just a SELECT.
 *   - ANONYMOUS. Mounted BEFORE the brokerage auth gate (peer of the public
 *     `/gtm` and `/billing` return-page routes) so no API key is required —
 *     browse is a public-tier read.
 *
 * Owner privacy: the bake NEVER selected the owner column, so a baked payload
 * structurally cannot carry an owner. This route additionally strips any
 * owner-shaped key defense-in-depth (see {@link sanitizeNodeFacetPayload}) so
 * even a malformed/legacy row can never leak an owner to an anonymous caller.
 *
 * Honest absence is served, not hidden: a node that legitimately lacks a facet
 * (Comal land-use, a gate-blocked county, a parcel outside every zoning
 * polygon, a declined envelope) carries that absence in its payload
 * (`facetCoverage`, null facets, envelope.status). The web card renders those
 * as an explicit "not verified in this area" state — a designed trust signal,
 * not an empty cell — so this route passes the absence through verbatim.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db, placeLayerSnapshots } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { brokerageCors } from "../middlewares/brokerageCors";
import { gtmErrorBody } from "../lib/gtmErrorClass";
import { TIER1_ADAPTER_KEY } from "../nodeFacetBakeTier1Cli";

/** The place_key form the bake writes for a parcel node. */
export function placeKeyForNode(parcelNodeId: string): string {
  return `node:${parcelNodeId}`;
}

/**
 * A parcel node id is `"{fips}:{normalizedPropId}"` — a 5-digit county FIPS,
 * a colon, then a non-empty appraisal prop id (digits, or verbatim for a
 * non-numeric id). Reject anything else BEFORE touching the DB so a junk path
 * segment cannot become a wildcard/anything lookup.
 */
const PARCEL_NODE_ID_RE = /^\d{5}:[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidParcelNodeId(raw: string): boolean {
  return PARCEL_NODE_ID_RE.test(raw);
}

/**
 * Defense-in-depth owner strip. The bake never writes an owner, so this is a
 * belt-and-suspenders guard against a malformed or legacy row: recursively
 * drop any object key whose name looks owner-ish (owner, ownerName,
 * owner_name, ...) at ANY depth. Returns a structurally identical payload with
 * every owner-shaped key removed. Pure — does not mutate the input.
 */
export function sanitizeNodeFacetPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeNodeFacetPayload(v));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      // Match `owner`, `ownerName`, `owner_name`, `ownerOccupancy`, etc. —
      // any key whose leading token (case-insensitive) is "owner".
      if (/^owner(?![a-z])/i.test(key) || /^owner[_A-Z]/.test(key)) {
        continue;
      }
      out[key] = sanitizeNodeFacetPayload(v);
    }
    return out;
  }
  return value;
}

/** Assert no owner-shaped key survives — used by the route AND the test. */
export function payloadHasOwnerKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((v) => payloadHasOwnerKey(v));
  if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^owner(?![a-z])/i.test(key) || /^owner[_A-Z]/.test(key)) return true;
      if (payloadHasOwnerKey(v)) return true;
    }
  }
  return false;
}

export const brokerageNodeFacetsRouter: IRouter = Router();

brokerageNodeFacetsRouter.use(brokerageCors);

brokerageNodeFacetsRouter.get(
  "/node/:parcelNodeId/facets",
  async (req: Request, res: Response) => {
    const parcelNodeId = decodeURIComponent(
      (Array.isArray(req.params.parcelNodeId)
        ? req.params.parcelNodeId[0]
        : req.params.parcelNodeId) ?? "",
    ).trim();

    if (!parcelNodeId || !isValidParcelNodeId(parcelNodeId)) {
      res
        .status(400)
        .json(
          gtmErrorBody(
            "validation_error",
            "invalid_request",
            "parcelNodeId must be '{fips}:{propId}' (e.g. 48055:10068)",
          ),
        );
      return;
    }

    const placeKey = placeKeyForNode(parcelNodeId);

    const [row] = await db
      .select({
        payloadJson: placeLayerSnapshots.payloadJson,
        snapshotAt: placeLayerSnapshots.snapshotAt,
      })
      .from(placeLayerSnapshots)
      .where(
        and(
          eq(placeLayerSnapshots.adapterKey, TIER1_ADAPTER_KEY),
          eq(placeLayerSnapshots.placeKey, placeKey),
        ),
      )
      .limit(1);

    if (!row) {
      // Node has no baked snapshot. This is NOT an error the card should hide —
      // the web app falls back to a live envelope fetch for un-baked nodes — so
      // we answer 404 with the honest "not baked" signal and the node id so the
      // client can route to its fallback deterministically.
      res.status(404).json(
        gtmErrorBody(
          "no_coverage",
          "not_baked",
          "No baked facets for this parcel node",
        ),
      );
      return;
    }

    const facets = sanitizeNodeFacetPayload(row.payloadJson);

    res.json({
      parcelNodeId,
      adapterKey: TIER1_ADAPTER_KEY,
      source: "baked-snapshot",
      snapshotAt:
        row.snapshotAt instanceof Date
          ? row.snapshotAt.toISOString()
          : (row.snapshotAt ?? null),
      facets,
    });
  },
);
