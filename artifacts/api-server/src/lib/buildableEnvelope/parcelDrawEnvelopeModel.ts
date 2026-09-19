/**
 * P-153 (Ruling B reversed for the polygon only, MCP get_smart_site draw
 * block) / P-374 (ONE derivation).
 *
 * Runs the SAME derivation `brokeragePlaceBuildableEnvelope` runs for the
 * map/export routes — `lib/buildableEnvelope/envelopeDrawDerivation.ts`'s
 * `deriveEnvelopeDraw`, which owns the parcel-ring read, the atom-chain read,
 * the spine read, the ordered district-signal probe, the jurisdiction key, the
 * P-257 planned-development gate, `fetchNearbyRoads`/`labelEdges` and
 * `composeBuildableEnvelopeDerivation` (which itself runs
 * `deriveBuildableEnvelope` + `reconcileWithAtomEnvelope`, unchanged) — so an
 * atom-pending parcel with a real, resolvable district + setback table gets a
 * DRAWN buildable-envelope polygon on the draw block, while the buildable-AREA
 * FIGURE stays refused everywhere (denied unconditionally by smartsite-mcp's
 * DERIVED_FIGURES_POLICY; this module never puts a figure on the draw wire).
 *
 * P-339 (Ruling 15, MCP half). This used to return `null` for every one of
 * three DIFFERENT things — modelled, declined, unreached — so the caller could
 * not tell a real decline from an attempt that never got there, and the draw
 * overlay fell back to the bake's stored `atom_path_pending` token, which
 * `envelopeHuman` renders "Withheld, setbacks unruled". It returns a
 * discriminated `EnvelopeDrawOutcome` naming WHICH step decided the outcome
 * (and, where the chain was read, whether one existed), so the overlay's
 * reason is the route's own answer rather than the bake's marker. See
 * `./envelopeDrawOutcome.ts` for the defect that closed and the one owner of
 * the reason.
 *
 * P-374 closed the REST of that gap: P-339 made the reason the route's own, but
 * this file still ran its own copy of the derivation and the copies had drifted
 * (district signal order, spine fallback, the planned-development gate, the
 * raw-vs-resolved district on the modelled wire). Both callers now run
 * `deriveEnvelopeDraw`; this file only maps its outcome onto the draw block's
 * vocabulary, and never re-derives.
 *
 * Fail-closed by design: called ONLY when the caller has already confirmed the
 * bake is atom-pending — see `propertyExplorer.ts`'s call site. Inside here,
 * any missing point, any ungeometric ring, a parcel-identity mismatch at the
 * resolved point, an empty/validation-failed derivation, or any thrown error
 * (network, parse, whatever) all resolve to a REFUSAL carrying its own step;
 * the caller then serves that step's reason, never a claim the route did not
 * make. This never throws.
 *
 * Real extra I/O, deliberately: up to four network/DB calls per atom-pending
 * draw-block request (parcel-ring pin-query, atom-chain fetch, spine read when
 * the ring carries no stamp, nearby-roads fetch) — the same four the route
 * makes for the same parcel. An accepted cost of this ruling — not cached or
 * deferred here beyond what those calls already do on their own.
 */

import { queryGisLayerGeoJson } from "../brokerageGisLayers";
import { deriveEnvelopeDraw } from "./envelopeDrawDerivation";
import type {
  EnvelopeDrawChain,
  EnvelopeDrawOutcome,
  EnvelopeDrawStep,
  EnvelopeModelledDraw,
} from "./envelopeDrawOutcome";

/**
 * P-374: the same derivation, called once.
 *
 * WHAT WAS WRONG. Two paths answered "does this parcel have a buildable
 * envelope, and if not, why". The route ran
 * `envelopeDrawDerivation.ts#deriveEnvelopeDraw` — the ordered district-signal
 * probe, the spine/atom-chain fallback, the P-257 planned-development gate.
 * This file ran its own copy: the bake's single `zoningCode`, straight into
 * `resolveAuthoritativeSetbacks`, with a `no-zoning-code` refusal whenever that
 * one code was missing. So `48453:239852` (Austin, GIS stamp `SF`, own district
 * `SF-3`) drew 25/5/10/15 on the route while this block refused — and
 * `48453:367134` resolved the OTHER Austin SF row. (On the 2026-09-18 artifact
 * of record the route's own side of that crossing was still live — the artifact
 * predates P-340; this lane's base carries it. The artifact shows the block
 * serving no polygon where the route served one, which is the projection gap.) `48309:103015`-class parcels
 * with no bake facet refused here while the route read the spine and drew.
 * Where both did draw, the served `district` was the raw code, not the
 * resolved one.
 *
 * THE RULE, unchanged from P-339: a surface never composes its own envelope
 * answer. P-339 made the REASON the route's own; this lane makes the DERIVATION
 * the route's own. This function is now a thin, fail-closed adapter: it
 * validates the one input the route does not have (a point), runs the route's
 * derivation, and maps its outcome onto the draw block's vocabulary. It may not
 * re-derive anything.
 *
 * The two gates kept here are the ones the route genuinely does not apply, and
 * both can only ADD a refusal:
 *   - `no-query-point`: the route can degrade to lot-shape labeling with no
 *     point; this block is seeded by one, so without it there is nothing to
 *     seed (unreached, no I/O).
 *   - `parcel-identity-mismatch`: passed to the derivation as
 *     `expectedParcelNodeId`. If live GIS drifts from the baked snapshot's
 *     `queryPoint`, a neighbour's ring must never be drawn onto this block.
 *
 * Real extra I/O, deliberately: the parcel-ring pin-query, the atom-chain
 * fetch, a spine read when the ring carries no zoning stamp, and the
 * nearby-roads fetch when it does — the same four calls the route makes for the
 * same parcel, not a fourth mechanism.
 *
 * Fail-closed by design: called ONLY when the caller has already confirmed the
 * bake is atom-pending — see `propertyExplorer.ts`'s call site. Every step
 * resolves to a named outcome; this never throws.
 */

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
  /**
   * The card's own composed situs city/state (`situsCompose.resolveSitusCity`,
   * the value the label already serves). The route's equivalent input is the
   * request geocode's city/state; when absent, the derivation falls back to the
   * ring's own situs string and then to the parcel-node FIPS derivation, so a
   * caller that cannot name a city is not refused for it.
   */
  jurisdictionCity?: string | null;
  jurisdictionState?: string | null;
  /** The card's own composed address, when the caller has one. */
  address?: string | null;
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

  const point = args.queryPoint;
  if (
    !point ||
    !Number.isFinite(point.latitude) ||
    !Number.isFinite(point.longitude)
  ) {
    return unreached("no-query-point");
  }

  // 1) The real parcel polygon at this point (the route's own call).
  let parcelGeo: { geojson: unknown; provider: string | null };
  try {
    parcelGeo = await queryGisLayerGeoJson({
      layer: "parcels",
      latitude: point.latitude,
      longitude: point.longitude,
    });
  } catch {
    // The ring read itself is the only stage name this attempt has reached.
    return unreached("parcel-ring-unavailable");
  }

  // 2) THE derivation — the route's own body, not a copy of it.
  const outcome = await deriveEnvelopeDraw({
    parcelGeo,
    jurisdictionCity: args.jurisdictionCity ?? null,
    jurisdictionState: args.jurisdictionState ?? null,
    address: args.address ?? null,
    point: { lat: point.latitude, lng: point.longitude },
    expectedParcelNodeId: args.parcelNodeId,
    postedParcelNodeId: args.parcelNodeId,
  });

  switch (outcome.state) {
    case "no-parcel-ring":
      return unreached("parcel-ring-unavailable");
    case "parcel-identity-mismatch":
      return unreached("parcel-identity-mismatch");
    case "threw":
      // The throw is reported at the stage it really happened in
      // (`deriveEnvelopeDraw`'s own `step`), never as a stage the attempt never
      // reached: a throw from a later stage reported as a missing ring would be
      // the same defect as `atom_path_pending` beside a chain, one layer down.
      return unreached(outcome.step);
    case "no-zoning-stamp":
      // The route's own terminal answer (`status: "declined"`,
      // `declineReason: "no-zoning-stamp"`). It read the chain and resolved
      // nothing to a district, so this is a DECLINE, not an unreached attempt.
      chain = outcome.chain;
      return declined("no-zoning-code");
    case "no-district":
      chain = outcome.chain;
      // P-257: when the district is a planned-development one, the route names
      // ITS refusal (a reason and a sentence about the ordinance), not a
      // shapeless "no source". `envelopeDrawRefusalReason` serves `declinedBy`
      // verbatim, so the draw block says what the route said.
      //
      // P-374: nothing else is added here. In particular this module does NOT
      // close the pre-registered chain rule (`setbacks-unresolved` with a chain
      // present, `atom_path_pending` only with a chain ABSENT) off just because
      // a null `jurisdictionKey` looks like a gap: P-339's two directions are a
      // contract the probe grades, and a caller's own missing city is not
      // evidence that no rule exists anywhere. When the draw block really
      // cannot reach a table its step is `setbacks-unresolved` (chain present)
      // or `atom_path_pending` (chain absent) — both true claims about the
      // chain it actually read, and both already carried by the outcome.
      return declined(
        "setbacks-unresolved",
        outcome.plannedDevelopment?.declineReason ?? null,
      );
    case "ungeometric-parcel":
      chain = outcome.chain;
      // The route's own 422 status for the same condition.
      return declined("derivation-not-drawn", "ungeometric-parcel");
    case "drawn": {
      chain = outcome.chain;
      // P60b's split, carried through rather than flattened: "no-buildable-area"
      // is a consume-lot MEASUREMENT and "geometry-validation-failed" is a gate
      // decline. Neither is a withhold and neither may be reported as one, so the
      // route's own `wireStatus` is the reason served.
      if (outcome.wireStatus !== "ok") {
        return declined("derivation-not-drawn", outcome.wireStatus);
      }
      const feature = outcome.derived.geojson.features[0];
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
            front_ft: outcome.resolved.scalars.front_ft,
            side_ft: outcome.resolved.scalars.side_ft,
            rear_ft: outcome.resolved.scalars.rear_ft,
            ...(typeof outcome.resolved.scalars.side_corner_ft === "number"
              ? { side_corner_ft: outcome.resolved.scalars.side_corner_ft }
              : {}),
            // P-374: the RESOLVED district the route serves, not the raw code
            // that seeded the probe. Serving the raw code here is how the draw
            // block could name a different district than the polygon it drew.
            district: outcome.effectiveZoningCode,
          },
          disclosure: feature.properties.disclosure,
        },
      };
    }
  }
}
