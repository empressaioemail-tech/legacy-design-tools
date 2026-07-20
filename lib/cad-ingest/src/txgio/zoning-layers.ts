/**
 * Per-city public zoning-GIS-layer registry for the parcel zoning stamp.
 *
 * The buildable-envelope route reads a parcel's zoning district off
 * `feature.properties.zoningCode` and maps it onto the jurisdiction's
 * setback-district row (districtMapping.ts). The StratMap land-parcel
 * program ships NO zoning, so store-backed parcels arrive zoning-null and
 * the district mapping degrades to the most-conservative fallback. This
 * registry maps a city to the public ArcGIS zoning polygon layer whose
 * district code is point-in-polygon'd onto each parcel at stamp time
 * (see `zoning-stamp.ts` + `zoning-cli.ts`).
 *
 * THE MATCH CONTRACT (why the RAW code is stamped, unmodified): the
 * envelope's `districtCode()` takes the LEADING whitespace token of a
 * setback row's `district_name` and normalizes it (upper, strip
 * non-alphanumeric); `mapDistrict()` matches the parcel's stamped code
 * (same normalization) against it. Georgetown's setback table
 * (`georgetown-tx.json`) uses `district_name` like "RS Residential
 * Single-Family" -> leading token "RS"; Georgetown's zoning GIS `ZONE`
 * field is "RS". So the RAW `ZONE` value stamped verbatim -> normalized
 * "RS" -> exact-matches the "RS ..." setback row. Verified live
 * 2026-07-20 for all 12 setback districts (RE/RL/RS/TF/TH/MF-1/MF-2/
 * CN/C-1/C-3/OF/IN); the 5 GIS-only codes (AG/BP/MH/MU-DT/PF) have no
 * setback row and correctly hit the conservative fallback (AG and MU are
 * deliberately excluded from the setback table as form-based /
 * no-simple-setback districts). DO NOT transform the code before
 * stamping — the leading-token contract does the alignment.
 *
 * The stamp is county-scoped (it updates `txgio_parcel` rows for one
 * county) but zoning is a CITY layer, so each config carries the county
 * whose parcels it stamps. A parcel centroid that falls in no zoning
 * polygon (outside the city, or an un-zoned area) is left NULL — honest
 * fallback, never a guessed district.
 */

export interface ZoningLayerConfig {
  /** City key (matches the setback jurisdictionKey stem, e.g. "georgetown-tx"). */
  cityKey: string;
  /** Human name for logs. */
  cityName: string;
  /**
   * County FIPS whose `txgio_parcel` rows this layer stamps. Georgetown is
   * in Williamson (48491); parcels are stamped where their centroid falls
   * inside a zoning polygon of this layer.
   */
  countyFips: string;
  /**
   * Public ArcGIS MapServer/FeatureServer layer URL (no trailing /query).
   * The layer must expose the district-code field below and polygon
   * geometry; the stamp fetches it once with `?where=1=1&outFields=<code>&
   * returnGeometry=true&outSR=4326&f=geojson` (paged).
   */
  layerUrl: string;
  /**
   * Field carrying the district code the setback table's leading token
   * matches (Georgetown: `ZONE`, e.g. "RS"). Stamped RAW (unmodified) per
   * the match contract above.
   */
  codeField: string;
  /**
   * Field carrying the human district description, for logs/provenance
   * only (Georgetown: `FULLZONE`, e.g. "Residential Single-Family"). Not
   * consumed by the envelope; recorded so a stamp run is auditable.
   */
  descriptionField?: string;
}

/**
 * Registry keyed by city. Georgetown is the first (and only wired) city;
 * the mechanism is general — add a city here (verify its `ZONE`-style code
 * aligns with that city's setback `district_name` leading tokens FIRST)
 * to onboard it.
 */
export const ZONING_LAYERS: Record<string, ZoningLayerConfig> = {
  "georgetown-tx": {
    cityKey: "georgetown-tx",
    cityName: "Georgetown",
    countyFips: "48491",
    layerUrl:
      "https://gis.georgetowntexas.gov/arcgis/rest/services/Planning/PlanningDevelopmentNew_WebMap/MapServer/20",
    codeField: "ZONE",
    descriptionField: "FULLZONE",
  },
};

export function resolveZoningLayer(input: string): ZoningLayerConfig | undefined {
  const key = input.trim().toLowerCase();
  if (ZONING_LAYERS[key]) return ZONING_LAYERS[key];
  return Object.values(ZONING_LAYERS).find(
    (c) => c.cityName.toLowerCase() === key || c.countyFips === key,
  );
}
