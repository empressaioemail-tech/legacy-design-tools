/**
 * Real TxGIO/StratMap land-parcel feature — Hays County (48209)
 * Prop_ID 12310, extracted verbatim from the stratmap25
 * `stratmap25-landparcels_48209_hays_202503` shapefile (public
 * domain). Small 7-vertex polygon near Uhland Rd, San Marcos; the
 * double space in SITUS_ADDR is genuine (normalization collapses it).
 */
export const HAYS_PARCEL_12310 = {
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-97.91233033799995, 29.89560583900004],
        [-97.91294211699994, 29.89508246300005],
        [-97.91295020199999, 29.895076204000077],
        [-97.91297140099994, 29.895094855000025],
        [-97.91313552599996, 29.89523915700005],
        [-97.91252467199996, 29.895773322000025],
        [-97.91233033799995, 29.89560583900004],
      ],
    ],
  },
  properties: {
    Prop_ID: "12310",
    GEO_ID: "10-0017-2347-00000-3",
    OWNER_NAME: "DELEON FELIX",
    SITUS_ADDR: "707  UHLAND RD, SAN MARCOS, TX 78666",
    SITUS_CITY: "SAN MARCOS",
    SITUS_STAT: "TX",
    SITUS_ZIP: "78666",
    FIPS: "48209",
    COUNTY: "HAYS",
    TAX_YEAR: 2025,
  },
} as const;

/** A point inside parcel 12310 (vertex average — interior for this shape). */
export const HAYS_PARCEL_12310_INSIDE = {
  longitude: -97.91274065628568,
  latitude: 29.8953539541429,
};

/** A point just outside the parcel's bbox. */
export const HAYS_PARCEL_12310_OUTSIDE = {
  longitude: -97.9135,
  latitude: 29.8951,
};

/** The real .prj text shipped with the stratmap25 Hays shapefile. */
export const HAYS_PRJ_WGS84 =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

/** A Texas state-plane .prj (EPSG:2277-style) that MUST be refused. */
export const TX_STATE_PLANE_PRJ =
  'PROJCS["NAD_1983_StatePlane_Texas_Central_FIPS_4203_Feet",GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137.0,298.257222101]]],PROJECTION["Lambert_Conformal_Conic"]]';
