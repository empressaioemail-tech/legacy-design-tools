/**
 * Registry of counties served from the self-hosted TxGIO parcel store.
 *
 * Source: TxGIO/StratMap statewide Land Parcels program — collection
 * `0fa04328-872e-481c-b453-126a74777593` on data.geographic.texas.gov
 * (public domain, no auth; CloudFront 403s bare user agents, so the
 * downloader sends a browser UA). Per-county zips carry `shp/` and
 * `fgdb/` copies of the same layer; we parse the shapefile. The
 * stratmap25 shapefiles ship in GCS_WGS_1984 (verified against the
 * .prj of the real Hays and Comal downloads 2026-07-13) — no
 * reprojection. TxGIO parcels are informational, not survey grade.
 *
 * v1 scope is DELIBERATELY Hays + Comal only: they have CAD roll data
 * (Hays: 131k `cad_property` rows) but no live queryable county GIS.
 * The five #242 counties (Travis, Williamson, Bexar, Bastrop,
 * Caldwell) have live county ArcGIS services and are NOT bulk-loaded
 * here — do not add them without revisiting that split.
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

export const TXGIO_COUNTIES: Record<string, TxgioCounty> = {
  "48209": {
    fips: "48209",
    name: "Hays",
    downloadUrl: txgioDownloadUrl("48209"),
  },
  "48091": {
    fips: "48091",
    name: "Comal",
    downloadUrl: txgioDownloadUrl("48091"),
  },
};

export function resolveTxgioCounty(input: string): TxgioCounty | undefined {
  const key = input.trim();
  if (TXGIO_COUNTIES[key]) return TXGIO_COUNTIES[key];
  const lower = key.toLowerCase();
  return Object.values(TXGIO_COUNTIES).find(
    (c) => c.name.toLowerCase() === lower,
  );
}
