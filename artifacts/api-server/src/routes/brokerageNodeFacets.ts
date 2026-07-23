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
import { and, eq, inArray } from "drizzle-orm";
import { brokerageCors } from "../middlewares/brokerageCors";
import { gtmErrorBody } from "../lib/gtmErrorClass";
import { TIER1_ADAPTER_KEY } from "../lib/nodeFacetTier1Constants";
import { TIER2_ADAPTER_KEY } from "../lib/nodeFacetTier2Constants";

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

/**
 * The Tier-2 overlay the card + the map's "FEMA flood zone" layer consume.
 *
 * The Tier-2 bake (`nodeFacetBakeTier2Cli.ts`) writes a per-node payload under
 * `node-facets:tier2` carrying `flood` (the real FEMA NFHL zone: in-SFHA / X /
 * outside-SFHA / unavailable, with the FEMA vintage) and — once the road-leg
 * infra lands — an upgraded `envelope`. This route composes that overlay onto
 * the Tier-1 base so the SAME anonymous pure-read the card already makes now
 * carries the real per-node flood status. A node with no Tier-2 row (not yet
 * baked) simply gets `tier2: null` — the card renders the Tier-1 base exactly
 * as before, so this is strictly additive and safe to ship ahead of the bake.
 *
 * Only the two card/layer-facing facets are surfaced (`flood`, `envelope`) plus
 * `bakedAt`; the rest of the Tier-2 payload (schema version, county echo) is
 * internal and stays off the wire. Owner-strip still runs over the composed
 * result defense-in-depth.
 */
export interface Tier2Overlay {
  flood: unknown;
  envelope: unknown;
  bakedAt: unknown;
  snapshotAt: string | null;
}

export interface BakedNodeFacetSnapshot {
  parcelNodeId: string;
  facets: unknown;
  snapshotAt: string | null;
  tier2: Tier2Overlay | null;
}

export function extractTier2Overlay(
  payloadJson: unknown,
  snapshotAt: Date | string | null,
): Tier2Overlay | null {
  if (!payloadJson || typeof payloadJson !== "object") return null;
  const p = payloadJson as Record<string, unknown>;
  // A Tier-2 row must carry a flood facet to be meaningful to the card. If it
  // does not (a malformed/legacy row), treat it as no overlay rather than
  // surfacing a half-shape the card can't render.
  if (!p.flood || typeof p.flood !== "object") return null;
  return {
    flood: p.flood,
    // Anti-zombie (WDLL 3.7): never overlay zombie Tier-2 envelope as product
    // truth. Envelope comes from the property atom chain (or null).
    envelope: null,
    bakedAt: p.bakedAt ?? null,
    snapshotAt:
      snapshotAt instanceof Date
        ? snapshotAt.toISOString()
        : (snapshotAt ?? null),
  };
}

/**
 * Strip baked Tier-1 envelope from the wire so legacy multiply snapshots cannot
 * remain product truth after the anti-zombie cut. Land-use / zoning / baseFacts
 * stay; envelope is atom-path only.
 */
export function stripZombieEnvelopeFromFacets(facets: unknown): unknown {
  if (!facets || typeof facets !== "object") return facets;
  const f = facets as Record<string, unknown>;
  const coverage =
    f.facetCoverage && typeof f.facetCoverage === "object"
      ? {
          ...(f.facetCoverage as Record<string, unknown>),
          envelope: false,
        }
      : f.facetCoverage;
  return {
    ...f,
    envelope: null,
    facetCoverage: coverage,
  };
}

export const brokerageNodeFacetsRouter: IRouter = Router();

brokerageNodeFacetsRouter.use(brokerageCors);

/**
 * Shared pure-read path for the public facet endpoint and paid Property
 * Explorer reports. Keeps R1 tethered to the same owner-free baked snapshot
 * rather than introducing a second query or compute path.
 */
export async function loadBakedNodeFacetSnapshot(
  parcelNodeId: string,
): Promise<BakedNodeFacetSnapshot | null> {
  const placeKey = placeKeyForNode(parcelNodeId);
  const rows = await db
    .select({
      adapterKey: placeLayerSnapshots.adapterKey,
      payloadJson: placeLayerSnapshots.payloadJson,
      snapshotAt: placeLayerSnapshots.snapshotAt,
    })
    .from(placeLayerSnapshots)
    .where(
      and(
        inArray(placeLayerSnapshots.adapterKey, [
          TIER1_ADAPTER_KEY,
          TIER2_ADAPTER_KEY,
        ]),
        eq(placeLayerSnapshots.placeKey, placeKey),
      ),
    )
    .limit(2);

  const row = rows.find((r) => r.adapterKey === TIER1_ADAPTER_KEY);
  if (!row) return null;
  const tier2Row = rows.find((r) => r.adapterKey === TIER2_ADAPTER_KEY);
  const tier2Raw = tier2Row
    ? extractTier2Overlay(tier2Row.payloadJson, tier2Row.snapshotAt)
    : null;

  return {
    parcelNodeId,
    facets: sanitizeNodeFacetPayload(
      stripZombieEnvelopeFromFacets(row.payloadJson),
    ),
    snapshotAt:
      row.snapshotAt instanceof Date
        ? row.snapshotAt.toISOString()
        : (row.snapshotAt ?? null),
    tier2:
      tier2Raw != null
        ? (sanitizeNodeFacetPayload(tier2Raw) as Tier2Overlay)
        : null,
  };
}

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

    const snapshot = await loadBakedNodeFacetSnapshot(parcelNodeId);
    if (!snapshot) {
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

    res.json({
      parcelNodeId,
      adapterKey: TIER1_ADAPTER_KEY,
      source: "baked-snapshot",
      snapshotAt: snapshot.snapshotAt,
      facets: snapshot.facets,
      // The FEMA flood overlay the card + the map's "FEMA flood zone" layer
      // read. `null` when the node has no Tier-2 row yet (renders the Tier-1
      // base unchanged). `tier2.flood` carries the real zone + FEMA vintage.
      tier2: snapshot.tier2,
    });
  },
);
