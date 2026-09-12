/**
 * P-153 Step A extraction (moved out of `routes/brokeragePlaceBuildableEnvelope.ts`
 * so the get_smart_site draw-block orchestration, `parcelDrawEnvelopeModel.ts`,
 * can reuse it without dragging that route file's whole Express/DB-touching
 * import graph — `resolvePlace`, `txgioAddressResolve`, `brokerageTxParcels`,
 * `txgioParcelStore` all pull in `@workspace/db` at module load, which several
 * existing `propertyExplorer.ts` unit tests mock with a minimal offline
 * surface; importing THOSE transitively broke that mock's minimality with no
 * behavioral upside for this module's own two pure functions).
 *
 * `firstParcelRing` and `composeBuildableEnvelopeDerivation` are BOTH pure —
 * no I/O, no `Response`, no `@workspace/db`. The route file re-exports them
 * (its `deriveLabelAndRespond` calls `composeBuildableEnvelopeDerivation`
 * from here — one copy, two callers, same as before the move) so its own
 * public surface is unchanged; `parcelDrawEnvelopeModel.ts` imports straight
 * from here instead, for the lighter import graph.
 */

import type { SetbackTable } from "@workspace/adapters";
import {
  deriveBuildableEnvelope,
  type BuildableEnvelopeResult,
} from "./derive";
import { reconcileWithAtomEnvelope } from "./reconcileAtomEnvelope";
import type { DistrictMappingResult } from "./districtMapping";
import type { EdgeLabelingResult } from "./edgeLabeling";
import type { Ring } from "./geometry";
import type { PropertyAtomChainWire } from "./fetchPropertyAtomChain";
import type { SetbackSourceKind } from "./authoritativeSetbackSource";
import {
  spineZoningProvenanceNote,
  type SpineZoningResolution,
} from "./spineZoningDistrict";
// Type-only: the SAME envelope module `brokeragePlaceBuildableEnvelope.ts`
// itself reads `EngineHonesty` from (`wrapEngineEnvelope`, the value export,
// is not needed here -- only the honesty shape).
import type { EngineHonesty } from "../../../../../lib/engine-core/src/envelope";

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
export function firstParcelRing(geojson: unknown): {
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

/**
 * P-153 Step A extraction: the PURE tail of `deriveLabelAndRespond` (setback
 * geometry compose + atom reconciliation + honesty envelope), factored out
 * so a second caller (the get_smart_site draw-block orchestration,
 * `parcelDrawEnvelopeModel.ts`) can run the EXACT same composition —
 * `deriveBuildableEnvelope` then `reconcileWithAtomEnvelope` — that this
 * route's map/export path runs, rather than a re-implementation.
 * `deriveLabelAndRespond` (in `routes/brokeragePlaceBuildableEnvelope.ts`)
 * calls this instead of inlining it: one copy, two callers.
 *
 * Still pure: no I/O, no `Response`. Callers own resolving `ring`/`table`/
 * `district`/`labeling`/`atomChain`/`spineZoning` first (network + DB reads)
 * and own sending (or otherwise using) the result.
 */
export function composeBuildableEnvelopeDerivation(args: {
  ring: Ring;
  table: SetbackTable;
  district: DistrictMappingResult;
  labeling: EdgeLabelingResult;
  atomChain: PropertyAtomChainWire | null;
  spineZoning: SpineZoningResolution | null;
  resolvedSourceKind: SetbackSourceKind;
  resolvedSourceLabel: string;
  resolvedEffectiveDate: string;
}): {
  derived: BuildableEnvelopeResult;
  wireStatus: "ok" | "no-buildable-area" | "geometry-validation-failed";
  honesty: EngineHonesty;
  derivePath: string;
} {
  const {
    ring,
    table,
    district,
    labeling,
    atomChain,
    spineZoning,
    resolvedSourceKind,
    resolvedSourceLabel,
    resolvedEffectiveDate,
  } = args;

  const rawDerived = deriveBuildableEnvelope({ ring, table, district, labeling });
  const derived = reconcileWithAtomEnvelope(
    rawDerived,
    atomChain?.buildableEnvelope?.outcome ?? null,
  );
  const atomReconciled = derived !== rawDerived;

  const estimate =
    atomChain?.buildableEnvelope?.readContract?.axes?.assertedConfidence
      ?.estimate;
  const confidenceValue =
    typeof estimate === "number" && Number.isFinite(estimate) ? estimate : 0;

  const derivePath = atomReconciled ? "labelEdges+derive+atom-reconciled" : "labelEdges+derive";
  const provenanceNote = spineZoning
    ? spineZoningProvenanceNote(spineZoning)
    : `Setbacks from ${resolvedSourceKind} (${resolvedSourceLabel}, effective ${resolvedEffectiveDate}). ${
        atomReconciled
          ? "Buildable area reconciled against the property atom chain (map/export parity)."
          : "Geometry from labelEdges+derive (map/export parity)."
      }`;

  const honesty: EngineHonesty = {
    confidence: { value: confidenceValue, kind: "asserted" },
    dataVintage: new Date().toISOString().slice(0, 10),
    coverage: {
      degraded: true,
      reason: derived.approximate
        ? `${provenanceNote} Geometry approximate — verify with survey + city.`
        : provenanceNote,
    },
    source: {
      adapter: spineZoning
        ? `brokerage:buildable-envelope:derive+${spineZoning.source}`
        : `brokerage:buildable-envelope:derive+${resolvedSourceKind}`,
      citationIds: derived.citationUrl ? [derived.citationUrl] : [],
    },
  };

  // P60b reason split: "no-buildable-area" is a consume-lot MEASUREMENT and
  // is only claimed when the boolean clip itself returned empty. A geometry
  // gate decline is a distinct machine-readable status — silent degradation
  // (a validation failure masquerading as a measurement) is prohibited.
  const wireStatus = !derived.empty
    ? "ok"
    : derived.emptyKind === "consumed"
      ? "no-buildable-area"
      : "geometry-validation-failed";

  return { derived, wireStatus, honesty, derivePath };
}
