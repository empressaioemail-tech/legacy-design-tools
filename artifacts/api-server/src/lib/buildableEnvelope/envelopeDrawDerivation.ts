/**
 * P-374 — ONE derivation for the envelope draw block.
 *
 * WHY THIS MODULE EXISTS. Two callers answered "does this parcel have a
 * buildable envelope, and if not, why not" with two separately written
 * derivations:
 *
 *   - `routes/brokeragePlaceBuildableEnvelope.ts` (`deriveAndRespond`) — the
 *     drawing route the map / export / PDF surfaces read.
 *   - `lib/buildableEnvelope/parcelDrawEnvelopeModel.ts`
 *     (`tryComposeEnvelopeModelForDraw`) — the `get_smart_site` draw block the
 *     MCP serves.
 *
 * P-153/P-339 made the MCP READ the route's outcome rather than the bake's
 * `atom_path_pending` marker, so the overlay's reason stopped being a stored
 * token and started being the route's own answer. That closed the reason's
 * projection. It did not close the DERIVATION: the MCP still ran its own copy
 * of the sequence, and the copies had drifted. Measured 2026-09-18 (this lane's
 * close carries the per-parcel table):
 *
 *   1. DISTRICT. The route picks the first signal that names a row in the
 *      jurisdiction's own table (`firstResolvableDistrictCode` over GIS stamp ->
 *      spine -> chain), so Austin's base code `SF` resolves to the parcel's own
 *      `SF-3`. The MCP fed its bake's single code straight to
 *      `resolveAuthoritativeSetbacks`, where `SF` crossed to `SF-4A` — a
 *      DIFFERENT setback table (15/3.5/5/10 against 25/5/10/15) drawn beside a
 *      card that ruled the other one.
 *      DATED, so the per-parcel table in the close is not read as a
 *      contradiction: on the 2026-09-18 artifact of record BOTH sides of the
 *      route still served the crossed row (the artifact predates P-340, which
 *      fixed the route's own side of this crossing); the MCP served no
 *      polygon at all. This lane's base carries P-340, so on it the route
 *      serves `25/5/10/15` and the draw block's own copy was the remaining
 *      crossing — which is what the parity fixtures pin.
 *   2. ZONING SOURCE. The route reads the spine/atom chain when the ring has no
 *      stamp; the MCP refused `no-zoning-code` on a missing bake facet alone.
 *   3. PLANNED DEVELOPMENT. The route names a planned-development district's own
 *      refusal (P-257's sentence); the MCP flattened it into
 *      `setbacks-unresolved`.
 *   4. The modelled draw carried the RAW code as its `district` while the route
 *      served the resolved one.
 *
 * THE RULE. One derivation, in one module, called by both. Its inputs are the
 * parcel's own facts plus whatever jurisdiction context the caller legitimately
 * has (the route has the request geocode; the MCP has the card's composed situs
 * city — `resolveSitusCity`, the same value the label already serves). The
 * callers render; they never re-derive. A caller may still apply its own
 * PRE-conditions (the MCP's no-point check and its identity guard), and those
 * are named in the close rather than hidden here — see `deriveEnvelopeDraw`'s
 * `expectedParcelNodeId`.
 *
 * Not a second mechanism: this is the route's own body, moved, with the route's
 * `deriveAndRespond` now calling it. `composeBuildableEnvelopeDerivation` (the
 * pure composition + honesty wrap) was already shared by both call sites and is
 * unchanged.
 */

import type { EngineHonesty } from "@workspace/engine-core";
import {
  type AuthoritativeSetbackResolution,
} from "./authoritativeSetbackSource";
import {
  composeBuildableEnvelopeDerivation,
  firstParcelRing,
} from "./composeBuildableEnvelopeDerivation";
import type { EdgeLabelingResult } from "./edgeLabeling";
import { labelEdges } from "./edgeLabeling";
import { cleanParcelRing, COLLINEAR_MERGE_MAX_FT, COLLINEAR_MERGE_RETRY_FT } from "./geometry";
import { decideEnvelopeFromLedger } from "./ledgerEnvelopeRails";
import type { EnvelopeDrawChain, EnvelopeDrawStep } from "./envelopeDrawOutcome";
import {
  fetchPropertyAtomChain,
  type PropertyAtomChainWire,
} from "./fetchPropertyAtomChain";
import type { PlannedDevelopmentSetbackRefusal } from "./plannedDevelopmentSetback";
import { fetchNearbyRoads, namedRoadsToCandidates } from "./roads";
import type { SpineZoningResolution } from "./spineZoningDistrict";

type ComposedEnvelope = ReturnType<typeof composeBuildableEnvelopeDerivation>;

/** The parcel ring the derivation read, as `firstParcelRing` returns it. */
export type EnvelopeDrawParcel = NonNullable<ReturnType<typeof firstParcelRing>>;

export type EnvelopeDrawDerivationInput = {
  /**
   * The resolved parcel feature collection. The route has it from either the
   * authoritative situs hit or the point pin-query; the draw block pin-queries
   * the same way (the route's own call), from the point the caller already has.
   */
  parcelGeo: { geojson: unknown; provider: string | null };
  /**
   * The jurisdiction city/state the caller resolved. The route passes the
   * geocode's; the draw block passes the card's own composed situs city
   * (`situsCompose.resolveSitusCity`, the value the label already serves).
   * Either may be absent — the ring's own situs string is the fallback, exactly
   * as the route has always done.
   */
  jurisdictionCity?: string | null;
  jurisdictionState?: string | null;
  /** The REQUEST's own address, when the caller has one (route only). */
  address?: string | null;
  /**
   * Reference point for the road lookup + edge labeling. `null` means no point
   * was resolved: roads are skipped and labeling degrades to lot shape, the
   * route's long-standing behaviour on a geocode miss.
   */
  point?: { lat: number; lng: number } | null;
  /** Route-only: `?skipRoad=1` skips the nearby-road read entirely. */
  skipRoad?: boolean;
  /** The caller-supplied subject id, used only when the ring stamps none. */
  postedParcelNodeId?: string | null;
  /**
   * When set, the fetched ring must stamp this id or the attempt stops at
   * `parcel-identity-mismatch`. The draw block passes it (a point that
   * pin-queries a neighbour must never draw a stranger's envelope onto this
   * parcel's block, P-339); the route does not (its parcel IS the subject by
   * construction, situs-first or pin-query).
   */
  expectedParcelNodeId?: string | null;
};

/** The chain state as far as the derivation got. */
type ReadChain = Exclude<EnvelopeDrawChain, "unreached">;

export type EnvelopeDrawDerivation =
  /** The query returned no usable polygon. Route: 404 no-parcel. */
  | { state: "no-parcel-ring" }
  /** The ring is a different parcel than `expectedParcelNodeId`. */
  | { state: "parcel-identity-mismatch"; parcelNodeId: string | null }
  /**
   * The attempt threw. `step` names the stage it happened in, so a caller that
   * catches (the draw block) reports the stage, and a caller that rethrows (the
   * route, whose 502 handling is unchanged) can still do so.
   */
  | { state: "threw"; step: EnvelopeDrawStep; error: unknown }
  /** Nothing anywhere named a district. The route's own honest decline. */
  | {
      state: "no-zoning-stamp";
      parcel: EnvelopeDrawParcel;
      parcelNodeId: string | null;
      chain: ReadChain;
      atomChain: PropertyAtomChainWire | null;
      spineZoning: SpineZoningResolution | null;
      honesty: EngineHonesty;
    }
  /**
   * The ledger rails declined. `ledgerReason` is the cell's own sentence.
   * This replaces the old `no-zoning-stamp` / `no-district` answers, which
   * re-derived a district and then missed the table.
   */
  | {
      state: "ledger-declined";
      parcel: EnvelopeDrawParcel;
      parcelNodeId: string | null;
      chain: ReadChain;
      atomChain: PropertyAtomChainWire | null;
      ledgerReason: string;
      ledgerCode: string;
      rail: "zoningDistrict" | "setbackFrontFt" | "setbackSideFt" | "setbackRearFt";
    }
  /** A district resolved, but no setback source covers it in this jurisdiction. */
  | {
      state: "no-district";
      parcel: EnvelopeDrawParcel;
      parcelNodeId: string | null;
      chain: ReadChain;
      atomChain: PropertyAtomChainWire | null;
      spineZoning: SpineZoningResolution | null;
      effectiveZoningCode: string;
      jurisdictionKey: string | null;
      /** P-257's own refusal, when the code is a planned-development district. */
      plannedDevelopment: PlannedDevelopmentSetbackRefusal | null;
    }
  /** `labelEdges` could not label the ring. Route: 422 ungeometric-parcel. */
  | {
      state: "ungeometric-parcel";
      parcel: EnvelopeDrawParcel;
      parcelNodeId: string | null;
      chain: ReadChain;
      atomChain: PropertyAtomChainWire | null;
      spineZoning: SpineZoningResolution | null;
      effectiveZoningCode: string;
      jurisdictionKey: string | null;
      resolved: AuthoritativeSetbackResolution;
    }
  /** The derivation ran and answered. `wireStatus` is the route's own status. */
  | {
      state: "drawn";
      parcel: EnvelopeDrawParcel;
      parcelNodeId: string | null;
      chain: ReadChain;
      atomChain: PropertyAtomChainWire | null;
      spineZoning: SpineZoningResolution | null;
      effectiveZoningCode: string;
      jurisdictionKey: string | null;
      resolved: AuthoritativeSetbackResolution;
      labeling: EdgeLabelingResult;
      derived: ComposedEnvelope["derived"];
      wireStatus: ComposedEnvelope["wireStatus"];
      honesty: ComposedEnvelope["honesty"];
      derivePath: ComposedEnvelope["derivePath"];
    };

/** A derivation that ran and answered — the shape the route's drawn renderer takes. */
export type EnvelopeDrawnDerivation = Extract<
  EnvelopeDrawDerivation,
  { state: "drawn" }
>;

/**
 * The route's own derivation, callable by anyone. Throws are RETURNED
 * (`state: "threw"`) rather than propagated, so a caller that must not throw
 * (the draw block) and a caller that must (the route's provider-failure 502)
 * both keep their own contract without a second try/catch layer around a copy
 * of this body.
 */
export async function deriveEnvelopeDraw(
  input: EnvelopeDrawDerivationInput,
): Promise<EnvelopeDrawDerivation> {
  const skipRoad = input.skipRoad === true;
  const point = input.point ?? null;

  // Stage the throw will be reported at, advanced as the derivation progresses
  // (P-339's `stageAtThrow`, moved here with the body it names).
  let stageAtThrow: EnvelopeDrawStep = "parcel-ring-unavailable";
  try {
    const parcel = firstParcelRing(input.parcelGeo.geojson);
    if (!parcel) return { state: "no-parcel-ring" };
    stageAtThrow = "derivation-threw";

    const parcelNodeIdValue: string | null =
      parcel.parcelNodeId ?? input.postedParcelNodeId ?? null;

    const expected = (input.expectedParcelNodeId ?? "").trim();
    if (expected && parcel.parcelNodeId && parcel.parcelNodeId !== expected) {
      return {
        state: "parcel-identity-mismatch",
        parcelNodeId: parcel.parcelNodeId,
      };
    }

    const atomChain = parcelNodeIdValue
      ? await fetchPropertyAtomChain(parcelNodeIdValue)
      : null;
    const chain: ReadChain = atomChain ? "present" : "absent";

    const ledger = await decideEnvelopeFromLedger(parcelNodeIdValue);
    if (ledger.state === "declined") {
      return {
        state: "ledger-declined",
        parcel,
        parcelNodeId: parcelNodeIdValue,
        chain,
        atomChain,
        ledgerReason: ledger.ledgerReason,
        ledgerCode: ledger.ledgerCode,
        rail: ledger.rail,
      };
    }

    const spineZoning: SpineZoningResolution = {
      district: ledger.district,
      source: "parcel-record",
      jurisdictionKey: ledger.jurisdictionKey,
    };
    const effectiveZoningCode = ledger.district;
    const jurisdictionKey = ledger.jurisdictionKey;
    const resolved = ledger.resolved;
    const hasPoint = point !== null;
    let roads = [] as ReturnType<typeof namedRoadsToCandidates>;
    if (!skipRoad && hasPoint) {
      roads = namedRoadsToCandidates(
        await fetchNearbyRoads({ lat: point.lat, lng: point.lng }),
      );
    }
    const refPoint = hasPoint && point ? { lng: point.lng, lat: point.lat } : null;
    const composeOn = (maxChordFt: number) => {
      const ring = cleanParcelRing(parcel.ring, maxChordFt);
      const labeling = labelEdges({
        ring,
        roads,
        refPoint,
        situsAddress: parcel.situsAddress,
      });
      if (!labeling) return { ring, labeling: null, composed: null };
      const composed = composeBuildableEnvelopeDerivation({
        ring,
        table: resolved.table,
        district: resolved.district,
        labeling,
        atomChain,
        spineZoning,
        resolvedSourceKind: resolved.sourceKind,
        resolvedSourceLabel: resolved.sourceLabel,
        resolvedEffectiveDate: resolved.effectiveDate,
      });
      return { ring, labeling, composed };
    };

    stageAtThrow = "edge-labeling-unavailable";
    // One-foot chord bound first. When that ring's strip difference throws,
    // retry once at three feet and keep the retry only if it produces a ring.
    // Measured: 48309:999666 (9,004 edges at one foot) and 48453:548022 (a
    // 14-edge road-labeled inset). On 548022 the three-foot envelope is inside
    // the StratMap ring.
    let drawn = composeOn(COLLINEAR_MERGE_MAX_FT);
    if (drawn.composed?.derived.emptyKind === "clip-failed") {
      const retry = composeOn(COLLINEAR_MERGE_RETRY_FT);
      if (retry.labeling && retry.composed && !retry.composed.derived.empty) {
        drawn = retry;
      }
    }
    if (!drawn.labeling || !drawn.composed) {
      return {
        state: "ungeometric-parcel",
        parcel,
        parcelNodeId: parcelNodeIdValue,
        chain,
        atomChain,
        spineZoning,
        effectiveZoningCode,
        jurisdictionKey,
        resolved,
      };
    }
    stageAtThrow = "derivation-threw";
    const composed = drawn.composed!;
    const labeling = drawn.labeling!;
    const { derived, wireStatus, honesty, derivePath } = composed;

    return {
      state: "drawn",
      parcel,
      parcelNodeId: parcelNodeIdValue,
      chain,
      atomChain,
      spineZoning,
      effectiveZoningCode,
      jurisdictionKey,
      resolved,
      labeling,
      derived,
      wireStatus,
      honesty,
      derivePath,
    };
  } catch (error) {
    return { state: "threw", step: stageAtThrow, error };
  }
}
