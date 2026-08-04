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
  /**
   * OPTIONAL. Regex STRING with exactly ONE capture group, applied to the
   * raw `codeField` value to extract the real district code BEFORE it is
   * stamped. When present, the field value is matched against
   * `new RegExp(codeExtractRegex)` and capture group 1 becomes the stamped
   * code (still RAW — no further transform; the leading-token normalization
   * in districtMapping does the alignment, per THE MATCH CONTRACT above).
   * If the regex does not match a given feature's value, that feature's
   * code falls through to NULL (honest — never a guessed district).
   * When ABSENT, behavior is exactly as today: the raw field value is the
   * code (Georgetown has none). Example (Hutto): the field value is
   * "Single Family (SF-1)"; with `codeExtractRegex` = `\(([^)]+)\)` the
   * stamped code is "SF-1", which normalizes to the "SF-1 ..." setback row.
   * Applied AFTER `codeDomainMap` (when both are set).
   */
  codeExtractRegex?: string;
  /**
   * OPTIONAL. Map ArcGIS coded-domain integer (or other raw) values to the
   * district string that must be stamped. Keys are the string form of the
   * raw field value (`"3"` for small-integer domain code 3). When present,
   * only mapped values stamp; unmapped raw codes become NULL (never stamp
   * a bare `"3"` that the setback router cannot match). Example (Bastrop
   * Zoned_Parcels/83 `ZoneTypeClass`): `"3"` → `"SF-1"`.
   */
  codeDomainMap?: Record<string, string>;
  /**
   * OPTIONAL. Codes that are NOT zoning districts and must never be stamped
   * (left as NULL on the parcel). Example: San Antonio `OCL` (Outside City
   * Limits) and `UZROW` (unzoneable right-of-way). Compared case-insensitively
   * after trim against the extracted code.
   */
  nullDistrictCodes?: string[];
  /**
   * OPTIONAL. ArcGIS `where` clause for the zoning-layer query (default
   * `1=1`). Use to shrink oversized layers before fetch (e.g. San Antonio
   * excluding OCL/UZROW polygons so the in-memory index stays tractable).
   */
  layerWhere?: string;
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
  "round-rock-tx": {
    cityKey: "round-rock-tx",
    cityName: "Round Rock",
    countyFips: "48491",
    layerUrl:
      "https://maps.roundrocktexas.gov/arcgis/rest/services/Planning/Planning_Multi/MapServer/12",
    codeField: "BASE_ZONIN",
    descriptionField: "URL",
  },
  "leander-tx": {
    cityKey: "leander-tx",
    cityName: "Leander",
    countyFips: "48491",
    layerUrl:
      "https://services1.arcgis.com/L0MLvN0Ay0iEjnCT/arcgis/rest/services/Leander_Current_Zoning/FeatureServer/3",
    codeField: "Use_",
    descriptionField: "Descr",
  },
  "new-braunfels-tx": {
    cityKey: "new-braunfels-tx",
    cityName: "New Braunfels",
    countyFips: "48091",
    layerUrl:
      "https://gismaps.newbraunfels.gov/arcserverwa22/rest/services/OpenData/PlanningZoning/MapServer/9",
    codeField: "District",
    descriptionField: "Name",
  },
  "dripping-springs-tx": {
    cityKey: "dripping-springs-tx",
    cityName: "Dripping Springs",
    countyFips: "48209",
    layerUrl:
      "https://services6.arcgis.com/XnTA1N5QxtOFa9o8/arcgis/rest/services/CODS_Zoning/FeatureServer/0",
    codeField: "Zoning_Abbreviation",
    descriptionField: "Zoning_District",
  },
  "hutto-tx": {
    cityKey: "hutto-tx",
    cityName: "Hutto",
    countyFips: "48491",
    layerUrl:
      "https://services.arcgis.com/YZhxlqU7ABWQBGTG/arcgis/rest/services/Hutto_Zoning_Districts/FeatureServer/0",
    codeField: "ZONING",
    descriptionField: "ZONING",
    codeExtractRegex: "\\(([^)]+)\\)",
  },

  // ---------------------------------------------------------------------------
  // Expansion 2026-07-21 — 10 more Central-TX cities, all LIVE-VERIFIED
  // (f=json metadata + /query sample). Fills the "zoning: not verified here"
  // gap so a stamped district unlocks the setback/buildable-envelope route.
  // Per city: whether a setback table already exists is called out below —
  // where a table is OWED, the zoning stamp still writes the real district
  // (the envelope route degrades to null dimensional rules until the table
  // lands, never a guessed setback). Setback-table alignment (per THE MATCH
  // CONTRACT: leading token of district_name, normalized upper + strip
  // non-alphanumeric) verified against live GIS codes where a table exists.
  // ---------------------------------------------------------------------------

  // Buda (Hays). Setback table EXISTS (buda-tx.json, R-1..R-5/R-MH/AG/B-1).
  // GIS `Zoning_Category` codes "R1"/"B1"/"AG" normalize to "R1"/"B1"/"AG" and
  // match setback tokens "R-1"/"B-1"/"AG" (hyphens stripped by normalizeCode);
  // "R2-C"/"R3/R4" prefix-map to R-2/R-3. F1..F5/HI/LI/PD are form-based /
  // commercial with no setback row -> conservative fallback (honest).
  "buda-tx": {
    cityKey: "buda-tx",
    cityName: "Buda",
    countyFips: "48209",
    layerUrl:
      "https://services6.arcgis.com/vXZW4vAaPRr14z2s/arcgis/rest/services/Zoning/FeatureServer/0",
    codeField: "Zoning_Category",
    descriptionField: "Zoning_Description",
  },
  // Kyle (Hays). Setback table EXISTS (kyle-tx.json, R-1-1/R-1-2/R-1-3/R-2/
  // R-3-1/R-3-2). GIS `Z_Code` carries those exact tokens verbatim -> exact
  // match. Was token-gated in a prior recon; the public path is this
  // utility.arcgis.com/usrsvcs proxy layer, which resolves WITHOUT a token
  // (verified live 2026-07-21). Remaining GIS codes (A/C-2/CBD-*/MXD/PUD/...)
  // have no setback row -> conservative fallback.
  "kyle-tx": {
    cityKey: "kyle-tx",
    cityName: "Kyle",
    countyFips: "48209",
    layerUrl:
      "https://utility.arcgis.com/usrsvcs/servers/cb715452b5464cd08d53449e26fa913d/rest/services/KCH-ESRI/Zoning/FeatureServer/0",
    codeField: "Z_Code",
    descriptionField: "Description",
  },
  // San Marcos (Hays). The cited table maps direct ZONECODE rows SF-6,
  // SF-4.5, and ND-3. Other stamped codes remain explicit table-note gaps
  // until their district/building-type standards are independently resolved.
  "san-marcos-tx": {
    cityKey: "san-marcos-tx",
    cityName: "San Marcos",
    countyFips: "48209",
    layerUrl:
      "https://smgis.sanmarcostx.gov/arcgis/rest/services/MPN/MyPermitNowFeatures/MapServer/6",
    codeField: "ZONECODE",
    descriptionField: "ZONINGDISTRICT",
  },
  // Cedar Park (Williamson). Cited table maps DR/SR/SU/MF/NB/LB/PO; UR and
  // other live codes remain explicit table-note gaps.
  "cedar-park-tx": {
    cityKey: "cedar-park-tx",
    cityName: "Cedar Park",
    countyFips: "48491",
    layerUrl:
      "https://gisrest.cedarparktexas.gov/cpgis/rest/services/Planning/Zoning/MapServer/3",
    codeField: "ZoningAbbrev",
    descriptionField: "ZoningType",
  },
  // Taylor (Williamson). Form-based SmartCode "Place Type" system (P2/P2.5/
  // P3/P3M/P4/P5/EC/CS) — no conventional R-1/C-1 districts. `First_Plac`
  // holds the clean place-type code. SETBACK TABLE OWED (a form-based /
  // place-type table, if one is codifiable).
  "taylor-tx": {
    cityKey: "taylor-tx",
    cityName: "Taylor",
    countyFips: "48491",
    layerUrl:
      "https://services7.arcgis.com/SQVxkeGOcRYhZqOD/arcgis/rest/services/Zoning_011720/FeatureServer/46",
    codeField: "First_Plac",
    descriptionField: "First_Plac",
  },
  // Liberty Hill (Williamson). No setback table yet. Field names are INVERTED:
  // `SHORT_DESC` holds the clean CODE (AG/C1/C2/C3/SF1/SF2/SF3/MF2/I-1/MH1/
  // PUD/PARK), `ZONING` holds the long name -> descriptionField. SETBACK TABLE
  // OWED (liberty-hill-tx.json).
  "liberty-hill-tx": {
    cityKey: "liberty-hill-tx",
    cityName: "Liberty Hill",
    countyFips: "48491",
    layerUrl:
      "https://services8.arcgis.com/qwMz1Ra8Qny9RDxC/ArcGIS/rest/services/Zoning_241031/FeatureServer/0",
    codeField: "SHORT_DESC",
    descriptionField: "ZONING",
  },
  // Pflugerville (Travis). GIS `ZOINING_TY` (source field-name typo, kept
  // verbatim) maps cited rows SF-S/SF-R/MF-20. GB1/GB2/LI/O remain explicit
  // table-note gaps pending non-residential dimensional extraction.
  "pflugerville-tx": {
    cityKey: "pflugerville-tx",
    cityName: "Pflugerville",
    countyFips: "48453",
    layerUrl:
      "https://maps.pflugervilletx.gov/arcgis/rest/services/Planning/Zoning_Districts/FeatureServer/0",
    codeField: "ZOINING_TY",
    descriptionField: "ZONING_DES",
  },
  // Austin (Travis). LIVE-VERIFIED 2026-07-24: Publish_Zoning_AGOL/0,
  // `BASE_ZONE` carries clean tokens (SF-1..SF-6, MF-1..MF-6, …). Setback
  // table EXISTS (austin-tx.json) for SF-1/2/3 + MF-1..MF-6 — remaining GIS
  // codes stamp as zoning-present / setback-pending (honest). Match contract
  // CLEAN (leading-token). Second Travis layer — jurisdiction is per-parcel
  // via stamped zoning_jurisdiction (PIP cityKey), not a county sole-key.
  "austin-tx": {
    cityKey: "austin-tx",
    cityName: "Austin",
    countyFips: "48453",
    layerUrl:
      "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/Publish_Zoning_AGOL/FeatureServer/0",
    codeField: "BASE_ZONE",
    descriptionField: "BASE_ZONE_CATEGORY",
  },
  // Bastrop city (Bastrop). B3 Place Types are REPEALED (Ord. 2026-06 /
  // 2026-04-14). LIVE law is BDC Euclidean districts. Stamp reads
  // Zoned_Parcels FeatureServer/83 `ZoneTypeClass` (short coded domain:
  // 1=P/OS … 3=SF-1 … 10=PDD). Prefer ZoneTypeClass over ZoneType (long
  // names). Domain ints MUST decode via codeDomainMap — naive stamp of "3"
  // would miss the BDC router looking for "SF-1". CORRECTION A: this layer
  // maps parcel→district ONLY; setback NUMBERS come from ordinance text
  // (Sec. 14.02.003), never GIS card FrontSetback/SideSetback fields.
  // Abandoned Zoning_Place_Type/0 PlaceTypeClass (P-x) must not be used.
  "bastrop-city-tx": {
    cityKey: "bastrop-city-tx",
    cityName: "Bastrop",
    countyFips: "48021",
    layerUrl:
      "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Zoned_Parcels/FeatureServer/83",
    codeField: "ZoneTypeClass",
    descriptionField: "ZoneDesc",
    // LIVE ZoneTypeClass codedValue domain (planner-probed 2026-07-29).
    codeDomainMap: {
      "1": "P/OS",
      "2": "RR",
      "3": "SF-1",
      "4": "SF-2",
      "5": "SF-3",
      "6": "MU",
      "7": "GC",
      "8": "PI",
      "9": "IND",
      "10": "PDD",
    },
  },
  // San Antonio (Bexar). Setback table EXISTS (san-antonio-tx.json, WDLL 51
  // Table 310-1 rows — RE/R-*/RM-*/MF-*/C-1..C-3/O-2/I-1/I-2). GIS `Base`
  // carries the clean base-zone code; composite `Zoning` mixes overlays so
  // `Base` is correct. OCL (Outside City Limits) and UZROW are NOT districts
  // — nullDistrictCodes + layerWhere exclude them from the index/stamp.
  // Under-stamp root cause (0.37%): ArcGIS paging stopped after one full page
  // when hosts omit `exceededTransferLimit` — fixed in zoning-service
  // fetchZoningFeatures 2026-07-24.
  "san-antonio-tx": {
    cityKey: "san-antonio-tx",
    cityName: "San Antonio",
    countyFips: "48029",
    layerUrl:
      "https://services.arcgis.com/g1fRTDLeMgspWrYp/arcgis/rest/services/COSA_Zoning/FeatureServer/12",
    codeField: "Base",
    descriptionField: "BaseDescription",
    nullDistrictCodes: ["OCL", "UZROW"],
    layerWhere: "Base NOT IN ('OCL','UZROW')",
  },
  // Elgin (Bastrop, 48021). SECOND Bastrop-county city zoning layer
  // (Bastrop city is "bastrop-city-tx" above). Elgin_Zoning FeatureServer
  // layer 0 covers the Bastrop-county-side cohort (CITY_LIMIT='ELGIN',
  // ~3,220 parcels); the SAME FeatureServer's layer 1 (~500 parcels,
  // fips 48453 Travis-county-side sliver) is a NAMED FOLLOW-ON, out of
  // this pass — not wired here. `Zone_Code` carries the raw district
  // token; every district's raw value equals its canonical setback
  // district_name leading token (Sec. 46-203 roster: R-1/R-2/R-3/C-1/
  // C-2/C-3/I) EXCEPT the multifamily district, which the ordinance names
  // "R-4" (Sec. 46-203(1)d) but the GIS layer stamps "A" (a legacy code
  // letter — confirmed by ordinance text: Sec. 46-391/46-417 both read
  // C-2/C-3 dwelling uses as governed "the same as ... the A-Multiple-
  // Family Residential District"). codeDomainMap decodes that one
  // divergence (A -> R-4). Per codeDomainMap semantics (see the type doc
  // above), when the map is present ONLY listed values stamp — unmapped
  // raw codes become NULL — so the other 7 districts are listed here too,
  // each as an identity mapping (e.g. "R-1" -> "R-1"), to keep them
  // stamping rather than silently falling through to NULL. SETBACK TABLE
  // OWED (elgin-development-code.json is a DRAFT in hauska-engine
  // packages/adapters/src/local/setbacks/, pending planner row-
  // verification + operator ratification — not yet ported to this repo's
  // lib/adapters copy or registered for serve).
  "elgin-tx": {
    cityKey: "elgin-tx",
    cityName: "Elgin",
    countyFips: "48021",
    layerUrl:
      "https://services3.arcgis.com/wdTkTU0MdZbNBEZy/arcgis/rest/services/Elgin_Zoning/FeatureServer/0",
    codeField: "Zone_Code",
    descriptionField: "Zoning",
    layerWhere: "CITY_LIMIT = 'ELGIN'",
    codeDomainMap: {
      "R-1": "R-1",
      "R-2": "R-2",
      "R-3": "R-3",
      A: "R-4",
      "C-1": "C-1",
      "C-2": "C-2",
      "C-3": "C-3",
      I: "I",
    },
  },
  // Lockhart (Caldwell). No setback table yet. GIS `ZONING` carries the bare
  // code (RLD/RMD/RHD/CCB/CHB/CLB/CMB/IH/IL/MH/PDD/PI/AO). First Caldwell-
  // county zoning layer. SETBACK TABLE OWED (lockhart-tx.json).
  "lockhart-tx": {
    cityKey: "lockhart-tx",
    cityName: "Lockhart",
    countyFips: "48055",
    layerUrl:
      "https://services3.arcgis.com/kPfGI7KGlXn5IaHL/arcgis/rest/services/Lockhart_City_Zoning_Online/FeatureServer/0",
    codeField: "ZONING",
  },

  // ---------------------------------------------------------------------------
  // Post-breadth zero-county wires (2026-07-24) — Guadalupe / McLennan / Bell
  // were recorded at honest-0% zoning; re-probe after ArcGIS paging fix showed
  // published city layers (un-wired), not genuine unzoned counties. Temple TX
  // and Schertz TX still lack a verified public FeatureServer → stay unwired
  // (honest absence for those city footprints until a layer is published).
  // SETBACK TABLES OWED for all five; stamp writes real districts only.
  // ---------------------------------------------------------------------------

  // Seguin (Guadalupe 48187). Planning/Zoning layer 1 `zone` (A-R/R-1/M-R/…).
  // Layer 0 is corridor overlays — do NOT use. SETBACK TABLE OWED.
  "seguin-tx": {
    cityKey: "seguin-tx",
    cityName: "Seguin",
    countyFips: "48187",
    layerUrl:
      "https://gis.seguintexas.gov/arcgis/rest/services/Planning/Zoning/FeatureServer/1",
    codeField: "zone",
    descriptionField: "orgzon",
    nullDistrictCodes: ["None", "ROW"],
  },
  // Cibolo (Guadalupe 48187). Hosted view `ZONING` (SF-1..SF-6/MF-*/C-*/…).
  // SETBACK TABLE OWED.
  "cibolo-tx": {
    cityKey: "cibolo-tx",
    cityName: "Cibolo",
    countyFips: "48187",
    layerUrl:
      "https://services3.arcgis.com/D32JCd9p0r1BYMwd/arcgis/rest/services/City_of_Cibolo__Zoning_(view)/FeatureServer/0",
    codeField: "ZONING",
    descriptionField: "Zoning_des",
  },
  // Waco (McLennan 48309). PublicMap Planning FS layer 1 `ZONING`
  // (R-1A../C-*/M-*/PUD). OUT/STATE are not districts. SETBACK TABLE OWED.
  "waco-tx": {
    cityKey: "waco-tx",
    cityName: "Waco",
    countyFips: "48309",
    layerUrl:
      "https://gis.wacotx.gov/server/rest/services/PublicMap/PublicMap_Planning_and_Economical_Development/FeatureServer/1",
    codeField: "ZONING",
    nullDistrictCodes: ["OUT", "STATE"],
    layerWhere: "ZONING NOT IN ('OUT','STATE')",
  },
  // Killeen (Bell 48027). Zoning/MapServer/7 Current Zoning `CODE`
  // (R-1/R-2/R-3/B-*/…). SETBACK TABLE OWED.
  "killeen-tx": {
    cityKey: "killeen-tx",
    cityName: "Killeen",
    countyFips: "48027",
    layerUrl:
      "https://killeengis.killeentexas.gov/arcgis/rest/services/Zoning/MapServer/7",
    codeField: "CODE",
  },
  // Belton (Bell 48027). Planning FS layer 6 Current_Zoning `Zoning_Abbr`.
  // Values include PD composites — stamped RAW (fact); setback match may
  // miss until a table lands. SETBACK TABLE OWED. Temple remains unwired
  // (no verified public FeatureServer as of 2026-07-24).
  "belton-tx": {
    cityKey: "belton-tx",
    cityName: "Belton",
    countyFips: "48027",
    layerUrl:
      "https://services5.arcgis.com/FkDUU6xkZJTbBa9X/arcgis/rest/services/Planning/FeatureServer/6",
    codeField: "Zoning_Abbr",
    descriptionField: "Zoning",
  },
};

export function resolveZoningLayer(input: string): ZoningLayerConfig | undefined {
  const key = input.trim().toLowerCase();
  if (ZONING_LAYERS[key]) return ZONING_LAYERS[key];
  return Object.values(ZONING_LAYERS).find(
    (c) => c.cityName.toLowerCase() === key || c.countyFips === key,
  );
}

/**
 * All wired cityKeys for a county FIPS. Always a Set — never assume one.
 * Empty set means no zoning layer is registered for that county.
 */
export function wiredZoningCityKeys(countyFips: string): Set<string> {
  const fips = countyFips.trim();
  return new Set(
    Object.values(ZONING_LAYERS)
      .filter((z) => z.countyFips === fips)
      .map((z) => z.cityKey),
  );
}

export interface ZoningJurisdictionParcel {
  /** Stamped cityKey from the PIP-matched layer (`austin-tx`). */
  zoningJurisdiction?: string | null;
  /** Optional situs city — FALLBACK only when stamped jurisdiction is null. */
  situsCity?: string | null;
  countyFips?: string | null;
}

/**
 * Resolve the zoning jurisdiction for ONE parcel.
 *
 * PIP membership is authoritative: when `zoning_jurisdiction` was stamped
 * from the matched city layer, return that cityKey. Unincorporated / no
 * match → null (honest fact, not a failure).
 *
 * `situs_city` is a FALLBACK tiebreaker only (rare overlapping-layer or
 * pre-migration rows). When used, the caller's `onSitusFallback` may log.
 * Returns hyphen cityKey form matching ZONING_LAYERS / setback tables.
 */
export function resolveZoningJurisdiction(
  parcel: ZoningJurisdictionParcel,
  opts?: {
    onSitusFallback?: (info: {
      cityKey: string;
      situsCity: string;
      countyFips: string;
    }) => void;
  },
): string | null {
  const stamped = typeof parcel.zoningJurisdiction === "string"
    ? parcel.zoningJurisdiction.trim().toLowerCase().replace(/_/g, "-")
    : "";
  if (stamped && ZONING_LAYERS[stamped]) return stamped;
  if (stamped) return stamped; // unknown-but-stamped key still wins over guess

  const situs = typeof parcel.situsCity === "string"
    ? parcel.situsCity.trim()
    : "";
  const fips = typeof parcel.countyFips === "string"
    ? parcel.countyFips.trim()
    : "";
  if (!situs || !fips) return null;

  const wired = wiredZoningCityKeys(fips);
  if (wired.size === 0) return null;

  const situsNorm = situs.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const cityKey of wired) {
    const layer = ZONING_LAYERS[cityKey];
    if (!layer) continue;
    const nameNorm = layer.cityName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    if (situsNorm === nameNorm || situsNorm.includes(nameNorm)) {
      opts?.onSitusFallback?.({
        cityKey,
        situsCity: situs,
        countyFips: fips,
      });
      return cityKey;
    }
  }
  return null;
}

/**
 * @deprecated Use {@link resolveZoningJurisdiction} (per-parcel) or
 * {@link wiredZoningCityKeys} (county Set). County-level "sole city" was
 * the wrong model — every county is multi-city; this always returns null.
 */
export function soleZoningJurisdictionKey(_countyFips: string): string | null {
  return null;
}
