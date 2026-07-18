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
import { logger } from "../lib/logger";
import { resolvePlace, parseCoordPlaceKey } from "../lib/placeResolve";
import { queryGisLayerGeoJson } from "../lib/brokerageGisLayers";
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
 *  the parcel's zoningCode/situsAddress properties. Null when no polygon. */
function firstParcelRing(geojson: unknown): {
  ring: Ring;
  zoningCode: string | null;
  situsAddress: string | null;
  apn: string | null;
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
}

function withPlace<T extends Record<string, unknown>>(
  body: T,
  ctx: EnvelopeContext,
): T & { placeKey: string } {
  return { ...body, placeKey: ctx.placeKey };
}

/** Resolve the derivation inputs (placeKey/address/coords) to a point + city/state. */
async function resolveContext(
  input:
    | { placeKey: string }
    | { address?: string; lat?: number; lng?: number },
): Promise<EnvelopeContext | { error: { status: number; body: Record<string, unknown> } }> {
  let resolveInput:
    | { address: string }
    | { lat: number; lng: number; address?: string };
  let addressHint: string | null = null;

  if ("placeKey" in input) {
    const coord = parseCoordPlaceKey(input.placeKey);
    if (coord) {
      resolveInput = { lat: coord.lat, lng: coord.lng };
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
  } else if (input.address) {
    resolveInput = { address: input.address };
    addressHint = input.address;
  } else if (input.lat != null && input.lng != null) {
    resolveInput = { lat: input.lat, lng: input.lng, address: input.address };
    addressHint = input.address ?? null;
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
  return {
    placeKey: resolved.placeKey,
    lat: resolved.geocode.lat,
    lng: resolved.geocode.lng,
    city: resolved.geocode.city,
    state: resolved.geocode.state,
    address: addressHint,
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

  // 1) Resolve the jurisdiction's setback table. No table => honest 404 (no
  //    codified setbacks here — the geometry can't be derived confidently).
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
        },
        ctx,
      ),
    );
    return;
  }

  // 2) Fetch the REAL parcel polygon at the place point (county GIS pin-query,
  //    same path the live map uses; carries zoningCode after enrichment).
  let parcelGeo: Awaited<ReturnType<typeof queryGisLayerGeoJson>>;
  try {
    parcelGeo = await queryGisLayerGeoJson({
      layer: "parcels",
      latitude: ctx.lat,
      longitude: ctx.lng,
    });
  } catch (err) {
    log.warn({ err, placeKey: ctx.placeKey }, "buildable-envelope: parcel fetch failed");
    res.status(502).json(
      withPlace(
        {
          status: "parcel-unavailable",
          reason:
            "Parcel geometry provider is unavailable; can't derive the envelope right now.",
        },
        ctx,
      ),
    );
    return;
  }

  const parcel = firstParcelRing(parcelGeo.geojson);
  if (!parcel) {
    res.status(404).json(
      withPlace(
        {
          status: "no-parcel",
          reason:
            "No parcel polygon found at this location, so a buildable envelope can't be derived.",
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
        { status: "no-district", reason: "Setback table has no districts." },
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
