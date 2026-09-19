/**
 * Buildable-envelope derivation route â€” the "show me the setbacks / where the
 * ADU fits" wedge geometry, spine-side so every consumer (Property Brief, the
 * Brief extension, the digital-design-center app) gets the same envelope.
 *
 *   GET  /api/brokerage/v1/place/:placeKey/buildable-envelope
 *   POST /api/brokerage/v1/place/buildable-envelope   { address }
 *
 * What it does: resolve the place -> its geocoded point + jurisdiction, fetch
 * the REAL parcel polygon at that point (WCAD/Hays/TxGIO county GIS via the same
 * parcels pin-query the map uses), fetch the codified setback table for the
 * jurisdiction, map the parcel's zoningCode to its setback district, label the
 * parcel's edges (front/side/rear) from the best available signal (nearest OSM
 * road -> geocoded point -> lot shape), inset each edge by its own setback, and
 * return the buildable-envelope GeoJSON wrapped in the standard engine honesty
 * envelope (confidence + provenance + Municode citation).
 *
 * HONESTY (commitment #1 / Master WDLL 3.7 I-A): product envelope confidence
 * is NEVER `labeling×district product`. This route serves the
 * retrieval atom-chain when present, otherwise honest-declines
 * (`atom_path_pending` / `no-zoning-stamp`). Geometry helper may remain in
 * lib/buildableEnvelope/derive.ts but does not author product confidence.
 *
 * Auth: mounted under the brokerage gate (parent `brokerageV1` applies
 * `requireBrokerageAuthOrServiceToken`); a missing/bad key is 401'd upstream.
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import { keyFromEngagementOrSynthesize } from "@workspace/codes";
import {
  wrapEngineEnvelope,
  type EngineHonesty,
} from "../../../../lib/engine-core/src/envelope";
import {
  legacyHonestyToReadContract,
  readContractForWire,
} from "@workspace/engine-core";
import { AdapterRunError } from "@workspace/adapters/types";
import { geocodeAddress } from "@workspace/site-context/server";
import { logger } from "../lib/logger";
import { resolvePlace, parseCoordPlaceKey } from "../lib/placeResolve";
import { placeKeyFromCoords, roundPlaceCoord } from "../lib/placeLayerUtils";
import { queryGisLayerGeoJson } from "../lib/brokerageGisLayers";
import {
  resolveRooftopByAddress,
  resolveRooftopAcrossCounties,
  resolveParcelBySitusDisambiguated,
  type SitusResolveOutcome,
} from "../lib/txgioAddressResolve";
import {
  resolveTxParcelCounty,
  resolvePointCountyByPip,
  countiesContainingPoint,
  allStoreCounties,
  queryTxCountyParcelByPropId,
  txCountyProviderLabel,
  txParcelProviderMode,
  TX_PARCEL_COUNTIES,
  type TxParcelCounty,
} from "../lib/brokerageTxParcels";
import { parcelNodeId, parseParcelNodeId } from "../lib/parcelNodeId";
import { NO_ZONING_STAMP_REASON } from "../lib/buildableEnvelope/absentZoningHonesty";
import {
  fetchPropertyAtomChain,
  type PropertyAtomChainWire,
} from "../lib/buildableEnvelope/fetchPropertyAtomChain";
import {
  resolveAuthoritativeSetbacks,
  type AuthoritativeSetbackResolution,
} from "../lib/buildableEnvelope/authoritativeSetbackSource";
import { getSetbackTableForZoning } from "@workspace/adapters";
import {
  districtCodeHasExactRow,
  firstResolvableDistrictCode,
} from "../lib/buildableEnvelope/districtMapping";
// P-340: the R-1 conflict row the resolver has returned since P-154 and this
// payload never served — see `setbackSourceConflict.ts`.
import { sourceConflictRowForResolution } from "../lib/buildableEnvelope/setbackSourceConflict";
import { plannedDevelopmentSetbackRefusalFor } from "../lib/buildableEnvelope/plannedDevelopmentSetback";
import {
  cityStateFromSitus,
  jurisdictionKeyFromParcelNode,
} from "../lib/buildableEnvelope/envelopeJurisdiction";
import { POST_BODY } from "../lib/buildableEnvelope/envelopePostBody";
import {
  labelEdges,
  type RoadCandidate,
} from "../lib/buildableEnvelope/edgeLabeling";
import { fetchNearbyRoads, namedRoadsToCandidates } from "../lib/buildableEnvelope/roads";
import {
  resolveSpineZoningWhenGisAbsent,
  type SpineZoningResolution,
} from "../lib/buildableEnvelope/spineZoningDistrict";
import { openRing, type Ring } from "../lib/buildableEnvelope/geometry";
// P-153 Step A: moved out of THIS file so the get_smart_site draw-block
// orchestration (parcelDrawEnvelopeModel.ts) can reuse both without pulling
// in this route's own resolvePlace/txgioAddressResolve/brokerageTxParcels/
// txgioParcelStore import graph (all @workspace/db-coupled at module load —
// see that lib file's own doc comment for why this move happened). Both
// re-exported below so THIS file's own public surface (and its own
// deriveLabelAndRespond call site, unchanged) still work exactly as before.
import {
  composeBuildableEnvelopeDerivation,
  firstParcelRing,
} from "../lib/buildableEnvelope/composeBuildableEnvelopeDerivation";
export {
  composeBuildableEnvelopeDerivation,
  firstParcelRing,
} from "../lib/buildableEnvelope/composeBuildableEnvelopeDerivation";

export const brokeragePlaceBuildableEnvelopeRouter: IRouter = Router();

const PLACE_KEY_PARAM = z.string().min(1);
export { POST_BODY } from "../lib/buildableEnvelope/envelopePostBody";

/**
 * P-151: bounds the point-resolution pin-query (`queryGisLayerGeoJson`) in
 * the explicit-coordinates branch of `handleBuildableEnvelope` so a slow or
 * stuck query surfaces as a DECLARED 503 refusal comfortably inside the
 * ~10s window that was otherwise surfacing as a bare platform 504 (observed
 * 2026-09-11, Travis County, `POST .../buildable-envelope` with a bare
 * `{lat,lng}` body). Named/exported per this file family's existing
 * timeout-constant convention (see `RADIUS_SEARCH_*` in `txgioRadiusSearch.ts`).
 *
 * IMPORTANT: this is a client-side race, NOT query cancellation. On timeout
 * the underlying DB query is left running server-side; this constant only
 * bounds how long THIS request waits on it. It relieves the user-facing
 * bare-504 symptom, not any underlying DB/pool contention.
 */
export const POINT_RESOLUTION_TIMEOUT_MS = 8_000;

/**
 * Marker error thrown by `withPointResolutionTimeout` when the wrapped
 * promise does not settle within `POINT_RESOLUTION_TIMEOUT_MS`. Distinguished
 * from a genuine `AdapterRunError` in the catch block below so a timeout and
 * a real provider failure produce different, honest responses.
 */
class PointResolutionTimeoutError extends Error {
  constructor() {
    super("buildable-envelope: point resolution exceeded time budget");
    this.name = "PointResolutionTimeoutError";
  }
}

/**
 * Races `promise` against a `ms` timer. Does NOT cancel `promise` on
 * timeout -- see the `POINT_RESOLUTION_TIMEOUT_MS` doc comment above.
 */
function withPointResolutionTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PointResolutionTimeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function reqLog(req: Request): typeof logger {
  return (req as unknown as { log?: typeof logger }).log ?? logger;
}

function decodePlaceKeyParam(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return decodeURIComponent(value ?? "").trim();
}

interface EnvelopeContext {
  placeKey: string;
  lat: number;
  lng: number;
  city: string | null;
  state: string | null;
  address: string | null;
  /**
   * How the resolved (lat,lng) was obtained. This is the TRUE authority
   * of the point, so a fuzzy ZIP/city centroid is never mistaken for a
   * rooftop:
   *   - "coordinates"  : caller passed explicit lat/lng (honored verbatim).
   *   - "authoritative": county rooftop point from `txgio_address`.
   *   - "geocode-high" : Nominatim returned a hit for the full address.
   *   - "geocode-low"  : Nominatim only matched a coarser rung
   *                       (city/ZIP centroid) â€” the point is NOT rooftop.
   *   - "parcel-identity": no point was sent; this is the representative
   *                       point of the parcel the caller IDENTIFIED
   *                       (`parcel_node_id`), used only for roads/labeling.
   */
  pointConfidence:
    | "coordinates"
    | "authoritative"
    | "geocode-high"
    | "geocode-low"
    | "parcel-identity";
  /**
   * False ONLY on the F4e situs-hit path when the geocode MISSED, so
   * `(lat,lng)` is a `(0,0)` sentinel, not a real location. Edge labeling
   * and the OSM road fetch must then skip the point signal (degrade to lot
   * shape) rather than treat null-island as the reference point. Absent /
   * true on every other path (a real point is always present).
   */
  hasPoint?: boolean;
}

function withPlace<T extends Record<string, unknown>>(
  body: T,
  ctx: EnvelopeContext,
): T & { placeKey: string } {
  return { ...body, placeKey: ctx.placeKey };
}

/**
 * Resolve the derivation inputs (placeKey/address/coords) to a point +
 * city/state, honoring the F4d authority order:
 *   (i)   explicit caller lat/lng   -> honored verbatim (no re-geocode
 *         of the point; the address, if present, only enriches city/state).
 *   (ii)  authoritative county rooftop from `txgio_address`             -> upgrade the point.
 *   (iii) fuzzy geocode              -> LAST resort, tagged with its true
 *         rung so a locality/ZIP centroid is never mistaken for rooftop.
 *
 * The situs->parcel-directly path (the strongest authority) is applied
 * downstream in `handleBuildableEnvelope`, where the county + provider
 * label are in hand.
 */
async function resolveContext(
  input:
    | { placeKey: string }
    | { address?: string; lat?: number; lng?: number },
  /**
   * A geocode already fetched by the situs pre-pass, reused here so the
   * no-situs-match fall-through path does NOT geocode a second time. Only
   * consulted for the address-only branch (explicit coords never geocode).
   * `null` means the pre-pass geocoded and MISSED â€” honored as a genuine
   * geocode miss (422) exactly as `resolvePlace` would have.
   */
  pregeocoded?: {
    provided: boolean;
    geocode: Awaited<ReturnType<typeof geocodeAddress>> | null;
  },
): Promise<EnvelopeContext | { error: { status: number; body: Record<string, unknown> } }> {
  let resolveInput:
    | { address: string }
    | { lat: number; lng: number; address?: string };
  let addressHint: string | null = null;
  // Set when the caller passed explicit coordinates â€” those are honored
  // verbatim as the point, bypassing the geocode-derived point entirely.
  let explicitCoords: { lat: number; lng: number } | null = null;

  if ("placeKey" in input) {
    const coord = parseCoordPlaceKey(input.placeKey);
    if (coord) {
      resolveInput = { lat: coord.lat, lng: coord.lng };
      explicitCoords = { lat: coord.lat, lng: coord.lng };
    } else {
      // A non-coordinate placeKey needs an address to re-geocode; we don't carry
      // a placeKey->address store here, so require the POST/address form.
      return {
        error: {
          status: 400,
          body: {
            error: "unresolvable_place_key",
            message:
              "This placeKey is not coordinate-encoded; call POST /place/buildable-envelope with { address }.",
          },
        },
      };
    }
  } else if (input.lat != null && input.lng != null) {
    // Explicit coordinates take precedence over any address: the caller
    // gave us the point, so we HONOR it and never re-geocode the address
    // to a (possibly wrong) point. The address, when present, is passed
    // only so `resolvePlace` can enrich city/state for jurisdiction.
    resolveInput = { lat: input.lat, lng: input.lng, address: input.address };
    explicitCoords = { lat: input.lat, lng: input.lng };
    addressHint = input.address ?? null;
  } else if (input.address) {
    resolveInput = { address: input.address };
    addressHint = input.address;
  } else {
    return {
      error: {
        status: 400,
        body: { error: "invalid_request", message: "address or lat+lng required" },
      },
    };
  }

  // Reuse the situs pre-pass geocode for the address-only branch so we do
  // not geocode twice. When the pre-pass geocoded and MISSED
  // (`provided && geocode === null`), honor it as a real geocode miss (422)
  // just as `resolvePlace` would. Explicit coords never geocode, so they
  // always go through `resolvePlace` (which only enriches city/state).
  const canReusePregeocode =
    pregeocoded?.provided === true && !explicitCoords && addressHint !== null;

  let resolved: Awaited<ReturnType<typeof resolvePlace>>;
  if (canReusePregeocode) {
    const geo = pregeocoded!.geocode;
    if (!geo) {
      return {
        error: {
          status: 422,
          body: {
            errorClass: "geocode_miss",
            error: "geocode_miss",
            message: "Could not geocode the provided address",
          },
        },
      };
    }
    resolved = {
      placeKey: placeKeyFromCoords(
        roundPlaceCoord(geo.latitude),
        roundPlaceCoord(geo.longitude),
      ),
      jurisdiction_key: null,
      ll_uuid: null,
      workspaceDid: null,
      geocode: {
        lat: roundPlaceCoord(geo.latitude),
        lng: roundPlaceCoord(geo.longitude),
        city: geo.jurisdictionCity ?? null,
        state: geo.jurisdictionState ?? null,
        confidence:
          geo.matchRung && geo.matchRung !== "street" ? "low" : "high",
        matchRung: geo.matchRung,
      },
    };
  } else {
    resolved = await resolvePlace(resolveInput);
  }
  if ("errorClass" in resolved) {
    return {
      error: {
        status: resolved.errorClass === "geocode_miss" ? 422 : 400,
        body: resolved,
      },
    };
  }

  let lat = resolved.geocode.lat;
  let lng = resolved.geocode.lng;
  let placeKey = resolved.placeKey;
  let pointConfidence: EnvelopeContext["pointConfidence"];

  if (explicitCoords) {
    // Caller-supplied point wins outright.
    lat = explicitCoords.lat;
    lng = explicitCoords.lng;
    pointConfidence = "coordinates";
  } else {
    // Address-only resolution. Try to UPGRADE the fuzzy geocode point to
    // the county's authoritative rooftop before we trust it. The county
    // is chosen from the (approximate) geocode point â€” county routing
    // bboxes are generous enough that even a ZIP centroid lands in the
    // right county â€” then the rooftop is matched by address WITHIN it.
    pointConfidence =
      resolved.geocode.matchRung && resolved.geocode.matchRung !== "street"
        ? "geocode-low"
        : "geocode-high";

    if (addressHint && txParcelProviderMode() === "county-gis") {
      // F4j: point-in-polygon county pre-resolution so a border address whose
      // geocode centroid sits in county A's parcel but nearer county B's
      // centroid looks up its authoritative rooftop in the RIGHT county (the
      // one that owns the parcel). Falls back to nearest-centroid when the
      // geocode point is in no store parcel (a coarse centroid often is), so
      // never worse than before.
      const county = (
        await resolvePointCountyByPip({ latitude: lat, longitude: lng })
      ).county;
      if (county) {
        try {
          const rooftop = await resolveRooftopByAddress({
            countyFips: county.fips,
            address: addressHint,
          });
          if (rooftop) {
            lat = rooftop.latitude;
            lng = rooftop.longitude;
            placeKey = placeKeyFromCoords(lat, lng);
            pointConfidence = "authoritative";
          }
        } catch (err) {
          // Authoritative lookup is best-effort; a store hiccup must not
          // sink the request â€” fall through to the geocode point.
          logger.warn(
            { err, address: addressHint, county: county.fips },
            "buildable-envelope: authoritative rooftop lookup failed",
          );
        }
      }
    }
  }

  return {
    placeKey,
    lat,
    lng,
    city: resolved.geocode.city,
    state: resolved.geocode.state,
    address: addressHint,
    pointConfidence,
  };
}

/**
 * The supported county a resolved prop id belongs to (for the provider
 * label + the geometry fetch-by-prop-id). Resolvers stamp the county into
 * the parcel node id (`{fips}:{propId}`), so recover the fips from there
 * and map it back to its `TxParcelCounty` — from the WHOLE registry, not
 * just the store-backed counties (P-373: an address/identity resolve must
 * be able to reach a live-ArcGIS county that the store cannot draw).
 */
function txParcelCountyByFips(fips: string): TxParcelCounty | null {
  const trimmed = fips.trim();
  if (!trimmed) return null;
  return TX_PARCEL_COUNTIES.find((c) => c.fips === trimmed) ?? null;
}

/**
 * AUTHORITATIVE situs->parcel resolution (F4e; supersedes the F4d
 * single-county unique-only `resolveParcelBySitusDirect`). Runs the
 * disambiguating, multi-county situs resolve and, on an authoritative hit,
 * fetches that parcel's polygon DIRECTLY by prop id â€” skipping the geocode
 * pin-query entirely.
 *
 * Returns:
 *   - `{ parcelGeo, provider }` on an authoritative hit (unique situs, or an
 *     ambiguous situs the point disambiguated to a single containing parcel).
 *   - `{ decline: true }` when the situs was AMBIGUOUS and the point could
 *     NOT disambiguate it â€” the caller must DECLINE HONESTLY, never
 *     blind-point-guess a wrong-situs neighbor (commitment #1, item 1).
 *   - `null` when there was NO situs match at all â€” the caller falls through
 *     to the existing rooftop/geocode/pin path unchanged.
 *
 * The candidate county set is EVERY store county whose routing bbox
 * contains the point (item 2), or â€” when there is no point (geocode miss) â€”
 * ALL store counties (item 3); a unique situs needs no point. This inverts
 * F4d's "situs downstream of geocode-derived county routing": situs
 * authority is evaluated FIRST, over all candidate counties, and only the
 * point is used to break a genuine situs ambiguity.
 */
async function resolveParcelBySitusAuthoritative(input: {
  address: string;
  point: { latitude: number; longitude: number } | null;
  log: typeof logger;
  placeKey: string;
}): Promise<
  | { parcelGeo: { geojson: unknown; provider: string | null }; nodeCountyFips: string }
  | { decline: SitusResolveOutcome }
  | null
> {
  if (txParcelProviderMode() !== "county-gis") return null;

  // Candidate counties: every registry county whose routing bbox contains
  // the point — INCLUDING live-ArcGIS counties (P-373). The tag says where
  // a county SERVES its polygons; it says nothing about where its address
  // index lives, and the index is the store table (statewide). Scoping the
  // situs search to store-tagged counties is what left a Caldwell address
  // unconsulted and let a Hays no-coverage 404 stand in for a real match.
  // With no point to route by, keep the store set (a no-point situs still
  // resolves across the counties that can be served from the table).
  const counties =
    input.point &&
    Number.isFinite(input.point.latitude) &&
    Number.isFinite(input.point.longitude)
      ? countiesContainingPoint(input.point.latitude, input.point.longitude)
      : allStoreCounties();
  if (counties.length === 0) return null;

  const outcome = await resolveParcelBySitusDisambiguated({
    counties: counties.map((c) => ({ fips: c.fips })),
    address: input.address,
    point: input.point,
  });

  if (!outcome.hit) {
    if (outcome.reason === "no-situs-match") return null; // fall through
    // Ambiguous situs the point couldn't disambiguate -> honest decline.
    input.log.info(
      {
        placeKey: input.placeKey,
        address: input.address,
        reason: outcome.reason,
        ambiguousCandidateCount: outcome.ambiguousCandidateCount,
      },
      "buildable-envelope: ambiguous situs not disambiguated by point; declining rather than guessing a neighbor",
    );
    return { decline: outcome };
  }

  // Authoritative hit â€” recover the owning county from the node id
  // (`{fips}:{propId}`) and fetch that parcel's polygon BY IDENTITY from
  // whichever source that county serves (P-373). The store is not always
  // able to draw what its own index names (Caldwell's rows carry the situs
  // and no polygon), so the fetch goes through the one function that knows
  // both sources; a genuine miss falls through unchanged.
  const nodeCountyFips = outcome.hit.parcelNodeId.split(":")[0] ?? "";
  const county = txParcelCountyByFips(nodeCountyFips);
  if (!county) return null;

  const result = await queryTxCountyParcelByPropId({
    county,
    propId: outcome.hit.rawPropId,
  });
  if (!result) return null;
  input.log.info(
    {
      placeKey: input.placeKey,
      address: input.address,
      parcelNodeId: outcome.hit.parcelNodeId,
      resolvedBy: outcome.resolvedBy,
      candidateCounties: counties.map((c) => c.fips),
    },
    "buildable-envelope: resolved parcel authoritatively by situs",
  );
  return {
    parcelGeo: { geojson: result.geojson, provider: txCountyProviderLabel(county) },
    nodeCountyFips: county.fips,
  };
}

/**
 * Pull the free-text address and any explicit point out of the raw route
 * input, WITHOUT geocoding. The address feeds the situs pre-pass; the
 * explicit point (caller lat/lng, or a coord-encoded placeKey) is honored
 * verbatim as the disambiguation point when present.
 */
function extractSitusInputs(
  input: { placeKey: string } | { address?: string; lat?: number; lng?: number },
): { address: string | null; explicitPoint: { latitude: number; longitude: number } | null } {
  if ("placeKey" in input) {
    const coord = parseCoordPlaceKey(input.placeKey);
    return {
      address: null,
      explicitPoint: coord ? { latitude: coord.lat, longitude: coord.lng } : null,
    };
  }
  const address = input.address?.trim() ? input.address.trim() : null;
  const explicitPoint =
    input.lat != null && input.lng != null && Number.isFinite(input.lat) && Number.isFinite(input.lng)
      ? { latitude: input.lat, longitude: input.lng }
      : null;
  return { address, explicitPoint };
}

/**
 * SITUS-FIRST pre-pass (F4e item 3 â€” the authority inversion). Run the
 * authoritative, multi-county, disambiguating situs resolve BEFORE any
 * geocode-quality or geocode-miss gate, so the STRONGEST signal (situs) is
 * no longer downstream of the WEAKEST (geocode-derived county routing).
 *
 * Point source for disambiguation, in authority order:
 *   - explicit caller point (honored verbatim), else
 *   - a BEST-EFFORT geocode purely to obtain a disambiguation point +
 *     city/state. A geocode MISS is NON-FATAL here: `point` stays null and a
 *     UNIQUE situs still resolves (that is the whole point â€” a clean unique
 *     situs must not be lost to a geocode miss). The geocode is NOT re-run
 *     downstream; its result is threaded back so the no-situs path reuses it.
 *
 * Returns the situs outcome plus the (best-effort) geocode so the caller can
 * (a) derive directly on a hit, (b) 404 honestly on an ambiguous decline, or
 * (c) fall through to the existing rooftop/geocode/pin path on no-match.
 */
async function situsFirstPreResolve(input: {
  address: string | null;
  explicitPoint: { latitude: number; longitude: number } | null;
  log: typeof logger;
  placeKey: string;
}): Promise<{
  situs:
    | { parcelGeo: { geojson: unknown; provider: string | null }; nodeCountyFips: string }
    | { decline: SitusResolveOutcome }
    | null;
  geocode: Awaited<ReturnType<typeof geocodeAddress>> | null;
}> {
  const { address, explicitPoint } = input;
  if (!address) return { situs: null, geocode: null };

  let point = explicitPoint;
  let geocode: Awaited<ReturnType<typeof geocodeAddress>> | null = null;
  if (!point && address) {
    // Authoritative StratMap rooftop BEFORE fuzzy geocode (Travis Simsbrook class).
    try {
      const rooftop = await resolveRooftopAcrossCounties({ address });
      if (rooftop) {
        point = { latitude: rooftop.latitude, longitude: rooftop.longitude };
      }
    } catch (err) {
      input.log.warn(
        { err, address, placeKey: input.placeKey },
        "buildable-envelope: multi-county rooftop lookup failed; falling back to geocode",
      );
    }
  }
  if (!point) {
    // Best-effort geocode ONLY for a disambiguation point + city/state. A
    // miss (or a service hiccup) must NOT abort â€” a unique situs resolves
    // with no point at all.
    try {
      geocode = await geocodeAddress(address);
      if (geocode && Number.isFinite(geocode.latitude) && Number.isFinite(geocode.longitude)) {
        point = { latitude: geocode.latitude, longitude: geocode.longitude };
      }
    } catch (err) {
      input.log.warn(
        { err, address, placeKey: input.placeKey },
        "buildable-envelope: best-effort geocode for situs disambiguation failed; proceeding point-less",
      );
    }
  }

  const situs = await resolveParcelBySitusAuthoritative({
    address,
    point,
    log: input.log,
    placeKey: input.placeKey,
  });
  return { situs, geocode };
}


/**
 * The parcel whose polygon CONTAINS a point, as this surface's own
 * pin-query answer (`parcel_node_id`), or null when the point is in no
 * parcel this build can serve. Never throws: a no-coverage upstream
 * decline is "nothing there", not a conflict (P-373).
 */
async function parcelNodeIdAtPoint(point: {
  latitude: number;
  longitude: number;
}): Promise<string | null> {
  try {
    const geo = await queryGisLayerGeoJson({
      layer: "parcels",
      latitude: point.latitude,
      longitude: point.longitude,
    });
    return firstParcelRing(geo.geojson)?.parcelNodeId ?? null;
  } catch {
    return null;
  }
}

/**
 * A representative point for a ring the caller did not supply one for —
 * the mean of its vertices. Used ONLY to drive the road lookup and edge
 * labeling when a request identifies its parcel without a point; it is
 * reported as `pointConfidence: "parcel-identity"`, never as a rooftop or
 * a caller coordinate.
 */
function representativePointOfRing(
  ring: Ring,
): { latitude: number; longitude: number } | null {
  const open = openRing(ring);
  if (open.length === 0) return null;
  let lng = 0;
  let lat = 0;
  for (const [x, y] of open) {
    lng += x;
    lat += y;
  }
  return { latitude: lat / open.length, longitude: lng / open.length };
}

/**
 * P-373: RESOLVE A POSTED IDENTITY.
 *
 * `parcel_node_id` in the POST body is the CALLER's own identification of
 * the subject — a card that is showing a parcel knows which parcel it is,
 * and it must not have to re-derive that from a point. It is treated here
 * as an AUTHORITY, not as the fallback hint it used to be: this route
 * resolves THAT parcel by its identity, from whichever source its county
 * serves, and never answers a different one.
 *
 * The refusal is the point of it. A point (or address) carried in the same
 * request can DISAGREE with the identity — `48453:352594`'s record point
 * sits in Hays County and pin-queries `48209:10757` — and answering the
 * point's parcel for a card that named another parcel is the wrong-parcel
 * defect itself. On a disagreement this declines with a NAMED reason and
 * still returns the identity it was given, so the surface can see that the
 * parcel it asked about is not the parcel its own point lands in.
 *
 * Outcomes:
 *   - resolved : derive from this parcel (its geometry, not the point's).
 *   - refused  : a finished response body + status; the caller sends it.
 */
async function resolvePostedParcelIdentity(input: {
  parcelNodeId: string;
  point: { latitude: number; longitude: number } | null;
  placeKey: string;
  log: typeof logger;
}): Promise<
  | {
      kind: "resolved";
      ctx: EnvelopeContext;
      parcelGeo: { geojson: unknown; provider: string | null };
    }
  | { kind: "refused"; status: number; body: Record<string, unknown> }
> {
  const basePlaceKey = input.point
    ? placeKeyFromCoords(
        roundPlaceCoord(input.point.latitude),
        roundPlaceCoord(input.point.longitude),
      )
    : input.placeKey;
  const refuse = (status: number, body: Record<string, unknown>) =>
    ({ kind: "refused" as const, status, body: { ...body, placeKey: basePlaceKey } });

  const parsed = parseParcelNodeId(input.parcelNodeId);
  if (!parsed) {
    return refuse(400, {
      error: "invalid_parcel_node_id",
      message: `\`parcel_node_id\` must be "{countyFips}:{propId}" (received "${input.parcelNodeId}").`,
    });
  }
  const canonical = parcelNodeId(parsed.countyFips, parsed.propId)!;
  // The county sources are keyed on their OWN (normalized) prop id, so the
  // fetch asks for the canonical suffix — a caller that posts
  // `"48055:040428"` still reaches parcel 40428 rather than missing it on
  // a leading zero the id space does not carry.
  const canonicalPropId = canonical.slice(canonical.indexOf(":") + 1);
  const county = txParcelCountyByFips(parsed.countyFips);
  if (!county) {
    input.log.info(
      { parcelNodeId: canonical },
      "buildable-envelope: identified parcel is in a county this build has no parcel source for",
    );
    return refuse(404, {
      status: "no-parcel",
      declineReason: "parcel-source-absent-in-county",
      reason: `This parcel is identified in FIPS ${parsed.countyFips}, a county this build has no parcel source for, so a buildable envelope can't be derived.`,
      parcel_node_id: canonical,
    });
  }

  const parcelGeo = await queryTxCountyParcelByPropId({
    county,
    propId: canonicalPropId,
  });
  if (!parcelGeo) {
    input.log.info(
      { parcelNodeId: canonical, county: county.fips },
      "buildable-envelope: identified parcel is not present in its county's source",
    );
    return refuse(404, {
      status: "no-parcel",
      declineReason: "parcel-identity-not-found",
      reason: `${county.name} County has no parcel ${canonicalPropId}, so the identified parcel could not be resolved.`,
      parcel_node_id: canonical,
    });
  }

  // The caller's point, when it sent one, must AGREE with the identity. A
  // point that pin-queries another parcel (classically in another county)
  // is refused, never answered — the card asked about ITS parcel.
  if (input.point) {
    const atPoint = await parcelNodeIdAtPoint(input.point);
    if (atPoint && atPoint !== canonical) {
      const pointCounty = txParcelCountyByFips(atPoint.split(":")[0] ?? "");
      input.log.info(
        {
          parcelNodeId: canonical,
          pointParcelNodeId: atPoint,
          pointCountyFips: pointCounty?.fips ?? null,
        },
        "buildable-envelope: point does not match the identified parcel; refusing rather than answering a stranger's parcel",
      );
      return refuse(404, {
        status: "no-parcel",
        declineReason: "parcel-identity-mismatch",
        reason: `The point sent with this request falls in ${atPoint}${pointCounty ? ` (${pointCounty.name} County)` : ""}, not in the identified parcel ${canonical}${county.fips !== (pointCounty?.fips ?? "") ? ` (${county.name} County)` : ""}, so a buildable envelope can't be derived for this parcel from that point.`,
        parcel_node_id: canonical,
      });
    }
  }

  const parcel = firstParcelRing(parcelGeo.geojson);
  const ringPoint = input.point ?? representativePointOfRing(parcel?.ring ?? []);
  const situsCityState = cityStateFromSitus(parcel?.situsAddress ?? null);
  const ctx: EnvelopeContext = {
    placeKey: ringPoint
      ? placeKeyFromCoords(
          roundPlaceCoord(ringPoint.latitude),
          roundPlaceCoord(ringPoint.longitude),
        )
      : basePlaceKey,
    lat: ringPoint?.latitude ?? 0,
    lng: ringPoint?.longitude ?? 0,
    city: situsCityState.city,
    state: situsCityState.state,
    address: parcel?.situsAddress ?? null,
    pointConfidence: input.point ? "coordinates" : "parcel-identity",
    hasPoint: ringPoint !== null,
  };
  return {
    kind: "resolved",
    ctx,
    // The derive tail reports `provider` on the payload's parcel block, so the
    // identity path names the source it read exactly as the pin/situs paths do.
    parcelGeo: { geojson: parcelGeo.geojson, provider: txCountyProviderLabel(county) },
  };
}

/**
 * The core derivation, shared by the GET (:placeKey) and POST (address) forms.
 * Resolves the place, fetches parcel + setbacks, labels edges, derives the
 * envelope, and sends the honesty-wrapped response (or an honest 404/pending).
 */
async function handleBuildableEnvelope(
  req: Request,
  res: Response,
  input:
    | { placeKey: string }
    | {
        address?: string;
        lat?: number;
        lng?: number;
        parcel_node_id?: string;
      },
  skipRoad: boolean,
): Promise<void> {
  const log = reqLog(req);

  // === F4e: SITUS-FIRST (authority inversion). ===
  // Run the authoritative, multi-county, disambiguating situs resolve BEFORE
  // resolveContext's geocode-quality/geocode-miss gate, so a clean unique
  // situs (or a point-disambiguated ambiguous situs) resolves even when the
  // geocode is a coarse centroid or MISSES entirely. Three outcomes:
  //   - HIT       : derive from that parcel directly, skipping the gate.
  //   - DECLINE   : ambiguous situs the point couldn't disambiguate -> honest
  //                 404 no-parcel (NEVER a blind-pin wrong-situs neighbor).
  //   - NO-MATCH  : fall through to the existing rooftop/geocode/pin path,
  //                 reusing the pre-pass geocode so we do not geocode twice.
  const { address: situsAddress, explicitPoint } = extractSitusInputs(input);

  // === P-373: A POSTED IDENTITY WINS. ===
  // The caller identifying its subject (`parcel_node_id`) is the strongest
  // signal in the request — stronger than an address string or a point,
  // both of which are ways of GUESSING at that identity. Resolve it by
  // identity, and refuse (named) when the point the caller sent with it
  // lands in a different parcel, rather than answering a stranger's parcel
  // for a card that named its own.
  const postedParcelNodeId =
    "parcel_node_id" in input ? input.parcel_node_id ?? null : null;
  let identityCtx: EnvelopeContext | null = null;
  let identityParcelGeo: {
    geojson: unknown;
    provider: string | null;
  } | null = null;
  if (postedParcelNodeId) {
    const identity = await resolvePostedParcelIdentity({
      parcelNodeId: postedParcelNodeId,
      point: explicitPoint,
      placeKey: "placeKey" in input ? input.placeKey : "",
      log,
    });
    if (identity.kind === "refused") {
      res.status(identity.status).json(identity.body);
      return;
    }
    identityCtx = identity.ctx;
    identityParcelGeo = identity.parcelGeo;
  }

  if (identityCtx && identityParcelGeo) {
    await deriveAndRespond({
      req,
      res,
      ctx: identityCtx,
      parcelGeo: identityParcelGeo,
      skipRoad,
      log,
      postedParcelNodeId,
    });
    return;
  }

  const { situs, geocode: pregeocode } = await situsFirstPreResolve({
    address: situsAddress,
    explicitPoint,
    log,
    placeKey: "placeKey" in input ? input.placeKey : "",
  });

  let parcelGeo: Awaited<ReturnType<typeof queryGisLayerGeoJson>> | {
    geojson: unknown;
    provider: string | null;
  };
  let ctx: EnvelopeContext;

  if (situs && "decline" in situs) {
    // Ambiguous situs, point did not disambiguate -> honest decline. Build a
    // minimal ctx (best-effort placeKey from the geocode point, if any) so
    // the response still carries placeKey.
    const pt =
      explicitPoint ??
      (pregeocode &&
      Number.isFinite(pregeocode.latitude) &&
      Number.isFinite(pregeocode.longitude)
        ? { latitude: pregeocode.latitude, longitude: pregeocode.longitude }
        : null);
    const declineCtx: EnvelopeContext = {
      placeKey: pt
        ? placeKeyFromCoords(roundPlaceCoord(pt.latitude), roundPlaceCoord(pt.longitude))
        : ("placeKey" in input ? input.placeKey : ""),
      lat: pt?.latitude ?? 0,
      lng: pt?.longitude ?? 0,
      city: pregeocode?.jurisdictionCity ?? null,
      state: pregeocode?.jurisdictionState ?? null,
      address: situsAddress,
      pointConfidence: explicitPoint ? "coordinates" : "geocode-low",
    };
    res.status(404).json(
      withPlace(
        {
          status: "no-parcel",
          reason:
            "This address matches multiple parcels sharing one situs and could not be pinned to a single one confidently, so a buildable envelope can't be derived.",
          parcel_node_id: null,
        },
        declineCtx,
      ),
    );
    return;
  }

  if (situs && "parcelGeo" in situs) {
    // AUTHORITATIVE situs hit. Build ctx WITHOUT the geocode gate. City/state
    // for the setback jurisdiction come from the geocode when it succeeded,
    // else from the resolved parcel's own situs string (a unique situs can
    // resolve with no geocode at all).
    const parcel0 = firstParcelRing(situs.parcelGeo.geojson);
    const fromSitus = cityStateFromSitus(parcel0?.situsAddress ?? null);
    const pt =
      explicitPoint ??
      (pregeocode &&
      Number.isFinite(pregeocode.latitude) &&
      Number.isFinite(pregeocode.longitude)
        ? { latitude: pregeocode.latitude, longitude: pregeocode.longitude }
        : null);
    ctx = {
      placeKey: pt
        ? placeKeyFromCoords(roundPlaceCoord(pt.latitude), roundPlaceCoord(pt.longitude))
        : ("placeKey" in input ? input.placeKey : ""),
      // The point (when present) still drives edge-labeling / road lookup
      // downstream; on a geocode miss it is absent and labeling degrades to
      // lot-shape (still honest).
      lat: pt?.latitude ?? 0,
      lng: pt?.longitude ?? 0,
      city: pregeocode?.jurisdictionCity ?? fromSitus.city,
      state: pregeocode?.jurisdictionState ?? fromSitus.state,
      address: situsAddress,
      pointConfidence: explicitPoint ? "coordinates" : "authoritative",
      // No real point when the geocode missed AND no explicit coords â€” edge
      // labeling must not treat the (0,0) sentinel as a reference point.
      hasPoint: pt !== null,
    };
    parcelGeo = situs.parcelGeo;
    // Skip the geocode gate and the pin-query â€” the parcel is already in hand.
    await deriveAndRespond({
      req,
      res,
      ctx,
      parcelGeo,
      skipRoad,
      log,
      postedParcelNodeId:
        "parcel_node_id" in input ? input.parcel_node_id ?? null : null,
    });
    return;
  }

  // === NO situs match: existing rooftop/geocode/pin path, unchanged. ===
  // Reuse the pre-pass geocode (fetched for the address-only branch) so we
  // don't geocode twice; explicit-coord / placeKey inputs never geocoded in
  // the pre-pass, so pass provided=false for those.
  const resolvedCtx = await resolveContext(input, {
    provided: situsAddress !== null && explicitPoint === null,
    geocode: pregeocode,
  });
  if ("error" in resolvedCtx) {
    res.status(resolvedCtx.error.status).json(resolvedCtx.error.body);
    return;
  }
  ctx = resolvedCtx;

  // 1) Fetch the REAL parcel polygon (carries zoningCode after enrichment AND
  //    the canonical `parcel_node_id`), BEFORE the setback check so the id is
  //    present on every honest status. The authoritative situs path already
  //    ran above (and either resolved, declined, or fell through as no-match),
  //    so here we only have the point pin-query (b) and the geocode-centroid
  //    honest-decline (b'):
  //      (b') geocode CENTROID (ZIP/city rung), no situs, no rooftop upgrade
  //           -> honest no-parcel (pin-querying a centroid is what grabbed a
  //           WRONG parcel before; commitment #1).
  //      (b)  point pin-query at the (rooftop-grade or explicit) point.
  try {
    if (ctx.pointConfidence === "geocode-low") {
      log.info(
        { placeKey: ctx.placeKey, address: ctx.address },
        "buildable-envelope: declining to resolve a parcel from a geocode centroid",
      );
      res.status(404).json(
        withPlace(
          {
            status: "no-parcel",
            reason:
              "Could not pin this address to a rooftop; only an approximate area was found, so a buildable envelope can't be derived confidently.",
            parcel_node_id: null,
          },
          ctx,
        ),
      );
      return;
    }
    // (b) point pin-query at the (rooftop-grade or explicit) point.
    //
    // P-151: race the query against POINT_RESOLUTION_TIMEOUT_MS ONLY on the
    // explicit-coordinates rung (pointConfidence === "coordinates" -- caller
    // supplied lat/lng directly, no situs/rooftop upgrade involved). This is
    // exactly the bare-{lat,lng}-no-address shape that produced the
    // 2026-09-11 bare 504. The address-driven rungs that also reach this
    // call ("geocode-high" / "authoritative") are left unwrapped -- they
    // already work and are out of scope for this mission.
    parcelGeo =
      ctx.pointConfidence === "coordinates"
        ? await withPointResolutionTimeout(
            queryGisLayerGeoJson({
              layer: "parcels",
              latitude: ctx.lat,
              longitude: ctx.lng,
            }),
            POINT_RESOLUTION_TIMEOUT_MS,
          )
        : await queryGisLayerGeoJson({
            layer: "parcels",
            latitude: ctx.lat,
            longitude: ctx.lng,
          });
  } catch (err) {
    if (err instanceof PointResolutionTimeoutError) {
      // DECLARED refusal, not a provider failure: the query may still be
      // running server-side (see POINT_RESOLUTION_TIMEOUT_MS doc comment) --
      // this only bounds how long the CALLER waits on it.
      log.warn(
        {
          placeKey: ctx.placeKey,
          pointConfidence: ctx.pointConfidence,
          timeoutMs: POINT_RESOLUTION_TIMEOUT_MS,
        },
        "buildable-envelope: point resolution exceeded time budget; declaring a bounded refusal (P-151)",
      );
      res.status(503).json(
        withPlace(
          {
            status: "resolution-timeout",
            reason:
              "Could not resolve a parcel for this point within the time budget.",
            parcel_node_id: null,
            errorClass: "resolution_timeout",
            message:
              "Could not resolve a parcel for this point within the time budget.",
          },
          ctx,
        ),
      );
      return;
    }
    // ERROR CLASSIFICATION (F4d). The store/provider readers throw a
    // named `AdapterRunError`: `no-coverage` means the query SUCCEEDED but
    // no parcel matched (an honest "no parcel here" â€” 404), whereas
    // network/upstream/parse/timeout/unknown are genuine provider failures
    // (502). Previously ALL throws collapsed to a 502 "provider
    // unavailable", so a geocode miss / point outside every polygon
    // masqueraded as an outage and the honest 404 branch was dead code for
    // the store-backed counties. Classify by code.
    const isEmptyResult =
      err instanceof AdapterRunError && err.code === "no-coverage";
    if (isEmptyResult) {
      log.info(
        { placeKey: ctx.placeKey, pointConfidence: ctx.pointConfidence },
        "buildable-envelope: no parcel at resolved location",
      );
      res.status(404).json(
        withPlace(
          {
            status: "no-parcel",
            reason:
              "No parcel found for this address, so a buildable envelope can't be derived.",
            parcel_node_id: null,
          },
          ctx,
        ),
      );
      return;
    }
    log.warn({ err, placeKey: ctx.placeKey }, "buildable-envelope: parcel fetch failed");
    res.status(502).json(
      withPlace(
        {
          status: "parcel-unavailable",
          reason:
            "Parcel geometry provider is unavailable; can't derive the envelope right now.",
          parcel_node_id: null,
        },
        ctx,
      ),
    );
    return;
  }

  await deriveAndRespond({
    req,
    res,
    ctx,
    parcelGeo,
    skipRoad,
    log,
    postedParcelNodeId:
      "parcel_node_id" in input ? input.parcel_node_id ?? null : null,
  });
}

async function deriveLabelAndRespond(args: {
  res: Response;
  ctx: EnvelopeContext;
  parcel: {
    apn: string | null;
    situsAddress: string | null;
    zoningCode: string | null;
    parcelNodeId: string | null;
    ring: Ring;
  };
  parcelGeo: { geojson: unknown; provider: string | null };
  skipRoad: boolean;
  parcelNodeId: string | null;
  effectiveZoningCode: string;
  resolved: AuthoritativeSetbackResolution;
  atomChain: PropertyAtomChainWire | null;
  spineZoning: SpineZoningResolution | null;
}): Promise<void> {
  const {
    res,
    ctx,
    parcel,
    parcelGeo,
    skipRoad,
    parcelNodeId,
    effectiveZoningCode,
    resolved,
    atomChain,
    spineZoning,
  } = args;

  const hasPoint = ctx.hasPoint !== false;
  let roads: RoadCandidate[] = [];
  if (!skipRoad && hasPoint) {
    roads = namedRoadsToCandidates(
      await fetchNearbyRoads({ lat: ctx.lat, lng: ctx.lng }),
    );
  }
  const labeling = labelEdges({
    ring: parcel.ring,
    roads,
    refPoint: hasPoint ? { lng: ctx.lng, lat: ctx.lat } : null,
    situsAddress: parcel.situsAddress,
  });
  if (!labeling) {
    res.status(422).json(
      withPlace(
        {
          status: "ungeometric-parcel",
          reason: "Parcel geometry is not a usable polygon for envelope derivation.",
          parcel_node_id: parcelNodeId,
        },
        ctx,
      ),
    );
    return;
  }

  const { derived, wireStatus, honesty, derivePath } = composeBuildableEnvelopeDerivation({
    ring: parcel.ring,
    table: resolved.table,
    district: resolved.district,
    labeling,
    atomChain,
    spineZoning,
    resolvedSourceKind: resolved.sourceKind,
    resolvedSourceLabel: resolved.sourceLabel,
    resolvedEffectiveDate: resolved.effectiveDate,
  });

  const zoningAtomDid = atomChain?.zoningFact?.atomDid;
  const setbackAtomDid = atomChain?.setbackRule?.atomDid;
  const envelopeAtomDid = atomChain?.buildableEnvelope?.atomDid;
  const codeSectionRefs = (atomChain?.codeSections ?? [])
    .filter(
      (s): s is { atomDid: string; sectionNumber: string; title?: string | null } =>
        typeof s?.atomDid === "string" &&
        s.atomDid.length > 0 &&
        typeof s.sectionNumber === "string" &&
        s.sectionNumber.length > 0,
    )
    .map((s) => ({
      atomDid: s.atomDid,
      sectionNumber: s.sectionNumber,
      ...(typeof s.title === "string" && s.title ? { title: s.title } : {}),
    }));
  type ProvenanceRefs = {
    zoning?: { atomDid: string };
    setback?: { atomDid: string };
    envelope?: { atomDid: string };
    codeSections?: Array<{
      atomDid: string;
      sectionNumber: string;
      title?: string;
    }>;
  };
  const builtProvenanceRefs: ProvenanceRefs = {};
  if (typeof zoningAtomDid === "string" && zoningAtomDid) {
    builtProvenanceRefs.zoning = { atomDid: zoningAtomDid };
  }
  if (typeof setbackAtomDid === "string" && setbackAtomDid) {
    builtProvenanceRefs.setback = { atomDid: setbackAtomDid };
  }
  if (typeof envelopeAtomDid === "string" && envelopeAtomDid) {
    builtProvenanceRefs.envelope = { atomDid: envelopeAtomDid };
  }
  if (codeSectionRefs.length > 0) {
    builtProvenanceRefs.codeSections = codeSectionRefs;
  }
  const provenanceRefs: ProvenanceRefs | undefined =
    Object.keys(builtProvenanceRefs).length > 0 ? builtProvenanceRefs : undefined;

  /**
   * P-340 — the conflict row for the resolution that produced this payload.
   * Composed from the SAME `resolved` object the served 4-tuple comes from, so
   * the row can never describe a different resolution than the one on the
   * wire.
   */
  const sourceConflictRow = sourceConflictRowForResolution(resolved);

  res.status(200).json(
    withPlace(
      {
        status: wireStatus,
        layer: "buildable-envelope",
        parcel_node_id: parcelNodeId,
        derivePath,
        setbackSource: resolved.sourceKind,
        effectiveZoningCode,
        /**
         * P-340 (OPS-24). The R-1 conflict row. `authoritativeSetbackSource.ts`
         * has returned `conflict` since P-154, but this payload builder names
         * its fields explicitly, so the declaration never reached a customer —
         * which is why the 2026-09-18 probe found an unreadable-date
         * disagreement on three of its seven `PANEL-DRAW-TABLE-DISAGREE`
         * subjects with no conflict row on either surface. Absent when there is
         * no conflict, so a payload whose sources agree is byte-identical to
         * what it was before this lane.
         */
        ...(sourceConflictRow ? { setbackSourceConflict: sourceConflictRow } : {}),
        ...(provenanceRefs ? { provenanceRefs } : {}),
        ...(spineZoning ? { spineZoningSource: spineZoning.source } : {}),
        setbacks: {
          front_ft: resolved.scalars.front_ft,
          side_ft: resolved.scalars.side_ft,
          rear_ft: resolved.scalars.rear_ft,
          ...(typeof resolved.scalars.side_corner_ft === "number"
            ? { side_corner_ft: resolved.scalars.side_corner_ft }
            : {}),
          district: effectiveZoningCode,
        },
        ...wrapEngineEnvelope(
          {
            geojson: derived.geojson,
            district: derived.district,
            approximate: derived.approximate,
            empty: derived.empty,
            citationUrl: derived.citationUrl,
            // P-270 (OPS-24 X11): this payload is built EXPLICITLY, field by
            // field, and `wrapEngineEnvelope` passes it through verbatim — so
            // a declaration `derive.ts` published is dropped here unless it is
            // named. This is the drawn-envelope path customers actually hit.
            ...(derived.citationVintage
              ? { citationVintage: derived.citationVintage }
              : {}),
            ...(derived.citationEffectiveDate
              ? { citationEffectiveDate: derived.citationEffectiveDate }
              : {}),
            parcel: {
              apn: parcel.apn,
              situsAddress: parcel.situsAddress,
              zoningCode: parcel.zoningCode,
              effectiveZoningCode,
              parcel_node_id: parcelNodeId,
              provider: parcelGeo.provider ?? null,
              notSurveyGrade: true,
            },
          },
          honesty,
        ),
        readContract: readContractForWire(legacyHonestyToReadContract(honesty)),
      },
      ctx,
    ),
  );
}

/**
 * Shared derivation tail: given a resolved parcel `parcelGeo` (from EITHER
 * the authoritative situs path or the point pin-query) plus the context,
 * resolve setbacks, map district, label edges, derive the envelope, and send
 * the honesty-wrapped response (or an honest non-ok status). Extracted so the
 * F4e situs-hit path (which skips the geocode gate and pin-query) and the
 * legacy pin-query path share ONE derivation + honesty implementation.
 */
async function deriveAndRespond(args: {
  req: Request;
  res: Response;
  ctx: EnvelopeContext;
  parcelGeo: { geojson: unknown; provider: string | null };
  skipRoad: boolean;
  log: typeof logger;
  postedParcelNodeId?: string | null;
}): Promise<void> {
  const { res, ctx, parcelGeo, skipRoad, postedParcelNodeId } = args;
  const parcel = firstParcelRing(parcelGeo.geojson);
  if (!parcel) {
    // The query succeeded but returned no usable polygon at this point.
    // This is the honest "no parcel here" case (404), NOT a provider
    // outage â€” the live county-GIS provider returns an empty collection
    // rather than throwing for a point outside every parcel.
    res.status(404).json(
      withPlace(
        {
          status: "no-parcel",
          reason:
            "No parcel polygon found at this location, so a buildable envelope can't be derived.",
          parcel_node_id: null,
        },
        ctx,
      ),
    );
    return;
  }

  // The tile-matching subject-parcel id, populated whenever the containing
  // parcel resolved (independent of setbacks). Threaded through every honest
  // response below so the map can snap + glow regardless of envelope outcome.
  const parcelNodeIdValue: string | null =
    parcel.parcelNodeId ?? postedParcelNodeId ?? null;

  const atomChain = parcelNodeIdValue
    ? await fetchPropertyAtomChain(parcelNodeIdValue)
    : null;

  const gisZoning = (parcel.zoningCode ?? "").trim();
  let spineZoning: SpineZoningResolution | null = gisZoning
    ? null
    : await resolveSpineZoningWhenGisAbsent(parcelNodeIdValue, parcel.zoningCode);

  /**
   * The ordered district-code signals, most specific first — the same order
   * this site has always used (the parcel's own GIS zoning stamp, then Spine's
   * zoning fact, then the atom chain's zoning fact, then its setback rule).
   */
  const districtCodeSignals: Array<string | null> = [
    gisZoning || null,
    spineZoning?.district ?? null,
    typeof atomChain?.zoningFact?.district === "string"
      ? atomChain.zoningFact.district
      : null,
    typeof atomChain?.setbackRule?.districtCode === "string"
      ? atomChain.setbackRule.districtCode
      : null,
  ];
  const firstSignal = districtCodeSignals.find((c) => (c ?? "").trim() !== "") ?? "";

  /**
   * P-340 — read the engagement key BEFORE probing any table. The table probe
   * below must run against the same jurisdiction key this site will resolve
   * with, so a code that names no row can never move a parcel between
   * jurisdictions. Hoisted above the no-zoning-stamp early return for that
   * reason only; both helpers are pure string work.
   */
  const situsCityState = cityStateFromSitus(parcel.situsAddress);
  const fromCityState = keyFromEngagementOrSynthesize({
    jurisdictionCity: ctx.city ?? situsCityState.city,
    jurisdictionState: ctx.state ?? situsCityState.state,
    address: ctx.address ?? undefined,
  });

  const provisionalJurisdictionKey =
    fromCityState ??
    jurisdictionKeyFromParcelNode({
      parcelNodeId: parcelNodeIdValue,
      districtCode: firstSignal,
    });

  /**
   * P-340 — A BASE CODE IS NOT A DISTRICT DETERMINATION.
   *
   * `parcel.zoningCode` (the county store's stamp) is sometimes a BASE code
   * rather than a zoning district: Austin's `SF` is the base of `SF-1`..`SF-6`
   * and `SF-4A`, and it names none of them. The first signal used to win
   * outright, so the route looked `SF` up, crossed it into the longest prefix
   * match (`SF-4A`, 15/3.5/5/10) and served that for two parcels whose own
   * city layer and whose own setback-rule atom both say `SF-3`/`SF-2`
   * (25/5/10/15) — the measured P-340 `48453:239852` / `48453:367134` defect,
   * and the reason the panel and the drawing disagreed about a whole table
   * rather than about one axis.
   *
   * `firstResolvableDistrictCode` takes the first signal that actually names a
   * row in this jurisdiction's own table, falling back to the old first signal
   * when none does. The jurisdiction key is the same one derived here from that
   * first signal, so a code that names no row can never move a parcel between
   * jurisdictions.
   */
  const effectiveZoningCode = firstResolvableDistrictCode(
    districtCodeSignals,
    provisionalJurisdictionKey,
    (key, code) => getSetbackTableForZoning(key, code),
  );

  if (!effectiveZoningCode.trim()) {
    const honesty: EngineHonesty = {
      confidence: { value: 0, kind: "asserted" },
      dataVintage: new Date().toISOString().slice(0, 10),
      coverage: {
        degraded: true,
        reason:
          "No zoning stamp on this parcel — honest absence; no district invented.",
      },
      source: {
        adapter: "brokerage:buildable-envelope",
        citationIds: [],
      },
    };

    res.status(200).json(
      withPlace(
        {
          status: "declined",
          declineReason: NO_ZONING_STAMP_REASON,
          layer: "buildable-envelope",
          parcel_node_id: parcelNodeIdValue,
          ...wrapEngineEnvelope(
            {
              geojson: {
                type: "FeatureCollection",
                features: [],
              },
              district: null,
              approximate: true,
              empty: true,
              citationUrl: "",
              parcel: {
                apn: parcel.apn,
                situsAddress: parcel.situsAddress,
                zoningCode: parcel.zoningCode,
                parcel_node_id: parcelNodeIdValue,
                provider: parcelGeo.provider ?? null,
                notSurveyGrade: true,
              },
            },
            honesty,
          ),
          readContract: readContractForWire(legacyHonestyToReadContract(honesty)),
        },
        ctx,
      ),
    );
    return;
  }

  /**
   * P-340: the SAME key the district signals were probed against above
   * (`provisionalJurisdictionKey`, which read `fromCityState`) — this site must
   * not re-derive it from the resolved district code, or the code the fallback
   * picked could move the parcel to a different jurisdiction than the one its
   * row was checked in.
   */
  const jurisdictionKey = provisionalJurisdictionKey;

  const resolved = resolveAuthoritativeSetbacks({
    jurisdictionKey,
    districtCode: effectiveZoningCode,
    atomRule: atomChain?.setbackRule ?? null,
  });

  if (!resolved) {
    /**
     * P-257 — say which kind of nothing this is.
     *
     * A planned-development code refuses a setback table for a REASON (its
     * standards live in its own ordinance and development plan), and that
     * reason has to reach the reader: the whole point of the refusal is that
     * the code is not a district. The gate is asked here as well as inside the
     * resolver because the resolver's `null` is deliberately shape-less and
     * `jurisdictionKey` may be null (a parcel with no resolvable city key never
     * reaches the resolver at all, so the district code is the only evidence
     * left — and it is enough).
     *
     * hauska-map composes the identical sentence for the panel; the two are
     * pinned byte-for-byte against each other's literals in both repos' suites.
     */
    const plannedDevelopment = plannedDevelopmentSetbackRefusalFor(
      { jurisdictionKey, districtCode: effectiveZoningCode },
      (code) => {
        const table = jurisdictionKey
          ? getSetbackTableForZoning(jurisdictionKey, code)
          : null;
        return !!table && districtCodeHasExactRow(table, code);
      },
    );
    res.status(404).json(
      withPlace(
        {
          status: "no-district",
          ...(plannedDevelopment
            ? {
                declineReason: plannedDevelopment.declineReason,
                reason: plannedDevelopment.disclosure,
              }
            : {
                reason:
                  "No authoritative setback source covers this district — geometry not derived.",
              }),
          jurisdictionKey: jurisdictionKey ?? null,
          parcel_node_id: parcelNodeIdValue,
        },
        ctx,
      ),
    );
    return;
  }

  await deriveLabelAndRespond({
    res,
    ctx,
    parcel,
    parcelGeo,
    skipRoad,
    parcelNodeId: parcelNodeIdValue,
    effectiveZoningCode,
    resolved,
    atomChain,
    spineZoning,
  });
}

brokeragePlaceBuildableEnvelopeRouter.get(
  "/:placeKey/buildable-envelope",
  (req, res) => {
    const parse = PLACE_KEY_PARAM.safeParse(
      decodePlaceKeyParam(req.params.placeKey),
    );
    if (!parse.success) {
      res.status(400).json({ error: "invalid_request", message: "placeKey required" });
      return;
    }
    const skipRoad = req.query.skipRoad === "1" || req.query.skipRoad === "true";
    void handleBuildableEnvelope(req, res, { placeKey: parse.data }, skipRoad);
  },
);

brokeragePlaceBuildableEnvelopeRouter.post("/buildable-envelope", (req, res) => {
  const parsed = POST_BODY.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
    return;
  }
  const { address, lat, lng, skipRoad, parcel_node_id } = parsed.data;
  if (!address && (lat == null || lng == null) && !parcel_node_id) {
    res.status(400).json({
      error: "invalid_request",
      message: "address, lat+lng, or parcel_node_id required",
    });
    return;
  }
  // Pass ALL of address+lat+lng through â€” DO NOT drop lat/lng when an
  // address is also present (the F4d bug: caller-supplied coordinates
  // were ignored and the address re-geocoded to a possibly-wrong point).
  // `resolveContext` honors explicit coordinates over the geocode.
  void handleBuildableEnvelope(
    req,
    res,
    { address, lat, lng, parcel_node_id },
    skipRoad === true,
  );
});

