/**
 * Registry of counties served from the self-hosted TxGIO parcel store.
 *
 * Source: TxGIO/StratMap statewide Land Parcels program — collection
 * `0fa04328-872e-481c-b453-126a74777593` on data.geographic.texas.gov
 * (public domain, no auth; CloudFront 403s bare user agents, so the
 * downloader sends a browser UA). Per-county zips carry `shp/` and
 * `fgdb/` copies of the same layer; we parse the shapefile. The
 * stratmap25 shapefiles ship in GCS_WGS_1984 (verified against the
 * .prj of the real Hays and Comal downloads 2026-07-13, and re-verified
 * against the real Caldwell 48055 download 2026-07-18) — no
 * reprojection. TxGIO parcels are informational, not survey grade.
 *
 * Scope (Wave D2, 2026-07-18): ALL ten Central-Texas counties are
 * bulk-loaded here so the PMTiles browse-layer bake (D3) has ONE
 * uniform source (`txgio_parcel`) covering the whole region. Earlier
 * scope was DELIBERATELY Hays + Comal only (they had CAD roll data but
 * no live queryable county GIS); the five #242 counties (Travis,
 * Williamson, Bexar, Bastrop, Caldwell) were served live from county
 * ArcGIS and excluded from the bulk load. That split is retired for the
 * map-store purpose: a bake of "the store" would silently omit the
 * densest metro counties, so they are unified into txgio_parcel here.
 * Serving those counties live elsewhere (property lookups) is
 * unaffected — this is the map geometry store, not the live-query path.
 *
 * The three gap counties (Guadalupe 48187, Bell 48027, McLennan 48309)
 * had geometry in no store at all and are added here for the same bake.
 *
 * URL/schema uniformity (verified 2026-07-18): every county resolves on
 * the same `stratmap25-landparcels_{fips}_lp.zip` template — all ten
 * range-GET verified live (sizes 12MB Caldwell .. 346MB Travis) — and
 * the StratMap program publishes ONE statewide-normalized attribute
 * schema, so all ten share the same DBF fields (Prop_ID, OWNER_NAME,
 * SITUS_*). No per-county URL or field-mapping overrides are needed.
 * Confirmed by reading the real Caldwell DBF header (37 fields,
 * byte-identical field order to the documented Hays/Comal schema in
 * parse.ts) and the shp/ layout of the Bexar and Travis zips.
 *
 * Land-use: StratMap ships geometry + owner/situs, but the choropleth
 * paint reads land-use from the CAD appraisal roll (`cad_property`), a
 * SEPARATE load. Every county added here renders GEOMETRY immediately;
 * a county with no loaded CAD roll renders without land-use coloring
 * until that roll lands. (STAT_LAND_/LOC_LAND_U land-use codes ARE
 * present in the StratMap DBF but are intentionally not parsed here —
 * see parse.ts.)
 */

const TXGIO_COLLECTION_ID = "0fa04328-872e-481c-b453-126a74777593";

export interface TxgioCounty {
  /** 5-digit county FIPS, e.g. `48209`. */
  fips: string;
  /** Human name, e.g. `Hays`. */
  name: string;
  /** Per-county land-parcels zip on data.geographic.texas.gov. */
  downloadUrl: string;
}

export function txgioDownloadUrl(fips: string): string {
  return (
    `https://data.geographic.texas.gov/${TXGIO_COLLECTION_ID}/resources/` +
    `stratmap25-landparcels_${fips}_lp.zip`
  );
}

function county(fips: string, name: string): TxgioCounty {
  return { fips, name, downloadUrl: txgioDownloadUrl(fips) };
}

/**
 * The ten Central-Texas counties whose parcel geometry is unified into
 * `txgio_parcel` for the PMTiles bake. Order: original v1 pair, then
 * the metro-5 (formerly live-only), then the three gap counties.
 */
export const TXGIO_COUNTIES: Record<string, TxgioCounty> = {
  // v1 (had no live county GIS)
  "48209": county("48209", "Hays"),
  "48091": county("48091", "Comal"),
  // metro-5 (were served live from county ArcGIS; unified here for the bake)
  "48453": county("48453", "Travis"),
  "48491": county("48491", "Williamson"),
  "48029": county("48029", "Bexar"),
  "48021": county("48021", "Bastrop"),
  "48055": county("48055", "Caldwell"),
  // gap counties (geometry was in no store)
  "48187": county("48187", "Guadalupe"),
  "48027": county("48027", "Bell"),
  "48309": county("48309", "McLennan"),
};

export function resolveTxgioCounty(input: string): TxgioCounty | undefined {
  const key = input.trim();
  if (TXGIO_COUNTIES[key]) return TXGIO_COUNTIES[key];
  const lower = key.toLowerCase();
  return Object.values(TXGIO_COUNTIES).find(
    (c) => c.name.toLowerCase() === lower,
  );
}
