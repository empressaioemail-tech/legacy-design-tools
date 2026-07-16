/**
 * Max map — PUBLIC AREA-LEVEL rent choropleth (ACS median gross rent,
 * Census table B25064) at census-tract granularity, with a mandatory
 * honesty disclosure on every feature and on the layer payload.
 *
 * Runs PARALLEL to the composite chain (brokerageGisCompositeLayers.ts)
 * and the federal proxy layers (brokerageGisFederalLayers.ts); this is
 * a separate file with its own layer key, wired into the /gis-layer
 * route alongside them. Render hook in liveGis.ts is PARENT-owned —
 * see the PR description for the layer-key + paint hand-off.
 *
 * ===================== COMMITMENT-#1 BOUNDARY =======================
 * This layer paints AREA estimates, never property-level rent. ACS
 * B25064 is *in-place* median gross rent (contract rent + tenant-paid
 * utilities) averaged over currently-occupied renter households in a
 * tract; it LAGS the market and reads BELOW current asking rent.
 * Every rendered surface and the payload carries the disclosure
 * {@link ACS_RENT_DISCLOSURE} plus a source citation
 * (ACS B25064 vintage year). A parcel painted with a tract average
 * WITHOUT that disclosure is a commitment-#1 violation — the
 * disclosure is the reason this layer is allowed to ship. This is the
 * same provenance discipline as the websearch fallback.
 *
 * HARD PROHIBITION. No per-parcel or market-asking rent value is ever
 * fetched, joined, or proxied here, and no commercial rent vendor
 * (RentCast, HelloData, Zillow ZORI, Cotality rent-AVM, …) is wired.
 * Those are operator-owned and blocked pending written vendor terms.
 *
 * DATA. Tract geometry comes from Census TIGERweb (keyless, live).
 * Rent values come from the Census ACS Data API, which requires
 * `CENSUS_API_KEY`. When the key is absent the layer still renders
 * tract polygons but with a null rent value + an explicit
 * `operatorDataPullRequired` flag and a degraded honesty band — it
 * NEVER fabricates a rent number.
 */

import {
  arcgisEnvelopeQueryGeoJson,
  type ArcGisGeoJsonFeatureCollection,
} from "@workspace/adapters/arcgis";
import { AdapterRunError } from "@workspace/adapters/types";
import {
  ACS_RENT_DISCLOSURE,
  ACS_RENT_TABLE,
  acsRentSourceCitation,
  acsRentVintage,
  censusApiKey,
  fetchAcsTractRentByCounty,
  type AcsTractRent,
} from "@workspace/adapters/federal/census-acs-rent";
import type { GisLayerBbox } from "./brokerageGisLayers";

export type RentAreaLayerKey = "rent-area-acs";

export const RENT_AREA_LAYER_KEY: RentAreaLayerKey = "rent-area-acs";

/**
 * Census TIGERweb tracts service (keyless ArcGIS MapServer). WGS84
 * envelope queries return tract polygons with a `GEOID` attribute we
 * join the ACS rent onto.
 */
const TIGERWEB_TRACTS_LAYER =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/0";

/**
 * Austin-Round Rock-Georgetown metro counties (Texas). Used only to
 * bound the ACS per-county rent fetch to the metro; the tract geometry
 * itself is queried by viewport bbox, so a request outside these
 * counties still returns TIGERweb tracts (rent left null with the
 * operator-data-pull flag when outside the fetched county set).
 *
 * Each entry carries a coarse county bounding box (WGS84) so we only
 * fire an ACS county fetch for counties the viewport actually touches.
 */
interface MetroCounty {
  name: string;
  stateFips: string;
  countyFips: string;
  bbox: GisLayerBbox;
}

const AUSTIN_METRO_COUNTIES: readonly MetroCounty[] = [
  {
    name: "Travis",
    stateFips: "48",
    countyFips: "453",
    bbox: { westLng: -98.17, southLat: 30.02, eastLng: -97.37, northLat: 30.63 },
  },
  {
    name: "Williamson",
    stateFips: "48",
    countyFips: "491",
    bbox: { westLng: -98.13, southLat: 30.4, eastLng: -97.35, northLat: 30.95 },
  },
  {
    name: "Hays",
    stateFips: "48",
    countyFips: "209",
    bbox: { westLng: -98.28, southLat: 29.87, eastLng: -97.72, northLat: 30.32 },
  },
  {
    name: "Bastrop",
    stateFips: "48",
    countyFips: "021",
    bbox: { westLng: -97.55, southLat: 29.9, eastLng: -96.95, northLat: 30.5 },
  },
  {
    name: "Caldwell",
    stateFips: "48",
    countyFips: "055",
    bbox: { westLng: -97.86, southLat: 29.6, eastLng: -97.36, northLat: 30.04 },
  },
];

export type RentConfidenceKind = "asserted-with-provenance";

/**
 * The provenance envelope stamped on every feature and on the payload.
 * Shape mirrors the honesty discipline used across the spine: a
 * disclosure, a source citation, an asserted-with-provenance
 * confidence, a data vintage, and a timestamp.
 */
export interface RentAreaProvenance {
  disclosure: string;
  source: string;
  table: string;
  vintage: number;
  /** Confidence is asserted, but always carries its provenance. */
  confidence: { value: number; kind: RentConfidenceKind };
  /** ACS/HUD figures are area aggregates; timestamp of this response. */
  timestamp: string;
  /** True when no CENSUS_API_KEY was present and rents are null. */
  operatorDataPullRequired: boolean;
}

export interface RentAreaLayerResult {
  layer: RentAreaLayerKey;
  provider: string;
  adapterKey: string;
  serviceUrl: string;
  geojson: ArcGisGeoJsonFeatureCollection;
  featureCount: number;
  queryMode: "bbox";
  truncated?: boolean;
  /** Payload-level provenance (also stamped per feature). */
  provenance: RentAreaProvenance;
  /** Mirror of provenance.disclosure at top level for easy surfacing. */
  disclosure: string;
  /** Mirror of provenance.operatorDataPullRequired for the route. */
  operatorDataPullRequired: boolean;
}

export function isRentAreaLayer(layer: string): layer is RentAreaLayerKey {
  return layer === RENT_AREA_LAYER_KEY;
}

export function listRentAreaLayerEndpoints(): Array<{
  layer: RentAreaLayerKey;
  serviceUrl: string;
  provider: string;
  adapterKey: string;
  description: string;
}> {
  return [
    {
      layer: RENT_AREA_LAYER_KEY,
      serviceUrl: TIGERWEB_TRACTS_LAYER,
      provider: "U.S. Census Bureau (ACS B25064 + TIGERweb tracts)",
      adapterKey: "census:acs-b25064-rent-area",
      description:
        "Area-level median gross rent (ACS B25064) by census tract. Area estimate, not property-level market rent.",
    },
  ];
}

function requireBbox(bbox: GisLayerBbox | undefined): GisLayerBbox {
  if (!bbox) {
    throw new AdapterRunError(
      "parse-error",
      "bbox is required for the rent-area layer viewport query",
    );
  }
  if (bbox.westLng >= bbox.eastLng || bbox.southLat >= bbox.northLat) {
    throw new AdapterRunError(
      "parse-error",
      "bbox must have west < east and south < north",
    );
  }
  return bbox;
}

function bboxIntersects(a: GisLayerBbox, b: GisLayerBbox): boolean {
  return (
    a.westLng < b.eastLng &&
    a.eastLng > b.westLng &&
    a.southLat < b.northLat &&
    a.northLat > b.southLat
  );
}

/** Extract an 11-digit tract GEOID from a TIGERweb feature's props. */
export function tractGeoidFromProps(
  props: Record<string, unknown> | undefined,
): string | null {
  if (!props) return null;
  const geoid =
    props.GEOID ?? props.geoid ?? props.GEOID10 ?? props.GEOID20 ?? props.GEOID_1;
  if (typeof geoid === "string" && /^\d{11}$/.test(geoid)) return geoid;
  // Reconstruct from STATE+COUNTY+TRACT when GEOID is absent.
  const state = props.STATE ?? props.STATEFP ?? props.STATEFP10;
  const county = props.COUNTY ?? props.COUNTYFP ?? props.COUNTYFP10;
  const tract = props.TRACT ?? props.TRACTCE ?? props.TRACTCE10;
  if (state != null && county != null && tract != null) {
    const s = String(state).padStart(2, "0");
    const c = String(county).padStart(3, "0");
    const t = String(tract).padStart(6, "0");
    const reconstructed = `${s}${c}${t}`;
    if (/^\d{11}$/.test(reconstructed)) return reconstructed;
  }
  return null;
}

function buildProvenance(input: {
  vintage: number;
  hasKey: boolean;
}): RentAreaProvenance {
  return {
    disclosure: ACS_RENT_DISCLOSURE,
    source: acsRentSourceCitation(input.vintage),
    table: ACS_RENT_TABLE,
    vintage: input.vintage,
    // ACS is a modeled 5-year survey aggregate; confidence is
    // asserted but always carries provenance (source + vintage +
    // per-feature margin of error). Lower band when rents are absent
    // (geometry only, pending the operator data-pull).
    confidence: {
      value: input.hasKey ? 0.6 : 0.3,
      kind: "asserted-with-provenance",
    },
    timestamp: new Date().toISOString(),
    operatorDataPullRequired: !input.hasKey,
  };
}

/**
 * Stamp each tract feature with the joined ACS rent + the mandatory
 * disclosure/provenance. Rent is null when ACS suppressed the tract or
 * when no CENSUS_API_KEY was present — never a fabricated value.
 * Exported for unit tests (no network).
 */
export function enrichRentAreaFeatures(input: {
  geojson: ArcGisGeoJsonFeatureCollection;
  rentByGeoid: Map<string, AcsTractRent>;
  provenance: RentAreaProvenance;
}): ArcGisGeoJsonFeatureCollection {
  const { rentByGeoid, provenance } = input;
  return {
    type: "FeatureCollection",
    features: input.geojson.features.map((raw) => {
      const feature = raw as {
        type?: string;
        geometry?: unknown;
        properties?: Record<string, unknown>;
      };
      const props = { ...(feature.properties ?? {}) };
      const geoid = tractGeoidFromProps(props);
      const rent = geoid ? rentByGeoid.get(geoid) : undefined;
      return {
        ...feature,
        properties: {
          ...props,
          geoid,
          medianGrossRent: rent?.medianGrossRent ?? null,
          medianGrossRentMoe: rent?.marginOfError ?? null,
          // Mandatory honesty fields on EVERY painted feature.
          rentAreaDisclosure: provenance.disclosure,
          rentAreaSource: provenance.source,
          rentAreaTable: provenance.table,
          rentAreaVintage: provenance.vintage,
          rentAreaConfidence: provenance.confidence,
          rentAreaTimestamp: provenance.timestamp,
          operatorDataPullRequired: provenance.operatorDataPullRequired,
        },
      };
    }),
  };
}

/**
 * Query the public area-level rent choropleth for a viewport bbox.
 *
 * 1. TIGERweb tract polygons for the viewport (keyless, live).
 * 2. ACS B25064 median gross rent for each metro county the viewport
 *    touches (only when CENSUS_API_KEY is set; otherwise rents null +
 *    operatorDataPullRequired).
 * 3. Every feature stamped with rent + the mandatory disclosure and
 *    provenance.
 */
export async function queryRentAreaLayerGeoJson(input: {
  bbox?: GisLayerBbox;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<RentAreaLayerResult> {
  const bbox = requireBbox(input.bbox);
  const vintage = acsRentVintage();
  const hasKey = censusApiKey() != null;
  const provenance = buildProvenance({ vintage, hasKey });
  const meta = listRentAreaLayerEndpoints()[0]!;

  const tracts = await arcgisEnvelopeQueryGeoJson({
    serviceUrl: TIGERWEB_TRACTS_LAYER,
    bbox,
    outFields: "GEOID,STATE,COUNTY,TRACT,BASENAME,NAME",
    upstreamLabel: "Census TIGERweb tracts",
    fetchImpl: input.fetchImpl,
    signal: input.signal,
  });

  if (tracts.features.length === 0) {
    throw new AdapterRunError(
      "no-coverage",
      "No census tracts in this viewport.",
    );
  }

  const rentByGeoid = new Map<string, AcsTractRent>();
  if (hasKey) {
    // Fetch ACS rent only for metro counties the viewport intersects,
    // then merge. A county fetch failure degrades that county to null
    // rents (still disclosed) rather than failing the whole layer.
    const counties = AUSTIN_METRO_COUNTIES.filter((c) =>
      bboxIntersects(bbox, c.bbox),
    );
    for (const county of counties) {
      try {
        const map = await fetchAcsTractRentByCounty({
          stateFips: county.stateFips,
          countyFips: county.countyFips,
          vintage,
          fetchImpl: input.fetchImpl,
          signal: input.signal,
        });
        for (const [geoid, rent] of map) rentByGeoid.set(geoid, rent);
      } catch {
        // Best-effort: a single county's ACS failure leaves its tracts
        // rent-null with the disclosure intact; never fabricated.
      }
    }
  }

  const enriched = enrichRentAreaFeatures({
    geojson: tracts,
    rentByGeoid,
    provenance,
  });

  return {
    layer: meta.layer,
    provider: meta.provider,
    adapterKey: meta.adapterKey,
    serviceUrl: meta.serviceUrl,
    geojson: enriched,
    featureCount: enriched.features.length,
    queryMode: "bbox",
    truncated: tracts.truncated,
    provenance,
    disclosure: provenance.disclosure,
    operatorDataPullRequired: provenance.operatorDataPullRequired,
  };
}

/**
 * Synthetic GeoJSON for fixture mode (no upstream). Emits one tract
 * polygon carrying the mandatory disclosure/provenance so the render
 * path and the honesty guardrail can be exercised offline. Rent is a
 * clearly-labeled FIXTURE value, never presented as real.
 */
export function rentAreaLayerFixtureResult(
  bbox: GisLayerBbox,
): RentAreaLayerResult {
  const vintage = acsRentVintage();
  const provenance = buildProvenance({ vintage, hasKey: true });
  const cx = (bbox.westLng + bbox.eastLng) / 2;
  const cy = (bbox.southLat + bbox.northLat) / 2;
  const dx = (bbox.eastLng - bbox.westLng) * 0.3;
  const dy = (bbox.northLat - bbox.southLat) * 0.3;
  const ring = [
    [cx - dx, cy - dy],
    [cx + dx, cy - dy],
    [cx + dx, cy + dy],
    [cx - dx, cy + dy],
    [cx - dx, cy - dy],
  ];
  const meta = listRentAreaLayerEndpoints()[0]!;
  const geojson: ArcGisGeoJsonFeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ring] },
        properties: {
          fixture: true,
          geoid: "48453000100",
          medianGrossRent: 1650,
          medianGrossRentMoe: 120,
          rentAreaDisclosure: provenance.disclosure,
          rentAreaSource: provenance.source,
          rentAreaTable: provenance.table,
          rentAreaVintage: provenance.vintage,
          rentAreaConfidence: provenance.confidence,
          rentAreaTimestamp: provenance.timestamp,
          operatorDataPullRequired: false,
        },
      },
    ],
  };
  return {
    layer: meta.layer,
    provider: meta.provider,
    adapterKey: meta.adapterKey,
    serviceUrl: meta.serviceUrl,
    geojson,
    featureCount: 1,
    queryMode: "bbox",
    truncated: false,
    provenance,
    disclosure: provenance.disclosure,
    operatorDataPullRequired: false,
  };
}
