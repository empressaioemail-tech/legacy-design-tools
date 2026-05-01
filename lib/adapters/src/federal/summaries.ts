/**
 * Plain-English summary chips for federal-tier adapter payloads.
 *
 * The Site Context tab renders one row per persisted `briefing_sources`
 * record. The federal adapters in this directory each persist a small
 * structured payload (FEMA flood-zone code, USGS elevation, EPA
 * EJScreen percentiles, FCC broadband tiers) but the row UI only
 * renders the layer kind + provider by default — reviewers had to
 * expand "View layer details" to see the actual reading.
 *
 * These formatters produce a single short string suitable for a chip
 * shown inline on the row (e.g. "Flood Zone: AE", "Elevation: 4,033 ft",
 * "EJ Index 65th pctile", "Up to 1 Gbps · 2 providers"). They:
 *
 *   - never throw — every formatter accepts `unknown` and degrades to
 *     a "no data" string when fields are missing or malformed;
 *   - return `null` when there is genuinely nothing to summarize so
 *     the caller can choose to omit the chip entirely;
 *   - mirror the adapter `note` semantics for the "no coverage" cases
 *     (e.g. FEMA's empty-features path → "No mapped flood risk").
 *
 * The shared {@link summarizeFederalPayload} entry point routes by
 * `layerKind` so callers don't have to import each formatter
 * individually. Unknown layer kinds return `null` (FE falls back to
 * its existing rendering).
 */

/**
 * Layer kinds emitted by the federal adapters in this directory. We
 * keep this aligned with the `layerKind` field on each adapter; if a
 * new federal adapter ships, add its kind here so the registry
 * picks it up.
 */
export type FederalLayerKind =
  | "fema-nfhl-flood-zone"
  | "usgs-ned-elevation"
  | "epa-ejscreen-blockgroup"
  | "fcc-broadband-availability";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickString(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return null;
}

/**
 * Format a number as an ordinal percentile (e.g. 1 → "1st", 22 → "22nd",
 * 87 → "87th"). The EJScreen percentiles are integers in 0-100 so we
 * round to the nearest integer before applying the suffix.
 */
function ordinal(n: number): string {
  const rounded = Math.round(n);
  const mod100 = rounded % 100;
  const mod10 = rounded % 10;
  let suffix = "th";
  if (mod100 < 11 || mod100 > 13) {
    if (mod10 === 1) suffix = "st";
    else if (mod10 === 2) suffix = "nd";
    else if (mod10 === 3) suffix = "rd";
  }
  return `${rounded}${suffix}`;
}

/**
 * Format an Mbps reading as either "N Mbps" or, for 1000+, "N Gbps"
 * (with one decimal when the value isn't a whole gigabit). Keeps the
 * chip readable for fiber tiers that report 1000/2000/5000 Mbps.
 */
function formatMbps(mbps: number): string {
  if (mbps >= 1000) {
    const gbps = mbps / 1000;
    const rounded = Number.isInteger(gbps) ? gbps : Number(gbps.toFixed(1));
    return `${rounded} Gbps`;
  }
  return `${Math.round(mbps)} Mbps`;
}

/**
 * Format an elevation reading. We round to the nearest foot/meter for
 * the chip (the architect can open "View layer details" for the
 * full-precision reading) and group thousands so a 4-digit elevation
 * stays glanceable.
 */
function formatElevation(value: number, units: string): string {
  const rounded = Math.round(value);
  const grouped = rounded.toLocaleString("en-US");
  // Normalize the most common unit strings EPQS ships ("Feet", "Meters")
  // to short forms; pass anything else through verbatim so an unfamiliar
  // unit string isn't silently dropped.
  const normalized =
    units.toLowerCase() === "feet"
      ? "ft"
      : units.toLowerCase() === "meters"
        ? "m"
        : units;
  return `Elevation: ${grouped} ${normalized}`;
}

/**
 * FEMA National Flood Hazard Layer summary.
 *
 * Examples:
 *   - in SFHA with BFE:  "Flood Zone AE · BFE 425.5 ft"
 *   - in SFHA, no BFE:   "Flood Zone AE (high-risk)"
 *   - mapped, not SFHA:  "Flood Zone X"
 *   - empty features:    "No mapped flood risk (Zone X)"
 */
export function summarizeFemaNfhlPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "flood-zone") return null;
  const zone = pickString(payload["floodZone"]);
  const inSfha = payload["inSpecialFloodHazardArea"] === true;
  const bfe = pickNumber(payload["baseFloodElevation"]);
  if (!zone) {
    // Adapter emits a row with `floodZone: null` for parcels that fall
    // outside any mapped flood polygon; mirror its `note` wording so
    // the row reads consistently.
    return "No mapped flood risk (Zone X)";
  }
  if (inSfha) {
    if (bfe !== null) {
      return `Flood Zone ${zone} · BFE ${bfe} ft`;
    }
    return `Flood Zone ${zone} (high-risk)`;
  }
  return `Flood Zone ${zone}`;
}

/**
 * USGS National Elevation Dataset summary.
 *
 * Examples:
 *   - normal reading:    "Elevation: 4,033 ft"
 *   - off-raster (null): "Elevation: not available (off-raster)"
 */
export function summarizeUsgsNedPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "elevation-point") return null;
  const elevation = pickNumber(payload["elevationFeet"]);
  if (elevation === null) {
    return "Elevation: not available (off-raster)";
  }
  const units = pickString(payload["units"]) ?? "Feet";
  return formatElevation(elevation, units);
}

/**
 * EPA EJScreen block-group summary.
 *
 * The full payload exposes several percentiles; the chip leads with
 * the demographic index (the most-cited single number in EJScreen
 * reporting) and tucks the headline pollution percentile (PM2.5)
 * after it when both are present.
 *
 * Examples:
 *   - both present:                    "EJ Index 65th pctile · PM2.5 72nd pctile"
 *   - only demographic index:          "EJ Index 65th pctile"
 *   - only pollution percentile:       "PM2.5 72nd pctile"
 *   - neither:                         "EJScreen indicators unavailable"
 */
export function summarizeEpaEjscreenPayload(
  payload: unknown,
): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "ejscreen-blockgroup") return null;
  const demo = pickNumber(payload["demographicIndexPercentile"]);
  const pm25 = pickNumber(payload["pm25Percentile"]);
  const parts: string[] = [];
  if (demo !== null) parts.push(`EJ Index ${ordinal(demo)} pctile`);
  if (pm25 !== null) parts.push(`PM2.5 ${ordinal(pm25)} pctile`);
  if (parts.length === 0) return "EJScreen indicators unavailable";
  return parts.join(" · ");
}

/**
 * FCC National Broadband Map summary.
 *
 * Examples:
 *   - 2 providers, fastest 1 Gbps:    "Up to 1 Gbps · 2 providers"
 *   - 1 provider, fastest 100 Mbps:   "Up to 100 Mbps · 1 provider"
 *   - providers but no Mbps reading:  "1 provider reported"
 *   - no providers (`providerCount` 0): "No fixed broadband reported"
 */
export function summarizeFccBroadbandPayload(
  payload: unknown,
): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "broadband-availability") return null;
  const providerCount = pickNumber(payload["providerCount"]) ?? 0;
  const fastest = pickNumber(payload["fastestDownstreamMbps"]);
  if (providerCount <= 0) {
    return "No fixed broadband reported";
  }
  const providerLabel = providerCount === 1 ? "provider" : "providers";
  if (fastest !== null) {
    return `Up to ${formatMbps(fastest)} · ${providerCount} ${providerLabel}`;
  }
  return `${providerCount} ${providerLabel} reported`;
}

/**
 * Single-entry-point dispatcher used by the Site Context tab. Routes
 * by `layerKind`; returns `null` for any layer kind that is not a
 * federal-tier adapter (callers should fall back to their existing
 * rendering for those rows).
 */
export function summarizeFederalPayload(
  layerKind: string,
  payload: unknown,
): string | null {
  switch (layerKind) {
    case "fema-nfhl-flood-zone":
      return summarizeFemaNfhlPayload(payload);
    case "usgs-ned-elevation":
      return summarizeUsgsNedPayload(payload);
    case "epa-ejscreen-blockgroup":
      return summarizeEpaEjscreenPayload(payload);
    case "fcc-broadband-availability":
      return summarizeFccBroadbandPayload(payload);
    default:
      return null;
  }
}
