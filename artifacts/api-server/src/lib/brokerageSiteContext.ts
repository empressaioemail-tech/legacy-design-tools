/**
 * Property Brief site-context layers — FEMA flood + Regrid parcel/zoning
 * for the Chrome extension wedge (no engagement / briefing_sources row).
 *
 * Read order: permanent place_layer_snapshots → adapter_response_cache
 * (via runAdapters cache) → live upstream.
 */

import {
  runAdapters,
  resolveJurisdiction,
  pickFirstString,
  PARCEL_ID_KEYS,
  ZONING_CODE_KEYS,
  ZONING_DESC_KEYS,
  type AdapterRunOutcome,
  type AdapterResult,
} from "@workspace/adapters";
import { femaNfhlAdapter } from "@workspace/adapters/federal/fema-nfhl";
import { summarizeFederalPayload } from "@workspace/adapters/federal/summaries";
import {
  regridParcelsAdapter,
  regridZoningAdapter,
} from "@workspace/adapters/national/regrid";
import { createAdapterResponseCache } from "./adapterCache";
import { placeKeyFromCoords } from "./placeLayerUtils";
import {
  readPlaceLayerSnapshot,
  writePlaceLayerSnapshot,
} from "./placeLayerSnapshots";

const BROKERAGE_SITE_CONTEXT_ADAPTERS = [
  femaNfhlAdapter,
  regridParcelsAdapter,
  regridZoningAdapter,
] as const;

const SNAPSHOT_ADAPTER_KEYS = BROKERAGE_SITE_CONTEXT_ADAPTERS.map(
  (a) => a.adapterKey,
);

export interface BrokerageSiteContextLayer {
  layerKind: string;
  adapterKey: string;
  tier: string;
  status: "ok" | "no-coverage" | "failed";
  provider?: string;
  summary?: string | null;
  snapshotDate?: string;
  payload?: Record<string, unknown>;
  fromArchive?: boolean;
  error?: { code: string; message: string };
}

export interface BrokerageSiteContext {
  layers: BrokerageSiteContextLayer[];
  placeKey: string;
}

export interface FetchBrokerageSiteContextInput {
  latitude: number;
  longitude: number;
  address?: string;
  jurisdictionCity?: string | null;
  jurisdictionState?: string | null;
}

function summarizeRegridPayload(
  layerKind: string,
  payload: Record<string, unknown>,
): string | null {
  if (layerKind === "regrid-parcel") {
    const parcel = payload.parcel as
      | { properties?: { fields?: Record<string, unknown> } }
      | undefined;
    const fields = parcel?.properties?.fields;
    if (!fields) return null;
    const apn = pickFirstString(fields, PARCEL_ID_KEYS);
    const acres =
      typeof fields.ll_gisacre === "number" ? fields.ll_gisacre : null;
    const owner = pickFirstString(fields, ["owner", "ownername", "ownfrst"]);
    const landUse = pickFirstString(fields, [
      "usecode",
      "usedesc",
      "landuse",
      "land_use",
    ]);
    const parts: string[] = [];
    if (apn) parts.push(`APN ${apn}`);
    if (acres !== null) parts.push(`${acres.toFixed(2)} ac`);
    if (landUse) parts.push(landUse);
    if (owner) parts.push(`Owner: ${owner}`);
    return parts.length ? parts.join(" · ") : "Parcel mapped";
  }
  if (layerKind === "regrid-zoning") {
    const zoning = payload.zoning as
      | { properties?: { fields?: Record<string, unknown> } }
      | undefined;
    const fields = zoning?.properties?.fields;
    if (!fields) return null;
    const code = pickFirstString(fields, ZONING_CODE_KEYS);
    const desc = pickFirstString(fields, ZONING_DESC_KEYS);
    const subtype = pickFirstString(fields, ["zoning_subtype", "zoning_type"]);
    if (code && desc) {
      return subtype ? `${code} — ${desc} (${subtype})` : `${code} — ${desc}`;
    }
    return code ?? desc ?? subtype ?? null;
  }
  return null;
}

function layerSummary(
  layerKind: string,
  payload: Record<string, unknown>,
): string | null {
  if (layerKind === "fema-nfhl-flood-zone") {
    return summarizeFederalPayload(layerKind, payload);
  }
  return summarizeRegridPayload(layerKind, payload);
}

function outcomeToLayer(
  outcome: AdapterRunOutcome,
  opts?: { fromArchive?: boolean },
): BrokerageSiteContextLayer {
  const base = {
    layerKind: outcome.layerKind,
    adapterKey: outcome.adapterKey,
    tier: outcome.tier,
    status: outcome.status,
    fromArchive: opts?.fromArchive,
  };

  if (outcome.status === "ok" && outcome.result) {
    const { result } = outcome;
    return {
      ...base,
      status: "ok",
      provider: result.provider,
      summary: layerSummary(result.layerKind, result.payload),
      snapshotDate: result.snapshotDate,
      payload: result.payload,
    };
  }

  if (outcome.error) {
    return {
      ...base,
      status: outcome.status === "no-coverage" ? "no-coverage" : "failed",
      error: {
        code: outcome.error.code,
        message: outcome.error.message,
      },
    };
  }

  return base;
}

function snapshotToOutcome(
  adapter: (typeof BROKERAGE_SITE_CONTEXT_ADAPTERS)[number],
  snap: {
    payload: Record<string, unknown>;
    snapshotAt: string;
  },
  status: "ok" | "no-coverage" | "failed",
  error?: AdapterRunOutcome["error"],
): AdapterRunOutcome {
  if (status !== "ok") {
    return {
      adapterKey: adapter.adapterKey,
      layerKind: adapter.layerKind,
      tier: adapter.tier,
      status,
      error: error ?? {
        code: "no-coverage",
        message: "Archived layer not available",
      },
    };
  }
  const result: AdapterResult = {
    adapterKey: adapter.adapterKey,
    tier: adapter.tier,
    layerKind: adapter.layerKind,
    sourceKind:
      adapter.adapterKey.startsWith("regrid:")
        ? "national-aggregator"
        : "federal-adapter",
    provider:
      adapter.adapterKey.startsWith("regrid:") ? "Regrid" : "FEMA NFHL",
    snapshotDate: snap.snapshotAt,
    payload: snap.payload,
  };
  return {
    adapterKey: adapter.adapterKey,
    layerKind: adapter.layerKind,
    tier: adapter.tier,
    status: "ok",
    result,
  };
}

async function loadArchivedOutcomes(
  latitude: number,
  longitude: number,
  placeKey: string,
): Promise<Map<string, AdapterRunOutcome>> {
  const found = new Map<string, AdapterRunOutcome>();
  for (const adapter of BROKERAGE_SITE_CONTEXT_ADAPTERS) {
    const snap = await readPlaceLayerSnapshot({
      adapterKey: adapter.adapterKey,
      latitude,
      longitude,
      placeKey,
    });
    if (!snap) continue;
    const status =
      snap.payload && Object.keys(snap.payload).length > 0 ? "ok" : "no-coverage";
    found.set(
      adapter.adapterKey,
      snapshotToOutcome(
        adapter,
        { payload: snap.payload, snapshotAt: snap.snapshotAt },
        status,
      ),
    );
  }
  return found;
}

export async function fetchBrokerageSiteContext(
  input: FetchBrokerageSiteContextInput,
): Promise<BrokerageSiteContext> {
  const { latitude, longitude } = input;
  const placeKey = placeKeyFromCoords(latitude, longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { layers: [], placeKey };
  }

  const jurisdiction = resolveJurisdiction({
    jurisdictionCity: input.jurisdictionCity,
    jurisdictionState: input.jurisdictionState,
    address: input.address,
  });

  const partnerCity =
    jurisdiction.localKey === "bastrop-tx" ||
    jurisdiction.localKey === "grand-county-ut" ||
    jurisdiction.localKey === "lemhi-county-id";

  const archived = await loadArchivedOutcomes(latitude, longitude, placeKey);
  const missingAdapters = BROKERAGE_SITE_CONTEXT_ADAPTERS.filter(
    (a) => !archived.has(a.adapterKey),
  );

  let liveOutcomes: AdapterRunOutcome[] = [];
  if (missingAdapters.length > 0) {
    const cache = createAdapterResponseCache();
    liveOutcomes = await runAdapters({
      adapters: [...missingAdapters],
      context: {
        parcel: {
          latitude,
          longitude,
          address: input.address ?? null,
        },
        jurisdiction: { ...jurisdiction, partnerCity },
      },
      cache,
    });

    for (const outcome of liveOutcomes) {
      if (outcome.status === "ok" && outcome.result) {
        await writePlaceLayerSnapshot({
          adapterKey: outcome.adapterKey,
          latitude,
          longitude,
          result: outcome.result,
          placeKey,
        });
        continue;
      }
      // Archive negative results so a repeat brief at the same coords does
      // not re-hit Regrid/FEMA for adapters that already returned no-coverage.
      if (outcome.status === "no-coverage") {
        const archivedAt = new Date().toISOString();
        await writePlaceLayerSnapshot({
          adapterKey: outcome.adapterKey,
          latitude,
          longitude,
          placeKey,
          result: {
            adapterKey: outcome.adapterKey,
            tier: outcome.tier,
            layerKind: outcome.layerKind,
            sourceKind: outcome.adapterKey.startsWith("regrid:")
              ? "national-aggregator"
              : "federal-adapter",
            provider:
              outcome.adapterKey.startsWith("regrid:") ? "Regrid" : "FEMA NFHL",
            snapshotDate: archivedAt,
            payload: {},
          },
        });
      }
    }
  }

  const mergedOutcomes: AdapterRunOutcome[] = BROKERAGE_SITE_CONTEXT_ADAPTERS.map(
    (a) => {
      const archivedOutcome = archived.get(a.adapterKey);
      if (archivedOutcome) return archivedOutcome;
      return (
        liveOutcomes.find((o) => o.adapterKey === a.adapterKey) ?? {
          adapterKey: a.adapterKey,
          tier: a.tier,
          layerKind: a.layerKind,
          status: "failed" as const,
          error: {
            code: "unknown" as const,
            message: "No layer outcome",
          },
        }
      );
    },
  );

  return {
    placeKey,
    layers: mergedOutcomes.map((o) =>
      outcomeToLayer(o, { fromArchive: archived.has(o.adapterKey) }),
    ),
  };
}

/** Plain-text block for Grok prompts (ok layers with summaries only). */
export function formatSiteContextForLlm(ctx: BrokerageSiteContext): string {
  const lines = ctx.layers
    .filter((l) => l.status === "ok" && l.summary)
    .map(
      (l) =>
        `- ${l.layerKind} (${l.provider ?? l.adapterKey}): ${l.summary}`,
    );
  if (!lines.length) return "";
  return ["Site context layers:", ...lines].join("\n");
}
