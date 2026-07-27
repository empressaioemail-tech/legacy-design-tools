/**
 * Zoning GIS provenance for Tier-1 snapshots (COMPLETE-BASTROP A1 / S-01/S-02).
 *
 * District FACTS come from the city AGOL layer registered in ZONING_LAYERS
 * (PIP stamp → txgio_parcel.zoning_district). Breadth bake is a TRANSFORM,
 * never the origin. When a district is present, Tier-1 must carry the layer
 * URL + codeField + cityKey so downstream emit can cite GIS, not the bake.
 */

import {
  ZONING_LAYERS,
  wiredZoningCityKeys,
  type ZoningLayerConfig,
} from "@workspace/cad-ingest/zoning-layers";

export interface ZoningGisProvenance {
  sourceUrl: string;
  codeField: string;
  cityKey: string;
  layerName: string;
  stampedAt: string;
}

/** Service name from an ArcGIS FeatureServer/MapServer URL, else a stable fallback. */
export function layerNameFromZoningUrl(layerUrl: string): string {
  const m = layerUrl.match(/\/([^/]+)\/(?:FeatureServer|MapServer)(?:\/|$)/i);
  return m?.[1] ?? "zoning-layer";
}

export function zoningProvenanceFromLayer(
  layer: ZoningLayerConfig,
  stampedAt: string,
): ZoningGisProvenance {
  return {
    sourceUrl: layer.layerUrl,
    codeField: layer.codeField,
    cityKey: layer.cityKey,
    layerName: layerNameFromZoningUrl(layer.layerUrl),
    stampedAt,
  };
}

/**
 * Resolve the ZONING_LAYERS config for a parcel that already carries a
 * district. Prefer the PIP/situs-resolved cityKey; when that is missing and
 * the county wires exactly one city layer (e.g. Bastrop → bastrop-city-tx),
 * use that sole layer. Multi-city counties without a stamped cityKey return
 * null (honest — do not invent which layer stamped the district).
 */
export function resolveZoningLayerForDistrict(opts: {
  resolvedCityKey: string | null | undefined;
  countyFips: string;
}): ZoningLayerConfig | null {
  const raw = typeof opts.resolvedCityKey === "string"
    ? opts.resolvedCityKey.trim().toLowerCase()
    : "";
  if (raw) {
    const hyphen = raw.replace(/_/g, "-");
    const byKey = ZONING_LAYERS[hyphen] ?? ZONING_LAYERS[raw];
    if (byKey) return byKey;
  }
  const wired = [...wiredZoningCityKeys(opts.countyFips)];
  if (wired.length === 1) {
    return ZONING_LAYERS[wired[0]] ?? null;
  }
  return null;
}
