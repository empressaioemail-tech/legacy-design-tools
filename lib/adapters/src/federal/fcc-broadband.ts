/**
 * FCC Broadband Data Collection (BDC) — federal broadband-availability
 * adapter.
 *
 * Uses the documented BDC v2 "availability at coordinate" JSON
 * endpoint, which accepts a lat/lng and returns one row per
 * fixed-broadband provider serving the BDC fabric location. The call
 * goes through {@link fetchWithRetry} so a transient FCC blip is
 * retried before we surface a row as failed. Output payload shape is
 * unchanged from prior revisions so downstream readers keep working.
 */

import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";
import { fetchWithRetry } from "../retry";

/**
 * BDC v2 published JSON endpoint. Documented at
 * https://broadbandmap.fcc.gov/data-download/nationwide-data — the
 * "location availability" lookup.
 */
const FCC_BDC_AVAILABILITY_ENDPOINT =
  "https://broadbandmap.fcc.gov/nbm/map/api/published/location/availability";
const FCC_BROADBAND_LABEL = "FCC National Broadband Map";

/**
 * Identifying User-Agent for the FCC NBM call. Several public broker
 * endpoints (Apache-fronted) 406 requests without a recognized UA;
 * spelling one out keeps the production call from tripping that gate.
 */
const FCC_BROADBAND_USER_AGENT =
  "smartcity-plan-review/1.0 (+https://prompt-agent-accelerator.replit.app)";

/**
 * Freshness window for the FCC National Broadband Map snapshot.
 *
 * The Broadband DATA Collection (BDC, post-Form 477) publishes new
 * fabric versions every six months (June + December filing windows),
 * and ISP deployment churn between filings can move a parcel from
 * "no fixed broadband" to gigabit fiber. 6 months keeps the warning
 * aligned with the publishing cadence — anything older than one BDC
 * cycle is the auditable sweet spot for "you should re-run this".
 */
export const FCC_BROADBAND_FRESHNESS_THRESHOLD_MONTHS = 6;

function federalApplies(ctx: AdapterContext): boolean {
  return ctx.jurisdiction.stateKey !== null;
}

function nowIso(): string {
  return new Date().toISOString();
}

interface FccProviderRow {
  provider: string | null;
  technologyCode: number | null;
  maxAdvertisedDownstreamMbps: number | null;
  maxAdvertisedUpstreamMbps: number | null;
  isResidential: boolean | null;
}

/** Coerce a number from either a number or stringified-number field. */
function pickNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Translate one BDC availability row (or one ArcGIS feature attribute
 * bag, kept for backward-compat with any cached envelopes still in
 * the ArcGIS shape) into the normalized provider record the briefing
 * engine consumes.
 *
 * BDC v2 ships fields like `brand_name`, `technology` /
 * `technology_code`, `max_advertised_download_speed`,
 * `max_advertised_upload_speed`, and `low_latency`. The legacy ArcGIS
 * shape used `BrandName`, `TechCode`, `MaxAdDown`, `MaxAdUp`,
 * `LowLatency`, `Residential`. We accept both so a partial rollout
 * (or a cached row from before this task landed) keeps decoding.
 */
function toProviderRow(attrs: Record<string, unknown>): FccProviderRow {
  const provider =
    pickString(attrs.brand_name) ??
    pickString(attrs.BrandName) ??
    pickString(attrs.provider_name);
  const technologyCode =
    pickNumber(attrs.technology_code) ??
    pickNumber(attrs.TechCode) ??
    pickNumber(attrs.technology);
  const down =
    pickNumber(attrs.max_advertised_download_speed) ??
    pickNumber(attrs.MaxAdDown) ??
    pickNumber(attrs.max_down);
  const up =
    pickNumber(attrs.max_advertised_upload_speed) ??
    pickNumber(attrs.MaxAdUp) ??
    pickNumber(attrs.max_up);
  let isResidential: boolean | null = null;
  if (typeof attrs.low_latency === "boolean") isResidential = attrs.low_latency;
  else if (typeof attrs.LowLatency === "boolean") isResidential = attrs.LowLatency;
  else if (typeof attrs.Residential === "number") isResidential = attrs.Residential === 1;
  else if (typeof attrs.residential === "number") isResidential = attrs.residential === 1;
  return {
    provider,
    technologyCode,
    maxAdvertisedDownstreamMbps: down,
    maxAdvertisedUpstreamMbps: up,
    isResidential,
  };
}

/**
 * Walk the BDC envelope's nested shapes and return the flat list of
 * provider attribute bags. BDC v2 returns `{ data: [...] }` for the
 * primary contract; we also accept `{ providers: [...] }` and the
 * legacy ArcGIS `{ features: [{ attributes: {...} }] }` envelope so
 * cached rows and any future contract shifts both decode.
 */
function extractProviderAttrs(
  envelope: unknown,
): Record<string, unknown>[] {
  if (!envelope || typeof envelope !== "object") return [];
  const env = envelope as {
    data?: unknown;
    providers?: unknown;
    features?: unknown;
  };
  if (Array.isArray(env.data)) {
    return env.data.filter(
      (r): r is Record<string, unknown> =>
        Boolean(r) && typeof r === "object",
    );
  }
  if (Array.isArray(env.providers)) {
    return env.providers.filter(
      (r): r is Record<string, unknown> =>
        Boolean(r) && typeof r === "object",
    );
  }
  if (Array.isArray(env.features)) {
    return env.features
      .map((f) => (f as { attributes?: unknown }).attributes)
      .filter(
        (a): a is Record<string, unknown> =>
          Boolean(a) && typeof a === "object",
      );
  }
  return [];
}

export const fccBroadbandAdapter: Adapter = {
  adapterKey: "fcc:broadband",
  tier: "federal",
  sourceKind: "federal-adapter",
  layerKind: "fcc-broadband-availability",
  provider: "FCC National Broadband Map",
  jurisdictionGate: {},
  appliesTo: federalApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const url = new URL(FCC_BDC_AVAILABILITY_ENDPOINT);
    url.searchParams.set("lat", String(ctx.parcel.latitude));
    url.searchParams.set("lng", String(ctx.parcel.longitude));

    const { response: res, attempts } = await fetchWithRetry(
      url.toString(),
      {
        signal: ctx.signal,
        // Apache front doors (and the FCC NBM tile server in particular)
        // 406 requests without a recognized `User-Agent`. Spell both UA
        // and Accept out so Node fetch's defaults don't trigger that gate.
        headers: {
          "User-Agent": FCC_BROADBAND_USER_AGENT,
          Accept: "application/json, */*;q=0.1",
        },
      },
      {
        fetchImpl: ctx.fetchImpl,
        signal: ctx.signal,
        upstreamLabel: FCC_BROADBAND_LABEL,
      },
    );
    if (!res.ok) {
      throw new AdapterRunError(
        "upstream-error",
        `FCC National Broadband Map responded with HTTP ${res.status} after ${attempts} attempt${attempts === 1 ? "" : "s"}. Use Force refresh to retry.`,
      );
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new AdapterRunError(
        "parse-error",
        `FCC NBM response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const rows = extractProviderAttrs(json);
    if (rows.length === 0) {
      return {
        adapterKey: this.adapterKey,
        tier: this.tier,
        layerKind: this.layerKind,
        sourceKind: this.sourceKind,
        provider: this.provider,
        snapshotDate: nowIso(),
        payload: {
          kind: "broadband-availability",
          providerCount: 0,
          fastestDownstreamMbps: null,
          fastestUpstreamMbps: null,
          providers: [],
        },
        note: "FCC reports no fixed-broadband deployment at this location.",
      };
    }
    const providers = rows.map(toProviderRow);
    const downs = providers
      .map((p) => p.maxAdvertisedDownstreamMbps)
      .filter((n): n is number => typeof n === "number");
    const ups = providers
      .map((p) => p.maxAdvertisedUpstreamMbps)
      .filter((n): n is number => typeof n === "number");
    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: {
        kind: "broadband-availability",
        providerCount: providers.length,
        fastestDownstreamMbps: downs.length > 0 ? Math.max(...downs) : null,
        fastestUpstreamMbps: ups.length > 0 ? Math.max(...ups) : null,
        providers,
      },
    };
  },
};
