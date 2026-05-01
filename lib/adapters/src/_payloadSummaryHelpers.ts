/**
 * Tiny payload-shape helpers shared by the state-tier and local-tier
 * summary chip formatters. The federal-tier formatters keep their own
 * inlined helpers (they predate this module) and are intentionally not
 * touched here — the goal is to keep state/local helpers symmetric
 * without forcing a federal refactor in the same change.
 *
 * Every helper accepts `unknown` and returns either a typed value or
 * `null` so the callers can stay defensive: the chip should degrade to
 * "no data" when fields are missing or malformed, never throw.
 */

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function pickString(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return null;
}

export function pickNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Walk a list of candidate keys on a record and return the first one
 * that resolves to a non-empty string. ArcGIS layers expose the same
 * conceptual field under wildly inconsistent column names across
 * jurisdictions (e.g. `PARCEL_ID` vs `PARCELID` vs `PIN` vs `APN`),
 * so each summarizer passes its own ranked list.
 */
export function pickFirstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const k of keys) {
    const v = pickString(record[k]);
    if (v !== null) return v;
  }
  return null;
}

/**
 * Same shape as {@link pickFirstString} but for numeric fields (acres,
 * area, count). Strings that parse cleanly to a finite number are
 * accepted — ArcGIS sometimes wraps numerics as strings in the JSON
 * envelope.
 */
export function pickFirstNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const k of keys) {
    const v = pickNumber(record[k]);
    if (v !== null) return v;
  }
  return null;
}

/**
 * Round acres to two decimals for display in a chip. Sub-acre lots
 * read more naturally with two decimals (0.42 ac), while large parcels
 * still group cleanly (12.34 ac → "12.34 ac"). We avoid `toFixed` for
 * whole acres so a round 5.0 ac reads as "5 ac" not "5.00 ac".
 */
export function formatAcres(acres: number): string {
  if (acres >= 100) {
    // For very large parcels (>= 100 ac), one decimal is plenty and
    // keeps the chip readable.
    const rounded = Math.round(acres * 10) / 10;
    return Number.isInteger(rounded) ? `${rounded} ac` : `${rounded.toFixed(1)} ac`;
  }
  const rounded = Math.round(acres * 100) / 100;
  if (Number.isInteger(rounded)) return `${rounded} ac`;
  // Trim a trailing zero on values like 0.40 → "0.4 ac" so the chip
  // reads naturally.
  const fixed = rounded.toFixed(2);
  return `${fixed.replace(/0$/, "").replace(/\.$/, "")} ac`;
}

/** Common parcel-id column names across the pilot adapters. */
export const PARCEL_ID_KEYS = [
  "PARCEL_ID",
  "PARCELID",
  "PARCEL_NO",
  "PARCEL_NUMBER",
  "PIN",
  "APN",
  "PROP_ID",
] as const;

/** Common acres column names across the pilot adapters. */
export const PARCEL_ACRES_KEYS = [
  "ACRES",
  "Acres",
  "GIS_ACRES",
  "ACREAGE",
  "LotAcres",
  "LOT_ACRES",
] as const;

/** Common zoning-code column names. */
export const ZONING_CODE_KEYS = [
  "ZONE_CODE",
  "ZONING",
  "ZONE",
  "ZONING_CODE",
  "ZONE_TYPE",
  "DISTRICT",
  "ZONE_CLASS",
] as const;

/** Common zoning long-description column names. */
export const ZONING_DESC_KEYS = [
  "ZONE_DESC",
  "ZONING_DESC",
  "DESCRIPTION",
  "ZONE_NAME",
  "ZONE_LABEL",
] as const;
