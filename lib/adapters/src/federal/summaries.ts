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

/**
 * One per-key payload delta surfaced by {@link diffFederalPayload}.
 * `key` is the underlying payload property name (stable, used as a
 * test-id and React key); `label` is the reader-friendly heading the
 * UI shows next to the before/after pair (matches the wording of the
 * inline summary chip — "Flood Zone", "BFE", "Elevation", …).
 */
export interface FederalPayloadFieldChange {
  key: string;
  label: string;
  before: string;
  after: string;
}

interface FederalPayloadField {
  key: string;
  label: string;
  format: (payload: Record<string, unknown>) => string;
}

/**
 * "(none)" mirrors the wording {@link formatBriefingDiffValue} uses
 * for missing metadata fields so the per-key payload reveal reads
 * consistently with the metadata table directly above it.
 */
const NONE = "(none)";

/**
 * Per-layer field readers keyed by `FederalLayerKind`. Each reader
 * pulls one value out of the structured payload and formats it the
 * same way the inline summary chip does (so an architect comparing
 * the rerun delta sees the same units / ordinal suffix / Mbps→Gbps
 * normalization they're already familiar with from the row itself).
 *
 * The list defines the *order* of rows in the "Payload changes"
 * table. Boolean/numeric/string fields are handled inline rather
 * than via a generic `pick*` so a malformed payload (missing key,
 * wrong type) degrades to "(none)" instead of throwing.
 */
const FEDERAL_PAYLOAD_FIELDS: Record<
  FederalLayerKind,
  ReadonlyArray<FederalPayloadField>
> = {
  "fema-nfhl-flood-zone": [
    {
      key: "floodZone",
      label: "Flood Zone",
      format: (p) => pickString(p["floodZone"]) ?? NONE,
    },
    {
      key: "inSpecialFloodHazardArea",
      label: "In SFHA",
      format: (p) => {
        const v = p["inSpecialFloodHazardArea"];
        if (v === true) return "Yes";
        if (v === false) return "No";
        return NONE;
      },
    },
    {
      key: "baseFloodElevation",
      label: "BFE",
      format: (p) => {
        const bfe = pickNumber(p["baseFloodElevation"]);
        return bfe === null ? NONE : `${bfe} ft`;
      },
    },
  ],
  "usgs-ned-elevation": [
    {
      key: "elevationFeet",
      label: "Elevation",
      format: (p) => {
        const elev = pickNumber(p["elevationFeet"]);
        if (elev === null) return NONE;
        const units = pickString(p["units"]) ?? "Feet";
        return formatElevation(elev, units).replace(/^Elevation:\s*/, "");
      },
    },
  ],
  "epa-ejscreen-blockgroup": [
    {
      key: "demographicIndexPercentile",
      label: "EJ Index",
      format: (p) => {
        const v = pickNumber(p["demographicIndexPercentile"]);
        return v === null ? NONE : `${ordinal(v)} pctile`;
      },
    },
    {
      key: "pm25Percentile",
      label: "PM2.5",
      format: (p) => {
        const v = pickNumber(p["pm25Percentile"]);
        return v === null ? NONE : `${ordinal(v)} pctile`;
      },
    },
  ],
  "fcc-broadband-availability": [
    {
      key: "providerCount",
      label: "Providers",
      format: (p) => {
        const v = pickNumber(p["providerCount"]);
        return v === null ? NONE : String(Math.round(v));
      },
    },
    {
      key: "fastestDownstreamMbps",
      label: "Fastest",
      format: (p) => {
        const v = pickNumber(p["fastestDownstreamMbps"]);
        return v === null ? NONE : formatMbps(v);
      },
    },
  ],
};

function isFederalLayerKind(kind: string): kind is FederalLayerKind {
  return Object.prototype.hasOwnProperty.call(
    FEDERAL_PAYLOAD_FIELDS,
    kind,
  );
}

/**
 * Diff a prior federal-adapter payload against the current row's
 * payload, returning one {@link FederalPayloadFieldChange} per
 * payload key whose formatted value moved between the two reruns.
 *
 * Returns `null` (caller skips the "Payload changes" subsection)
 * when:
 *
 *   - `layerKind` is not a federal-tier adapter (state/local rows
 *     have less standardized payloads — see the task #211 brief);
 *   - either side's payload is not an object (manual-upload rows
 *     default to `{}` and would still be objects, but this guards
 *     against a producer accidentally writing a scalar);
 *   - the two payload `kind` discriminants differ — comparing a
 *     `flood-zone` payload against an `elevation-point` payload
 *     would emit a wall of garbage rows. A producer that has
 *     legitimately changed the payload `kind` between reruns
 *     should be looked at via the existing "View layer details"
 *     expander, not the rerun-delta surface.
 *
 * Returns an empty array when the kinds match and every key
 * formats to the same string (a true byte-identical rerun) — the
 * caller should then suppress the subsection so an architect
 * isn't shown an empty "Payload changes" heading.
 *
 * Otherwise returns one entry per moved key, in the order the
 * field list above declares (matches the order the inline summary
 * chip composes its parts so the reveal reads top-down the same
 * way the chip reads left-to-right).
 */
export function diffFederalPayload(
  layerKind: string,
  priorPayload: unknown,
  currentPayload: unknown,
): FederalPayloadFieldChange[] | null {
  if (!isFederalLayerKind(layerKind)) return null;
  if (!isRecord(priorPayload) || !isRecord(currentPayload)) return null;
  const priorKind = priorPayload["kind"];
  const currentKind = currentPayload["kind"];
  if (typeof priorKind !== "string" || typeof currentKind !== "string") {
    return null;
  }
  if (priorKind !== currentKind) return null;
  const fields = FEDERAL_PAYLOAD_FIELDS[layerKind];
  const changes: FederalPayloadFieldChange[] = [];
  for (const f of fields) {
    const before = f.format(priorPayload);
    const after = f.format(currentPayload);
    if (before !== after) {
      changes.push({ key: f.key, label: f.label, before, after });
    }
  }
  return changes;
}
