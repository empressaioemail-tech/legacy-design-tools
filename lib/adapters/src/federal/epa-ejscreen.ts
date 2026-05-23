/**
 * EPA EJScreen — federal environmental-justice screening adapter.
 *
 * STATUS (last swept 2026-05-23): broken upstream. EPA has fully
 * decommissioned the EJScreen public-facing infrastructure — the
 * `ejscreen.epa.gov` host is NXDOMAIN, the `www.epa.gov/ejscreen*`
 * page tree returns HTTP 404, and the broker endpoint this adapter
 * targets (`/mapper/ejscreenRESTbroker3.aspx`) refuses TCP at the
 * decommissioned host. The adapter therefore always fails; the EPA
 * pill renders red in the partnership review UI. No PR is open to
 * swap the URL because no EPA-published v2 successor exists at this
 * time. See _research/2026-05-23_qa22_epa_path1a_cc-agent-C.md for
 * the full dead-end trail.
 *
 * Sweep summary (so a future agent does not re-dig the same ground):
 *   geopub.epa.gov/arcgis/rest/services       — no EJ folder/service
 *   gispub.epa.gov/arcgis/rest/services       — no EJ folder/service
 *   edg.epa.gov/data/PUBLIC/OEI/              — no EJScreen archive
 *   NEPAssist/NEPAVELayersPublic_fgdb         — NAAQS non-attainment
 *                                                polygons only
 *                                                (categorical, not the
 *                                                percentile schema)
 *   ORD/EnvironmentalQualityIndex             — different methodology
 *                                                + different schema
 *   OEI/ACS_Demographics_by_Tract_2008_2012   — stale Census, no
 *                                                pollution layer
 *   EPA Esri Online org search for "EJScreen" — only third-party
 *                                                mirrors of the 2023
 *                                                archive (CalEPA,
 *                                                Delaware FirstMap,
 *                                                small state orgs)
 *
 * Fallback the operator may opt into (NOT enabled here): the
 * CalEPA-hosted archive of the EJScreen 2023 block-group dataset at
 *   services2.arcgis.com/iq8zYa0SRsvIFFKz/.../EJSCREEN_2023_BG_StatePct...
 * preserves all five indicators this adapter previously surfaced
 * (with two field renames: RAW_D_POP→ACSTOTPOP and
 * P_D2_VULEOPCT→P_DEMOGIDX_2). It is a state-agency-hosted mirror,
 * not an EPA endpoint, and its `P_*` fields are state-distribution
 * percentiles rather than the original broker's US percentiles — both
 * are substantive deltas an operator should weigh before adopting.
 *
 * The original broker contract (kept here for reference): accept a
 * point geometry, return a JSON envelope with indicators for the
 * enclosing block group nested at `data.main`, keyed by EJScreen
 * field names (population, demographic index percentile, key
 * pollution percentiles).
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
import { SLOW_UPSTREAM_TIMEOUT_MS } from "../timeouts";

const EPA_EJSCREEN_BROKER =
  "https://ejscreen.epa.gov/mapper/ejscreenRESTbroker3.aspx";
const EPA_EJSCREEN_LABEL = "EPA EJScreen";

/**
 * Identifying User-Agent for the EJScreen broker call. The broker
 * sits behind an IIS/Apache front door that rejects requests without
 * a recognized `User-Agent` (production saw this as `fetch failed`).
 */
const EPA_EJSCREEN_USER_AGENT =
  "smartcity-plan-review/1.0 (+https://cortex.empressa.io)";

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
  // PL-04: federal adapters apply nationwide whenever the engagement is
  // geocoded. See fema-nfhl.ts for the decoupling rationale.
  return (
    Number.isFinite(ctx.parcel.latitude) &&
    Number.isFinite(ctx.parcel.longitude)
  );
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
  // QA-22 — the EJScreen broker routinely answers slower than the 15s
  // runner default; widen this adapter's budget so a slow-but-healthy
  // broker response is not cut off as a `timeout` failure.
  timeoutMs: SLOW_UPSTREAM_TIMEOUT_MS,
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

    const {
      response: res,
      attempts,
      bodyExcerpt,
      throwExcerpt,
    } = await fetchWithRetry(
      url.toString(),
      {
        signal: ctx.signal,
        // EJScreen's broker 406s requests with the default Node fetch
        // headers (production saw this as `fetch failed`). Spell UA +
        // Accept out so the broker accepts the call.
        headers: {
          "User-Agent": EPA_EJSCREEN_USER_AGENT,
          Accept: "application/json, */*;q=0.1",
        },
      },
      {
        fetchImpl: ctx.fetchImpl,
        signal: ctx.signal,
        upstreamLabel: EPA_EJSCREEN_LABEL,
        // QA-22 reopen follow-on — collapse fetch-throws (DNS / TLS /
        // ECONNREFUSED / ECONNRESET) into the `!res.ok` branch below
        // so the pill can name the actual network failure mode.
        // cortex-api-00020-85n showed the EJScreen call failing with
        // "fetch failed" + no body — operator can't pick the
        // mitigation (DNS resolver / NAT egress IP / CA bundle / TLS
        // pin) from that alone.
        captureThrowsAsResult: true,
      },
    );
    if (!res.ok) {
      if (throwExcerpt) {
        // The request never got a response back — DNS resolution, TLS
        // handshake, connection establishment, or stream read failed
        // before the broker's HTTP layer answered. `throwExcerpt`
        // names the underlying failure mode (e.g. `ENOTFOUND
        // getaddrinfo ejscreen.epa.gov`) so the operator can pick
        // the mitigation off the pill alone.
        throw new AdapterRunError(
          "network-error",
          `EPA EJScreen did not get a response after ${attempts} attempt${attempts === 1 ? "" : "s"}. Network error: ${throwExcerpt}. Use Force refresh to retry.`,
        );
      }
      // QA-22 reopen: append the upstream body excerpt so a 503 / 502
      // / 504 from the EJScreen broker surfaces its actual response
      // (maintenance banner, error envelope, empty body) in the
      // layer-failure pill — operators don't need Cloud Run access to
      // tell schema drift from transient flakiness.
      const suffix = bodyExcerpt ? ` Upstream response: ${bodyExcerpt}` : "";
      throw new AdapterRunError(
        "upstream-error",
        `EPA EJScreen responded with HTTP ${res.status} after ${attempts} attempt${attempts === 1 ? "" : "s"}.${suffix} Use Force refresh to retry.`,
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
