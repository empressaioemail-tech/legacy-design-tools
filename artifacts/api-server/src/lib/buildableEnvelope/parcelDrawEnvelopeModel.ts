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
 * P-339 (Ruling 15, MCP half). This used to return `null` for every one of
 * three DIFFERENT things — modelled, declined, unreached — so the caller could
 * not tell a real decline from an attempt that never got there, and the draw
 * overlay fell back to the bake's stored `atom_path_pending` token, which
 * `envelopeHuman` renders "Withheld, setbacks unruled". It now returns a
 * discriminated `EnvelopeDrawOutcome` naming WHICH step decided the outcome
 * (and, where the chain was read, whether one existed), so the overlay's
 * reason is the route's own answer rather than the bake's marker. See
 * `./envelopeDrawOutcome.ts` for the defect this closes and the one owner of
 * the reason.
 *
 * Fail-closed by design: called ONLY when the caller has already confirmed the
 * bake is atom-pending — see `propertyExplorer.ts`'s call site. Inside here,
 * any missing setback source, any ungeometric ring, a parcel-identity mismatch
 * at the resolved point, an empty/validation-failed derivation, or any thrown
 * error (network, parse, whatever) all resolve to a REFUSAL carrying its own
 * step; the caller then serves that step's reason, never a claim the route did
 * not make. This never throws.
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
import type {
  EnvelopeDrawChain,
  EnvelopeDrawOutcome,
  EnvelopeDrawStep,
  EnvelopeModelledDraw,
} from "./envelopeDrawOutcome";

/** Kept under its original name: this module's public shape is unchanged by P-339. */
export type EnvelopeModelledForDraw = EnvelopeModelledDraw;

/**
 * Attempt the same setback-geometry resolution `deriveAndRespond` runs,
 * seeded from a point the caller already resolved (no geocode, no situs
 * disambiguation here — the caller already knows which parcel this is).
 * Returns the route's own outcome, discriminated; never throws.
 *
 * P-339: `modelled` is the only state that draws. `declined` is a real answer
 * the derivation reached; `unreached` is an attempt that stopped before it got
 * one. The two refusals differ precisely in whether the surface may say a
 * determination was made, which is what `envelopeDrawRefusalReason` reads.
 */
export async function tryComposeEnvelopeModelForDraw(args: {
  /** The parcel this draw block is for (from the baked snapshot). */
  parcelNodeId: string;
  /** The baked zoning district code (propertyExplorer.ts's `root.zoning`). */
  zoningCode: string | null;
  /** `snapshot.queryPoint` — the resolved point for this parcel. */
  queryPoint: { latitude: number; longitude: number } | null;
}): Promise<EnvelopeDrawOutcome> {
  // Set from the moment the chain fetch is reached. `"unreached"` is the
  // honest value for every earlier exit, and is load-bearing: it is what stops
  // `atom_path_pending` ("nothing is ruled here") being served for an attempt
  // that never read the chain at all.
  let chain: EnvelopeDrawChain = "unreached";
  /** An attempt that stopped before it reached an answer. Not a decline. */
  const unreached = (step: EnvelopeDrawStep): EnvelopeDrawOutcome => ({
    state: "unreached",
    refusal: { step, chain },
  });
  /** A refusal the route REACHED — a real answer, carrying the route's own token. */
  const declined = (
    step: EnvelopeDrawStep,
    declinedBy?: string | null,
  ): EnvelopeDrawOutcome => ({
    state: "declined",
    refusal: declinedBy == null ? { step, chain } : { step, chain, declinedBy },
  });
  // P-339: the step the attempt had reached WHEN it threw. Advanced as the
  // derivation progresses, so a throw is reported at the stage it really
  // happened in where that stage has its own name, and as `derivation-threw`
  // where it does not — never as a stage the attempt never got to.
  let stageAtThrow: EnvelopeDrawStep = "parcel-ring-unavailable";
  try {
    const zoningCode = (args.zoningCode ?? "").trim();
    if (!zoningCode) return unreached("no-zoning-code");
    const point = args.queryPoint;
    if (
      !point ||
      !Number.isFinite(point.latitude) ||
      !Number.isFinite(point.longitude)
    ) {
      return unreached("no-query-point");
    }

    // 1) The real parcel polygon at this point (same call deriveAndRespond makes).
    const parcelGeo = await queryGisLayerGeoJson({
      layer: "parcels",
      latitude: point.latitude,
      longitude: point.longitude,
    });
    const parcel = firstParcelRing(parcelGeo.geojson);
    if (!parcel) return unreached("parcel-ring-unavailable");
    // Past the ring: the chain and road reads have no step name of their own,
    // so a throw in either is reported as a throw, not as a ring failure.
    stageAtThrow = "derivation-threw";

    // Identity guard: when the freshly-fetched parcel stamps its own
    // parcel_node_id, it must be the SAME parcel this draw block is for.
    // A point that pin-queries a neighbor (drift between the baked
    // snapshot's queryPoint and live GIS) must never draw a stranger's
    // envelope onto this parcel's draw block.
    if (parcel.parcelNodeId && parcel.parcelNodeId !== args.parcelNodeId) {
      return unreached("parcel-identity-mismatch");
    }
    const parcelNodeId = parcel.parcelNodeId ?? args.parcelNodeId;

    // 2) Atom chain (same call deriveAndRespond/deriveLabelAndRespond make).
    const atomChain = parcelNodeId
      ? await fetchPropertyAtomChain(parcelNodeId)
      : null;
    chain = atomChain ? "present" : "absent";

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
    if (!resolved) return declined("setbacks-unresolved");

    // 4) Nearby roads for edge labeling (same call deriveLabelAndRespond makes).
    const roads = namedRoadsToCandidates(
      await fetchNearbyRoads({ lat: point.latitude, lng: point.longitude }),
    );

    // 5) Edge labeling.
    stageAtThrow = "edge-labeling-unavailable";
    const labeling = labelEdges({
      ring: parcel.ring,
      roads,
      refPoint: { lng: point.longitude, lat: point.latitude },
      situsAddress: parcel.situsAddress,
    });
    if (!labeling) return unreached("edge-labeling-unavailable");
    stageAtThrow = "derivation-threw";

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

    // P60b's split, carried through rather than flattened: "no-buildable-area"
    // is a consume-lot MEASUREMENT and "geometry-validation-failed" is a gate
    // decline. Neither is a withhold and neither may be reported as one, so the
    // route's own `wireStatus` is the reason served.
    if (wireStatus !== "ok") {
      return declined("derivation-not-drawn", wireStatus);
    }
    const feature = derived.geojson.features[0];
    const coordinates = feature?.geometry?.coordinates?.[0];
    if (!feature || !coordinates || coordinates.length < 4) {
      return unreached("ring-too-small");
    }

    return {
      state: "modelled",
      chain,
      model: {
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
      },
    };
  } catch {
    // A throw is an attempt that never reached an answer — the same class as a
    // missing ring, never a decline. It is reported at the stage it happened
    // in (see `stageAtThrow`), never as a stage the attempt never got to:
    // reporting a throw from a later stage as a missing ring would be the same
    // defect as reporting `atom_path_pending` beside a chain, one layer down.
    // `chain` still carries whatever was known when it threw, so a chain-read
    // failure is never reported as "no chain exists".
    return unreached(stageAtThrow);
  }
}
