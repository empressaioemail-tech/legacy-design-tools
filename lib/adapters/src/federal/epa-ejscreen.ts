/**
 * EPA EJScreen — federal environmental-justice screening adapter.
 *
 * EPA EJScreen publishes block-group level environmental + demographic
 * indicators. The current public broker endpoint is
 * `https://ejscreen.epa.gov/mapper/ejscreenRESTbroker3.aspx` (the
 * legacy `ejscreenRESTbroker.aspx` was deprecated in 2023). It accepts
 * a point geometry and returns a JSON envelope with the indicators for
 * the enclosing block group (population, demographic index, key
 * pollution percentiles).
 *
 * The broker's response shape is awkward (it nests the indicators
 * inside `data.main` as named fields) so we surface the raw envelope
 * verbatim plus a normalized subset the briefing engine reads first.
 *
 * Calls go through {@link fetchWithRetry} so transient broker
 * hiccups are not surfaced as a hard failure on the first try.
 */

import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";
import { fetchWithRetry } from "../retry";

const EPA_EJSCREEN_BROKER =
  "https://ejscreen.epa.gov/mapper/ejscreenRESTbroker3.aspx";
const EPA_EJSCREEN_LABEL = "EPA EJScreen";

/**
 * Freshness window for the EPA EJScreen snapshot.
 *
 * EJScreen is rebuilt roughly annually, after the Census/ACS five-year
 * sample it draws demographics from is republished and the EPA's
 * pollution model layers (PM2.5, ozone, NATA) are refreshed. 18 months
 * gives the architect a buffer past the typical annual cycle so a row
 * isn't tagged stale during the brief overlap when EJScreen has
 * announced an update but the adapter cache hasn't rerun yet.
 */
export const EPA_EJSCREEN_FRESHNESS_THRESHOLD_MONTHS = 18;

function federalApplies(ctx: AdapterContext): boolean {
  return ctx.jurisdiction.stateKey !== null;
}

function nowIso(): string {
  return new Date().toISOString();
}

export const epaEjscreenAdapter: Adapter = {
  adapterKey: "epa:ejscreen",
  tier: "federal",
  sourceKind: "federal-adapter",
  layerKind: "epa-ejscreen-blockgroup",
  provider: "EPA EJScreen",
  jurisdictionGate: {},
  appliesTo: federalApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const url = new URL(EPA_EJSCREEN_BROKER);
    url.searchParams.set("namespace", "EJScreen");
    url.searchParams.set(
      "geometry",
      JSON.stringify({
        spatialReference: { wkid: 4326 },
        x: ctx.parcel.longitude,
        y: ctx.parcel.latitude,
      }),
    );
    // Broker3 contract: distance in `unit` (9035 = meters). 1m keeps
    // the lookup pinned to the enclosing block group without pulling
    // adjacent geographies.
    url.searchParams.set("distance", "1");
    url.searchParams.set("unit", "9035");
    url.searchParams.set("areatype", "blockgroup");
    url.searchParams.set("f", "pjson");

    const { response: res, attempts } = await fetchWithRetry(
      url.toString(),
      { signal: ctx.signal },
      {
        fetchImpl: ctx.fetchImpl,
        signal: ctx.signal,
        upstreamLabel: EPA_EJSCREEN_LABEL,
      },
    );
    if (!res.ok) {
      throw new AdapterRunError(
        "upstream-error",
        `EPA EJScreen responded with HTTP ${res.status} after ${attempts} attempt${attempts === 1 ? "" : "s"}. Use Force refresh to retry.`,
      );
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new AdapterRunError(
        "parse-error",
        `EPA EJScreen response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!json || typeof json !== "object") {
      throw new AdapterRunError(
        "parse-error",
        "EPA EJScreen response was not a JSON object",
      );
    }
    // Broker surfaces failures inline as `{ error: "..." }`.
    const errMsg = (json as { error?: unknown }).error;
    if (typeof errMsg === "string" && errMsg.length > 0) {
      throw new AdapterRunError(
        "upstream-error",
        `EPA EJScreen error: ${errMsg}`,
      );
    }
    const data =
      ((json as { data?: unknown }).data as { main?: unknown } | undefined) ??
      undefined;
    const main =
      data && typeof data === "object"
        ? ((data as { main?: unknown }).main as Record<string, unknown> | undefined)
        : undefined;
    // The block-group lookup can come back empty when the point falls
    // in unincorporated land that wasn't included in the EJScreen
    // base layer (rare — the dataset covers all 50 states + DC + PR
    // block groups, but rural edges occasionally miss).
    if (!main || Object.keys(main).length === 0) {
      throw new AdapterRunError(
        "no-coverage",
        "EJScreen returned no block-group indicators at this lat/lng.",
      );
    }
    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: {
        kind: "ejscreen-blockgroup",
        // Surface the most-cited subset the briefing engine reads first.
        // Anything else is still available on `raw` for downstream readers.
        population: pickNumber(main, "RAW_D_POP"),
        demographicIndexPercentile: pickNumber(main, "P_D2_VULEOPCT"),
        pm25Percentile: pickNumber(main, "P_PM25"),
        ozonePercentile: pickNumber(main, "P_OZONE"),
        leadPaintPercentile: pickNumber(main, "P_LDPNT"),
        raw: main,
      },
    };
  },
};

function pickNumber(
  obj: Record<string, unknown>,
  key: string,
): number | null {
  const v = obj[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
