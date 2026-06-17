/**
 * Bridge map-layers assemble results into generate-layers persistence + wire.
 */

import type { BriefingSource } from "@workspace/db";
import type { AdapterRunOutcome } from "@workspace/adapters";
import type {
  MapLayerSlot,
  MapLayersAssemblePayload,
} from "./engineSpineMapLayers";

const LAYER_KEY_TO_LAYER_KIND: Record<string, string> = {
  "parcel-polygon": "cotality-parcel",
  "flood-zone": "fema-nfhl-flood-zone",
  floodway: "fema-nfhl-floodway",
  dem: "site-topography-dem",
  topography: "site-topography",
  "opportunity-zone-tract": "opportunity-zone",
  zoning: "cotality-zoning",
};

export function layerKindFromMapSlot(slot: MapLayerSlot): string {
  return LAYER_KEY_TO_LAYER_KIND[slot.layerKey] ?? slot.layerKey;
}

export function mapSlotToAdapterOutcome(slot: MapLayerSlot): AdapterRunOutcome {
  const layerKind = layerKindFromMapSlot(slot);
  const adapterKey = slot.adapterKey ?? `map-layers:${slot.layerKey}`;
  if (slot.status === "ok" && slot.envelope) {
    return {
      adapterKey,
      tier: "federal",
      layerKind,
      status: "ok",
      fromCache: false,
      cachedAt: null,
      result: {
        adapterKey,
        tier: "federal",
        layerKind,
        sourceKind: "federal-adapter",
        provider: slot.envelope.source.adapter,
        snapshotDate: slot.envelope.dataVintage ?? new Date().toISOString(),
        payload: {
          ...slot.envelope.payload,
          mapLayerKey: slot.layerKey,
        },
      },
    };
  }
  return {
    adapterKey,
    tier: "federal",
    layerKind,
    status: slot.status === "failed" ? "failed" : "no-coverage",
    fromCache: false,
    cachedAt: null,
    error: slot.error
      ? { code: slot.error.code as "no-coverage", message: slot.error.message }
      : {
          code: "no-coverage",
          message: slot.pendingReason ?? `map layer ${slot.layerKey} not available`,
        },
  };
}

export function mapLayersToAdapterOutcomes(
  payload: MapLayersAssemblePayload,
): AdapterRunOutcome[] {
  return payload.layers.map(mapSlotToAdapterOutcome);
}

export interface GenerateLayersOutcomeWire {
  adapterKey: string;
  tier: "federal" | "state" | "local";
  sourceKind: "manual-upload" | "federal-adapter" | "state-adapter" | "local-adapter";
  layerKind: string;
  status: "ok" | "no-coverage" | "failed";
  error: { code: string; message: string } | null;
  sourceId: string | null;
  fromCache: boolean;
  cachedAt: string | null;
  upstreamFreshness: {
    status: "fresh" | "stale" | "unknown";
    reason: string | null;
  } | null;
}

export function mapSlotToGenerateLayersOutcome(
  slot: MapLayerSlot,
  sourceId: string | null,
): GenerateLayersOutcomeWire {
  const layerKind = layerKindFromMapSlot(slot);
  const adapterKey = slot.adapterKey ?? `map-layers:${slot.layerKey}`;
  const base: GenerateLayersOutcomeWire = {
    adapterKey,
    tier: "federal",
    sourceKind: "federal-adapter",
    layerKind,
    sourceId,
    fromCache: false,
    cachedAt: null,
    upstreamFreshness: null,
    status: "failed",
    error: null,
  };
  if (slot.status === "ok") {
    return { ...base, status: "ok", error: null };
  }
  if (slot.status === "pending") {
    return {
      ...base,
      status: "no-coverage",
      error: {
        code: "pending",
        message: slot.pendingReason ?? "wave-3 geometry pending",
      },
    };
  }
  return {
    ...base,
    status: slot.status === "failed" ? "failed" : "no-coverage",
    error: slot.error
      ? { code: slot.error.code, message: slot.error.message }
      : {
          code: "no-coverage",
          message: slot.pendingReason ?? "no coverage",
        },
  };
}

/** Values for briefing_sources insert from a map layer slot. */
export function briefingSourceValuesFromMapSlot(
  briefingId: string,
  slot: MapLayerSlot,
): Omit<BriefingSource, "id" | "createdAt" | "supersededAt" | "supersededById"> {
  const layerKind = layerKindFromMapSlot(slot);
  const adapterKey = slot.adapterKey ?? `map-layers:${slot.layerKey}`;
  const envelope = slot.envelope;
  return {
    briefingId,
    layerKind,
    sourceKind: "federal-adapter",
    provider: `${adapterKey} (map-layers assemble)`,
    snapshotDate: envelope?.dataVintage
      ? new Date(envelope.dataVintage)
      : new Date(),
    note:
      slot.pendingReason ??
      (typeof envelope?.payload.note === "string"
        ? envelope.payload.note
        : null),
    payload: envelope?.payload ?? { kind: slot.layerKey },
    uploadObjectPath: null,
    uploadOriginalFilename: null,
    uploadContentType: null,
    uploadByteSize: null,
    dxfObjectPath: null,
    glbObjectPath: null,
    conversionStatus: null,
    conversionError: null,
  };
}
