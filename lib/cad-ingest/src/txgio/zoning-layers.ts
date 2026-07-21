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
   */
  codeExtractRegex?: string;
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
  // San Marcos (Hays). Setback table is a STUB (san-marcos-tx.json has empty
  // districts[] — blocked on code-atom corpus onboarding + acceptance gate).
  // Zoning still stamps the real district (`ZoneCode`, e.g. R-1-10/MU-2/C);
  // the envelope route returns "no codified setbacks yet" until the table is
  // populated. SETBACK TABLE OWED (populate districts[] once corpus lands).
  "san-marcos-tx": {
    cityKey: "san-marcos-tx",
    cityName: "San Marcos",
    countyFips: "48209",
    layerUrl:
      "https://smgis.sanmarcostx.gov/arcgis/rest/services/MPN/MyPermitNowFeatures/MapServer/6",
    codeField: "ZONECODE",
    descriptionField: "ZONINGDISTRICT",
  },
  // Cedar Park (Williamson). No setback table yet. GIS `ZoningAbbrev` clean
  // codes (SR/UR/MF/DR/LB/NB/PO/SU). SETBACK TABLE OWED (cedar-park-tx.json).
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
  // Pflugerville (Travis). No setback table yet. GIS `ZOINING_TY` (source
  // field-name typo, kept verbatim) clean codes (SF-S/R/MF-20/GB1/GB2/LI/O).
  // First Travis-county zoning layer. SETBACK TABLE OWED (pflugerville-tx.json).
  "pflugerville-tx": {
    cityKey: "pflugerville-tx",
    cityName: "Pflugerville",
    countyFips: "48453",
    layerUrl:
      "https://maps.pflugervilletx.gov/arcgis/rest/services/Planning/Zoning_Districts/FeatureServer/0",
    codeField: "ZOINING_TY",
    descriptionField: "ZONING_DES",
  },
  // Bastrop city (Bastrop). A setback table EXISTS (bastrop-tx.json) but it
  // codifies the OLD conventional code (R-MD/C-1/I-1/DT-1). The LIVE GIS layer
  // is the B3 FORM-BASED "Place Type" code (P-1..P-5/P-CS/P-EC/PDD) — these do
  // NOT align with the existing table's tokens, so the stamp writes the real
  // Place Type but the envelope will fall back until a P-* table lands.
  // SETBACK TABLE OWED (a Place-Type table; the current bastrop-tx.json is the
  // wrong edition for this GIS layer). First Bastrop-county zoning layer.
  "bastrop-city-tx": {
    cityKey: "bastrop-city-tx",
    cityName: "Bastrop",
    countyFips: "48021",
    layerUrl:
      "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Zoning_Place_Type/FeatureServer/0",
    codeField: "PlaceTypeClass",
    descriptionField: "PlaceType",
  },
  // San Antonio (Bexar). No setback table yet. Large public COSA layer;
  // `Base` carries the clean base-zone code (R-*/MF-*/C-*/O-*/I-*/D/UD/...),
  // the composite `Zoning` field mixes in overlays so `Base` is the correct
  // field. First Bexar-county zoning layer. SETBACK TABLE OWED
  // (san-antonio-tx.json — sizeable district set).
  "san-antonio-tx": {
    cityKey: "san-antonio-tx",
    cityName: "San Antonio",
    countyFips: "48029",
    layerUrl:
      "https://services.arcgis.com/g1fRTDLeMgspWrYp/arcgis/rest/services/COSA_Zoning/FeatureServer/12",
    codeField: "Base",
    descriptionField: "BaseDescription",
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
};

export function resolveZoningLayer(input: string): ZoningLayerConfig | undefined {
  const key = input.trim().toLowerCase();
  if (ZONING_LAYERS[key]) return ZONING_LAYERS[key];
  return Object.values(ZONING_LAYERS).find(
    (c) => c.cityName.toLowerCase() === key || c.countyFips === key,
  );
}
