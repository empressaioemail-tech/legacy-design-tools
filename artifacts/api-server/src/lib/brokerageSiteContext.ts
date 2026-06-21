/**
 * Property Brief site-context layers — federal environmental + Cotality
 * investor depth for the Chrome extension wedge (no engagement /
 * briefing_sources row).
 *
 * Read order: permanent place_layer_snapshots → adapter_response_cache
 * (via runAdapters cache) → live upstream.
 *
 * Regrid was purged 2026-06-17 — Cotality is the sole national parcel spine.
 */

import {
  runAdapters,
  resolveJurisdiction,
  pickFirstString,
  type Adapter,
  type AdapterRunOutcome,
  type AdapterResult,
} from "@workspace/adapters";
import { summarizeFederalPayload } from "@workspace/adapters/federal/summaries";
import { summarizeStatePayload } from "@workspace/adapters/state/summaries";
import type { ReadContract } from "@hauska/atom-contract/read-contract";
import type { EngineHonesty } from "@workspace/engine-core";
import {
  legacyHonestyToReadContract,
  readContractForWire,
} from "@workspace/engine-core";
import { createAdapterResponseCache } from "./adapterCache";
import { placeKeyFromCoords } from "./placeLayerUtils";
import {
  readPlaceLayerSnapshot,
  writePlaceLayerSnapshot,
} from "./placeLayerSnapshots";
import {
  adaptersForInvestorTier,
  depthMeterAllowance,
  isMeteredCotalityAdapter,
  resolveInvestorPackageTier,
  type InvestorPackageTier,
} from "./brokerageTierGate";

/** Wall-clock budget for one brief site-context fetch (all adapters). */
export const BROKERAGE_SITE_CONTEXT_TIMEOUT_MS = 45_000;

const COTALITY_PARCEL_ID_KEYS = [
  "parcelnumb",
  "parcelnum",
  "apn",
  "APN",
  "clip",
] as const;

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
  /** Sealed envelope honesty slice per layer (vintage + confidence). */
  engineHonesty?: EngineHonesty | null;
  /** F4 read-contract — authoritative widthed confidence surface. */
  readContract?: ReadContract | null;
}

export interface BrokerageSiteContext {
  layers: BrokerageSiteContextLayer[];
  placeKey: string;
  parcelClip?: string | null;
  packageTier?: InvestorPackageTier;
}

export interface FetchBrokerageSiteContextInput {
  latitude: number;
  longitude: number;
  address?: string;
  jurisdictionCity?: string | null;
  jurisdictionState?: string | null;
  packageTier?: InvestorPackageTier | null;
  brokerageAuthTier?: "operator" | "extension_public" | "user" | null;
  depthMeterRemaining?: number | null;
  /** W4 — warming mode: Cotality from snapshots only; no live Cotality upstream. */
  snapshotsOnly?: boolean;
}

function layerHonestyFromPayload(
  payload: Record<string, unknown> | undefined,
  adapterKey: string,
): EngineHonesty | null {
  if (!payload) return null;
  const vintage =
    typeof payload.snapshotDate === "string"
      ? payload.snapshotDate
      : typeof payload.retrievedAt === "string"
        ? payload.retrievedAt
        : null;
  return {
    confidence: { value: 0.72, kind: "asserted" },
    dataVintage: vintage,
    coverage: { degraded: false },
    source: { adapter: adapterKey },
  };
}

function summarizeCotalityPayload(
  layerKind: string,
  payload: Record<string, unknown>,
): string | null {
  const clip = payload.clip;
  if (layerKind === "cotality-parcel") {
    const parcel = payload.parcel as
      | { properties?: Record<string, unknown> }
      | undefined;
    const apn = pickFirstString(parcel?.properties ?? {}, COTALITY_PARCEL_ID_KEYS);
    const parts = ["Parcel polygon mapped"];
    if (apn) parts.push(`APN ${apn}`);
    if (clip) parts.push(`CLIP ${clip}`);
    return parts.join(" · ");
  }
  if (layerKind === "cotality-zoning") {
    const zoning = payload.zoning as
      | { properties?: Record<string, unknown> }
      | undefined;
    const code = pickFirstString(zoning?.properties ?? {}, [
      "zoning",
      "zoningCode",
      "code",
    ]);
    const desc = pickFirstString(zoning?.properties ?? {}, [
      "zoning_description",
      "zoningDescription",
      "description",
    ]);
    if (code && desc) return `${code} — ${desc}`;
    return code ?? desc ?? "Zoning from Cotality site-location";
  }
  if (layerKind === "cotality-property") {
    return "Owner, sale, tax, AVM, comparables, and transaction history (cited)";
  }
  if (layerKind === "cotality-rent-avm") {
    return "Rent AVM + rental trend cite (not an opinion of value)";
  }
  if (layerKind === "cotality-liens-mortgage-tax") {
    const mud = payload.mudPidAssessment as
      | { mudPidDetected?: boolean }
      | undefined;
    if (mud?.mudPidDetected) {
      return "Tax/liens cite — MUD/PID special-district assessment flags present";
    }
    return "Liens, mortgage, and tax assessment cite";
  }
  if (layerKind === "cotality-permits") {
    return "Building permits on this parcel (underwriting depth)";
  }
  if (layerKind === "cotality-propensity") {
    return "Propensity scores (underwriting depth, not a lead feed)";
  }
  if (layerKind === "cotality-owner-occupancy") {
    return "Owner-occupancy / absentee indicator (underwriting depth)";
  }
  if (layerKind === "cotality-climate" || layerKind === "cotality-hazards") {
    return "Modeled peril / flood depth at return periods (FEMA stays free baseline)";
  }
  if (layerKind === "cotality-replacement-cost") {
    return "Replacement cost cite for insurance math";
  }
  if (layerKind === "cotality-sinkhole") {
    return "Karst / sinkhole integrated risk cite";
  }
  if (layerKind === "cotality-foundation") {
    return "Foundation type cite (insurability depth)";
  }
  if (layerKind === "opportunity-zone") {
    const inOz = payload.inOpportunityZone === true;
    const tract = payload.tractGeoid;
    const round = payload.ozRound ?? "oz-1.0";
    return inOz
      ? `In OZ tract ${tract ?? "unknown"} (${round})`
      : `Not in OZ (${round} list)`;
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
    summarizeCotalityPayload(layerKind, payload)
  );
}

function adapterSourceKind(adapter: Adapter): AdapterResult["sourceKind"] {
  if (adapter.adapterKey.startsWith("cotality:")) return "national-aggregator";
  if (adapter.adapterKey.startsWith("national:")) return "federal-adapter";
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
    const engineHonesty = layerHonestyFromPayload(
      result.payload,
      outcome.adapterKey,
    );
    return {
      ...base,
      status: "ok",
      provider: result.provider,
      summary: layerSummary(result.layerKind, result.payload),
      snapshotDate: result.snapshotDate,
      payload: result.payload,
      engineHonesty,
      readContract: engineHonesty
        ? readContractForWire(legacyHonestyToReadContract(engineHonesty))
        : null,
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

function applyDepthMeter(
  adapters: readonly Adapter[],
  depthMeterRemaining: number | null | undefined,
): readonly Adapter[] {
  if (depthMeterRemaining == null) return adapters;
  let budget = depthMeterRemaining;
  return adapters.filter((a) => {
    if (!isMeteredCotalityAdapter(a.adapterKey)) return true;
    if (budget <= 0) return false;
    budget -= 1;
    return true;
  });
}

export function brokerageSiteContextAdapters(
  tier: InvestorPackageTier = "free",
): readonly Adapter[] {
  return adaptersForInvestorTier(tier);
}

/** Extension / workspace read — omits GeoJSON-scale `payload` blobs. */
export function stripSiteContextForClient(
  ctx: BrokerageSiteContext,
): BrokerageSiteContext {
  return {
    placeKey: ctx.placeKey,
    parcelClip: ctx.parcelClip,
    packageTier: ctx.packageTier,
    layers: ctx.layers.map(({ payload: _payload, ...layer }) => layer),
  };
}

/** Strip layer payloads from a stored brief run payload before API response. */
export function stripBriefPayloadForClient<T extends Record<string, unknown>>(
  brief: T,
): T {
  const raw = brief.siteContext;
  if (!raw || typeof raw !== "object") return brief;
  return {
    ...brief,
    siteContext: stripSiteContextForClient(raw as BrokerageSiteContext),
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

  const packageTier = resolveInvestorPackageTier({
    tier: input.packageTier,
    brokerageAuthTier: input.brokerageAuthTier,
  });

  let adapters = brokerageSiteContextAdapters(packageTier);
  adapters = applyDepthMeter(adapters, input.depthMeterRemaining ?? depthMeterAllowance(packageTier));

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
  const adaptersToFetchLive = input.snapshotsOnly
    ? missingAdapters.filter((a) => !isMeteredCotalityAdapter(a.adapterKey))
    : missingAdapters;

  if (adaptersToFetchLive.length > 0) {
    const cache = createAdapterResponseCache();
    const budgetAc = new AbortController();
    const budgetTimer = setTimeout(
      () => budgetAc.abort(),
      BROKERAGE_SITE_CONTEXT_TIMEOUT_MS,
    );
    try {
      liveOutcomes = await runAdapters({
        adapters: [...adaptersToFetchLive],
        context: {
          parcel: {
            latitude,
            longitude,
            address: input.address ?? null,
            city: input.jurisdictionCity ?? null,
            state: input.jurisdictionState ?? null,
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
      liveOutcomes.find((o) => o.adapterKey === a.adapterKey) ??
      (input.snapshotsOnly && isMeteredCotalityAdapter(a.adapterKey)
        ? {
            adapterKey: a.adapterKey,
            tier: a.tier,
            layerKind: a.layerKind,
            status: "no-coverage" as const,
            error: {
              code: "no-coverage" as const,
              message: "W4: no snapshot — live Cotality disabled during warming",
            },
          }
        : {
            adapterKey: a.adapterKey,
            tier: a.tier,
            layerKind: a.layerKind,
            status: "failed" as const,
            error: {
              code: "unknown" as const,
              message: "No layer outcome",
            },
          })
    );
  });

  const layers = mergedOutcomes.map((o) =>
    outcomeToLayer(o, { fromArchive: archived.has(o.adapterKey) }),
  );

  let parcelClip: string | null = null;
  for (const layer of layers) {
    if (layer.status !== "ok" || !layer.payload) continue;
    const clip = layer.payload.clip;
    if (typeof clip === "string" && clip.trim()) {
      parcelClip = clip.trim();
      break;
    }
  }

  return {
    placeKey,
    parcelClip,
    packageTier,
    layers,
  };
}

function layerDetailLines(layer: BrokerageSiteContextLayer): string[] {
  if (layer.status !== "ok" || !layer.payload) {
    return layer.summary ? [layer.summary] : [];
  }
  const summary =
    layer.summary ??
    layerSummary(layer.layerKind, layer.payload) ??
    null;
  return summary ? [summary] : [];
}

/** Plain-text block for Grok prompts (ok layers with Cotality/federal summaries). */
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

/** Site layers + uploaded private restrictions for Property Brief LLM prompts. */
export function formatBrokerageContextForLlm(input: {
  siteContext?: BrokerageSiteContext;
  privateRestrictionsBlock?: string;
}): string {
  const parts = [
    input.siteContext ? formatSiteContextForLlm(input.siteContext) : "",
    input.privateRestrictionsBlock ?? "",
  ].filter(Boolean);
  return parts.join("\n\n");
}
