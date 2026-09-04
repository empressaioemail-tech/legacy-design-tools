/**
 * Envelope jurisdiction helpers.
 *
 * `cityStateFromSitus` keeps a three-part meaning ("street, city, ST zip").
 * City-less CAD situs (two comma parts) is not widened here.
 *
 * When city is missing, `jurisdictionKeyFromParcelNode` is the second
 * derivation: county FIPS from the parcel node plus the already-resolved
 * district, unique among that county's wired city setback tables. Zero or
 * many hits stay null (honest). Not a situs regex.
 */

import { getSetbackTableForZoning } from "@workspace/adapters";
import { wiredZoningCityKeys } from "@workspace/cad-ingest/zoning-layers";
import { mapDistrict } from "./districtMapping";

/**
 * Best-effort city/state from a stored situs string
 * ("300 BLANCO RIVER RD, WIMBERLEY, TX 78676" -> { city: "WIMBERLEY",
 * state: "TX" }). Used to synthesize the setback jurisdiction key when a
 * situs hit resolved WITHOUT a geocode (miss) so there is no geocode
 * city/state. Returns nulls when the shape is not the expected
 * "street, city, ST zip". Never fabricates.
 */
export function cityStateFromSitus(situs: string | null): {
  city: string | null;
  state: string | null;
} {
  if (!situs) return { city: null, state: null };
  const parts = situs.split(",").map((p) => p.trim()).filter(Boolean);
  // Expect [street, city, "ST zip"] (or [street, city, "ST", zip]).
  if (parts.length < 3) return { city: null, state: null };
  const city = parts[1] || null;
  const stateZip = parts.slice(2).join(" ").trim();
  const stateMatch = /\b([A-Za-z]{2})\b/.exec(stateZip);
  const state = stateMatch ? stateMatch[1]!.toUpperCase() : null;
  return { city, state };
}

const FIPS_RE = /^\d{5}$/;

export function countyFipsFromParcelNodeId(
  parcelNodeId: string | null | undefined,
): string | null {
  if (!parcelNodeId) return null;
  const fips = parcelNodeId.split(":")[0]?.trim() ?? "";
  return FIPS_RE.test(fips) ? fips : null;
}

/**
 * Resolve a setback jurisdiction key from the parcel node when city/state
 * is absent. County FIPS comes from the node id; the district is the
 * already-resolved GIS/spine/atom stamp. A table hit counts only when
 * `mapDistrict` matches that stamp (not the conservative no-stamp fallback).
 * Exactly one wired city for that FIPS may hit; otherwise null.
 */
export function jurisdictionKeyFromParcelNode(args: {
  parcelNodeId: string | null | undefined;
  districtCode: string | null | undefined;
}): string | null {
  const district = (args.districtCode ?? "").trim();
  if (!district) return null;
  const fips = countyFipsFromParcelNodeId(args.parcelNodeId);
  if (!fips) return null;

  const hits: string[] = [];
  for (const cityKey of wiredZoningCityKeys(fips)) {
    const table = getSetbackTableForZoning(cityKey, district);
    if (!table?.districts.length) continue;
    const mapped = mapDistrict(table, district);
    if (!mapped || mapped.kind === "fallback-conservative") continue;
    hits.push(table.jurisdictionKey);
  }
  const unique = [...new Set(hits)];
  return unique.length === 1 ? unique[0]! : null;
}
