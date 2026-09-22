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

import { getSetbackTableForZoning } from "@workspace/adapters";
import { canonicalZoningJurisdictionKey } from "@workspace/cad-ingest/zoning-layers";
import { keyFromEngagementOrSynthesize } from "@workspace/codes";
import type { EngineHonesty } from "@workspace/engine-core";
import {
  resolveAuthoritativeSetbacks,
  type AuthoritativeSetbackResolution,
} from "./authoritativeSetbackSource";
import {
  composeBuildableEnvelopeDerivation,
  firstParcelRing,
} from "./composeBuildableEnvelopeDerivation";
import {
  districtCodeHasExactRow,
  firstResolvableDistrictCode,
} from "./districtMapping";
import type { EdgeLabelingResult } from "./edgeLabeling";
import { labelEdges } from "./edgeLabeling";
import type { EnvelopeDrawChain, EnvelopeDrawStep } from "./envelopeDrawOutcome";
import {
  cityStateFromSitus,
  jurisdictionKeyFromParcelNode,
} from "./envelopeJurisdiction";
import {
  fetchPropertyAtomChain,
  type PropertyAtomChainWire,
} from "./fetchPropertyAtomChain";
import {
  plannedDevelopmentSetbackRefusalFor,
  type PlannedDevelopmentSetbackRefusal,
} from "./plannedDevelopmentSetback";
import { fetchNearbyRoads, namedRoadsToCandidates } from "./roads";
import {
  recordJurisdictionKeyForDistrict,
  resolveSpineZoningWhenGisAbsent,
  type SpineZoningResolution,
} from "./spineZoningDistrict";

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

    const gisZoning = (parcel.zoningCode ?? "").trim();
    const spineZoning: SpineZoningResolution | null = gisZoning
      ? null
      : await resolveSpineZoningWhenGisAbsent(
          parcelNodeIdValue,
          parcel.zoningCode,
        );

    /**
     * The ordered district-code signals, most specific first — the same order
     * this site has always used (the parcel's own GIS zoning stamp, then
     * Spine's zoning fact, then the atom chain's zoning fact, then its setback
     * rule).
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
    const firstSignal =
      districtCodeSignals.find((c) => (c ?? "").trim() !== "") ?? "";

    /**
     * P-340 — read the engagement key BEFORE probing any table. The table probe
     * below must run against the same jurisdiction key this site will resolve
     * with, so a code that names no row can never move a parcel between
     * jurisdictions.
     */
    const situsCityState = cityStateFromSitus(parcel.situsAddress);
    const fromCityState = keyFromEngagementOrSynthesize({
      jurisdictionCity: input.jurisdictionCity ?? situsCityState.city,
      jurisdictionState: input.jurisdictionState ?? situsCityState.state,
      address: input.address ?? undefined,
    });

    /**
     * P-339/P-366 residual (OPS-24, 2026-09-21) — THE JURISDICTION THAT STAMPED
     * THE DISTRICT LEADS.
     *
     * THE DEFECT. The key below is the one both the district probe and the table
     * lookup run against, and it was derived from the situs city, then a
     * geocoded city, then the county's unique district hit — never from the
     * source that stamped the district. On `48491:R415488` (Williamson) those
     * two disagree: the zoning stamp is `SF-S` off Pflugerville's own zoning
     * layer (`pflugerville-tx`, served by the record rail beside the district
     * code), while the situs/geocode city resolves to Round Rock. The route
     * probed Round Rock's table for a Pflugerville district, found no row, and
     * refused `no-district` — while its own card served that district's
     * Pflugerville row (25/7.5/20/15) at the same time. Same shape on
     * `48453:352594` (Buda): the stamp is `R2`/`buda-tx` and the derivation fell
     * through to a district-uniqueness guess in another city.
     *
     * THE RULE. A setback table belongs to the jurisdiction whose ordinance
     * stamped the district. When the source that held the district also names
     * that jurisdiction (`SpineZoningResolution.jurisdictionKey`, read beside
     * the district off the same cell — the ledger is the serving path), it is
     * the key. A situs city is a postal place name and a geocoded city is where
     * a pin landed; neither is an authority, so they keep their place BELOW the
     * stamp rather than above it. Where no source names a jurisdiction (an
     * atom-chain stamp, or GIS's own `zoningCode`), the derivation is unchanged:
     * city/state, then the county's unique district hit.
     *
     * P-340's rule is kept, and this is the same rule applied to the key's
     * source: the key is read BEFORE any table is probed and is the one both the
     * probe and the lookup use, so a code that names no row can never move a
     * parcel between jurisdictions.
     *
     * SECOND SOURCE FOR THE SAME PAIR (same lane, same day). The county parcel
     * sources DO stamp a `zoningCode` (`payload.parcel.zoningCode: "SF"` on
     * `48453:367134`, `"SF-S"` on `48453:280210`), and a GIS stamp suppresses
     * `resolveSpineZoningWhenGisAbsent` entirely — so on those parcels the
     * record cell was never read and the key fell to the situs city (absent on
     * CAD lines like `1006 WISTERIA CIR`) or to the county-wide
     * district-uniqueness guess. Measured live on the identity path the map
     * sends after P-383, four buckets that PASS today answered `no-district`:
     * `48453:239852` (record: SF-3 / austin-tx), `48453:523600`
     * (SU / cedar-park-tx), `48055:40428` (P / san-marcos-tx) and `48055:27929`
     * (R1 / martindale-tx) — each with its corpus row present and its card
     * drawing. `recordJurisdictionKeyForDistrict` therefore reads the pair
     * whenever the spine did not already carry one, and returns it only for the
     * district being probed. It reads a value beside the district; it never
     * searches jurisdictions for one that answers.
     *
     * P-406 (OPS-25, 2026-09-22) — AND THE STAMP IS RESOLVED THROUGH THE
     * REGISTRY'S OWN `cityKey`. Both values below are whatever the source
     * wrote, and a source that writes the NAME of a zoning-layer ENTRY instead
     * of the `cityKey` that entry declares is accepted by every comparison in
     * this site — the two strings are identical for 23 of the registry's 26
     * entries, and `ZONING_LAYERS` resolves either. They are not identical for
     * the three entries that carry one city across several counties, and that
     * is exactly the indirection those entries exist to perform:
     * `elgin-tx-travis` (48453) declares `cityKey: "elgin-tx"`, the one string
     * `isElginCityJurisdiction` routes the ratified Elgin table on. Measured
     * live: the record cell for `48453:959606` (Elgin, Travis side) carries
     * `elgin-tx-travis`, so the rule above shipped the entry name as the key,
     * the Elgin table was never reached, and the parcel refused `no-district`
     * while PROD drew it R-3. Reading the value through
     * `canonicalZoningJurisdictionKey` is what the registry's own comment says
     * `cityKey` is for; it fixes all three entries at once and is a no-op for
     * every other key, including table-owning keys like
     * `elgin-development-code`.
     */
    const fromDistrictStamp = canonicalZoningJurisdictionKey(
      spineZoning?.jurisdictionKey,
    );
    const fromRecordCell = fromDistrictStamp
      ? null
      : canonicalZoningJurisdictionKey(
          await recordJurisdictionKeyForDistrict(parcelNodeIdValue, firstSignal),
        );
    const provisionalJurisdictionKey =
      fromDistrictStamp ??
      fromRecordCell ??
      fromCityState ??
      jurisdictionKeyFromParcelNode({
        parcelNodeId: parcelNodeIdValue,
        districtCode: firstSignal,
      });

    /**
     * P-340 — A BASE CODE IS NOT A DISTRICT DETERMINATION. See that lane's own
     * note on the two measured Austin parcels; the rule is unchanged here.
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
      return {
        state: "no-zoning-stamp",
        parcel,
        parcelNodeId: parcelNodeIdValue,
        chain,
        atomChain,
        spineZoning,
        honesty,
      };
    }

    /**
     * P-340: the SAME key the district signals were probed against above
     * (`provisionalJurisdictionKey`) — this site must not re-derive it from the
     * resolved district code, or the code the fallback picked could move the
     * parcel to a different jurisdiction than the one its row was checked in.
     */
    const jurisdictionKey = provisionalJurisdictionKey;

    const resolved = resolveAuthoritativeSetbacks({
      jurisdictionKey,
      districtCode: effectiveZoningCode,
      atomRule: atomChain?.setbackRule ?? null,
    });

    if (!resolved) {
      /**
       * P-257 — say which kind of nothing this is. A planned-development code
       * refuses a setback table for a REASON (its standards live in its own
       * ordinance and development plan), and that reason has to reach the
       * reader.
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
      return {
        state: "no-district",
        parcel,
        parcelNodeId: parcelNodeIdValue,
        chain,
        atomChain,
        spineZoning,
        effectiveZoningCode,
        jurisdictionKey,
        plannedDevelopment,
      };
    }

    const hasPoint = point !== null;
    let roads = [] as ReturnType<typeof namedRoadsToCandidates>;
    if (!skipRoad && hasPoint) {
      roads = namedRoadsToCandidates(
        await fetchNearbyRoads({ lat: point.lat, lng: point.lng }),
      );
    }
    stageAtThrow = "edge-labeling-unavailable";
    const labeling = labelEdges({
      ring: parcel.ring,
      roads,
      refPoint: hasPoint ? { lng: point.lng, lat: point.lat } : null,
      situsAddress: parcel.situsAddress,
    });
    if (!labeling) {
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

    /**
     * 6) The SAME pure composition the map/export route runs — real reuse, not
     * a re-implementation.
     */
    const { derived, wireStatus, honesty, derivePath } =
      composeBuildableEnvelopeDerivation({
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
