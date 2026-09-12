/**
 * P-153 (Ruling B reversed for the polygon only, MCP get_smart_site draw
 * block). Orchestrates the SAME derivation `brokeragePlaceBuildableEnvelope`
 * runs for the map/export routes — `queryGisLayerGeoJson` (parcel ring) ->
 * `fetchPropertyAtomChain` -> `resolveAuthoritativeSetbacks` ->
 * `fetchNearbyRoads`/`labelEdges` -> `composeBuildableEnvelopeDerivation`
 * (which itself runs `deriveBuildableEnvelope` + `reconcileWithAtomEnvelope`,
 * unchanged) — so an atom-pending parcel with a real, resolvable district +
 * setback table gets a DRAWN buildable-envelope polygon on the draw block,
 * while the buildable-AREA FIGURE stays refused everywhere (denied
 * unconditionally by smartsite-mcp's DERIVED_FIGURES_POLICY; this module
 * never puts a figure on the draw wire).
 *
 * Fail-closed by design: called ONLY when the caller has already confirmed
 * (a) the envelope is atom-pending (`envelopeReason(...) === "atom_path_pending"`)
 * and (b) a baked zoning code exists — see `propertyExplorer.ts`'s call
 * site. Inside here, any missing setback source, any ungeometric ring, a
 * parcel-identity mismatch at the resolved point, an empty/validation-failed
 * derivation, or any thrown error (network, parse, whatever) all fall
 * through to `null`; the caller then keeps TODAY'S hardcoded refused
 * envelope overlay, unchanged. This never throws.
 *
 * Real extra I/O, deliberately: up to three network/DB calls per atom-pending
 * draw-block request (parcel-ring pin-query, atom-chain fetch, nearby-roads
 * fetch). An accepted cost of this ruling — not cached or deferred here
 * beyond what those three calls already do on their own.
 *
 * `composeBuildableEnvelopeDerivation`/`firstParcelRing` import from THIS
 * package's own `composeBuildableEnvelopeDerivation.ts` (not from
 * `routes/brokeragePlaceBuildableEnvelope.ts`, even though that route file
 * re-exports the same two functions): that route file's OTHER imports
 * (`resolvePlace`, `txgioAddressResolve`, `brokerageTxParcels`,
 * `txgioParcelStore`) all pull in `@workspace/db` at module load, and this
 * module is reached from `propertyExplorer.ts` on every atom-pending draw
 * request — dragging that whole graph in here would force every existing
 * `propertyExplorer.ts` unit test's `@workspace/db` mock to grow to match,
 * for zero behavioral gain (this module never touches the route file's own
 * Express/geocode/situs machinery). `@workspace/codes`'s
 * `keyFromEngagementOrSynthesize` below is a SEPARATE, unavoidable
 * `@workspace/db` dependency (that package's own barrel couples it to a
 * warmup-queue orchestrator) — real, not an import-graph accident, so it is
 * not routed around the same way.
 */

import { queryGisLayerGeoJson } from "../brokerageGisLayers";
import {
  composeBuildableEnvelopeDerivation,
  firstParcelRing,
} from "./composeBuildableEnvelopeDerivation";
import { fetchPropertyAtomChain } from "./fetchPropertyAtomChain";
import { resolveAuthoritativeSetbacks } from "./authoritativeSetbackSource";
import {
  cityStateFromSitus,
  jurisdictionKeyFromParcelNode,
} from "./envelopeJurisdiction";
import { fetchNearbyRoads, namedRoadsToCandidates } from "./roads";
import { labelEdges } from "./edgeLabeling";
import { keyFromEngagementOrSynthesize } from "@workspace/codes";

export type EnvelopeModelledForDraw = {
  /** WGS84 [lng, lat] outer-ring vertices of the buildable-envelope polygon. */
  ringLngLat: [number, number][];
  setbacks: {
    front_ft: number;
    side_ft: number;
    rear_ft: number;
    side_corner_ft?: number;
    district: string;
  };
  /** Human disclosure string off `deriveBuildableEnvelope`'s own props (not survey grade, etc). Carried for context; not independently re-serialized onto the draw wire today. */
  disclosure: string;
};

/**
 * Attempt the same setback-geometry resolution `deriveAndRespond` runs,
 * seeded from a point the caller already resolved (no geocode, no situs
 * disambiguation here — the caller already knows which parcel this is).
 * Returns `null` on any refusal or failure; never throws.
 */
export async function tryComposeEnvelopeModelForDraw(args: {
  /** The parcel this draw block is for (from the baked snapshot). */
  parcelNodeId: string;
  /** The baked zoning district code (propertyExplorer.ts's `root.zoning`). */
  zoningCode: string | null;
  /** `snapshot.queryPoint` — the resolved point for this parcel. */
  queryPoint: { latitude: number; longitude: number } | null;
}): Promise<EnvelopeModelledForDraw | null> {
  try {
    const zoningCode = (args.zoningCode ?? "").trim();
    if (!zoningCode) return null;
    const point = args.queryPoint;
    if (
      !point ||
      !Number.isFinite(point.latitude) ||
      !Number.isFinite(point.longitude)
    ) {
      return null;
    }

    // 1) The real parcel polygon at this point (same call deriveAndRespond makes).
    const parcelGeo = await queryGisLayerGeoJson({
      layer: "parcels",
      latitude: point.latitude,
      longitude: point.longitude,
    });
    const parcel = firstParcelRing(parcelGeo.geojson);
    if (!parcel) return null;

    // Identity guard: when the freshly-fetched parcel stamps its own
    // parcel_node_id, it must be the SAME parcel this draw block is for.
    // A point that pin-queries a neighbor (drift between the baked
    // snapshot's queryPoint and live GIS) must never draw a stranger's
    // envelope onto this parcel's draw block.
    if (parcel.parcelNodeId && parcel.parcelNodeId !== args.parcelNodeId) {
      return null;
    }
    const parcelNodeId = parcel.parcelNodeId ?? args.parcelNodeId;

    // 2) Atom chain (same call deriveAndRespond/deriveLabelAndRespond make).
    const atomChain = parcelNodeId
      ? await fetchPropertyAtomChain(parcelNodeId)
      : null;

    // 3) Jurisdiction key: city/state from the situs string only (no geocode
    // ctx at this call site), falling back to the parcel-node derivation —
    // the same fallback deriveAndRespond uses when ctx.city/ctx.state are
    // absent.
    const situsCityState = cityStateFromSitus(parcel.situsAddress);
    const fromCityState = keyFromEngagementOrSynthesize({
      jurisdictionCity: situsCityState.city,
      jurisdictionState: situsCityState.state,
      address: undefined,
    });
    const jurisdictionKey =
      fromCityState ??
      jurisdictionKeyFromParcelNode({
        parcelNodeId,
        districtCode: zoningCode,
      });

    const resolved = resolveAuthoritativeSetbacks({
      jurisdictionKey,
      districtCode: zoningCode,
      atomRule: atomChain?.setbackRule ?? null,
    });
    if (!resolved) return null;

    // 4) Nearby roads for edge labeling (same call deriveLabelAndRespond makes).
    const roads = namedRoadsToCandidates(
      await fetchNearbyRoads({ lat: point.latitude, lng: point.longitude }),
    );

    // 5) Edge labeling.
    const labeling = labelEdges({
      ring: parcel.ring,
      roads,
      refPoint: { lng: point.longitude, lat: point.latitude },
      situsAddress: parcel.situsAddress,
    });
    if (!labeling) return null;

    // 6) The SAME pure composition the map/export route runs — real reuse,
    // not a re-implementation.
    const { derived, wireStatus } = composeBuildableEnvelopeDerivation({
      ring: parcel.ring,
      table: resolved.table,
      district: resolved.district,
      labeling,
      atomChain,
      spineZoning: null,
      resolvedSourceKind: resolved.sourceKind,
      resolvedSourceLabel: resolved.sourceLabel,
      resolvedEffectiveDate: resolved.effectiveDate,
    });

    // Only a real, drawn polygon reaches the draw block. "no-buildable-area"
    // (setbacks genuinely consume the lot) and "geometry-validation-failed"
    // (a gate decline) are both real outcomes but carry no polygon this
    // ruling draws — both fall through to the untouched refused overlay,
    // same as any other failure here.
    if (wireStatus !== "ok") return null;
    const feature = derived.geojson.features[0];
    const coordinates = feature?.geometry?.coordinates?.[0];
    if (!feature || !coordinates || coordinates.length < 4) return null;

    return {
      ringLngLat: coordinates as [number, number][],
      setbacks: {
        front_ft: resolved.scalars.front_ft,
        side_ft: resolved.scalars.side_ft,
        rear_ft: resolved.scalars.rear_ft,
        ...(typeof resolved.scalars.side_corner_ft === "number"
          ? { side_corner_ft: resolved.scalars.side_corner_ft }
          : {}),
        district: zoningCode,
      },
      disclosure: feature.properties.disclosure,
    };
  } catch {
    return null;
  }
}
