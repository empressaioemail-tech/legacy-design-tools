/**
 * Property Brief site-context layers — federal environmental + Regrid
 * parcel/zoning for the Chrome extension wedge (no engagement /
 * briefing_sources row).
 *
 * Read order: permanent place_layer_snapshots → adapter_response_cache
 * (via runAdapters cache) → live upstream.
 *
 * Federal set mirrors `FEDERAL_ADAPTERS` minus FCC (QA-22) and matches
 * the nationwide generate-layers federal trio: FEMA, USGS NED, EPA
 * EJScreen, plus Regrid parcel/zoning. USDA / USFWS adapters are not
 * yet in `@workspace/adapters` — track under PB-003 follow-up.
 */

import {
  runAdapters,
  resolveJurisdiction,
  pickFirstString,
  PARCEL_ID_KEYS,
  ZONING_CODE_KEYS,
  ZONING_DESC_KEYS,
  isTceqEdwardsEnabled,
  type Adapter,
  type AdapterRunOutcome,
  type AdapterResult,
} from "@workspace/adapters";
import { femaNfhlAdapter } from "@workspace/adapters/federal/fema-nfhl";
import { usgsNedAdapter } from "@workspace/adapters/federal/usgs-ned";
import { epaEjscreenAdapter } from "@workspace/adapters/federal/epa-ejscreen";
import { summarizeFederalPayload } from "@workspace/adapters/federal/summaries";
import {
  regridParcelsAdapter,
  regridZoningAdapter,
} from "@workspace/adapters/national/regrid";
import { summarizeStatePayload } from "@workspace/adapters/state/summaries";
import { texasEdwardsAquiferAdapter } from "@workspace/adapters/state/texas";
import { createAdapterResponseCache } from "./adapterCache";
import { placeKeyFromCoords } from "./placeLayerUtils";
import {
  readPlaceLayerSnapshot,
  writePlaceLayerSnapshot,
} from "./placeLayerSnapshots";

/** Wall-clock budget for one brief site-context fetch (all adapters). */
export const BROKERAGE_SITE_CONTEXT_TIMEOUT_MS = 30_000;

/** Premium Regrid `fields` keys beyond pilot GIS column names. */
const REGRID_PARCEL_ID_KEYS = [
  ...PARCEL_ID_KEYS,
  "parcelnumb",
  "parcelnum",
  "state_parcelnum",
  "account_num",
] as const;

const REGRID_ZONING_CODE_KEYS = [
  ...ZONING_CODE_KEYS,
  "zoning",
  "zoning_code",
] as const;

const REGRID_ZONING_DESC_KEYS = [
  ...ZONING_DESC_KEYS,
  "zoning_description",
  "zoning_desc",
] as const;

function brokerageSiteContextAdapters(): readonly Adapter[] {
  const adapters: Adapter[] = [
    femaNfhlAdapter,
    usgsNedAdapter,
    epaEjscreenAdapter,
    regridParcelsAdapter,
    regridZoningAdapter,
  ];
  if (isTceqEdwardsEnabled()) {
    adapters.push(texasEdwardsAquiferAdapter);
  }
  return adapters;
}

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
    const apn = pickFirstString(fields, REGRID_PARCEL_ID_KEYS);
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
    const code = pickFirstString(fields, REGRID_ZONING_CODE_KEYS);
    const desc = pickFirstString(fields, REGRID_ZONING_DESC_KEYS);
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
  return (
    summarizeFederalPayload(layerKind, payload) ??
    summarizeStatePayload(layerKind, payload) ??
    summarizeRegridPayload(layerKind, payload)
  );
}

function adapterSourceKind(adapter: Adapter): AdapterResult["sourceKind"] {
  if (adapter.adapterKey.startsWith("regrid:")) return "national-aggregator";
  if (adapter.tier === "state") return "state-adapter";
  return "federal-adapter";
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
  adapter: Adapter,
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
    sourceKind: adapterSourceKind(adapter),
    provider: adapter.provider,
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
  adapters: readonly Adapter[],
  latitude: number,
  longitude: number,
  placeKey: string,
): Promise<Map<string, AdapterRunOutcome>> {
  const found = new Map<string, AdapterRunOutcome>();
  for (const adapter of adapters) {
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

function emptyArchiveResult(adapter: Adapter, archivedAt: string): AdapterResult {
  return {
    adapterKey: adapter.adapterKey,
    tier: adapter.tier,
    layerKind: adapter.layerKind,
    sourceKind: adapterSourceKind(adapter),
    provider: adapter.provider,
    snapshotDate: archivedAt,
    payload: {},
  };
}

export async function fetchBrokerageSiteContext(
  input: FetchBrokerageSiteContextInput,
): Promise<BrokerageSiteContext> {
  const { latitude, longitude } = input;
  const placeKey = placeKeyFromCoords(latitude, longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { layers: [], placeKey };
  }

  const adapters = brokerageSiteContextAdapters();

  const jurisdiction = resolveJurisdiction({
    jurisdictionCity: input.jurisdictionCity,
    jurisdictionState: input.jurisdictionState,
    address: input.address,
  });

  const partnerCity =
    jurisdiction.localKey === "bastrop-tx" ||
    jurisdiction.localKey === "grand-county-ut" ||
    jurisdiction.localKey === "lemhi-county-id";

  const archived = await loadArchivedOutcomes(
    adapters,
    latitude,
    longitude,
    placeKey,
  );
  const missingAdapters = adapters.filter((a) => !archived.has(a.adapterKey));

  let liveOutcomes: AdapterRunOutcome[] = [];
  if (missingAdapters.length > 0) {
    const cache = createAdapterResponseCache();
    const budgetAc = new AbortController();
    const budgetTimer = setTimeout(
      () => budgetAc.abort(),
      BROKERAGE_SITE_CONTEXT_TIMEOUT_MS,
    );
    try {
      liveOutcomes = await runAdapters({
        adapters: [...missingAdapters],
        context: {
          parcel: {
            latitude,
            longitude,
            address: input.address ?? null,
          },
          jurisdiction: { ...jurisdiction, partnerCity },
          signal: budgetAc.signal,
        },
        cache,
      });
    } finally {
      clearTimeout(budgetTimer);
    }

    for (const outcome of liveOutcomes) {
      const adapter = adapters.find((a) => a.adapterKey === outcome.adapterKey);
      if (!adapter) continue;

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
      if (outcome.status === "no-coverage") {
        await writePlaceLayerSnapshot({
          adapterKey: outcome.adapterKey,
          latitude,
          longitude,
          placeKey,
          result: emptyArchiveResult(adapter, new Date().toISOString()),
        });
      }
    }
  }

  const mergedOutcomes: AdapterRunOutcome[] = adapters.map((a) => {
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
  });

  return {
    placeKey,
    layers: mergedOutcomes.map((o) =>
      outcomeToLayer(o, { fromArchive: archived.has(o.adapterKey) }),
    ),
  };
}

function regridParcelDetailLines(
  payload: Record<string, unknown>,
): string[] {
  const parcel = payload.parcel as
    | { properties?: { fields?: Record<string, unknown> } }
    | undefined;
  const fields = parcel?.properties?.fields;
  if (!fields) return [];

  const lines: string[] = [];
  const apn = pickFirstString(fields, REGRID_PARCEL_ID_KEYS);
  const llUuid = pickFirstString(fields, ["ll_uuid", "llUuid"]);
  const owner = pickFirstString(fields, ["owner", "ownername", "ownfrst"]);
  const landUse = pickFirstString(fields, [
    "usecode",
    "usedesc",
    "landuse",
    "land_use",
  ]);
  const acres =
    typeof fields.ll_gisacre === "number" ? fields.ll_gisacre : null;
  const parcelZoning = pickFirstString(fields, REGRID_ZONING_CODE_KEYS);

  if (apn) lines.push(`APN: ${apn}`);
  if (llUuid) lines.push(`Regrid ll_uuid: ${llUuid}`);
  if (acres !== null) lines.push(`Area: ${acres.toFixed(2)} acres`);
  if (landUse) lines.push(`Land use: ${landUse}`);
  if (owner) lines.push(`Owner: ${owner}`);
  if (parcelZoning) lines.push(`Zoning (parcel field): ${parcelZoning}`);
  return lines;
}

function regridZoningDetailLines(
  payload: Record<string, unknown>,
): string[] {
  const zoning = payload.zoning as
    | { properties?: { fields?: Record<string, unknown> } }
    | undefined;
  const fields = zoning?.properties?.fields;
  if (!fields) return [];

  const lines: string[] = [];
  const code = pickFirstString(fields, REGRID_ZONING_CODE_KEYS);
  const desc = pickFirstString(fields, REGRID_ZONING_DESC_KEYS);
  const subtype = pickFirstString(fields, ["zoning_subtype", "zoning_type"]);
  const llUuid = pickFirstString(fields, ["ll_uuid", "llUuid"]);

  if (code) lines.push(`Zoning code: ${code}`);
  if (desc) lines.push(`Zoning description: ${desc}`);
  if (subtype) lines.push(`Zoning subtype: ${subtype}`);
  if (llUuid) lines.push(`Regrid ll_uuid: ${llUuid}`);
  return lines;
}

function layerDetailLines(layer: BrokerageSiteContextLayer): string[] {
  if (layer.status !== "ok" || !layer.payload) {
    return layer.summary ? [layer.summary] : [];
  }

  if (layer.layerKind === "regrid-parcel") {
    const detail = regridParcelDetailLines(layer.payload);
    return detail.length ? detail : layer.summary ? [layer.summary] : [];
  }
  if (layer.layerKind === "regrid-zoning") {
    const detail = regridZoningDetailLines(layer.payload);
    return detail.length ? detail : layer.summary ? [layer.summary] : [];
  }
  const summary =
    summarizeFederalPayload(layer.layerKind, layer.payload) ??
    summarizeStatePayload(layer.layerKind, layer.payload);
  return summary ? [summary] : layer.summary ? [layer.summary] : [];
}

/** Plain-text block for Grok prompts (ok layers with field-level Regrid detail). */
export function formatSiteContextForLlm(ctx: BrokerageSiteContext): string {
  const lines: string[] = [];
  for (const layer of ctx.layers) {
    if (layer.status !== "ok") continue;
    const detail = layerDetailLines(layer);
    if (!detail.length) continue;
    const header = `${layer.layerKind} (${layer.provider ?? layer.adapterKey})`;
    lines.push(`- ${header}:`);
    for (const row of detail) {
      lines.push(`  · ${row}`);
    }
  }
  if (!lines.length) return "";
  return ["Site context layers:", ...lines].join("\n");
}
