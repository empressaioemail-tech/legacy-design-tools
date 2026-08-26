/**
 * P-85 WDLL items 2-3 — live ArcGIS easement intersect at click time.
 * No landing tables on this card; Factory lands layers in Phase D.
 */

export interface LiveEasementGisLayerSpec {
  sourceLayerId: string;
  sourceLayerName: string;
  layerUrl: string;
  /** When set, query only if parcel centroid falls inside this city FIPS/city key scope. */
  cityScopeFips?: string;
  recordingRefField?: string;
  widthField?: string;
  typeField?: string;
}

export const P85_LIVE_EASEMENT_GIS_LAYERS: readonly LiveEasementGisLayerSpec[] = [
  {
    sourceLayerId: "round-rock-easements",
    sourceLayerName: "City of Round Rock Easements",
    layerUrl:
      "https://maps.roundrocktexas.gov/arcgis/rest/services/Easements/MapServer/0",
    cityScopeFips: "48491",
    recordingRefField: "Recordation_Num",
    typeField: "Type",
  },
  {
    sourceLayerId: "cedar-park-easements",
    sourceLayerName: "City of Cedar Park Easements",
    layerUrl:
      "https://gis.cedarparktexas.gov/arcgis/rest/services/Easements/FeatureServer/0",
    cityScopeFips: "48491",
    typeField: "EasementType",
  },
  {
    sourceLayerId: "bastrop-city-easements",
    sourceLayerName: "City of Bastrop Easements",
    layerUrl:
      "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Easements_/FeatureServer/43",
    cityScopeFips: "48021",
    typeField: "Status",
  },
  {
    sourceLayerId: "mclennan-cad-easement-lines",
    sourceLayerName: "McLennan CAD Easement Lines",
    layerUrl:
      "https://services8.arcgis.com/5e4b1SY8bogTc3pH/arcgis/rest/services/McLennanCADWebService/FeatureServer/9",
    cityScopeFips: "48309",
  },
  {
    sourceLayerId: "mclennan-cad-easement-text",
    sourceLayerName: "McLennan CAD Easement Text",
    layerUrl:
      "https://services8.arcgis.com/5e4b1SY8bogTc3pH/arcgis/rest/services/McLennanCADWebService/FeatureServer/10",
    cityScopeFips: "48309",
    recordingRefField: "DOC_NUM",
    widthField: "WIDTH",
    typeField: "TYPE",
  },
];

export interface LiveEasementGisHit {
  sourceLayerId: string;
  sourceLayerName: string;
  recordingRef: string | null;
  easementType: string | null;
  corridorWidthFt: number | null;
  featureIds: number[];
  geometryGeojson: unknown;
}

export interface LiveEasementGisQueryAudit {
  queriedAt: string;
  parcelKey: string;
  countyFips: string;
  layers: Array<{
    sourceLayerId: string;
    layerUrl: string;
    query: string;
    featureCount: number;
    featureIds: number[];
    skippedReason?: string;
  }>;
  hits: LiveEasementGisHit[];
}

function arcgisIntersectQueryUrl(
  layerUrl: string,
  geojsonGeometry: { type: string; coordinates: unknown },
): string {
  const geometry = encodeURIComponent(JSON.stringify(geojsonGeometry));
  const base = layerUrl.replace(/\/$/, "");
  return (
    `${base}/query?` +
    new URLSearchParams({
      geometry,
      geometryType: "esriGeometryPolygon",
      spatialRel: "esriSpatialRelIntersects",
      inSR: "4326",
      outSR: "4326",
      returnGeometry: "true",
      outFields: "*",
      f: "geojson",
    })
  );
}

function pickField(
  props: Record<string, unknown>,
  fieldName: string | undefined,
): string | null {
  if (!fieldName) return null;
  const val = props[fieldName];
  if (val == null || val === "") return null;
  return String(val);
}

/**
 * Query public easement GIS layers live for one parcel polygon.
 * City-scoped layers skip when parcel is outside that city's limits (caller supplies scope check).
 */
export async function queryLiveEasementGisForParcel(args: {
  parcelKey: string;
  countyFips: string;
  parcelGeometryGeojson: { type: string; coordinates: unknown };
  /** Return false to skip a city-scoped layer (parcel outside city limits). */
  isInsideCityScope?: (cityScopeFips: string) => boolean;
}): Promise<LiveEasementGisQueryAudit> {
  const queriedAt = new Date().toISOString();
  const layers: LiveEasementGisQueryAudit["layers"] = [];
  const hits: LiveEasementGisHit[] = [];

  for (const spec of P85_LIVE_EASEMENT_GIS_LAYERS) {
    if (spec.cityScopeFips && spec.cityScopeFips !== args.countyFips) {
      layers.push({
        sourceLayerId: spec.sourceLayerId,
        layerUrl: spec.layerUrl,
        query: "skipped",
        featureCount: 0,
        featureIds: [],
        skippedReason: "county_fips_mismatch",
      });
      continue;
    }

    if (
      spec.cityScopeFips &&
      args.isInsideCityScope &&
      !args.isInsideCityScope(spec.cityScopeFips)
    ) {
      layers.push({
        sourceLayerId: spec.sourceLayerId,
        layerUrl: spec.layerUrl,
        query: "skipped",
        featureCount: 0,
        featureIds: [],
        skippedReason: "outside_city_limits",
      });
      continue;
    }

    const queryUrl = arcgisIntersectQueryUrl(
      spec.layerUrl,
      args.parcelGeometryGeojson,
    );
    const res = await fetch(queryUrl);
    if (!res.ok) {
      layers.push({
        sourceLayerId: spec.sourceLayerId,
        layerUrl: spec.layerUrl,
        query: queryUrl,
        featureCount: 0,
        featureIds: [],
        skippedReason: `http_${res.status}`,
      });
      continue;
    }

    const geojson = (await res.json()) as {
      features?: Array<{
        id?: number;
        properties?: Record<string, unknown>;
        geometry?: unknown;
      }>;
    };
    const features = geojson.features ?? [];
    const featureIds = features
      .map((f) => f.id)
      .filter((id): id is number => typeof id === "number");

    layers.push({
      sourceLayerId: spec.sourceLayerId,
      layerUrl: spec.layerUrl,
      query: queryUrl,
      featureCount: features.length,
      featureIds,
    });

    if (features.length > 0) {
      hits.push({
        sourceLayerId: spec.sourceLayerId,
        sourceLayerName: spec.sourceLayerName,
        recordingRef: pickField(
          features[0]?.properties ?? {},
          spec.recordingRefField,
        ),
        easementType: pickField(
          features[0]?.properties ?? {},
          spec.typeField,
        ),
        corridorWidthFt: spec.widthField
          ? Number(features[0]?.properties?.[spec.widthField]) || null
          : null,
        featureIds,
        geometryGeojson: {
          type: "FeatureCollection",
          features: features.map((f) => ({
            type: "Feature",
            properties: f.properties ?? {},
            geometry: f.geometry,
          })),
        },
      });
    }
  }

  return {
    queriedAt,
    parcelKey: args.parcelKey,
    countyFips: args.countyFips,
    layers,
    hits,
  };
}
