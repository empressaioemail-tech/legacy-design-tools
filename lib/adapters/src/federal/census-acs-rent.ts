/**
 * Census ACS median gross rent (table B25064) — free public federal
 * AREA-LEVEL rent data, tract granularity.
 *
 * COMMITMENT-#1 BOUNDARY (operator-resolved, R1 SPLIT). This adapter
 * fetches AREA estimates only — the ACS 5-year median gross rent for a
 * census tract. It is NOT a per-parcel or market-asking rent source.
 * ACS B25064 is *in-place* gross rent (contract rent + tenant-paid
 * utilities) across all currently-occupied renter households in the
 * tract; it lags the market and reads BELOW current asking rents
 * because it averages leases signed over prior years. Every consumer
 * of this data MUST carry the disclosure string
 * {@link ACS_RENT_DISCLOSURE} plus the source citation — a parcel
 * painted with a tract average without that disclosure is a
 * commitment-#1 violation.
 *
 * HARD PROHIBITION. Do NOT extend this module to fetch, join, or
 * proxy any per-parcel or market-asking rent value, and do NOT wire
 * any commercial rent vendor (RentCast, HelloData, Zillow ZORI,
 * Cotality rent-AVM, etc.) through it. Those are operator-owned and
 * blocked pending written vendor terms.
 *
 * DATA ACCESS. The Census Data API requires an API key
 * (`CENSUS_API_KEY`). When the key is absent the fetch is skipped and
 * the caller renders geometry with a null rent value + an explicit
 * "operator data-pull required" degraded flag, never a fabricated
 * number. Key signup: https://api.census.gov/data/key_signup.html
 */

import { AdapterRunError } from "../types";
import { fetchWithRetry } from "../retry";

const ACS_USER_AGENT =
  "smartcity-plan-review/1.0 (+https://cortex.empressa.io)";

/**
 * Default ACS 5-year vintage. The B25064 estimate is a 5-year rolling
 * average; the vintage year names the terminal year of that window.
 * Overridable via `ACS_RENT_VINTAGE` so an operator can bump the
 * vintage without a redeploy when a newer ACS release lands.
 */
export const ACS_RENT_DEFAULT_VINTAGE = 2023;

/** ACS detailed table: median gross rent (dollars). */
export const ACS_RENT_TABLE = "B25064";
const ACS_RENT_ESTIMATE_VAR = "B25064_001E";
const ACS_RENT_MOE_VAR = "B25064_001M";

/**
 * MANDATORY honesty disclosure. Every rendered surface and the layer
 * payload MUST carry this string. It is the reason the layer is
 * allowed to ship: it prevents an area average being read as a
 * property-level market rent.
 */
export const ACS_RENT_DISCLOSURE =
  "area estimate, not property-level market rent";

export function acsRentVintage(): number {
  const raw = process.env.ACS_RENT_VINTAGE?.trim();
  if (raw && /^\d{4}$/.test(raw)) return Number(raw);
  return ACS_RENT_DEFAULT_VINTAGE;
}

export function censusApiKey(): string | null {
  const raw = process.env.CENSUS_API_KEY?.trim();
  return raw && raw.length > 0 ? raw : null;
}

/** Source citation string for the ACS B25064 tract layer. */
export function acsRentSourceCitation(vintage = acsRentVintage()): string {
  return `U.S. Census Bureau, American Community Survey ${vintage} 5-Year Estimates, table ${ACS_RENT_TABLE} (median gross rent), tract level`;
}

export interface AcsTractRent {
  /** 11-digit tract GEOID (state+county+tract). */
  geoid: string;
  /** Median gross rent in dollars, or null when ACS suppressed it. */
  medianGrossRent: number | null;
  /** Margin of error (dollars) on the estimate, or null. */
  marginOfError: number | null;
}

/**
 * Coerce an ACS numeric cell. ACS uses negative sentinels
 * (-666666666, -222222222, etc.) for suppressed / not-applicable
 * estimates; those become null, never a painted value.
 */
function acsNumber(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  // ACS jam / suppression sentinels are large negatives.
  if (n <= -100000) return null;
  return n;
}

/**
 * Fetch ACS B25064 median gross rent for every tract in one county.
 * Returns a map keyed by 11-digit tract GEOID.
 *
 * Requires `CENSUS_API_KEY`. Throws `AdapterRunError("unknown")` when
 * the key is absent so the caller can degrade to geometry-only with
 * the operator-data-pull flag rather than fabricating rents. Callers
 * should gate on {@link censusApiKey} first to avoid the throw.
 */
export async function fetchAcsTractRentByCounty(input: {
  stateFips: string;
  countyFips: string;
  vintage?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<Map<string, AcsTractRent>> {
  const key = censusApiKey();
  if (!key) {
    throw new AdapterRunError(
      "unknown",
      "CENSUS_API_KEY is not configured. ACS median gross rent is an operator data-pull; set the key to enable live rent values. Sign up: https://api.census.gov/data/key_signup.html",
    );
  }
  const vintage = input.vintage ?? acsRentVintage();
  const url = new URL(`https://api.census.gov/data/${vintage}/acs/acs5`);
  url.searchParams.set(
    "get",
    `NAME,${ACS_RENT_ESTIMATE_VAR},${ACS_RENT_MOE_VAR}`,
  );
  url.searchParams.set("for", "tract:*");
  url.searchParams.set(
    "in",
    `state:${input.stateFips} county:${input.countyFips}`,
  );
  url.searchParams.set("key", key);

  const { response: res, attempts, bodyExcerpt, throwExcerpt } =
    await fetchWithRetry(
      url.toString(),
      {
        signal: input.signal,
        headers: {
          "User-Agent": ACS_USER_AGENT,
          Accept: "application/json, */*;q=0.1",
        },
      },
      {
        fetchImpl: input.fetchImpl,
        signal: input.signal,
        upstreamLabel: "Census ACS B25064",
        captureThrowsAsResult: true,
      },
    );
  if (!res.ok) {
    if (throwExcerpt) {
      throw new AdapterRunError(
        "network-error",
        `Census ACS did not get a response after ${attempts} attempt${attempts === 1 ? "" : "s"}. Network error: ${throwExcerpt}.`,
      );
    }
    const suffix = bodyExcerpt ? ` Upstream response: ${bodyExcerpt}` : "";
    throw new AdapterRunError(
      "upstream-error",
      `Census ACS responded with HTTP ${res.status} after ${attempts} attempt${attempts === 1 ? "" : "s"}.${suffix}`,
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new AdapterRunError(
      "parse-error",
      `Census ACS response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseAcsTractRentRows(json);
}

/**
 * Parse the ACS matrix response into a GEOID-keyed rent map.
 * The ACS Data API returns a header row followed by data rows; the
 * geography columns (state, county, tract) trail the requested
 * variables. Exported for unit tests (no network).
 */
export function parseAcsTractRentRows(json: unknown): Map<string, AcsTractRent> {
  const out = new Map<string, AcsTractRent>();
  if (!Array.isArray(json) || json.length < 2) return out;
  const header = json[0];
  if (!Array.isArray(header)) return out;
  const idx = (name: string) => header.indexOf(name);
  const iEst = idx(ACS_RENT_ESTIMATE_VAR);
  const iMoe = idx(ACS_RENT_MOE_VAR);
  const iState = idx("state");
  const iCounty = idx("county");
  const iTract = idx("tract");
  if (iEst < 0 || iState < 0 || iCounty < 0 || iTract < 0) return out;

  for (let r = 1; r < json.length; r++) {
    const row = json[r];
    if (!Array.isArray(row)) continue;
    const state = String(row[iState] ?? "").padStart(2, "0");
    const county = String(row[iCounty] ?? "").padStart(3, "0");
    const tract = String(row[iTract] ?? "").padStart(6, "0");
    if (!state || !county || !tract) continue;
    const geoid = `${state}${county}${tract}`;
    out.set(geoid, {
      geoid,
      medianGrossRent: acsNumber(row[iEst]),
      marginOfError: iMoe >= 0 ? acsNumber(row[iMoe]) : null,
    });
  }
  return out;
}
