/**
 * Reasoning overlays for Max-tier map render (75i task 11).
 *
 * Cited verdicts and layer findings pinned to parcel coordinates —
 * not raw geometry display.
 */

import type { EngineHonesty } from "@workspace/engine-core";
import type { InvestorVerdict } from "./brokerageInvestorVerdict";
import type { MapLayerSlot, MapLayersAssemblePayload } from "./engineSpineMapLayers";

export type MapReasoningOverlayKind =
  | "verdict"
  | "opportunity-zone"
  | "floodway"
  | "flood-zone"
  | "mud-pid"
  | "layer-note";

export interface MapReasoningOverlay {
  id: string;
  kind: MapReasoningOverlayKind;
  label: string;
  detail: string | null;
  citationAdapter: string | null;
  anchor: { latitude: number; longitude: number };
  honesty: EngineHonesty | null;
}

function honestyFromSlot(slot: MapLayerSlot | undefined): EngineHonesty | null {
  if (!slot?.envelope) return null;
  return {
    confidence: {
      value: slot.envelope.confidence.value,
      kind: slot.envelope.confidence.kind as EngineHonesty["confidence"]["kind"],
    },
    dataVintage: slot.envelope.dataVintage,
    coverage: slot.envelope.coverage,
    source: slot.envelope.source,
  };
}

export function buildMapReasoningOverlays(input: {
  assemble: MapLayersAssemblePayload;
  verdict?: InvestorVerdict | null;
  mudPidLine?: string | null;
}): MapReasoningOverlay[] {
  const { latitude, longitude } = input.assemble.place;
  const anchor = { latitude, longitude };
  const overlays: MapReasoningOverlay[] = [];
  const slotByKey = new Map(
    input.assemble.layers.map((l) => [l.layerKey, l]),
  );

  if (input.verdict) {
    overlays.push({
      id: "verdict-primary",
      kind: "verdict",
      label: input.verdict.headline,
      detail: input.verdict.rationale[0] ?? null,
      citationAdapter: null,
      anchor,
      honesty: null,
    });
    if (input.verdict.ozLine) {
      overlays.push({
        id: "verdict-oz",
        kind: "opportunity-zone",
        label: input.verdict.ozLine,
        detail: null,
        citationAdapter: "national:opportunity-zone",
        anchor,
        honesty: honestyFromSlot(slotByKey.get("opportunity-zone-tract")),
      });
    }
  }

  const floodway = slotByKey.get("floodway");
  if (floodway?.status === "ok") {
    const attrs = floodway.envelope?.payload.attributes as
      | { inFloodway?: boolean }
      | undefined;
    overlays.push({
      id: "layer-floodway",
      kind: "floodway",
      label:
        attrs?.inFloodway === false
          ? "Outside regulatory floodway"
          : "Regulatory floodway intersects parcel",
      detail:
        typeof floodway.envelope?.payload.note === "string"
          ? floodway.envelope.payload.note
          : null,
      citationAdapter: floodway.adapterKey ?? "fema:nfhl-flood-zone",
      anchor,
      honesty: honestyFromSlot(floodway),
    });
  }

  const floodZone = slotByKey.get("flood-zone");
  if (floodZone?.status === "ok") {
    const payload = floodZone.envelope?.payload ?? {};
    const attrs = payload.attributes as { floodZone?: unknown } | undefined;
    const zone =
      attrs?.floodZone != null ? String(attrs.floodZone) : null;
    overlays.push({
      id: "layer-flood-zone",
      kind: "flood-zone",
      label: zone ? `FEMA flood zone ${zone}` : "FEMA flood zone mapped",
      detail: null,
      citationAdapter: floodZone.adapterKey ?? "fema:nfhl-flood-zone",
      anchor,
      honesty: honestyFromSlot(floodZone),
    });
  }

  const oz = slotByKey.get("opportunity-zone-tract");
  if (oz?.status === "ok" && !input.verdict?.ozLine) {
    const attrs = oz.envelope?.payload.attributes as
      | { inOpportunityZone?: boolean; tractGeoid?: string }
      | undefined;
    overlays.push({
      id: "layer-oz-tract",
      kind: "opportunity-zone",
      label: attrs?.inOpportunityZone
        ? `Opportunity Zone tract ${attrs.tractGeoid ?? ""}`.trim()
        : "Not in a designated Opportunity Zone tract",
      detail: null,
      citationAdapter: oz.adapterKey ?? "national:opportunity-zone",
      anchor,
      honesty: honestyFromSlot(oz),
    });
  }

  if (input.mudPidLine) {
    overlays.push({
      id: "verdict-mud-pid",
      kind: "mud-pid",
      label: input.mudPidLine,
      detail: null,
      citationAdapter: "tx-comptroller-registry",
      anchor,
      honesty: null,
    });
  }

  return overlays;
}
