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

/**
 * The REAL .prj shipped with the 202505 StratMap vintage — Web Mercator
 * (EPSG:3857), coordinates in METERS. Read verbatim from the King
 * 48269, Loving 48301 and Sterling 48431 archives on 2026-08-08
 * (`_inbox/2026-08-08_SWEEP_statewide_readiness.md` section 3); 12 of
 * 12 sampled 202505 counties ship exactly this, 57 of 254 counties are
 * on that vintage.
 *
 * THIS IS THE REGRESSION FIXTURE. Note the nested
 * `GEOGCS["GCS_WGS_1984", ...]` — it contains the substring the old
 * datum-only guard tested for, so the old guard PASSED on projected
 * meters. It must now be refused.
 */
export const TXGIO_202505_WEB_MERCATOR_PRJ =
  'PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],UNIT["Meter",1.0]]';

/**
 * The real shapefile-header bbox of King County 48269 (202505 vintage),
 * read from bytes 36-68 of the .shp main-file header on 2026-08-08.
 * Web Mercator meters — a legitimate west longitude for that county is
 * about -100.2 degrees, not -11,189,891.
 */
export const KING_48269_WEB_MERCATOR_BBOX = {
  westLng: -11189891.3150,
  southLat: 3947657.0592,
  eastLng: -11128288.8778,
  northLat: 4007106.7923,
};

/**
 * A synthetic parcel-shaped polygon in Web Mercator meters, sized like
 * a real small parcel (about 60m x 45m) and placed inside King County's
 * real header bbox. Stands in for one feature of a 202505 archive.
 */
export const KING_48269_WEB_MERCATOR_PARCEL = {
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-11189891.315, 3947657.0592],
        [-11189831.315, 3947657.0592],
        [-11189831.315, 3947702.0592],
        [-11189891.315, 3947702.0592],
        [-11189891.315, 3947657.0592],
      ],
    ],
  },
  properties: {
    Prop_ID: "5001",
    GEO_ID: "R5001",
    OWNER_NAME: "KING RANCH TEST",
    SITUS_ADDR: "1 RANCH RD",
    SITUS_CITY: "GUTHRIE",
    SITUS_STAT: "TX",
    SITUS_ZIP: "79236",
    FIPS: "48269",
    COUNTY: "KING",
    TAX_YEAR: 2025,
  },
} as const;

/**
 * GROUND TRUTH for the reprojection. `KING_48269_WEB_MERCATOR_BBOX`
 * above, converted EPSG:3857 -> EPSG:4326, measured against the REAL
 * archive on 2026-08-08: the 697,553-byte
 * `stratmap25-landparcels_48269_lp.zip` was downloaded from
 * data.geographic.texas.gov, its 2,326 features reprojected, and all
 * 2,313 with polygon geometry passed the Texas envelope assertion.
 *
 * The values below are that county's true position. King County, Texas
 * spans roughly lng -100.52..-100.00 and lat 33.39..33.84 (US Census
 * county boundary), so the conversion is verified against the county's
 * KNOWN LOCATION and not merely against its own arithmetic. A
 * reprojection bug that produced a self-consistent but wrong answer —
 * an ellipsoidal instead of spherical inverse, say, which shifts
 * latitude by tens of km — would fail this fixture.
 */
export const KING_48269_REPROJECTED_BBOX = {
  westLng: -100.52050395900791,
  southLat: 33.39353987451293,
  eastLng: -99.96711985025019,
  northLat: 33.8382739939311,
};

/**
 * EPSG:3857 <-> EPSG:4326 reference pairs with PUBLISHED values — the
 * defining constants of the CRS, which this codebase did not derive.
 *
 * EPSG:3857's declared extent is +/-20037508.342789244 m on both axes
 * (that is pi * 6378137, the half-circumference of the projection
 * sphere), corresponding to +/-180 degrees longitude and the CRS's
 * documented latitude limit of +/-85.05112877980659 degrees. Those are
 * the numbers every EPSG registry entry and every tiling scheme quotes,
 * so recovering them exactly from the inverse is an independent check
 * of the constant, the formula, and the units all at once — a wrong
 * radius or an ellipsoidal inverse misses the latitude limit.
 */
export const WEB_MERCATOR_REFERENCE_PAIRS: ReadonlyArray<{
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly longitude: number;
  readonly latitude: number;
}> = [
  { label: "origin (null island)", x: 0, y: 0, longitude: 0, latitude: 0 },
  {
    label: "east extent at equator",
    x: 20037508.342789244,
    y: 0,
    longitude: 180,
    latitude: 0,
  },
  {
    label: "west extent at equator",
    x: -20037508.342789244,
    y: 0,
    longitude: -180,
    latitude: 0,
  },
  {
    label: "north extent (EPSG:3857 latitude limit)",
    x: 0,
    y: 20037508.342789244,
    longitude: 0,
    latitude: 85.05112877980659,
  },
  {
    label: "south extent (EPSG:3857 latitude limit)",
    x: 0,
    y: -20037508.342789244,
    longitude: 0,
    latitude: -85.05112877980659,
  },
];

/**
 * Ordinary Texas points for the ROUND-TRIP closure assertion. Unlike
 * the reference pairs above these degree values are the input, not a
 * published constant: the test projects them forward and inverts them,
 * so it measures the numerical closure of the pair rather than
 * corroborating the formula. Both properties are worth testing and the
 * distinction is deliberate — the King County fixture above is what
 * corroborates the formula against the physical world.
 */
export const TEXAS_ROUND_TRIP_POINTS: ReadonlyArray<{
  readonly label: string;
  readonly longitude: number;
  readonly latitude: number;
}> = [
  { label: "Austin", longitude: -97.7431, latitude: 30.2672 },
  { label: "Guthrie (King county seat)", longitude: -100.3229, latitude: 33.6212 },
  { label: "El Paso (west tip)", longitude: -106.4850, latitude: 31.7619 },
  { label: "Brownsville (south tip)", longitude: -97.4975, latitude: 25.9017 },
  { label: "Texline (panhandle top)", longitude: -103.0207, latitude: 36.3792 },
];
