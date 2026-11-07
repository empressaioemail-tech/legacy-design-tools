/**
 * Publisher ETJ GeoJSON feature -> normalized `tx_etj_boundary` records
 * (feat/p241-etj-acquisition, P-241 acquisition half).
 *
 * Mirrors `boundary/parse.ts`. The differences ETJ forces:
 *
 *   - the identity is the publisher's own object id namespaced by the register
 *     city key (`austin-tx:22`), because ETJ rings have no statewide code;
 *   - the ring label comes from the publisher's own attribute when the layer
 *     carries one, and otherwise from the publisher's layer name. A ring whose
 *     label cannot be established from either is still ingested: the label is
 *     descriptive, and dropping real geometry because a publisher named it
 *     poorly would be worse than keeping it with the layer's own name.
 *     Nothing is ever synthesised from a statute or from a distance formula.
 *   - a feature with no readable object id IS declined: without it there is no
 *     stable key, so a re-ingest could not be idempotent.
 *
 * Field names for every register entry were verified live on 2026-09-16; the
 * `objectIdField` candidates below cover exactly the names those services
 * reported (OBJECTID, FID, objectid, OBJECTID_1) plus the ArcGIS default.
 */

import type { ParseCounters } from "../types";
import { recordSkip } from "../types";
import {
  bboxOfGeometry,
  type GeoBbox,
  type GeoJsonGeometry,
} from "../txgio/geo";
import type { EtjRegistryEntry } from "./etjRegistry";
import type { EtjRawFeature, EtjSourceMetadata } from "./etjService";

/** Object-id attribute names observed across the register's publishers. */
const OBJECT_ID_CANDIDATES = [
  "OBJECTID",
  "objectid",
  "OBJECTID_1",
  "FID",
  "ObjectID",
] as const;

export interface TxEtjBoundaryRecord {
  /** `<cityKey>:<publisher object id>`. */
  etjId: string;
  cityKey: string;
  cityName: string;
  cityGeoId: string | null;
  ringLabel: string;
  geometry: GeoJsonGeometry;
  bbox: GeoBbox;
  /** The publisher's layer URL this ring came from. */
  sourceCitation: string;
}

function str(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : null;
}

function polygonGeometry(
  geometry: unknown,
): GeoJsonGeometry | null {
  if (!geometry || typeof geometry !== "object") return null;
  const g = geometry as { type?: unknown };
  if (g.type === "Polygon" || g.type === "MultiPolygon") {
    return geometry as GeoJsonGeometry;
  }
  return null;
}

/** Read the publisher's object id, preferring the layer's own declaration. */
export function readObjectId(
  attributes: Record<string, unknown>,
  objectIdField: string | null,
): string | null {
  if (objectIdField !== null) {
    const v = str(attributes[objectIdField]);
    if (v !== null) return v;
  }
  for (const candidate of OBJECT_ID_CANDIDATES) {
    const v = str(attributes[candidate]);
    if (v !== null) return v;
  }
  return null;
}

/** The ring's label: publisher's attribute, else the publisher's layer name. */
export function readRingLabel(
  entry: EtjRegistryEntry,
  attributes: Record<string, unknown>,
  metadata: Pick<EtjSourceMetadata, "layerName"> | null,
): string | null {
  const flat = (s: string): string => s.replace(/\s+/g, " ").trim();
  if (entry.labelField !== null) {
    const v = str(attributes[entry.labelField]);
    if (v !== null) return flat(v);
  }
  const layerName = metadata?.layerName ?? null;
  if (layerName !== null) return flat(layerName);
  if (entry.layerNameFallback !== null) return flat(entry.layerNameFallback);
  return null;
}

/**
 * Normalize one publisher ETJ GeoJSON feature. Returns null (and records the
 * decline) when the feature cannot carry a stable identity or bounded
 * geometry.
 */
export function normalizeEtjBoundaryFeature(
  entry: EtjRegistryEntry,
  feature: EtjRawFeature,
  metadata: Pick<EtjSourceMetadata, "layerName" | "objectIdField"> | null,
  counters: ParseCounters,
): TxEtjBoundaryRecord | null {
  const attributes =
    feature.properties && typeof feature.properties === "object"
      ? feature.properties
      : {};

  const objectId = readObjectId(attributes, metadata?.objectIdField ?? null);
  if (objectId === null) {
    recordSkip(
      counters,
      `${entry.cityKey}: feature carries no readable object id ` +
        `(declared ${metadata?.objectIdField ?? "none"})`,
    );
    return null;
  }

  const geometry = polygonGeometry(feature.geometry);
  if (geometry === null) {
    recordSkip(counters, `${entry.cityKey}:${objectId}: no polygon geometry`);
    return null;
  }
  const bbox = bboxOfGeometry(geometry);
  if (bbox === null) {
    recordSkip(counters, `${entry.cityKey}:${objectId}: unbounded geometry`);
    return null;
  }

  const ringLabel = readRingLabel(entry, attributes, metadata);
  if (ringLabel === null) {
    recordSkip(
      counters,
      `${entry.cityKey}:${objectId}: no ring label and no layer name to fall back on`,
    );
    return null;
  }

  return {
    etjId: `${entry.cityKey}:${objectId}`,
    cityKey: entry.cityKey,
    cityName: entry.cityName,
    cityGeoId: entry.cityGeoId,
    ringLabel,
    geometry,
    bbox,
    sourceCitation: entry.layerUrl ?? "",
  };
}
