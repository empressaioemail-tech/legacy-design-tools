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
import {
  wrapEngineEnvelope,
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
import { type PropertyAtomChainWire } from "../lib/buildableEnvelope/fetchPropertyAtomChain";
import { type AuthoritativeSetbackResolution } from "../lib/buildableEnvelope/authoritativeSetbackSource";
// P-340: the R-1 conflict row the resolver has returned since P-154 and this
// payload never served — see `setbackSourceConflict.ts`.
import { sourceConflictRowForResolution } from "../lib/buildableEnvelope/setbackSourceConflict";
import { cityStateFromSitus } from "../lib/buildableEnvelope/envelopeJurisdiction";
import { POST_BODY } from "../lib/buildableEnvelope/envelopePostBody";
import {
  type SpineZoningResolution,
} from "../lib/buildableEnvelope/spineZoningDistrict";
import { openRing, ringContainsPoint, type Ring } from "../lib/buildableEnvelope/geometry";
// P-374: the ONE derivation both this route and the get_smart_site draw block
// run — see that module's own doc comment for the drift this closed.
import {
  deriveEnvelopeDraw,
  type EnvelopeDrawParcel,
  type EnvelopeDrawnDerivation,
} from "../lib/buildableEnvelope/envelopeDrawDerivation";
// P-153 Step A: moved out of THIS file so the get_smart_site draw-block
// orchestration (parcelDrawEnvelopeModel.ts) can reuse both without pulling
// in this route's own resolvePlace/txgioAddressResolve/brokerageTxParcels/
// txgioParcelStore import graph (all @workspace/db-coupled at module load —
// see that lib file's own doc comment for why this move happened). P-374 moved
// the derivation itself to `envelopeDrawDerivation.ts`; both are re-exported
// below so THIS file's own public surface still works exactly as before.
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
 * P-382 — THE POINT THE FALL-THROUGH PATH WOULD HAVE SERVED.
 *
 * THE MECHANISM, MEASURED (`_scratch/p382-mechanism.mjs` + `p382-geocode-repro.mjs`,
 * and the CP1 artifact):
 *
 *   - `resolveRooftopAcrossCounties` (the situs pre-pass's rooftop lookup) is
 *     bounded to `allStoreCounties()`, so for an address whose rooftop lives
 *     in a LIVE-ArcGIS county (Caldwell, Bastrop) it MISSES and the pre-pass
 *     falls to the geocode.
 *   - P-373 widened the situs candidate set from `storeCountiesContainingPoint`
 *     to `countiesContainingPoint` (see `resolveParcelBySitusAuthoritative`),
 *     so an address in a live-ArcGIS county now HITS the authoritative situs
 *     path — which is the parcel fix the lane wanted (measured: the store's
 *     own situs index answers all five canary addresses with their OWN node
 *     id).
 *   - But this branch builds the place point from the pre-pass GEOCODE
 *     (`pregeocode`), while the fall-through path UPGRADES that geocode to the
 *     owning county's authoritative `txgio_address` rooftop first. Serving the
 *     geocode is the 2026-09-19 canary's five `placeKey` regressions (measured:
 *     48055:130676 moved 5,061 m off its parcel, onto the 78648 ZIP centroid).
 *
 * The dispatch's proposed mechanism — the new live-service probe in
 * `resolvePointCountyByPip` returning a DIFFERENT county so the rooftop lookup
 * stops being served — is REFUTED BY MEASUREMENT: at every one of the five
 * canary points the pre-change county (store PIP, else nearest centroid) and
 * the post-change live-PIP return the SAME county, and it is the county that
 * owns the subject (4 via `live-pip`, 1 via the centroid fallback; 0 changed).
 * With the same county, the same address and an address index that production
 * proves holds the rooftop, that upgrade would still have run. The route
 * simply never reaches it any more.
 *
 * So: a situs hit whose OWNING COUNTY is not reachable by the pre-P-373
 * candidate set (a live-ArcGIS county — exactly the set P-373's widening newly
 * made reachable) asks that county's own address index for the rooftop, which
 * is the same source, same county and same code path the pre-P-373
 * `resolveContext` upgrade used (`resolveRooftopByAddress`; county-scoped, so
 * the registry tag never filters a live county out). A hit in a STORE-tagged
 * county was reachable before P-373 too and keeps this branch's own point
 * (this returns null), which is what makes "nothing else moves" structural
 * rather than hopeful.
 *
 * Best-effort, like the path it mirrors: a store hiccup falls back to the
 * geocode point (never sinks the request).
 */
async function authoritativeRooftopForSitusHit(input: {
  owningCountyFips: string;
  address: string | null;
  log: typeof logger;
}): Promise<{ latitude: number; longitude: number } | null> {
  const owning = txParcelCountyByFips(input.owningCountyFips);
  if (!owning || owning.source === "txgio-store") return null;
  if (!input.address) return null;
  if (txParcelProviderMode() !== "county-gis") return null;
  try {
    const rooftop = await resolveRooftopByAddress({
      countyFips: owning.fips,
      address: input.address,
    });
    return rooftop
      ? { latitude: rooftop.latitude, longitude: rooftop.longitude }
      : null;
  } catch (err) {
    // Authoritative lookup is best-effort; a store hiccup must not sink the
    // request — fall through to the geocode point, exactly as the
    // fall-through path does.
    input.log.warn(
      { err, address: input.address, county: owning.fips },
      "buildable-envelope: authoritative rooftop lookup failed on a situs hit in a live county; serving the geocode point",
    );
    return null;
  }
}


/**
 * The parcel whose polygon CONTAINS a point, as this surface's own
 * pin-query answer (`parcel_node_id`) — THREE values, never two (P-382).
 *
 *   - `{ state: "measured" }` : the layer ANSWERED. `parcelNodeId` is the
 *     parcel at the point, or null when the point is in no parcel this
 *     build can serve. That includes the upstream's own DECLARED empty
 *     coverage (`AdapterRunError` code `no-coverage`), which this route
 *     already classifies as an honest "no parcel here" 404 and NOT as an
 *     outage (see the pin-query catch below) — the same classification is
 *     used here, so "nothing there" stays a positive answer.
 *   - `{ state: "unknown" }`  : the lookup did not run. `reason` NAMES the
 *     failure. P-373 collapsed this into `null`, so a parcels layer that was
 *     down or slow read as "the point is in no parcel" — an UNKNOWN
 *     answering as agreement with whatever identity the caller posted.
 */
type PointParcelLookup =
  | { state: "measured"; parcelNodeId: string | null }
  | { state: "unknown"; reason: string };

async function parcelNodeIdAtPoint(point: {
  latitude: number;
  longitude: number;
}): Promise<PointParcelLookup> {
  try {
    const geo = await queryGisLayerGeoJson({
      layer: "parcels",
      latitude: point.latitude,
      longitude: point.longitude,
    });
    return { state: "measured", parcelNodeId: firstParcelRing(geo.geojson)?.parcelNodeId ?? null };
  } catch (err) {
    if (err instanceof AdapterRunError && err.code === "no-coverage") {
      return { state: "measured", parcelNodeId: null };
    }
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err instanceof AdapterRunError
        ? err.code
        : err instanceof Error
          ? err.name
          : "Error";
    return { state: "unknown", reason: `${code}: ${message}` };
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
 * request can DISAGREE with the identity — a point in a lot two streets away,
 * or an address that resolves to another parcel — and answering the point's
 * parcel for a card that named another parcel is the wrong-parcel defect
 * itself. On a disagreement this declines with a NAMED reason and still
 * returns the identity it was given, so the surface can see that the parcel it
 * asked about is not the parcel its own point lands in.
 *
 * A point can also LOOK like disagreement without being any (P-339/P-366
 * residual, 2026-09-21). `48453:352594`'s record point sits in a Hays parcel
 * (`48209:10757`) while lying inside its own Travis ring, because the two
 * counties' parcel geometries overlap at the county line, and the point lookup
 * resolves through the nearest county source rather than the id's. The point is
 * therefore checked against the IDENTIFIED parcel's own ring first: inside it,
 * the point agrees with the identity and the request is served from that
 * parcel's own geometry; outside it, the two refusals below apply exactly as
 * they did.
 *
 * A point that could not be CHECKED AT ALL is a third case, and it is not
 * agreement: the parcels layer being down, slow or unparseable used to
 * collapse to "no parcel at the point" (P-373), which silently skipped the
 * check and served the request with `pointConfidence: "coordinates"` — a
 * point the response presents as verified when nothing verified it. An
 * unmade check now declines with `point-verification-unavailable` (P-382);
 * an upstream's DECLARED empty coverage ("no parcel here") still carries on,
 * because that is an answer. A point inside the identified parcel's own ring is
 * not an unmade check either: it is a verification against the identity itself,
 * and it is served on that basis.
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
  // is refused, never answered — the card asked about ITS parcel. A point
  // whose check could not be MADE is refused too (P-382): serving it would
  // report the point as verified when nothing verified it.
  //
  // P-339/P-366 residual (OPS-24, 2026-09-21) — THE POINT THE IDENTITY ALREADY
  // ANSWERS FOR. The check above resolves the point through the NEAREST county
  // source, which is the parcel layer that OWNS the point's neighbourhood and
  // not necessarily the parcel's identity. At a county line the two disagree:
  // `48453:352594` is a Travis parcel (its id says so, and its own ring is
  // served by the Travis store) whose record point ALSO falls inside a Hays
  // parcel, because the two counties' geometries overlap there. Reading that as
  // disagreement made the card's own record point evidence against the card's
  // own parcel, and refused a request that named the parcel it meant.
  //
  // The identity is the authority it always was (P-373). So the point is
  // checked against the IDENTIFIED parcel's own ring first: a point inside the
  // parcel the caller named agrees with that identity by definition, whatever
  // else its neighbourhood contains, and the derivation below uses the
  // identified parcel's geometry anyway. Only a point that is NOT in the
  // identified parcel can disagree with it, and only then do the two refusals
  // above apply, unchanged.
  const parcel = firstParcelRing(parcelGeo.geojson);
  if (input.point) {
    const pointAgreesWithIdentity = ringContainsPoint(parcel?.ring, input.point);
    const atPoint = pointAgreesWithIdentity
      ? null
      : await parcelNodeIdAtPoint(input.point);
    if (atPoint && atPoint.state === "unknown") {
      input.log.warn(
        { parcelNodeId: canonical, reason: atPoint.reason },
        "buildable-envelope: the point could not be checked against the identified parcel; refusing rather than serving it unverified",
      );
      return refuse(502, {
        status: "parcel-unavailable",
        declineReason: "point-verification-unavailable",
        reason: `The point sent with this request could not be checked against the identified parcel ${canonical} (${atPoint.reason}), so a buildable envelope can't be derived for this parcel from that point. Re-send the request with the parcel_node_id alone (no point) to derive from the parcel's own geometry.`,
        parcel_node_id: canonical,
      });
    }
    if (atPoint?.parcelNodeId && atPoint.parcelNodeId !== canonical) {
      const pointCounty = txParcelCountyByFips(atPoint.parcelNodeId.split(":")[0] ?? "");
      input.log.info(
        {
          parcelNodeId: canonical,
          pointParcelNodeId: atPoint.parcelNodeId,
          pointCountyFips: pointCounty?.fips ?? null,
        },
        "buildable-envelope: point does not match the identified parcel; refusing rather than answering a stranger's parcel",
      );
      return refuse(404, {
        status: "no-parcel",
        declineReason: "parcel-identity-mismatch",
        reason: `The point sent with this request falls in ${atPoint.parcelNodeId}${pointCounty ? ` (${pointCounty.name} County)` : ""}, not in the identified parcel ${canonical}${county.fips !== (pointCounty?.fips ?? "") ? ` (${county.name} County)` : ""}, so a buildable envelope can't be derived for this parcel from that point.`,
        parcel_node_id: canonical,
      });
    }
  }

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
    const geocodePoint =
      pregeocode &&
      Number.isFinite(pregeocode.latitude) &&
      Number.isFinite(pregeocode.longitude)
        ? { latitude: pregeocode.latitude, longitude: pregeocode.longitude }
        : null;
    // P-382: on a hit P-373's widening newly made reachable (a live-ArcGIS
    // county), serve the point the fall-through path would have served — the
    // owning county's authoritative rooftop — so the address keeps the point
    // it had before P-373. Store-tagged hits (reachable before too) are
    // untouched.
    const rooftopPoint = explicitPoint
      ? null
      : await authoritativeRooftopForSitusHit({
          owningCountyFips: situs.nodeCountyFips,
          address: situsAddress,
          log,
        });
    const pt = explicitPoint ?? rooftopPoint ?? geocodePoint;
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
      // Name the TRUE authority of the point (P-382). This branch used to
      // claim "authoritative" for every non-explicit point, but a geocode
      // point is not a `txgio_address` rooftop: "authoritative" is only
      // earned by a rooftop. The rung label mirrors `resolveContext`'s own
      // (`matchRung !== "street"` is a coarse locality/ZIP centroid).
      pointConfidence: explicitPoint
        ? "coordinates"
        : rooftopPoint
          ? "authoritative"
          : geocodePoint
            ? pregeocode?.matchRung && pregeocode.matchRung !== "street"
              ? "geocode-low"
              : "geocode-high"
            : "geocode-low",
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

/**
 * P-374: RENDERER ONLY. This used to derive — it fetched the roads, labeled the
 * ring and composed the envelope, while `parcelDrawEnvelopeModel.ts` ran its own
 * copy of the same sequence. Both now call `deriveEnvelopeDraw` (see
 * `envelopeDrawDerivation.ts`) and this function only turns its `drawn` outcome
 * into the route's response, field by field. Nothing here may re-derive.
 */
async function respondWithDrawnEnvelope(args: {
  res: Response;
  ctx: EnvelopeContext;
  parcel: EnvelopeDrawParcel;
  parcelGeo: { geojson: unknown; provider: string | null };
  parcelNodeId: string | null;
  effectiveZoningCode: string;
  resolved: AuthoritativeSetbackResolution;
  atomChain: PropertyAtomChainWire | null;
  spineZoning: SpineZoningResolution | null;
  derived: EnvelopeDrawnDerivation["derived"];
  wireStatus: EnvelopeDrawnDerivation["wireStatus"];
  honesty: EnvelopeDrawnDerivation["honesty"];
  derivePath: EnvelopeDrawnDerivation["derivePath"];
}): Promise<void> {
  const {
    res,
    ctx,
    parcel,
    parcelGeo,
    parcelNodeId,
    effectiveZoningCode,
    resolved,
    atomChain,
    spineZoning,
    derived,
    wireStatus,
    honesty,
    derivePath,
  } = args;

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
 * the authoritative situs path or the point pin-query) plus the context, run
 * the ONE derivation (`deriveEnvelopeDraw`) and send the honesty-wrapped
 * response (or an honest non-ok status).
 *
 * P-374: the body this function used to own — chain fetch, spine read, district
 * signal order, jurisdiction key, table probe, planned-development gate — now
 * lives in `lib/buildableEnvelope/envelopeDrawDerivation.ts` and is the SAME
 * code the `get_smart_site` draw block runs. This function resolves the
 * place-shaped inputs (ctx city/state/address, the point, `skipRoad`) and
 * RENDERS the outcome; it must not derive anything of its own. The route's own
 * throw contract is unchanged: the derivation returns a throw as
 * `state: "threw"` and this function rethrows it, so the caller's provider
 * failure handling sees exactly what it saw before.
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
  const hasPoint = ctx.hasPoint !== false;

  const outcome = await deriveEnvelopeDraw({
    parcelGeo,
    jurisdictionCity: ctx.city,
    jurisdictionState: ctx.state,
    address: ctx.address,
    point: hasPoint ? { lat: ctx.lat, lng: ctx.lng } : null,
    skipRoad,
    postedParcelNodeId: postedParcelNodeId ?? null,
  });

  if (outcome.state === "threw") {
    // Unchanged contract: a throw in the chain/road/spine/composition reach is
    // a provider failure to THIS route, handled by its callers as it always
    // was. The draw block, which must never throw, catches the same value at
    // its own call site.
    throw outcome.error;
  }

  if (outcome.state === "no-parcel-ring") {
    // The query succeeded but returned no usable polygon at this point.
    // This is the honest "no parcel here" case (404), NOT a provider
    // outage — the live county-GIS provider returns an empty collection
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

  if (outcome.state === "parcel-identity-mismatch") {
    // Unreachable on this call site: the route passes no `expectedParcelNodeId`
    // (the parcel it resolved IS the subject). Loud rather than silent if that
    // ever changes.
    throw new Error(
      "deriveEnvelopeDraw: parcel-identity-mismatch on a route call, which never sets expectedParcelNodeId",
    );
  }

  const { parcel, parcelNodeId } = outcome;

  if (outcome.state === "ledger-declined") {
    res.status(200).json(
      withPlace(
        {
          status: "declined",
          declineReason: outcome.ledgerCode,
          reason: outcome.ledgerReason,
          layer: "buildable-envelope",
          parcel_node_id: parcelNodeId,
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
                parcel_node_id: parcelNodeId,
                provider: parcelGeo.provider ?? null,
                notSurveyGrade: true,
              },
            },
            {
              confidence: { value: 0, kind: "asserted" },
              dataVintage: new Date().toISOString().slice(0, 10),
              coverage: { degraded: true, reason: outcome.ledgerReason },
              source: {
                adapter: "brokerage:buildable-envelope:parcel-record",
                citationIds: [],
              },
            },
          ),
        },
        ctx,
      ),
    );
    return;
  }

  if (outcome.state === "no-zoning-stamp") {
    res.status(200).json(
      withPlace(
        {
          status: "declined",
          declineReason: NO_ZONING_STAMP_REASON,
          layer: "buildable-envelope",
          parcel_node_id: parcelNodeId,
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
                parcel_node_id: parcelNodeId,
                provider: parcelGeo.provider ?? null,
                notSurveyGrade: true,
              },
            },
            outcome.honesty,
          ),
          readContract: readContractForWire(
            legacyHonestyToReadContract(outcome.honesty),
          ),
        },
        ctx,
      ),
    );
    return;
  }

  if (outcome.state === "no-district") {
    const { plannedDevelopment } = outcome;
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
          jurisdictionKey: outcome.jurisdictionKey ?? null,
          parcel_node_id: parcelNodeId,
        },
        ctx,
      ),
    );
    return;
  }

  if (outcome.state === "ungeometric-parcel") {
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

  if (outcome.sanity) {
    res.status(200).json(
      withPlace(
        {
          status: "geometry-validation-failed",
          reason: outcome.sanity.sentence,
          sanityReasons: outcome.sanity.reasons,
          layer: "buildable-envelope",
          parcel_node_id: parcelNodeId,
          setbacks: {
            front_ft: outcome.resolved.scalars.front_ft,
            side_ft: outcome.resolved.scalars.side_ft,
            rear_ft: outcome.resolved.scalars.rear_ft,
            ...(typeof outcome.resolved.scalars.side_corner_ft === "number"
              ? { side_corner_ft: outcome.resolved.scalars.side_corner_ft }
              : {}),
            district: outcome.effectiveZoningCode,
          },
          ...wrapEngineEnvelope(
            {
              geojson: { type: "FeatureCollection", features: [] },
              district: outcome.derived.district,
              approximate: true,
              empty: true,
              citationUrl: outcome.derived.citationUrl,
              parcel: {
                apn: parcel.apn,
                situsAddress: parcel.situsAddress,
                zoningCode: parcel.zoningCode,
                effectiveZoningCode: outcome.effectiveZoningCode,
                parcel_node_id: parcelNodeId,
                provider: parcelGeo.provider ?? null,
                notSurveyGrade: true,
              },
            },
            outcome.honesty,
          ),
        },
        ctx,
      ),
    );
    return;
  }

  await respondWithDrawnEnvelope({
    res,
    ctx,
    parcel,
    parcelGeo,
    parcelNodeId,
    effectiveZoningCode: outcome.effectiveZoningCode,
    resolved: outcome.resolved,
    atomChain: outcome.atomChain,
    spineZoning: outcome.spineZoning,
    derived: outcome.derived,
    wireStatus: outcome.wireStatus,
    honesty: outcome.honesty,
    derivePath: outcome.derivePath,
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

