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
  getSetbackTable,
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
import { logger } from "../lib/logger";
import { resolvePlace, parseCoordPlaceKey } from "../lib/placeResolve";
import { placeKeyFromCoords } from "../lib/placeLayerUtils";
import { queryGisLayerGeoJson } from "../lib/brokerageGisLayers";
import {
  resolveParcelBySitus,
  resolveRooftopByAddress,
} from "../lib/txgioAddressResolve";
import {
  resolveTxParcelCounty,
  txCountyProviderLabel,
  txParcelProviderMode,
} from "../lib/brokerageTxParcels";
import { queryTxgioParcelByPropId } from "../lib/txgioParcelStore";
import { deriveBuildableEnvelope } from "../lib/buildableEnvelope/derive";
import { labelEdges, type RoadPolyline } from "../lib/buildableEnvelope/edgeLabeling";
import { mapDistrict } from "../lib/buildableEnvelope/districtMapping";
import { fetchNearestRoads } from "../lib/buildableEnvelope/roads";
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

  const resolved = await resolvePlace(resolveInput);
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
      const county = resolveTxParcelCounty({ latitude: lat, longitude: lng });
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
 * AUTHORITATIVE situs->parcel short-circuit (F4d, highest authority).
 * When the address matches exactly ONE parcel by
 * `txgio_parcel.situs_address` within the resolved county, fetch that
 * parcel's polygon DIRECTLY by prop id — skipping geocode AND
 * point-in-polygon. Returns the same `{ geojson, provider }` shape the
 * pin-query path returns, or null to fall through to the point path
 * (no address, no county, no unambiguous situs match, or the county has
 * no self-hosted store — the live-county-GIS counties are pin-queried).
 */
async function resolveParcelBySitusDirect(
  ctx: EnvelopeContext,
): Promise<{ geojson: unknown; provider: string | null } | null> {
  if (!ctx.address) return null;
  if (txParcelProviderMode() !== "county-gis") return null;
  const county = resolveTxParcelCounty({ latitude: ctx.lat, longitude: ctx.lng });
  // Situs is stored in `txgio_parcel`, so the direct fetch-by-prop-id only
  // applies to the self-hosted store-backed counties (Hays/Comal). Live
  // county-GIS counties resolve by pin as before.
  if (!county || county.source !== "txgio-store") return null;

  const hit = await resolveParcelBySitus({
    countyFips: county.fips,
    address: ctx.address,
  });
  if (!hit) return null;

  // Fetch geometry by the RAW prop id (the store's `prop_id` column),
  // recovered from the same situs row that produced the match.
  const result = await queryTxgioParcelByPropId({
    countyFips: county.fips,
    countyName: county.name,
    propId: hit.rawPropId,
  });
  if (!result) return null;
  return { geojson: result.geojson, provider: txCountyProviderLabel(county) };
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
  const resolvedCtx = await resolveContext(input);
  if ("error" in resolvedCtx) {
    res.status(resolvedCtx.error.status).json(resolvedCtx.error.body);
    return;
  }
  const ctx: EnvelopeContext = resolvedCtx;

  // 1) Fetch the REAL parcel polygon FIRST (carries zoningCode after
  //    enrichment AND the canonical `parcel_node_id`). This runs BEFORE the
  //    setback-table check so `parcel_node_id` is available on every honest
  //    non-ok status where the parcel resolved — including `no-setbacks`.
  //    That is the point: a jurisdiction with no codified setback table (e.g.
  //    Dripping Springs) still has a real parcel, and the map must be able to
  //    snap + glow the subject parcel even when there is no envelope to draw.
  //    `parcel_node_id` is therefore gated on parcel resolution, NOT on
  //    setback/envelope derivation.
  //
  //    RESOLUTION AUTHORITY (F4d):
  //      (a) AUTHORITATIVE situs->parcel: when the address matches exactly
  //          one parcel by `txgio_parcel.situs_address`, fetch THAT parcel's
  //          polygon directly by prop id — no geocode, no point-in-polygon.
  //      (b) point pin-query at ctx.(lat,lng): the point is already the best
  //          available (explicit coords > authoritative rooftop > geocode),
  //          so this is the same live map path, now fed a trustworthy point.
  //    A geocode centroid (low confidence) that resolved NEITHER (a) nor a
  //    containing parcel is reported as an honest no-parcel, never a
  //    fabricated wrong-parcel and never a provider-outage 502.
  let parcelGeo: Awaited<ReturnType<typeof queryGisLayerGeoJson>> | {
    geojson: unknown;
    provider: string | null;
  };
  try {
    parcelGeo =
      (await resolveParcelBySitusDirect(ctx)) ??
      (await queryGisLayerGeoJson({
        layer: "parcels",
        latitude: ctx.lat,
        longitude: ctx.lng,
      }));
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
  const jurisdictionKey = keyFromEngagementOrSynthesize({
    jurisdictionCity: ctx.city,
    jurisdictionState: ctx.state,
    address: ctx.address ?? undefined,
  });
  const table: SetbackTable | null = jurisdictionKey
    ? getSetbackTable(jurisdictionKey)
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

  // 3) District mapping (Problem B). Never returns a wrong-but-confident
  //    district — an unmatched/absent zoningCode degrades to the most-
  //    conservative district, flagged for verification.
  const district = mapDistrict(table, parcel.zoningCode);
  if (!district) {
    res.status(404).json(
      withPlace(
        {
          status: "no-district",
          reason: "Setback table has no districts.",
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
  let road: RoadPolyline | null = null;
  if (!skipRoad) {
    const roads = await fetchNearestRoads({ lat: ctx.lat, lng: ctx.lng });
    road = roads[0] ?? null;
  }
  const labeling = labelEdges({
    ring: parcel.ring,
    road,
    refPoint: { lng: ctx.lng, lat: ctx.lat },
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

  const honesty: EngineHonesty = {
    // The GEOMETRY is deterministic; the CONFIDENCE reflects the labeling +
    // district inference. Use `asserted` (never `calibrated`/`deterministic`)
    // so the wire never claims survey-grade certainty for an inferred envelope.
    confidence: { value: derived.confidence, kind: "asserted" },
    dataVintage: new Date().toISOString().slice(0, 10),
    coverage: derived.approximate
      ? {
          degraded: true,
          reason: derived.empty
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
        status: derived.empty ? "no-buildable-area" : "ok",
        layer: "buildable-envelope",
        // Top-level mirror of payload.parcel.parcel_node_id, so the map-snap
        // consumer reads ONE uniform field (`parcel_node_id`) across every
        // status (ok, no-buildable-area, no-setbacks, pending, no-parcel, ...).
        parcel_node_id: parcelNodeIdValue,
        ...wrapEngineEnvelope(
          {
            geojson: derived.geojson,
            district: derived.district,
            approximate: derived.approximate,
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
  void handleBuildableEnvelope(
    req,
    res,
    address ? { address } : { lat, lng, address },
    skipRoad === true,
  );
});
