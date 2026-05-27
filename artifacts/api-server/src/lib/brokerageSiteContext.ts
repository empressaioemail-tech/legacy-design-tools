/**
 * Property Brief site-context layers — FEMA flood + Regrid parcel/zoning
 * for the Chrome extension wedge (no engagement / briefing_sources row).
 */

import {
  runAdapters,
  resolveJurisdiction,
  pickFirstString,
  PARCEL_ID_KEYS,
  ZONING_CODE_KEYS,
  ZONING_DESC_KEYS,
  type AdapterRunOutcome,
} from "@workspace/adapters";
import { femaNfhlAdapter } from "@workspace/adapters/federal/fema-nfhl";
import { summarizeFederalPayload } from "@workspace/adapters/federal/summaries";
import {
  regridParcelsAdapter,
  regridZoningAdapter,
} from "@workspace/adapters/national/regrid";

const BROKERAGE_SITE_CONTEXT_ADAPTERS = [
  femaNfhlAdapter,
  regridParcelsAdapter,
  regridZoningAdapter,
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
  error?: { code: string; message: string };
}

export interface BrokerageSiteContext {
  layers: BrokerageSiteContextLayer[];
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
    const parts: string[] = [];
    if (apn) parts.push(`APN ${apn}`);
    if (acres !== null) parts.push(`${acres.toFixed(2)} ac`);
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
    if (code && desc) return `${code} — ${desc}`;
    return code ?? desc ?? null;
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

function outcomeToLayer(outcome: AdapterRunOutcome): BrokerageSiteContextLayer {
  const base = {
    layerKind: outcome.layerKind,
    adapterKey: outcome.adapterKey,
    tier: outcome.tier,
    status: outcome.status,
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

export async function fetchBrokerageSiteContext(
  input: FetchBrokerageSiteContextInput,
): Promise<BrokerageSiteContext> {
  const { latitude, longitude } = input;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { layers: [] };
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

  const outcomes = await runAdapters({
    adapters: [...BROKERAGE_SITE_CONTEXT_ADAPTERS],
    context: {
      parcel: {
        latitude,
        longitude,
        address: input.address ?? null,
      },
      jurisdiction: { ...jurisdiction, partnerCity },
    },
  });

  return { layers: outcomes.map(outcomeToLayer) };
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
