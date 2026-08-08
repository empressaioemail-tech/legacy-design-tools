/**
 * Registry of Texas counties reachable through the self-hosted TxGIO
 * parcel store.
 *
 * Source: TxGIO/StratMap statewide Land Parcels program — collection
 * `0fa04328-872e-481c-b453-126a74777593` on data.geographic.texas.gov
 * (public domain, no auth; CloudFront 403s bare user agents, so the
 * downloader sends a browser UA). Per-county zips carry `shp/` and
 * `fgdb/` copies of the same layer; we parse the shapefile. TxGIO
 * parcels are informational, not survey grade.
 *
 * PROJECTION — READ THIS BEFORE ASSUMING DEGREES. The header of this
 * file previously asserted the program ships GCS_WGS_1984 statewide.
 * That is FALSE for the 202505 vintage: 12 of 12 sampled 202505
 * counties ship `PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere", ...]`
 * — EPSG:3857, coordinates in METERS — while 15 of 15 sampled counties
 * on every other vintage (202503, 202507, 202508, 202509) ship
 * geographic degrees. 57 of the 254 counties are on 202505. See
 * `_inbox/2026-08-08_SWEEP_statewide_readiness.md` section 3. The
 * ingest therefore rejects a PROJCS `.prj` outright and, more
 * importantly, range-asserts every feature's coordinates against the
 * Texas WGS84 envelope in `parse.ts` — a projected or otherwise
 * non-degree county fails closed rather than loading garbage.
 *
 * URL/SCHEMA UNIFORMITY (verified 2026-07-18, re-verified statewide
 * 2026-08-08): every county resolves on the same
 * `stratmap25-landparcels_{fips}_lp.zip` template — all 254 range-GET
 * probed live, 253 answering 206 and Donley 48129 alone returning 404 —
 * and the StratMap program publishes ONE statewide-normalized attribute
 * schema, so every county shares the same DBF fields (Prop_ID, GEO_ID,
 * OWNER_NAME, SITUS_*). Rural samples across all five vintages carried
 * all seven fields the ingest reads, in identical order; 202503
 * archives carry two extra ArcGIS fields (`Shape_Leng`, `Shape_Area`)
 * the ingest ignores by name-based lookup. No per-county URL or
 * field-mapping overrides are needed, and none has ever existed — the
 * only per-county data any entry here has ever carried is the county
 * NAME, which the statewide roster below supplies for all 254.
 *
 * WHY THIS FILE NO LONGER GATES THE CLI (2026-08-08). `TXGIO_COUNTIES`
 * used to be BOTH the record of which counties are loaded AND the
 * allowlist the ingest CLI resolved against, so a county could not even
 * be dry-run until someone hand-added a line here. That coupling
 * encoded no real constraint — `txgioDownloadUrl` was already general
 * and the schema is statewide-uniform — and it blocked the 235-county
 * statewide acquisition. The two concerns are now separate:
 *
 *   TXGIO_STATEWIDE_COUNTIES  all 254 real TX counties (fips -> name),
 *                             generated from `texas_roster_v1.json`.
 *                             This is what the CLI resolves against.
 *   TXGIO_COUNTIES            the counties whose geometry is LOADED into
 *                             `txgio_parcel`. Still hand-maintained,
 *                             because it is a claim about the store's
 *                             contents, and `jurisdictions.ts` composes
 *                             it into `getJurisdictionConfig().geometry`
 *                             — ballooning it to 254 would assert
 *                             geometry we do not have. Add a county here
 *                             when its load lands, not before.
 *
 * Land-use: StratMap ships geometry + owner/situs, but the choropleth
 * paint reads land-use from the CAD appraisal roll (`cad_property`), a
 * SEPARATE load. Every county loaded renders GEOMETRY immediately; a
 * county with no loaded CAD roll renders without land-use coloring
 * until that roll lands. (STAT_LAND_/LOC_LAND_U land-use codes ARE
 * present in the StratMap DBF but are intentionally not parsed by
 * parse.ts — see the note there.)
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
 * Counties whose StratMap archive is a confirmed 404 at source and
 * therefore cannot be acquired from the bulk program at all. Kept as a
 * NAMED absence so the CLI fails with an explanation rather than a
 * transport stack trace, and so the gap is visible rather than implied
 * by silence.
 *
 * Donley 48129: 404 confirmed twice (2026-08-02 matrix, re-probed
 * 2026-08-08 across all 254). Needs a county CAD or ArcGIS override
 * rather than a StratMap fetch.
 */
export const TXGIO_ABSENT_FROM_STRATMAP: Record<string, string> = {
  "48129": "StratMap archive returns 404 (confirmed 2026-08-02, re-probed 2026-08-08)",
};

/**
 * Every Texas county, FIPS -> name. Generated from
 * `P:\doc_repo\_catalog\texas_roster_v1.json` (254 entries, the
 * canonical statewide roster) on 2026-08-08.
 *
 * Embedded rather than validated structurally. Texas county codes DO
 * happen to be exactly the odd numbers 001..507 — verified against the
 * roster, 254 of 254 with no gaps and no extras — so a structural test
 * `/^48\d{3}$/ && odd && <= 507` would accept precisely the right set
 * and nothing else. It was rejected anyway for two reasons. First, it
 * carries no NAME, and the CLI needs one for `--list`, for its log
 * lines, and for `resolveTxgioCounty("comal")` name resolution, which
 * would otherwise have to be dropped. Second, "odd numbers up to 507"
 * is a coincidence of the FIPS assignment scheme, not a rule anyone
 * guarantees; an explicit roster states what is true rather than
 * relying on a pattern that happens to hold. The table is generated,
 * not typed, so it costs nothing to regenerate if the roster changes.
 */
export const TXGIO_STATEWIDE_COUNTIES: Record<string, string> = {
  "48001": "Anderson",
  "48003": "Andrews",
  "48005": "Angelina",
  "48007": "Aransas",
  "48009": "Archer",
  "48011": "Armstrong",
  "48013": "Atascosa",
  "48015": "Austin",
  "48017": "Bailey",
  "48019": "Bandera",
  "48021": "Bastrop",
  "48023": "Baylor",
  "48025": "Bee",
  "48027": "Bell",
  "48029": "Bexar",
  "48031": "Blanco",
  "48033": "Borden",
  "48035": "Bosque",
  "48037": "Bowie",
  "48039": "Brazoria",
  "48041": "Brazos",
  "48043": "Brewster",
  "48045": "Briscoe",
  "48047": "Brooks",
  "48049": "Brown",
  "48051": "Burleson",
  "48053": "Burnet",
  "48055": "Caldwell",
  "48057": "Calhoun",
  "48059": "Callahan",
  "48061": "Cameron",
  "48063": "Camp",
  "48065": "Carson",
  "48067": "Cass",
  "48069": "Castro",
  "48071": "Chambers",
  "48073": "Cherokee",
  "48075": "Childress",
  "48077": "Clay",
  "48079": "Cochran",
  "48081": "Coke",
  "48083": "Coleman",
  "48085": "Collin",
  "48087": "Collingsworth",
  "48089": "Colorado",
  "48091": "Comal",
  "48093": "Comanche",
  "48095": "Concho",
  "48097": "Cooke",
  "48099": "Coryell",
  "48101": "Cottle",
  "48103": "Crane",
  "48105": "Crockett",
  "48107": "Crosby",
  "48109": "Culberson",
  "48111": "Dallam",
  "48113": "Dallas",
  "48115": "Dawson",
  "48117": "Deaf Smith",
  "48119": "Delta",
  "48121": "Denton",
  "48123": "DeWitt",
  "48125": "Dickens",
  "48127": "Dimmit",
  "48129": "Donley",
  "48131": "Duval",
  "48133": "Eastland",
  "48135": "Ector",
  "48137": "Edwards",
  "48139": "Ellis",
  "48141": "El Paso",
  "48143": "Erath",
  "48145": "Falls",
  "48147": "Fannin",
  "48149": "Fayette",
  "48151": "Fisher",
  "48153": "Floyd",
  "48155": "Foard",
  "48157": "Fort Bend",
  "48159": "Franklin",
  "48161": "Freestone",
  "48163": "Frio",
  "48165": "Gaines",
  "48167": "Galveston",
  "48169": "Garza",
  "48171": "Gillespie",
  "48173": "Glasscock",
  "48175": "Goliad",
  "48177": "Gonzales",
  "48179": "Gray",
  "48181": "Grayson",
  "48183": "Gregg",
  "48185": "Grimes",
  "48187": "Guadalupe",
  "48189": "Hale",
  "48191": "Hall",
  "48193": "Hamilton",
  "48195": "Hansford",
  "48197": "Hardeman",
  "48199": "Hardin",
  "48201": "Harris",
  "48203": "Harrison",
  "48205": "Hartley",
  "48207": "Haskell",
  "48209": "Hays",
  "48211": "Hemphill",
  "48213": "Henderson",
  "48215": "Hidalgo",
  "48217": "Hill",
  "48219": "Hockley",
  "48221": "Hood",
  "48223": "Hopkins",
  "48225": "Houston",
  "48227": "Howard",
  "48229": "Hudspeth",
  "48231": "Hunt",
  "48233": "Hutchinson",
  "48235": "Irion",
  "48237": "Jack",
  "48239": "Jackson",
  "48241": "Jasper",
  "48243": "Jeff Davis",
  "48245": "Jefferson",
  "48247": "Jim Hogg",
  "48249": "Jim Wells",
  "48251": "Johnson",
  "48253": "Jones",
  "48255": "Karnes",
  "48257": "Kaufman",
  "48259": "Kendall",
  "48261": "Kenedy",
  "48263": "Kent",
  "48265": "Kerr",
  "48267": "Kimble",
  "48269": "King",
  "48271": "Kinney",
  "48273": "Kleberg",
  "48275": "Knox",
  "48277": "Lamar",
  "48279": "Lamb",
  "48281": "Lampasas",
  "48283": "La Salle",
  "48285": "Lavaca",
  "48287": "Lee",
  "48289": "Leon",
  "48291": "Liberty",
  "48293": "Limestone",
  "48295": "Lipscomb",
  "48297": "Live Oak",
  "48299": "Llano",
  "48301": "Loving",
  "48303": "Lubbock",
  "48305": "Lynn",
  "48307": "McCulloch",
  "48309": "McLennan",
  "48311": "McMullen",
  "48313": "Madison",
  "48315": "Marion",
  "48317": "Martin",
  "48319": "Mason",
  "48321": "Matagorda",
  "48323": "Maverick",
  "48325": "Medina",
  "48327": "Menard",
  "48329": "Midland",
  "48331": "Milam",
  "48333": "Mills",
  "48335": "Mitchell",
  "48337": "Montague",
  "48339": "Montgomery",
  "48341": "Moore",
  "48343": "Morris",
  "48345": "Motley",
  "48347": "Nacogdoches",
  "48349": "Navarro",
  "48351": "Newton",
  "48353": "Nolan",
  "48355": "Nueces",
  "48357": "Ochiltree",
  "48359": "Oldham",
  "48361": "Orange",
  "48363": "Palo Pinto",
  "48365": "Panola",
  "48367": "Parker",
  "48369": "Parmer",
  "48371": "Pecos",
  "48373": "Polk",
  "48375": "Potter",
  "48377": "Presidio",
  "48379": "Rains",
  "48381": "Randall",
  "48383": "Reagan",
  "48385": "Real",
  "48387": "Red River",
  "48389": "Reeves",
  "48391": "Refugio",
  "48393": "Roberts",
  "48395": "Robertson",
  "48397": "Rockwall",
  "48399": "Runnels",
  "48401": "Rusk",
  "48403": "Sabine",
  "48405": "San Augustine",
  "48407": "San Jacinto",
  "48409": "San Patricio",
  "48411": "San Saba",
  "48413": "Schleicher",
  "48415": "Scurry",
  "48417": "Shackelford",
  "48419": "Shelby",
  "48421": "Sherman",
  "48423": "Smith",
  "48425": "Somervell",
  "48427": "Starr",
  "48429": "Stephens",
  "48431": "Sterling",
  "48433": "Stonewall",
  "48435": "Sutton",
  "48437": "Swisher",
  "48439": "Tarrant",
  "48441": "Taylor",
  "48443": "Terrell",
  "48445": "Terry",
  "48447": "Throckmorton",
  "48449": "Tom Green",
  "48451": "Tom Green",
  "48453": "Travis",
  "48455": "Trinity",
  "48457": "Tyler",
  "48459": "Upshur",
  "48461": "Upton",
  "48463": "Uvalde",
  "48465": "Val Verde",
  "48467": "Van Zandt",
  "48469": "Victoria",
  "48471": "Walker",
  "48473": "Waller",
  "48475": "Ward",
  "48477": "Washington",
  "48479": "Webb",
  "48481": "Wharton",
  "48483": "Wheeler",
  "48485": "Wichita",
  "48487": "Wilbarger",
  "48489": "Willacy",
  "48491": "Williamson",
  "48493": "Wilson",
  "48495": "Winkler",
  "48497": "Wise",
  "48499": "Wood",
  "48501": "Yoakum",
  "48503": "Young",
  "48505": "Zapata",
  "48507": "Zavala",
};

/**
 * The counties whose parcel geometry is LOADED into `txgio_parcel`.
 *
 * This is a claim about what the store CONTAINS, not about what the
 * ingest may fetch — `resolveTxgioCounty` resolves all 254. It stays
 * hand-maintained because `jurisdictions.ts` composes it into
 * `getJurisdictionConfig().geometry`, where presence means "this county
 * has parcel geometry available"; asserting that for a county with no
 * rows would be a fabricated capability.
 *
 * Order: original v1 pair, then the metro-5 (formerly live-only), then
 * the three gap counties, then the DFW fan. Add a county when its load
 * lands.
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
  // DFW fan (2026-08-04)
  "48113": county("48113", "Dallas"),
  "48439": county("48439", "Tarrant"),
  "48085": county("48085", "Collin"),
  "48121": county("48121", "Denton"),
  "48397": county("48397", "Rockwall"),
  "48139": county("48139", "Ellis"),
  "48251": county("48251", "Johnson"),
  "48257": county("48257", "Kaufman"),
  "48367": county("48367", "Parker"),
};

/** True when `fips` is one of the 254 real Texas counties. */
export function isTexasCountyFips(fips: string): boolean {
  return TXGIO_STATEWIDE_COUNTIES[fips.trim()] !== undefined;
}

/** True when the county's geometry is already loaded into `txgio_parcel`. */
export function isTxgioCountyLoaded(fips: string): boolean {
  return TXGIO_COUNTIES[fips.trim()] !== undefined;
}

/**
 * Resolve a county by FIPS or by name, across ALL 254 Texas counties —
 * not only the loaded ones. Returns `undefined` for anything that is
 * not a real Texas county, so the CLI still fails closed on a typo or
 * an out-of-state FIPS before any network call.
 *
 * A loaded county returns its `TXGIO_COUNTIES` entry by identity (the
 * object `jurisdictions.ts` composes), so existing referential-equality
 * expectations hold; an unloaded county gets an equivalent record built
 * from the same statewide URL template.
 */
export function resolveTxgioCounty(input: string): TxgioCounty | undefined {
  const key = input.trim();
  // Loaded counties resolve to their existing registry object by identity.
  if (TXGIO_COUNTIES[key]) return TXGIO_COUNTIES[key];
  const statewideName = TXGIO_STATEWIDE_COUNTIES[key];
  if (statewideName) return county(key, statewideName);

  const lower = key.toLowerCase();
  const loadedByName = Object.values(TXGIO_COUNTIES).find(
    (c) => c.name.toLowerCase() === lower,
  );
  if (loadedByName) return loadedByName;
  const entry = Object.entries(TXGIO_STATEWIDE_COUNTIES).find(
    ([, name]) => name.toLowerCase() === lower,
  );
  return entry ? county(entry[0], entry[1]) : undefined;
}
