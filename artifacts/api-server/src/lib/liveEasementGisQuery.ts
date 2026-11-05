/**
 * P-85 WDLL items 2-3 — live ArcGIS easement intersect at click time.
 * No landing tables on this card; Factory lands layers in Phase D.
 *
 * Fixed 2026-11-05 (easements plan Phase 0):
 *   - The intersect geometry was URL-encoded twice and sent as GeoJSON. ArcGIS refuses both, with
 *     HTTP 200 and an `error` body, which this module read as "no features": every layer reported
 *     no easements for every parcel. The geometry is now Esri rings (outer ring clockwise, holes
 *     counter-clockwise), encoded once, and an ArcGIS error body is recorded as
 *     `arcgis_error`, never as zero features.
 *   - Results are paged while ArcGIS says the transfer limit was exceeded.
 *   - Every intersecting feature is reported in `features`, each with its own recording reference,
 *     type, width and source document link; the hit's top-level fields stay the first feature's.
 *   - City of Bastrop Easements_/43 names its recording number in DocumentNo, Record or RecordedID
 *     (county clerk instrument numbers, 4-digit year plus 5 digits): the first value of that shape
 *     is the recording reference, and its Laserfiche Link is the source document.
 */

export interface LiveEasementGisLayerSpec {
  sourceLayerId: string;
  sourceLayerName: string;
  layerUrl: string;
  /** When set, query only if parcel centroid falls inside this city FIPS/city key scope. */
  cityScopeFips?: string;
  recordingRefField?: string;
  /**
   * Ordered fields to read a recording reference from, used instead of `recordingRefField`: the
   * first non-blank value that matches `recordingRefPattern` (when set) is taken.
   */
  recordingRefFields?: readonly string[];
  recordingRefPattern?: RegExp;
  /** Field holding the source's own document address for the feature (https only). */
  sourceDocumentUrlField?: string;
  /** Hosts a source document address may be on (the host itself or a subdomain). */
  sourceDocumentHosts?: readonly string[];
  widthField?: string;
  typeField?: string;
}

/** Bastrop County clerk instrument number: 4-digit year then a 5-digit sequence, e.g. 201816096. */
export const BASTROP_INSTRUMENT_NUMBER = /^(?:19|20)\d{7}$/;

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
    recordingRefFields: ["DocumentNo", "Record", "RecordedID"],
    recordingRefPattern: BASTROP_INSTRUMENT_NUMBER,
    sourceDocumentUrlField: "Link",
    sourceDocumentHosts: ["cityofbastrop.org"],
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

export interface LiveEasementGisFeature {
  featureId: number | null;
  recordingRef: string | null;
  easementType: string | null;
  corridorWidthFt: number | null;
  sourceDocumentUrl: string | null;
}

export interface LiveEasementGisHit {
  sourceLayerId: string;
  sourceLayerName: string;
  /** The first intersecting feature's recording reference (kept for existing readers). */
  recordingRef: string | null;
  easementType: string | null;
  corridorWidthFt: number | null;
  featureIds: number[];
  /** Every intersecting feature, in the order ArcGIS returned them. */
  features: LiveEasementGisFeature[];
  /** Distinct non-null recording references across `features`. */
  recordingRefs: string[];
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
    /** Pages read (more than 1 when ArcGIS reported its transfer limit exceeded). */
    pages?: number;
    skippedReason?: string;
  }>;
  hits: LiveEasementGisHit[];
}

type Ring = number[][];

function signedArea(ring: Ring): number {
  let a = 0;
  for (let i = 0; i + 1 < ring.length; i++) a += ring[i]![0]! * ring[i + 1]![1]! - ring[i + 1]![0]! * ring[i]![1]!;
  return a / 2;
}

/** Esri rings orientation: outer rings clockwise (negative signed area), holes counter-clockwise. */
function orient(ring: Ring, clockwise: boolean): Ring {
  const isClockwise = signedArea(ring) < 0;
  return isClockwise === clockwise ? ring : [...ring].reverse();
}

/** GeoJSON Polygon / MultiPolygon to an Esri polygon geometry, or null for anything else. */
export function esriPolygonFromGeojson(
  geojson: { type: string; coordinates: unknown },
): { rings: Ring[]; spatialReference: { wkid: 4326 } } | null {
  const polygons: Ring[][] =
    geojson.type === "Polygon"
      ? [geojson.coordinates as Ring[]]
      : geojson.type === "MultiPolygon"
        ? (geojson.coordinates as Ring[][])
        : [];
  const rings: Ring[] = [];
  for (const poly of polygons) {
    poly.forEach((ring, i) => {
      if (Array.isArray(ring) && ring.length >= 4) rings.push(orient(ring, i === 0));
    });
  }
  return rings.length > 0 ? { rings, spatialReference: { wkid: 4326 } } : null;
}

/**
 * The intersect query is POSTed as a form (fixed 2026-11-05). By GET, services7.arcgis.com answered
 * 404 for an ordinary Bastrop parcel (60 vertices, a 2,299-character URL even with coordinates
 * rounded) while the same query by POST returned its 6 easements. ArcGIS REST accepts every query
 * parameter by POST, and the body has no URL length ceiling.
 */
function arcgisIntersectQuery(
  layerUrl: string,
  esriGeometry: { rings: Ring[]; spatialReference: { wkid: 4326 } },
  resultOffset = 0,
): { url: string; body: URLSearchParams } {
  const base = layerUrl.replace(/\/$/, "");
  return {
    url: `${base}/query`,
    body: new URLSearchParams({
      // URLSearchParams encodes once; a second encodeURIComponent made ArcGIS refuse the query.
      geometry: JSON.stringify(esriGeometry),
      geometryType: "esriGeometryPolygon",
      spatialRel: "esriSpatialRelIntersects",
      inSR: "4326",
      outSR: "4326",
      returnGeometry: "true",
      outFields: "*",
      resultOffset: String(resultOffset),
      f: "geojson",
    }),
  };
}

function pickField(
  props: Record<string, unknown>,
  fieldName: string | undefined,
): string | null {
  if (!fieldName) return null;
  const val = props[fieldName];
  if (val == null) return null;
  const s = String(val).trim();
  return s === "" ? null : s;
}

export function readRecordingRef(
  props: Record<string, unknown>,
  spec: LiveEasementGisLayerSpec,
): string | null {
  if (spec.recordingRefFields?.length) {
    for (const field of spec.recordingRefFields) {
      const v = pickField(props, field);
      if (!v || v === "0") continue;
      if (spec.recordingRefPattern && !spec.recordingRefPattern.test(v)) continue;
      return v;
    }
    return null;
  }
  return pickField(props, spec.recordingRefField);
}

export function readSourceDocumentUrl(
  props: Record<string, unknown>,
  spec: LiveEasementGisLayerSpec,
): string | null {
  const v = pickField(props, spec.sourceDocumentUrlField);
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:") return null;
    const hosts = spec.sourceDocumentHosts ?? [];
    if (!hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) return null;
    return u.toString();
  } catch {
    return null;
  }
}

type GeojsonFeature = { id?: number; properties?: Record<string, unknown>; geometry?: unknown };

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
  const esriGeometry = esriPolygonFromGeojson(args.parcelGeometryGeojson);

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

    if (!esriGeometry) {
      layers.push({
        sourceLayerId: spec.sourceLayerId,
        layerUrl: spec.layerUrl,
        query: "skipped",
        featureCount: 0,
        featureIds: [],
        skippedReason: `unsupported_parcel_geometry_${args.parcelGeometryGeojson.type}`,
      });
      continue;
    }

    const features: GeojsonFeature[] = [];
    let firstQueryUrl = "";
    let pages = 0;
    let failure: string | null = null;
    for (let offset = 0; ; ) {
      const query = arcgisIntersectQuery(spec.layerUrl, esriGeometry, offset);
      // The audit keeps a readable record of the request: the endpoint, then the form body.
      if (!firstQueryUrl) firstQueryUrl = `POST ${query.url} ${query.body.toString()}`;
      const res = await fetch(query.url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: query.body,
      });
      if (!res.ok) {
        failure = `http_${res.status}`;
        break;
      }
      const body = (await res.json()) as {
        error?: { code?: number; message?: string };
        features?: GeojsonFeature[];
        exceededTransferLimit?: boolean;
        properties?: { exceededTransferLimit?: boolean };
      };
      if (body.error) {
        failure = `arcgis_error${body.error.code ? `_${body.error.code}` : ""}: ${body.error.message ?? "unknown"}`;
        break;
      }
      pages += 1;
      const page = body.features ?? [];
      features.push(...page);
      const more = body.exceededTransferLimit === true || body.properties?.exceededTransferLimit === true;
      if (!more || page.length === 0 || pages >= 50) break;
      offset += page.length;
    }

    if (failure) {
      layers.push({
        sourceLayerId: spec.sourceLayerId,
        layerUrl: spec.layerUrl,
        query: firstQueryUrl,
        featureCount: 0,
        featureIds: [],
        ...(pages > 0 ? { pages } : {}),
        skippedReason: failure,
      });
      continue;
    }

    const featureIds = features
      .map((f) => f.id)
      .filter((id): id is number => typeof id === "number");

    layers.push({
      sourceLayerId: spec.sourceLayerId,
      layerUrl: spec.layerUrl,
      query: firstQueryUrl,
      featureCount: features.length,
      featureIds,
      pages,
    });

    if (features.length > 0) {
      const details: LiveEasementGisFeature[] = features.map((f) => {
        const props = f.properties ?? {};
        const width = spec.widthField ? Number(props[spec.widthField]) : NaN;
        return {
          featureId: typeof f.id === "number" ? f.id : null,
          recordingRef: readRecordingRef(props, spec),
          easementType: pickField(props, spec.typeField),
          corridorWidthFt: Number.isFinite(width) && width > 0 ? width : null,
          sourceDocumentUrl: readSourceDocumentUrl(props, spec),
        };
      });
      const first = details[0]!;
      hits.push({
        sourceLayerId: spec.sourceLayerId,
        sourceLayerName: spec.sourceLayerName,
        recordingRef: first.recordingRef,
        easementType: first.easementType,
        corridorWidthFt: first.corridorWidthFt,
        featureIds,
        features: details,
        recordingRefs: [...new Set(details.map((d) => d.recordingRef).filter((r): r is string => r !== null))],
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
