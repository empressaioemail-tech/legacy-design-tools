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
 *
 * SNAPSHOT FLOOD IS NOT SERVED HERE (lane SS-W16, 2026-08-19). `tier2.flood`
 * is always null and carries a typed refusal in `tier2.floodDisposition`
 * instead. The replacement is a sibling field `floodHazardFact` read from
 * flood-hazard-fact atoms (lane s1-flood-inspect, 2026-08-21). That read is
 * a NEW lookup, not a revival of the tile-centre NFHL bake. The reasoning
 * for the snapshot cut is on {@link disposeTier2Flood} below.
 *
 * LAND-USE ATOM IS A ROOT SIBLING (lane s7-land-use-inspect, 2026-08-21).
 * `landUseFact` is read from land-use-fact atoms. Baked
 * `facets.baseFacts.landUse` stays the retiredStore cad-roll object this
 * pass. Never SELECT the CAD roll table for `landUseFact`.
 *
 * SPECIAL-DISTRICT ATOM IS A ROOT SIBLING (lane serve P-48, 2026-08-21).
 * `specialDistrictFact` is read from special-district-fact atoms. Dual
 * grammar on the parcel PREFIX only; districtId is the writer `:sd:`
 * suffix. mud is a districtType on that family, not a second atom.
 * Never SELECT bake / place_layer_snapshots / CAD / mud-pid for this field.
 *
 * PIPELINE ATOM IS A ROOT SIBLING (lane serve P-49, 2026-08-22).
 * `pipelineFact` is read from rrc-pipeline-fact atoms. Writer keys by
 * bare parcelNodeId; dual grammar is ANY(parcel keys). Spatial attach is
 * write-time buffer-intersect, not a live texas-rrc / tx_rrc_pipeline
 * query and not a special-district :sd: picker. Never SELECT bake /
 * place_layer_snapshots / CAD / GIS for this field.
 *
 * WELL ATOM IS A ROOT SIBLING (lane serve P-50, 2026-08-22).
 * `wellFact` is read from well-fact atoms. Writer keys
 * entity_id = `${parcelNodeId}:${wellKey}`; dual grammar is prefix-range
 * on both parcel prefixes, not pipeline ANY(bare parcel) and not the
 * special-district :sd: picker. Spatial attach is write-time 152 m
 * on-or-near. Never SELECT bake / place_layer_snapshots / CAD / GIS /
 * texas-rrc / tx_rrc_well for this field.
 *
 * BUILDING-FOOTPRINT ATOM IS A ROOT SIBLING (lane serve P-51, 2026-08-22).
 * `buildingFootprintFact` is read from building-footprint atoms. Writer
 * keys entity_id = `${parcelNodeId}:footprint:${footprintId}` on today's
 * store. Dual grammar is prefix-range on both parcel prefixes.
 * structureRole is body.structureRole — do not parse `:primary` as
 * identity. Spatial attach is write-time staged overlap. Never SELECT
 * bake / place_layer_snapshots / CAD / GIS / tx_building_footprint.
 *
 * BOUNDARY-EDGE ATOM IS A ROOT SIBLING (lane serve P-53, 2026-08-22).
 * `boundaryEdgeFact` is read from property-boundary-edge atoms. Writer
 * keys entity_id = `${countyFips}:${propId}:boundary:${edgeIndex}`. Dual
 * grammar is prefix-range on both parcel prefixes for `:boundary:`
 * suffixes. Geometry is the atom body, never GIS parcel outline /
 * txgio_parcel / bake ring. Never SELECT bake / place_layer_snapshots /
 * CAD / GIS / txgio_parcel for this field.
 *
 * CITY LIMITS IS A ROOT SIBLING (lane P-76, 2026-08-24).
 * `cityLimitsFact` is PIP against `tx_city_boundary`, not an atom.
 * Status is incorporated | unincorporated | unmeasured. ETJ is
 * `etjStatus: unresolved` — no buffer, no offset ring. Empty table
 * is unmeasured, never unincorporated. Query point is the bake
 * lat/lng index and is served on the fact as `queryPoint` (null when
 * the bake holds the 0,0 sentinel). Never copy situs city as
 * incorporated place.
 *
 * ZONING VERDICT DERIVES FROM CITY LIMITS (CTX card F, 2026-08-28).
 * For a parcel WITHOUT a zoning stamp, `facets.zoning` is the verdict
 * `zoningVerdictFromCityLimits` builds from `cityLimitsFact` and the
 * county roster: `stamp-missing` inside an incorporated place (the
 * place named), `not-applicable` only when the index is populated, the
 * point is outside every place, and the county's unincorporated
 * territory is unzoned; `unmeasured` otherwise, carrying the reason.
 * `baseFacts.situsCity` is never an input: until this card a null
 * situsCity (which the conformant bake wrote for every parcel) served
 * central Austin as `not-applicable: unincorporated`. The land-use
 * fact receives the same verdict only when it is `not-applicable`.
 *
 * OWNER ATOM IS A ROOT SIBLING (lane serve P-54, 2026-08-22; gate
 * tightened 2026-08-24). `ownerFact` is read from owner-fact atoms.
 * Writer keys entity_id = `${parcelNodeId}:${taxYear}` (same CAD-year
 * family as land-use-fact). Dual grammar is LIKE prefix:% on both
 * parcel prefixes; taxYear is the writer suffix. Owner name and mailing
 * leave this route only when PE entitlement is studio or team
 * (`subscriptionTierGrantsStudio` on `pe_user_entitlements`). Anonymous,
 * free, Solo, $15 unlock, and identified-only brokerage sessions receive
 * a typed `studio-gated` refusal with no ownerName and no mailing, and
 * do not query atoms. Identified session is not the gate. Operator /
 * extension API keys are not a session. Share-loop full-fidelity is a
 * locked exception on the share path, not this read. Never SELECT
 * cad-parcel-roll / bake / cad_property / GIS ParcelCardData.owner for
 * this field. Do not run sanitizeNodeFacetPayload on a granted
 * ownerFact (it would strip ownerName).
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db, placeLayerSnapshots } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { brokerageCors } from "../middlewares/brokerageCors";
import { gtmErrorBody } from "../lib/gtmErrorClass";
import { refusePayloadAtServe } from "../lib/serveGuards";
import { TIER1_ADAPTER_KEY } from "../lib/nodeFacetTier1Constants";
import { TIER2_ADAPTER_KEY } from "../lib/nodeFacetTier2Constants";
import { loadFloodHazardFactForServe } from "../lib/floodHazardFactServeCutover";
import { loadLandUseFactAtom } from "../lib/landUseFactRead";
import { loadSpecialDistrictFactForServe } from "../lib/specialDistrictFactServeCutover";
import { loadPipelineFactAtom } from "../lib/pipelineFactRead";
import { loadWellFactForServe } from "../lib/wellFactServeCutover";
import { loadBuildingFootprintFactAtom } from "../lib/buildingFootprintFactRead";
import { loadBoundaryEdgeFactAtom } from "../lib/boundaryEdgeFactRead";
import {
  studioGatedOwnerFactRefusal,
  loadOwnerFactAtom,
} from "../lib/ownerFactRead";
import {
  resolvePeEntitlement,
  subscriptionTierGrantsStudio,
} from "../lib/peEntitlement";
import { loadStructuralFactAtom } from "../lib/structuralFactRead";
import { loadCityLimitsFactForServe } from "../lib/cityLimitsFactServeCutover";
import { usableCityLimitsQueryPoint } from "@workspace/cad-ingest/city-limits";
import { enrichLandUseFactWithZoningVerdict } from "../lib/landUseFactVerdict";
import { zoningVerdictFromCityLimits } from "../lib/verdictLayerServe";
import {
  attachVerdictLayersToFacets,
  attachCadRollOverlaysToFacets,
} from "../lib/structuralFactToFacetsWire";
import { resolveCadRollOverlaysForServe } from "../lib/cadRollServeCutover";
import { parseParcelNodeId } from "../lib/parcelNodeId";
import { enrichFacetsResponseWithRegistry } from "@workspace/instrument-registry";
import {
  authenticatedBrokerageUserId,
  extractBrokerageApiKey,
} from "../middlewares/brokerageAuth";
import { verifySessionToken } from "../lib/sessionToken";
import {
  extractEnvelopeBriefRefusal,
  type EnvelopeBriefRefusal,
} from "../lib/envelopeBriefRefusal";

export type { EnvelopeBriefRefusal } from "../lib/envelopeBriefRefusal";
export { extractEnvelopeBriefRefusal };

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
 * Reuse the existing brokerage identified-session signal without remounting
 * this public route behind 401. Operator / extension keys stay anonymous
 * for ownerFact (`authenticatedBrokerageUserId` requires tier `user`).
 */
function applyExistingIdentifiedBrokerageSession(req: Request): void {
  if (authenticatedBrokerageUserId(req) != null) return;
  const provided = extractBrokerageApiKey(req);
  if (!provided?.includes(".")) return;
  if (!process.env.SESSION_SECRET?.trim()) return;
  let verified: ReturnType<typeof verifySessionToken>;
  try {
    verified = verifySessionToken(provided);
  } catch {
    return;
  }
  if (verified.ok && verified.session.requestor?.kind === "user") {
    req.session = verified.session;
    req.brokerageAuth = { tier: "user" };
  }
}

export function isIdentifiedOwnerFactCaller(req: Request): boolean {
  applyExistingIdentifiedBrokerageSession(req);
  return authenticatedBrokerageUserId(req) != null;
}

/**
 * Studio|Team PE entitlement is the owner-name gate. Identified session
 * alone is not enough (2026-08-24). Unlock and Solo refuse.
 */
export async function callerGrantsOwnerFact(req: Request): Promise<boolean> {
  applyExistingIdentifiedBrokerageSession(req);
  if (authenticatedBrokerageUserId(req) == null) return false;
  const snap = await resolvePeEntitlement(req);
  return subscriptionTierGrantsStudio(snap.subscriptionTier);
}

function isOwnerIshKey(key: string): boolean {
  if (/^owner(?![a-z])/i.test(key) || /^owner[_A-Z]/.test(key)) return true;
  return /^(cad|gis|txgio)[_-]?owner/i.test(key);
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
      // Match `owner`, `ownerName`, `owner_name`, `cadOwner`, `gisOwner`,
      // `txgioOwner` — any key that can paint a CAD/GIS owner name.
      if (isOwnerIshKey(key)) {
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
      if (isOwnerIshKey(key)) return true;
      if (payloadHasOwnerKey(v)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tier-2 FLOOD IS RETIRED AT THE READ PATH (lane SS-W16, 2026-08-19, P-45).
//
// WHY. The Tier-2 bake does not ask FEMA about the parcel. It quantises the
// parcel centroid onto a 0.005-degree tile (`nodeFacetBakeTier2Cli.ts:126`
// FEMA_TILE_DEG, `:287-291` tileKey, `:666` femaTile) and issues ONE NFHL point
// query at the TILE CENTRE (`:507-508` `tileCenter(key)` -> `arcgisPointQuery`).
// The answer is then stamped onto every parcel that fell in that tile. Measured
// displacement from the parcel it answers for: median 227 m, max 366 m.
//
// Lane SS-W11 adjudicated 5,756 disagreements against FEMA NFHL directly: the
// `flood-hazard-fact` atom was right in 5,714 of 5,714 non-split cases and this
// instrument in ZERO — including 1,995 parcels told they were OUTSIDE a Special
// Flood Hazard Area whose centroid is INSIDE one. A wrong flood determination
// served anonymously is a safety claim, not a completeness number, so the serve
// stops here rather than waiting on the replacement.
//
// `fema:nfhl-flood-zone` is not a second store to retire separately. It is the
// adapterKey this same bake stamps into its own provenance. Same bake, same
// quantiser, one instrument — so they retire as a pair, which is what the
// producer-keyed refusal below implements.
//
// SCOPE. This retires the BAKED Tier-2 flood facet on the node-facets read path
// ONLY. The live `fema:nfhl-flood-zone` map-layer adapter (brokerageGisLayers,
// engineSpineMapLayers, planReviewLayerRun, warmingHarness) queries FEMA at a
// real point rather than through the tile quantiser; it is a different
// instrument that happens to share an adapter-key STRING, and retiring it on
// the string match would be exactly the syntactic reasoning this cut exists to
// remove. The Tier-2 BAKE itself is also untouched: its stored rows are the
// evidence SS-W11 adjudicated against, and retirement sequences consumers-first.
// ---------------------------------------------------------------------------

/**
 * Every instrument that has ever authored the `flood` facet of a
 * `node-facets:tier2` row, identified by the `provenance.adapterKey` the facet
 * carries ABOUT ITSELF.
 *
 * This list is the branch input, and that is the whole design. The guard this
 * replaces asked `if (!p.flood || typeof p.flood !== "object")` — a presence
 * plus shape test with ONE input, satisfied by any object, including the
 * tile-quantised one. The guard one repo over in hauska-map
 * (`apps/property-explorer/src/lib/baked-facets.ts:430`) asks
 * `base.includes("/property-atoms")` — a SUBSTRING test on a configuration
 * string deciding which of two semantically different flood answers a caller
 * receives. Both decide a hazard determination by syntax.
 *
 * This asks a different question: WHICH INSTRUMENT produced this value, by
 * exact string equality against a closed set, and is every member of that set
 * accounted for. Adding a producer here without adding its `case` in
 * {@link disposeTier2Flood} is a TYPECHECK FAILURE at the `never` assignment,
 * not a silent pass-through.
 */
export const TIER2_FLOOD_PRODUCERS = ["fema:nfhl-flood-zone"] as const;
export type Tier2FloodProducer = (typeof TIER2_FLOOD_PRODUCERS)[number];

/**
 * Why no flood value is on the wire for this node. Every variant is a REFUSAL:
 * after the SS-W16 retirement there is no input for which this read path emits
 * a flood determination, and the type says so rather than the comment saying so.
 *
 * This is a distinct state from `tier2: null`, which means "no Tier-2 row exists
 * for this node at all". Collapsing "refused" into "absent" would hide the
 * retirement from every consumer, which is the failure mode the enforcement
 * doctrine names: correct prose over a live store, consumers unable to tell.
 */
export type Tier2FloodDisposition =
  | {
      state: "refused";
      code: "retired-instrument";
      producer: Tier2FloodProducer;
      retiredOn: string;
      supersededBy: string;
      reason: string;
    }
  | {
      state: "refused";
      code: "unrecognised-producer";
      producer: string | null;
      reason: string;
    }
  | {
      state: "refused";
      code: "no-flood-facet";
      producer: null;
      reason: string;
    };

/** Read the facet's self-declared producer. Never infers one. */
function readFloodProducer(floodFacet: Record<string, unknown>): string | null {
  const provenance = floodFacet.provenance;
  if (!provenance || typeof provenance !== "object") return null;
  const adapterKey = (provenance as Record<string, unknown>).adapterKey;
  return typeof adapterKey === "string" && adapterKey.trim()
    ? adapterKey.trim()
    : null;
}

/** Exact membership in the closed producer set. No substring, no prefix. */
function asRecognisedProducer(raw: string | null): Tier2FloodProducer | null {
  if (raw === null) return null;
  return (TIER2_FLOOD_PRODUCERS as readonly string[]).includes(raw)
    ? (raw as Tier2FloodProducer)
    : null;
}

/**
 * Decide what happens to a stored Tier-2 flood facet. Total and fail-closed:
 * every input — recognised producer, unrecognised producer, absent provenance,
 * missing facet, malformed row — resolves to a refusal carrying its basis. No
 * branch returns a value, and no branch falls through to a default that serves
 * one.
 */
export function disposeTier2Flood(floodFacet: unknown): Tier2FloodDisposition {
  if (
    !floodFacet ||
    typeof floodFacet !== "object" ||
    Array.isArray(floodFacet)
  ) {
    return {
      state: "refused",
      code: "no-flood-facet",
      producer: null,
      reason:
        "This Tier-2 row carries no flood facet. Absent is not a determination.",
    };
  }

  const raw = readFloodProducer(floodFacet as Record<string, unknown>);
  const producer = asRecognisedProducer(raw);
  if (producer === null) {
    return {
      state: "refused",
      code: "unrecognised-producer",
      producer: raw,
      reason:
        "This flood facet declares no recognised producing instrument, so its " +
        "fitness to answer cannot be established. Refusing rather than " +
        "defaulting to serve.",
    };
  }

  switch (producer) {
    case "fema:nfhl-flood-zone":
      return {
        state: "refused",
        code: "retired-instrument",
        producer,
        retiredOn: "2026-08-19",
        supersededBy: "flood-hazard-fact",
        reason:
          "Retired 2026-08-19 (lane SS-W16, P-45). This instrument queried FEMA " +
          "NFHL once per 0.005-degree tile at the tile centre, a measured median " +
          "227 m and maximum 366 m from the parcel it answered for. Adjudicated " +
          "against FEMA NFHL over 5,756 disagreements it was correct in 0 cases, " +
          "including 1,995 parcels reported outside a Special Flood Hazard Area " +
          "whose centroid is inside one. Read flood hazard from the " +
          "flood-hazard-fact atom instead.",
      };
    default: {
      // Exhaustiveness gate. If TIER2_FLOOD_PRODUCERS grows a member without a
      // case above, `producer` is that member here rather than `never` and this
      // line fails `pnpm run typecheck`. A new producer therefore cannot reach
      // a caller without an explicit ruling on whether it may answer.
      const unhandled: never = producer;
      return {
        state: "refused",
        code: "unrecognised-producer",
        producer: String(unhandled),
        reason:
          "A recognised producer reached the read path with no disposition " +
          "ruling. Refusing.",
      };
    }
  }
}

/**
 * The Tier-2 overlay composed onto the Tier-1 base.
 *
 * `flood` is typed as the literal `null`, not `unknown`. That is a second,
 * independent mechanism from {@link disposeTier2Flood}: even if the runtime
 * switch were edited away, assigning a flood value to this field fails
 * `tsc`. The comment is not the guarantee; the type is.
 *
 * `envelope` is likewise always null — anti-zombie (WDLL 3.7): the buildable
 * envelope comes from the property atom chain, never from a Tier-2 row.
 *
 * A node with NO Tier-2 row still gets `tier2: null`. A node WITH a Tier-2 row
 * gets this overlay carrying `floodDisposition`, so "we hold a row and refuse
 * its flood facet" is distinguishable on the wire from "nothing is baked here".
 * The rest of the Tier-2 payload (schema version, county echo) stays internal.
 * Owner-strip still runs over the composed result defense-in-depth.
 */
export interface Tier2Overlay {
  flood: null;
  floodDisposition: Tier2FloodDisposition;
  envelope: null;
  bakedAt: unknown;
  snapshotAt: string | null;
}

export interface BakedNodeFacetSnapshot {
  parcelNodeId: string;
  facets: unknown;
  snapshotAt: string | null;
  tier2: Tier2Overlay | null;
  /** Honest envelope refusal derived from raw Tier-1 payload before strip. */
  envelopeBriefRefusal: EnvelopeBriefRefusal;
  /** Bake coord index. Absent/null when missing, non-finite, or 0,0. */
  queryPoint?: { longitude: number; latitude: number } | null;
}

export function extractTier2Overlay(
  payloadJson: unknown,
  snapshotAt: Date | string | null,
): Tier2Overlay | null {
  // The only question this branch answers is whether a Tier-2 ROW exists. It no
  // longer inspects the flood facet to decide whether to emit an overlay: that
  // was the presence-shaped guard, and a row's flood facet now determines a
  // REFUSAL REASON, never whether a caller receives a determination.
  if (!payloadJson || typeof payloadJson !== "object") return null;
  const p = payloadJson as Record<string, unknown>;
  return {
    flood: null,
    floodDisposition: disposeTier2Flood(p.flood),
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
      latRounded: placeLayerSnapshots.latRounded,
      lngRounded: placeLayerSnapshots.lngRounded,
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
  try {
    refusePayloadAtServe(row.payloadJson);
  } catch (err) {
    const code = (err as { code?: string }).code ?? "SERVE_REFUSED";
    throw Object.assign(new Error(String((err as Error).message)), { code });
  }
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
    envelopeBriefRefusal: extractEnvelopeBriefRefusal(row.payloadJson),
    queryPoint: usableCityLimitsQueryPoint(
      Number(row.lngRounded),
      Number(row.latRounded),
    ),
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

    const grantsOwnerFact = await callerGrantsOwnerFact(req);
    let snapshot;
    let floodHazardFact;
    let landUseFactRaw;
    let specialDistrictFact;
    let pipelineFact;
    let wellFact;
    let buildingFootprintFact;
    let boundaryEdgeFact;
    let ownerFactLoaded;
    let structuralFact;
    let cadRollOverlay;
    try {
      const parsedForOverlay = parseParcelNodeId(parcelNodeId);
      [
        snapshot,
        floodHazardFact,
        landUseFactRaw,
        specialDistrictFact,
        pipelineFact,
        wellFact,
        buildingFootprintFact,
        boundaryEdgeFact,
        ownerFactLoaded,
        structuralFact,
        cadRollOverlay,
      ] = await Promise.all([
        loadBakedNodeFacetSnapshot(parcelNodeId),
        loadFloodHazardFactForServe(parcelNodeId),
        loadLandUseFactAtom(parcelNodeId),
        loadSpecialDistrictFactForServe(parcelNodeId),
        loadPipelineFactAtom(parcelNodeId),
        loadWellFactForServe(parcelNodeId),
        loadBuildingFootprintFactAtom(parcelNodeId),
        loadBoundaryEdgeFactAtom(parcelNodeId),
        grantsOwnerFact
          ? loadOwnerFactAtom(parcelNodeId)
          : Promise.resolve(null),
        loadStructuralFactAtom(parcelNodeId),
        // PARCEL-B-SLATE2: a malformed parcelNodeId already 400'd above this
        // handler's own reachable code, but parseParcelNodeId is defensive
        // regardless -- a null parse resolves every rail to "keep legacy"
        // rather than throwing mid-Promise.all.
        parsedForOverlay
          ? resolveCadRollOverlaysForServe(parsedForOverlay.countyFips, parsedForOverlay.propId)
          : Promise.resolve({
              marketValue: null,
              assessedValue: null,
              landValue: null,
              improvementValue: null,
              livingAreaSqft: null,
              yearBuilt: null,
            }),
      ]);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ACCESS_NOT_DEFAULTED" || code === "SITUS_PUNCTUATION_ONLY") {
        res.status(422).json(
          gtmErrorBody("serve_refused", code, (err as Error).message),
        );
        return;
      }
      throw err;
    }
    const ownerFact =
      ownerFactLoaded ?? studioGatedOwnerFactRefusal(parcelNodeId);
    // City limits FIRST: the zoning verdict derives incorporation from this
    // containment fact and from nothing else (CTX card F). A null situsCity
    // is not evidence of anything.
    const cityLimitsFact = await loadCityLimitsFactForServe(
      parcelNodeId,
      snapshot?.queryPoint ?? null,
    );
    const zoningVerdict = snapshot
      ? zoningVerdictFromCityLimits(parcelNodeId, snapshot.facets, cityLimitsFact)
      : null;
    const landUseFact = enrichLandUseFactWithZoningVerdict(
      landUseFactRaw,
      zoningVerdict,
    );
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

    res.json(
      enrichFacetsResponseWithRegistry({
      parcelNodeId,
      adapterKey: TIER1_ADAPTER_KEY,
      source: "baked-snapshot",
      snapshotAt: snapshot.snapshotAt,
      facets: attachCadRollOverlaysToFacets(
        attachVerdictLayersToFacets(
          snapshot.facets as Record<string, unknown>,
          structuralFact,
          zoningVerdict,
          cadRollOverlay.livingAreaSqft,
        ),
        cadRollOverlay,
      ),
      // `null` when the node has no Tier-2 row at all. When a row exists, the
      // overlay carries `flood: null` plus a typed `floodDisposition` saying
      // why — retired instrument, unrecognised producer, or no facet.
      // Snapshot flood values never leave this field (SS-W16, 2026-08-19).
      tier2: snapshot.tier2,
      // Replacement flood determination. Dual-grammar bind of flood-hazard-fact
      // atoms. Typed refusal on miss / conflict / unconfigured store. Never
      // copied from the baked Tier-2 snapshot.
      floodHazardFact,
      // Land-use-fact atom. Dual grammar on the parcel PREFIX only; taxYear
      // comes from the atom row. Baked facets.baseFacts.landUse stays
      // retiredStore. Never copied off the CAD roll table.
      landUseFact,
      // Special-district-fact atom. Dual grammar on the parcel PREFIX only;
      // districtId comes from the writer `:sd:` suffix. Never copied off
      // bake / CAD / mud-pid. mud is a districtType, not a second family.
      specialDistrictFact,
      // rrc-pipeline-fact atom. Dual grammar on the parcel keys (writer
      // stores bare parcelNodeId). Spatial attach is write-time, not a
      // live texas-rrc overlay. Never copied off bake / CAD / GIS.
      pipelineFact,
      // well-fact atom. Dual grammar on the parcel PREFIX only; wellKey
      // is the writer suffix. Spatial attach is write-time 152 m. Never
      // copied off bake / CAD / GIS / texas-rrc / tx_rrc_well.
      wellFact,
      // building-footprint atom. Dual grammar on the parcel PREFIX only.
      // structureRole is body.structureRole, never the :primary token.
      // Spatial attach is write-time staged overlap. Never copied off
      // bake / CAD / GIS / tx_building_footprint.
      buildingFootprintFact,
      // property-boundary-edge atom. Dual grammar on the parcel PREFIX
      // only for :boundary: suffixes. Geometry is the atom body, never
      // GIS parcel outline / txgio_parcel / bake ring.
      boundaryEdgeFact,
      // owner-fact atom. Dual grammar on the parcel PREFIX only; taxYear
      // is the writer suffix. Studio|Team only. Everyone else is a typed
      // studio-gated refusal with no ownerName / mailing and no atoms
      // SELECT. Never copied off cad-parcel-roll / bake / cad_property / GIS.
      ownerFact,
      // Structural/CAMA layer (living_area_sqft, year_built). bulk_primary
      // counties on stratmap-roll tier return lookup-failed; populated
      // counties return present. Never upgrades lookup-failed in transit.
      structuralFact,
      // City limits PIP against tx_city_boundary. Not an atom. Empty
      // index is unmeasured. ETJ is unresolved, never a buffer. Carries
      // the query point the containment (and the zoning verdict) rests on.
      cityLimitsFact,
      }),
    );
  },
);
