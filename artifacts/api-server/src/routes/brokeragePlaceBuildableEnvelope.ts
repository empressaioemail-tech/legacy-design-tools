/**
 * Buildable-envelope derivation route — the "show me the setbacks / where the
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
 * HONESTY (commitment #1): a WRONG envelope drawn confidently is worse than
 * none. The envelope confidence is the product of the edge-labeling and
 * district-mapping confidences; whenever either is weak the payload is marked
 * `approximate` with an explicit "verify with survey + city" disclosure and the
 * confidence is `asserted`, never presented as survey-grade. Empty envelopes
 * (setbacks exceed the lot) return honestly with null geometry + a reason.
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
  getSetbackTableForZoning,
  type SetbackTable,
} from "@workspace/adapters";
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
  resolveParcelBySitusDisambiguated,
  type SitusResolveOutcome,
} from "../lib/txgioAddressResolve";
import {
  resolveTxParcelCounty,
  resolvePointCountyByPip,
  storeCountiesContainingPoint,
  allStoreCounties,
  txCountyProviderLabel,
  txParcelProviderMode,
  type TxParcelCounty,
} from "../lib/brokerageTxParcels";
import { queryTxgioParcelByPropId } from "../lib/txgioParcelStore";
import {
  absentZoningDisclosure,
  isAbsentZoningFallback,
  NO_ZONING_STAMP_REASON,
  scrubAbsentZoningGeojson,
} from "../lib/buildableEnvelope/absentZoningHonesty";
import { deriveBuildableEnvelope } from "../lib/buildableEnvelope/derive";
import {
  labelEdges,
  type RoadCandidate,
} from "../lib/buildableEnvelope/edgeLabeling";
import { mapDistrict } from "../lib/buildableEnvelope/districtMapping";
import { fetchNearbyRoads } from "../lib/buildableEnvelope/roads";
import type { Ring } from "../lib/buildableEnvelope/geometry";

export const brokeragePlaceBuildableEnvelopeRouter: IRouter = Router();

const PLACE_KEY_PARAM = z.string().min(1);
const POST_BODY = z
  .object({
    address: z.string().min(1).optional(),
    lat: z.number().finite().optional(),
    lng: z.number().finite().optional(),
    /** Skip the (slow, best-effort) OSM road fetch — labeling uses point/shape. */
    skipRoad: z.boolean().optional(),
  })
  .strict();

function reqLog(req: Request): typeof logger {
  return (req as unknown as { log?: typeof logger }).log ?? logger;
}

function decodePlaceKeyParam(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return decodeURIComponent(value ?? "").trim();
}

/** Pull the first Polygon outer ring out of a parcel FeatureCollection, plus
 *  the parcel's zoningCode/situsAddress properties. Null when no polygon.
 *
 *  `parcelNodeId` is the canonical tile-matching parcel identity
 *  (`{county_fips}:{normalizeCadPropId(prop_id)}`). It is NOT re-derived here:
 *  both parcel emit paths — the live county-GIS provider
 *  (`brokerageTxParcels.ts`) and the self-hosted TxGIO store
 *  (`txgioParcelStore.ts`) — already stamp `parcel_node_id` onto each feature's
 *  properties via the shared `parcelNodeId()` helper (the same helper the
 *  PMTiles bake uses), so reading it straight off the feature guarantees the
 *  value byte-matches the tile `promoteId`. Null when the parcel source did not
 *  stamp one (e.g. the dormant Cotality fallback, or a county parcel with no
 *  appraisal prop id) — a mismatching id would glow the wrong parcel or
 *  nothing, so null is the honest answer. */
function firstParcelRing(geojson: unknown): {
  ring: Ring;
  zoningCode: string | null;
  situsAddress: string | null;
  apn: string | null;
  parcelNodeId: string | null;
} | null {
  const fc = geojson as { features?: unknown[] } | null;
  if (!fc || !Array.isArray(fc.features)) return null;
  for (const f of fc.features) {
    const feat = f as {
      geometry?: { type?: string; coordinates?: unknown };
      properties?: Record<string, unknown> | null;
    };
    const geom = feat?.geometry;
    if (!geom) continue;
    let ring: unknown = null;
    if (geom.type === "Polygon" && Array.isArray(geom.coordinates)) {
      ring = geom.coordinates[0];
    } else if (geom.type === "MultiPolygon" && Array.isArray(geom.coordinates)) {
      const first = geom.coordinates[0];
      ring = Array.isArray(first) ? first[0] : null;
    }
    if (!Array.isArray(ring) || ring.length < 4) continue;
    const props = feat.properties ?? {};
    const str = (v: unknown): string | null =>
      typeof v === "string" && v.trim() ? v : null;
    return {
      ring: ring as Ring,
      zoningCode: str(props.zoningCode),
      situsAddress: str(props.situsAddress),
      apn: str(props.apn),
      parcelNodeId: str(props.parcel_node_id),
    };
  }
  return null;
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
   *                       (city/ZIP centroid) — the point is NOT rooftop.
   */
  pointConfidence:
    | "coordinates"
    | "authoritative"
    | "geocode-high"
    | "geocode-low";
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
   * `null` means the pre-pass geocoded and MISSED — honored as a genuine
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
  // Set when the caller passed explicit coordinates — those are honored
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
    // is chosen from the (approximate) geocode point — county routing
    // bboxes are generous enough that even a ZIP centroid lands in the
    // right county — then the rooftop is matched by address WITHIN it.
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
          // sink the request — fall through to the geocode point.
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
 * The store county that owns a resolved prop id (for the provider label +
 * the geometry fetch-by-prop-id). The disambiguating resolver stamps the
 * county into the parcel node id (`{fips}:{propId}`), so recover the fips
 * from there and map it back to its `TxParcelCounty`.
 */
function storeCountyByFips(fips: string): TxParcelCounty | null {
  return allStoreCounties().find((c) => c.fips === fips) ?? null;
}

/**
 * AUTHORITATIVE situs->parcel resolution (F4e; supersedes the F4d
 * single-county unique-only `resolveParcelBySitusDirect`). Runs the
 * disambiguating, multi-county situs resolve and, on an authoritative hit,
 * fetches that parcel's polygon DIRECTLY by prop id — skipping the geocode
 * pin-query entirely.
 *
 * Returns:
 *   - `{ parcelGeo, provider }` on an authoritative hit (unique situs, or an
 *     ambiguous situs the point disambiguated to a single containing parcel).
 *   - `{ decline: true }` when the situs was AMBIGUOUS and the point could
 *     NOT disambiguate it — the caller must DECLINE HONESTLY, never
 *     blind-point-guess a wrong-situs neighbor (commitment #1, item 1).
 *   - `null` when there was NO situs match at all — the caller falls through
 *     to the existing rooftop/geocode/pin path unchanged.
 *
 * The candidate county set is EVERY store county whose routing bbox
 * contains the point (item 2), or — when there is no point (geocode miss) —
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

  // Candidate store counties: those whose routing bbox contains the point
  // (item 2 — all containing, not nearest-centroid); ALL store counties when
  // there is no point to route by (item 3 — a unique situs still resolves).
  const counties =
    input.point &&
    Number.isFinite(input.point.latitude) &&
    Number.isFinite(input.point.longitude)
      ? storeCountiesContainingPoint(input.point.latitude, input.point.longitude)
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

  // Authoritative hit — recover the owning store county from the node id
  // (`{fips}:{propId}`) to fetch geometry + label the provider.
  const nodeCountyFips = outcome.hit.parcelNodeId.split(":")[0] ?? "";
  const county = storeCountyByFips(nodeCountyFips);
  if (!county) return null;

  const result = await queryTxgioParcelByPropId({
    countyFips: county.fips,
    countyName: county.name,
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
 * SITUS-FIRST pre-pass (F4e item 3 — the authority inversion). Run the
 * authoritative, multi-county, disambiguating situs resolve BEFORE any
 * geocode-quality or geocode-miss gate, so the STRONGEST signal (situs) is
 * no longer downstream of the WEAKEST (geocode-derived county routing).
 *
 * Point source for disambiguation, in authority order:
 *   - explicit caller point (honored verbatim), else
 *   - a BEST-EFFORT geocode purely to obtain a disambiguation point +
 *     city/state. A geocode MISS is NON-FATAL here: `point` stays null and a
 *     UNIQUE situs still resolves (that is the whole point — a clean unique
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
  if (!point) {
    // Best-effort geocode ONLY for a disambiguation point + city/state. A
    // miss (or a service hiccup) must NOT abort — a unique situs resolves
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
 * Best-effort city/state from a stored situs string
 * ("300 BLANCO RIVER RD, WIMBERLEY, TX 78676" -> { city: "WIMBERLEY",
 * state: "TX" }). Used to synthesize the setback jurisdiction key when a
 * situs hit resolved WITHOUT a geocode (miss) so there is no geocode
 * city/state. Returns nulls when the shape is not the expected
 * "street, city, ST zip". Never fabricates.
 */
function cityStateFromSitus(situs: string | null): {
  city: string | null;
  state: string | null;
} {
  if (!situs) return { city: null, state: null };
  const parts = situs.split(",").map((p) => p.trim()).filter(Boolean);
  // Expect [street, city, "ST zip"] (or [street, city, "ST", zip]).
  if (parts.length < 3) return { city: null, state: null };
  const city = parts[1] || null;
  const stateZip = parts.slice(2).join(" ").trim();
  const stateMatch = /\b([A-Za-z]{2})\b/.exec(stateZip);
  const state = stateMatch ? stateMatch[1]!.toUpperCase() : null;
  return { city, state };
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
    | { address?: string; lat?: number; lng?: number },
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
      // No real point when the geocode missed AND no explicit coords — edge
      // labeling must not treat the (0,0) sentinel as a reference point.
      hasPoint: pt !== null,
    };
    parcelGeo = situs.parcelGeo;
    // Skip the geocode gate and the pin-query — the parcel is already in hand.
    await deriveAndRespond({ req, res, ctx, parcelGeo, skipRoad, log });
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
    parcelGeo = await queryGisLayerGeoJson({
      layer: "parcels",
      latitude: ctx.lat,
      longitude: ctx.lng,
    });
  } catch (err) {
    // ERROR CLASSIFICATION (F4d). The store/provider readers throw a
    // named `AdapterRunError`: `no-coverage` means the query SUCCEEDED but
    // no parcel matched (an honest "no parcel here" — 404), whereas
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

  await deriveAndRespond({ req, res, ctx, parcelGeo, skipRoad, log });
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
}): Promise<void> {
  const { res, ctx, parcelGeo, skipRoad } = args;
  const parcel = firstParcelRing(parcelGeo.geojson);
  if (!parcel) {
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

  // The tile-matching subject-parcel id, populated whenever the containing
  // parcel resolved (independent of setbacks). Threaded through every honest
  // response below so the map can snap + glow regardless of envelope outcome.
  const parcelNodeIdValue: string | null = parcel.parcelNodeId;

  // 2) Resolve the jurisdiction's setback table. No table => honest 404 (no
  //    codified setbacks here — the geometry can't be derived confidently) —
  //    but the parcel DID resolve, so still emit `parcel_node_id` for the snap.
  //    City/state come from the geocode when available, else from the parcel's
  //    own situs (F4e: a situs-resolved parcel with a missed geocode still
  //    synthesizes a jurisdiction key from its situs city/state).
  const situsCityState = cityStateFromSitus(parcel.situsAddress);
  const jurisdictionKey = keyFromEngagementOrSynthesize({
    jurisdictionCity: ctx.city ?? situsCityState.city,
    jurisdictionState: ctx.state ?? situsCityState.state,
    address: ctx.address ?? undefined,
  });
  const table: SetbackTable | null = jurisdictionKey
    ? getSetbackTableForZoning(jurisdictionKey, parcel.zoningCode)
    : null;
  if (!table) {
    res.status(404).json(
      withPlace(
        {
          status: "no-setbacks",
          reason:
            "No codified setback table for this jurisdiction yet, so a buildable envelope can't be derived.",
          jurisdictionKey: jurisdictionKey ?? null,
          parcel_node_id: parcelNodeIdValue,
        },
        ctx,
      ),
    );
    return;
  }
  // A registered-but-empty table (e.g. San Marcos pending onboarding) is an
  // honest "pending", not a fabricated envelope.
  if (!table.districts.length) {
    res.status(200).json(
      withPlace(
        {
          status: "pending",
          reason:
            table.note ??
            "Setback table for this jurisdiction is pending onboarding.",
          jurisdictionKey,
          parcel_node_id: parcelNodeIdValue,
        },
        ctx,
      ),
    );
    return;
  }

  // 3) District mapping (Problem B). Unmatched/absent zoningCode returns null
  //    so we decline honestly instead of inventing a district row.
  const district = mapDistrict(table, parcel.zoningCode);
  if (!district) {
    res.status(404).json(
      withPlace(
        {
          status: "no-district",
          reason: parcel.zoningCode
            ? "Zoning code did not match a setback district row."
            : "Setback table has no matching district for this parcel.",
          parcel_node_id: parcelNodeIdValue,
        },
        ctx,
      ),
    );
    return;
  }

  // 4) Edge labeling (Problem A — the crux). Best signal wins: nearest OSM road
  //    (high), else the geocoded point (medium), else lot shape (low). The road
  //    fetch is best-effort; failure degrades to the point signal.
  //    When there is NO real point (F4e situs hit + geocode miss), skip BOTH
  //    the road fetch and the point refPoint — a `(0,0)` sentinel would label
  //    edges against null island. Labeling then degrades honestly to lot
  //    shape.
  //    Pass ALL nearby roads (not just the single longest) plus the parcel's
  //    situs, so labelEdges can prefer the situs-NAMED fronting street (the
  //    cul-de-sac defense) and, failing that, pick the best-matching edge across
  //    every candidate — instead of blindly matching the longest way.
  const hasPoint = ctx.hasPoint !== false;
  let roads: RoadCandidate[] = [];
  if (!skipRoad && hasPoint) {
    roads = await fetchNearbyRoads({ lat: ctx.lat, lng: ctx.lng });
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
          parcel_node_id: parcelNodeIdValue,
        },
        ctx,
      ),
    );
    return;
  }

  // 5) Derive + honesty-wrap.
  const derived = deriveBuildableEnvelope({
    ring: parcel.ring,
    table,
    district,
    labeling,
  });

  // Absent zoning: keep the conservative estimate shape, but never stamp the
  // fallback row name (e.g. I-2) as a real district determination.
  const absentZoning = isAbsentZoningFallback(district);
  const setbacksForDisclosure = {
    front_ft: district.district.front_ft,
    side_ft: district.district.side_ft,
    rear_ft: district.district.rear_ft,
  };
  const geojson = absentZoning
    ? scrubAbsentZoningGeojson(derived.geojson, setbacksForDisclosure)
    : derived.geojson;
  const wireDistrict = absentZoning ? null : derived.district;
  const wireStatus = absentZoning
    ? "declined"
    : derived.empty
      ? "no-buildable-area"
      : "ok";

  const honesty: EngineHonesty = {
    // The GEOMETRY is deterministic; the CONFIDENCE reflects the labeling +
    // district inference. Use `asserted` (never `calibrated`/`deterministic`)
    // so the wire never claims survey-grade certainty for an inferred envelope.
    confidence: { value: derived.confidence, kind: "asserted" },
    dataVintage: new Date().toISOString().slice(0, 10),
    coverage:
      derived.approximate || absentZoning
        ? {
            degraded: true,
            reason: absentZoning
              ? absentZoningDisclosure(setbacksForDisclosure)
              : derived.empty
                ? "No buildable area — setbacks exceed the lot."
                : "Approximate — edge orientation and/or zoning district inferred; verify with survey + city.",
          }
        : { degraded: false },
    source: {
      adapter: "brokerage:buildable-envelope",
      citationIds: [derived.citationUrl],
    },
  };

  res.status(200).json(
    withPlace(
      {
        status: wireStatus,
        ...(absentZoning
          ? { declineReason: NO_ZONING_STAMP_REASON, matchKind: "fallback-conservative" }
          : {}),
        layer: "buildable-envelope",
        // Top-level mirror of payload.parcel.parcel_node_id, so the map-snap
        // consumer reads ONE uniform field (`parcel_node_id`) across every
        // status (ok, no-buildable-area, no-setbacks, pending, no-parcel, ...).
        parcel_node_id: parcelNodeIdValue,
        ...wrapEngineEnvelope(
          {
            geojson,
            district: wireDistrict,
            approximate: derived.approximate || absentZoning,
            empty: derived.empty,
            citationUrl: derived.citationUrl,
            parcel: {
              apn: parcel.apn,
              situsAddress: parcel.situsAddress,
              zoningCode: parcel.zoningCode,
              // Canonical tile-matching id for canvas-free map snap + glow.
              // Read straight off the resolved feature (already stamped by the
              // parcel provider via the shared parcelNodeId() helper), so it
              // byte-matches the PMTiles promoteId. Null when unresolvable.
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
  const { address, lat, lng, skipRoad } = parsed.data;
  if (!address && (lat == null || lng == null)) {
    res.status(400).json({
      error: "invalid_request",
      message: "address or lat+lng required",
    });
    return;
  }
  // Pass ALL of address+lat+lng through — DO NOT drop lat/lng when an
  // address is also present (the F4d bug: caller-supplied coordinates
  // were ignored and the address re-geocoded to a possibly-wrong point).
  // `resolveContext` honors explicit coordinates over the geocode.
  void handleBuildableEnvelope(
    req,
    res,
    { address, lat, lng },
    skipRoad === true,
  );
});
