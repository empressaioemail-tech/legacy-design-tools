/**
 * Plain-English summary chips for local-tier adapter payloads.
 *
 * Mirrors the pattern in `../federal/summaries.ts` and `../state/summaries.ts`.
 * Local-tier coverage (current pilot set):
 *   - Grand County, UT (Moab):     parcels, zoning, roads
 *   - Lemhi County, ID (Salmon):   parcels, zoning, roads
 *   - Bastrop County, TX:          parcels, zoning, floodplain
 *
 * The parcel formatter is shared with the state tier (UGRC / INSIDE
 * Idaho parcels emit the same `{ kind: "parcel", parcel: {...} }`
 * shape as the county adapters), so we import it here rather than
 * duplicating it.
 *
 * As with the federal/state formatters:
 *   - every formatter accepts `unknown` and degrades to a "no data"
 *     chip when fields are missing or malformed;
 *   - the dispatcher returns `null` for any layer kind that is not a
 *     local-tier layer.
 */

import {
  isRecord,
  pickFirstString,
  pickNumber,
  pickString,
  ZONING_CODE_KEYS,
  ZONING_DESC_KEYS,
} from "../_payloadSummaryHelpers";
import { summarizeParcelPayload } from "../state/summaries";

/** Layer kinds emitted by the local-tier adapters. */
export type LocalLayerKind =
  | "grand-county-ut-parcels"
  | "grand-county-ut-zoning"
  | "grand-county-ut-roads"
  | "lemhi-county-id-parcels"
  | "lemhi-county-id-zoning"
  | "lemhi-county-id-roads"
  | "bastrop-tx-parcels"
  | "bastrop-tx-zoning"
  | "bastrop-tx-floodplain";

/**
 * Zoning summary used by every county zoning adapter.
 *
 * Payload shape: `{ kind: "zoning", zoning: {attributes, ...} }`.
 * We try a small ranked list of common zoning-code column names and,
 * when present, append the human-readable district name.
 *
 * Examples:
 *   - code + description:  "Zoning R-1 · Single-Family Residential"
 *   - code only:           "Zoning R-1"
 *   - description only:    "Zoning: Single-Family Residential"
 *   - neither:             "Zoning polygon present"
 */
export function summarizeZoningPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "zoning") return null;
  const zoning = payload["zoning"];
  if (!isRecord(zoning)) return "Zoning polygon present";
  const attrs = isRecord(zoning["attributes"]) ? zoning["attributes"] : {};
  const code = pickFirstString(attrs, ZONING_CODE_KEYS);
  const desc = pickFirstString(attrs, ZONING_DESC_KEYS);
  if (code && desc) return `Zoning ${code} · ${desc}`;
  if (code) return `Zoning ${code}`;
  if (desc) return `Zoning: ${desc}`;
  return "Zoning polygon present";
}

/**
 * Roads summary covering both the county-GIS path and the OSM Overpass
 * fallback. The two paths emit different shapes:
 *
 *   - county-gis: `{ kind: "roads", source: "county-gis", features: [...] }`
 *   - osm:        `{ kind: "roads", source: "osm", radiusMeters, elements: [...] }`
 *
 * The chip surfaces the count and (for the OSM fallback) the search
 * radius so the source attribution stays glanceable.
 *
 * Examples:
 *   - county-gis, 3 features:   "3 road segments (county GIS)"
 *   - county-gis, 1 feature:    "1 road segment (county GIS)"
 *   - osm fallback, 2 + 100m:   "2 road segments within 100m (OSM)"
 *   - empty:                    "No roads recorded near this point"
 *   - missing source tag:       "<n> road segments"
 */
export function summarizeRoadsPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "roads") return null;
  const source = pickString(payload["source"]);
  const features = payload["features"];
  const elements = payload["elements"];
  // Count whichever array the producer wrote — the two adapter paths
  // each pick exactly one — falling back to 0 when neither is present.
  let count = 0;
  if (Array.isArray(features)) count = features.length;
  else if (Array.isArray(elements)) count = elements.length;
  if (count <= 0) return "No roads recorded near this point";
  const noun = count === 1 ? "segment" : "segments";
  if (source === "osm") {
    const radius = pickNumber(payload["radiusMeters"]);
    if (radius !== null) {
      return `${count} road ${noun} within ${radius}m (OSM)`;
    }
    return `${count} road ${noun} (OSM)`;
  }
  if (source === "county-gis") {
    return `${count} road ${noun} (county GIS)`;
  }
  return `${count} road ${noun}`;
}

/**
 * Bastrop County floodplain summary.
 *
 * Payload shape: `{ kind: "floodplain", inMappedFloodplain: bool, features: [...] }`.
 * The adapter always emits a row (even when the parcel is outside the
 * mapped floodplain) so the chip needs to express both verdicts. When
 * the parcel is inside the floodplain we surface the FEMA-derived
 * `FLD_ZONE` from the first feature when present.
 *
 * Examples:
 *   - in floodplain w/ zone:   "In mapped floodplain (Zone AE)"
 *   - in floodplain, no zone:  "In mapped floodplain"
 *   - outside floodplain:      "Outside mapped floodplain"
 */
export function summarizeFloodplainPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "floodplain") return null;
  const inFlood = payload["inMappedFloodplain"] === true;
  if (!inFlood) return "Outside mapped floodplain";
  const features = payload["features"];
  if (Array.isArray(features) && features.length > 0) {
    const first = features[0];
    if (isRecord(first)) {
      const attrs = isRecord(first["attributes"]) ? first["attributes"] : {};
      const zone = pickFirstString(attrs, [
        "FLD_ZONE",
        "ZONE",
        "FloodZone",
        "FLOOD_ZONE",
      ]);
      if (zone) return `In mapped floodplain (Zone ${zone})`;
    }
  }
  return "In mapped floodplain";
}

/**
 * Single-entry-point dispatcher used by the Site Context tab. Routes
 * by `layerKind`; returns `null` for any layer kind that is not a
 * local-tier adapter.
 */
export function summarizeLocalPayload(
  layerKind: string,
  payload: unknown,
): string | null {
  switch (layerKind) {
    case "grand-county-ut-parcels":
    case "lemhi-county-id-parcels":
    case "bastrop-tx-parcels":
      return summarizeParcelPayload(payload);
    case "grand-county-ut-zoning":
    case "lemhi-county-id-zoning":
    case "bastrop-tx-zoning":
      return summarizeZoningPayload(payload);
    case "grand-county-ut-roads":
    case "lemhi-county-id-roads":
      return summarizeRoadsPayload(payload);
    case "bastrop-tx-floodplain":
      return summarizeFloodplainPayload(payload);
    default:
      return null;
  }
}
