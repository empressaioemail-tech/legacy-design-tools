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
 * 2026-07-20 for the rows that existed then (RE/RS/TF/TH/MF-1/MF-2/
 * CN/C-1/C-3/OF/IN); the 5 GIS-only codes (AG/BP/MH/MU-DT/PF) had no
 * setback row at that time and correctly hit the conservative fallback.
 * CORRECTED 2026-09-16 (P-258 lane-c): that verification list named RL as
 * covered, which was never true — Georgetown's single-family rows are
 * RE/RT/RS/RM and no row's leading token normalizes to "RL", so an
 * "RL"-stamped parcel correctly falls back. The rewrite's Section 4.02
 * Equivalency Table maps previous-UDC "RL Residential Low Density" onto
 * current-UDC "RT Residential Traditional", so RL land is covered only
 * through its successor's row. AG/MH/PF/MU-DT are now rowed (adopted
 * 2026-08-11, effective 2026-11-01 rewrite vintage, so they are NOT in
 * force on 2026-09-16); BP and RL remain genuine gaps. See
 * georgetown-tx.json's note for both. DO NOT transform the code before
 * stamping — the leading-token contract does the alignment.
 *
 * AMENDED 2026-09-17 (P-259): "do not transform the code" holds for every
 * layer that publishes a base code directly. A layer that publishes a
 * COMPOUND value (Austin's `ZONING_ZTYPE`: "SF-3-HD-NP", "CS-1-MU-V-NCCD-…")
 * sets `baseCodeParse`, and the transform is exactly ONE step — resolve the
 * longest known base district off the front against that city's own setback
 * vocabulary, discarding nothing (overlays, and any second `/`-joined
 * district, are carried on the parsed result rather than thrown away). The
 * stamped result is still a router-normalized district code, so the
 * leading-token contract above is what does the alignment; the parse only
 * decides WHICH district the layer is asserting for that polygon.
 *
 * The stamp is county-scoped (it updates `txgio_parcel` rows for one
 * county) but zoning is a CITY layer, so each config carries the county
 * whose parcels it stamps. A parcel centroid that falls in no zoning
 * polygon (outside the city, or an un-zoned area) is left NULL — honest
 * fallback, never a guessed district.
 */

import type { BaseCodeParseConfig } from "./zoning-base-code";

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
   * OPTIONAL. Resolve the code to its BASE district before stamping, for
   * layers whose published value appends combining districts and overlays to
   * the base with the same separator the base itself uses (`zoning-base-code.ts`
   * has the finding; Austin's `ZONING_ZTYPE` is the case that motivated it:
   * the longest-match rule yields `CS-1` where a naive first-token split yields
   * `CS`, a different row that also exact-matches the router). Applied AFTER
   * `codeDomainMap` and `codeExtractRegex`.
   *
   * When set, a value with no known base district is stamped VERBATIM (never a
   * truncated prefix) and counted apart, and a planned-development value stamps
   * its RAW code as before, so A-164's PUD message still fires. Registry entries
   * are the only place this is set, and only `longest-match` is ever configured.
   */
  baseCodeParse?: BaseCodeParseConfig;
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
  /**
   * OPTIONAL (Burnet stage 3 §3 Bug 2). Set ONLY for a layer whose features
   * ARE the city's own parcel fabric (one feature per CAD parcel, carrying
   * both its own prop id and its zoning code) — Horseshoe Bay's `Zoning
   * Parcels` layer is the case this exists for. When set, the stamp matches
   * each parcel by THIS id FIRST (`buildParcelIdIndex` + `stampCountyZoning`,
   * normalized the same way `--prop-ids-file` ids are): the parcel's own
   * feature decides — a published code stamps it, a blank/null code is a
   * declared "no district on the city's own layer" outcome (never filled in
   * from a neighbour's polygon) — and the point-in-polygon lookup is used
   * only as a fallback when no feature on the layer carries that parcel's
   * id. LEAVE UNSET for a layer whose features are actual DISTRICT polygons
   * (Marble Falls: a handful of zoning polygons, many parcels per polygon,
   * no parcel id on the layer at all) — the point lookup is the only
   * sensible match there and stays the ONLY path when this is unset,
   * byte-identical to pre-Bug-2 behavior.
   */
  parcelIdField?: string;
}

/**
 * Austin's base-district vocabulary, in the router's spelling: the 37
 * `district_name` leading tokens of `lib/adapters/src/local/setbacks/
 * austin-tx.json` (P-258 added 28 rows to that table on 2026-09-16, taking it
 * to 37 districts). Listed explicitly rather than read from the table at
 * runtime: `cad-ingest` does not depend on `adapters`/`api-server`, and a typo
 * in a table row should not silently become this parser's vocabulary.
 * `zoning-base-code.test.ts` asserts this list EQUALS the table's
 * leading-token set (read at source) and that every member normalizes to a
 * code `mapDistrict` exact-matches, so it cannot drift from the row it must
 * hit.
 */
export const AUSTIN_BASE_CODES = [
  "SF-1",
  "SF-2",
  "SF-3",
  "SF-4A",
  "SF-4B",
  "SF-5",
  "SF-6",
  "MF-1",
  "MF-2",
  "MF-3",
  "MF-4",
  "MF-5",
  "MF-6",
  "CS",
  "CS-1",
  "GR",
  "LI",
  "RR",
  "P",
  "LO",
  "LA",
  "LR",
  "MH",
  "DR",
  "CBD",
  "GO",
  "DMU",
  "NO",
  "IP",
  "W/LO",
  "CH",
  "AV",
  "MI",
  "AG",
  "R&D",
  "CR",
  "L",
] as const;

/**
 * Planned-development codes (A-164: their setbacks come from their own
 * ordinance, so they get the PUD message rather than a district). Pattern text
 * and flag are copied VERBATIM from P-255's census
 * (`doc_repo/scripts/setback-parcel-census.mjs`: `PLANNED_DEVELOPMENT =
 * /^(PUD|PDD|PD|PC|P-?U-?D)([\s-].*)?$/i`), which P-256 also copied into the
 * factory writer — three implementations would only be a divergence risk if
 * they disagreed, so they carry the same formula.
 *
 * Austin's measured PD-shaped values (live layer, 2026-09-17): PUD (1,062
 * polygons), PUD-NP (77), PUD-H-NP (1), PUD-H (1), PUD-NCCD-NP (1) — 1,142
 * polygons over 5 values, and no value anywhere in the layer starts with
 * `PD`, `PDD` or `PC`. `LI-PUD` (3 polygons) is NOT PD-shaped by this
 * start-anchored formula: it stamps LI with PUD carried as an overlay, and
 * `I-PUD` (1) is interim, so it reads as planned development under
 * {@link AUSTIN_INTERIM_QUALIFIERS}. That is deliberate — see the ORDER note
 * in zoning-base-code.ts.
 */
export const PLANNED_DEVELOPMENT_PATTERN = "^(PUD|PDD|PD|PC|P-?U-?D)([\\s-].*)?$";
export const PLANNED_DEVELOPMENT_FLAGS = "i";

/**
 * Austin's INTERIM qualifier (P-259b, operator ruling 2026-09-17). The layer
 * publishes an interim family as `I-<base>` over 14 live values / 1,229
 * polygons: `I-SF-2` (662), `I-RR` (321), `I-SF-4A` (220), `I-LA` (12),
 * `I-SF-3` (3), `I-GR` (2), `I-MF-3` (2), and 1 each of `I-AV`, `I-MF-2`,
 * `I-PUD`, `I-RR-NP`, `I-SF-1`, `I-SF-2-NP`, `I-SF-6`.
 *
 * A designation granted on annexation until permanent zoning is established,
 * which carries its base district's standards by ordinance — so the value reads
 * as its base with the interim fact disclosed, never as a district of its own
 * and never as a truncation. Source: City of Austin ordinances (C2O-2009-017
 * for the `I-SF-2` reading); the city's 2016 development-standards table gives
 * I-SF-2 front 25 / side 5 / rear 10, which is the shipped `austin-tx.json`
 * SF-2 row. Only `I` is declared: the layer publishes no other interim family,
 * and an undeclared qualifier leaves the value unrecognised as before.
 */
export const AUSTIN_INTERIM_QUALIFIERS = ["I"] as const;

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

  // Buda (Hays). Setback table EXISTS (buda-tx.json: R-1..R-5, R-MH, AG,
  // B-1, plus B-2/B-3/LI/HI added by P-258 lane-c 2026-09-16 from UDC
  // Subsection 2.07.02). GIS `Zoning_Category` codes "R1"/"B1"/"AG"
  // normalize to "R1"/"B1"/"AG" and match setback tokens "R-1"/"B-1"/"AG"
  // (hyphens stripped by normalizeCode); "R2-C"/"R3/R4" prefix-map to R-2/R-3.
  // KNOWN ALIGNMENT DEFECT (recorded, not fixed here): the compound code
  // "B2/R5" normalizes to "B2R5" and PREFIX-matches the B-2 row at 0.7, so the
  // R-5 half of the parcel's code is silently ignored. F1..F5/F3H/F4H/F5H stay
  // form-based (Form Based Code Subsection 2.08, keyed by building type and
  // street type) with no setback row -> conservative fallback (honest), and the
  // east-side "B-5" family has no setback row either.
  "buda-tx": {
    cityKey: "buda-tx",
    cityName: "Buda",
    countyFips: "48209",
    layerUrl:
      "https://services6.arcgis.com/vXZW4vAaPRr14z2s/arcgis/rest/services/Zoning/FeatureServer/0",
    codeField: "Zoning_Category",
    descriptionField: "Zoning_Description",
  },
  // Kyle (Hays). Setback table EXISTS (kyle-tx.json: R-1-1/R-1-2/R-1-3/R-2/
  // R-3-1/R-3-2 plus A, R-3-3, CBD-2, W, CM, HS and NC added by P-258 lane-c
  // 2026-09-16 from Ch. 53 §53-33 Charts 1-3 and §53-662). GIS `Z_Code`
  // carries those exact tokens verbatim -> exact match. Was token-gated in a
  // prior recon; the public path is this utility.arcgis.com/usrsvcs proxy
  // layer, which resolves WITHOUT a token (verified live 2026-07-21).
  // Remaining GIS codes with NO row, all declining honestly: C-1, C-2, CC,
  // M-3, OI, MXD, HI, PUD, A-DA, CBD-1 (its standards are by base use),
  // R-1-T (deferred to Division 5) and R-1-C (deferred to Division 6).
  "kyle-tx": {
    cityKey: "kyle-tx",
    cityName: "Kyle",
    countyFips: "48209",
    layerUrl:
      "https://utility.arcgis.com/usrsvcs/servers/cb715452b5464cd08d53449e26fa913d/rest/services/KCH-ESRI/Zoning/FeatureServer/0",
    codeField: "Z_Code",
    descriptionField: "Description",
  },
  // San Marcos (Hays). P-258 lane-c (2026-09-16) lifted this table from 8
  // rows to 27: the direct ZONECODE rows are now SF-6, SF-4.5, ND-3, ND-3.2,
  // ND-3.5, ND-4, N-CM, SF-R, MH, FD, MU, CC, GC, NC, OP, CD-2/CD-2.5/CD-3/
  // CD-4/CD-5/CD-5D, CM, BP, HC, LI, HI (all quoted from the adopted-redline
  // Development Code, ORD-2026-08). Still NO row: the Chapter 9 LEGACY codes
  // (D, TH, AR, DR, MR, MF-12/MF-18/MF-24, VMU, PH-ZL) — the adopted-redline
  // PDF read this pass stops before Chapter 9 — and CD-1, whose own section
  // (4.4.3.1) states impervious cover and density but no building-setback
  // block at all. Those decline honestly; see san-marcos-tx.json's note.
  "san-marcos-tx": {
    cityKey: "san-marcos-tx",
    cityName: "San Marcos",
    countyFips: "48209",
    layerUrl:
      "https://smgis.sanmarcostx.gov/arcgis/rest/services/MPN/MyPermitNowFeatures/MapServer/6",
    codeField: "ZONECODE",
    descriptionField: "ZONINGDISTRICT",
  },
  // Cedar Park (Williamson). Cited table maps DR/SR/SU/MF/NB/LB/PO plus UR,
  // added by P-258 lane-c (2026-09-16) as a DOCUMENTED CONSERVATIVE ENVELOPE
  // (front 25 / interior side 15 / street side 25 / rear 20 / height 35) with
  // the front-entry-vs-rear-entry and street-class alternatives quoted in the
  // row's provenance -- the GIS "UR" token cannot distinguish them. Still
  // explicit table-note gaps: GB, LI, HC, HI, H, PS, OG, OR, MU, PD. TC is NOT
  // rowed on purpose: the Town Center Code (Art. 11.02 Div. 2 + Regulating
  // Plan) requires no setbacks in Town Center Area 1 and its only table is
  // keyed by lot type.
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
  // holds the clean place-type code. Setback table delivered (WDLL 51,
  // transcribed 2026-07-23) — taylor-tx.json.
  "taylor-tx": {
    cityKey: "taylor-tx",
    cityName: "Taylor",
    countyFips: "48491",
    layerUrl:
      "https://services7.arcgis.com/SQVxkeGOcRYhZqOD/arcgis/rest/services/Zoning_011720/FeatureServer/46",
    codeField: "First_Plac",
    descriptionField: "First_Plac",
  },
  // Liberty Hill (Williamson). Field names are INVERTED: `SHORT_DESC` holds
  // the clean CODE (AG/C1/C2/C3/SF1/SF2/SF3/MF2/I-1/MH1/PUD/PARK), `ZONING`
  // holds the long name -> descriptionField. Setback table delivered (WDLL
  // 51, transcribed 2026-07-23) — liberty-hill-tx.json.
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
  // verbatim) maps cited rows SF-S/SF-R/MF-20 plus the corridor rows CL3/CL4/
  // CL5 added by P-258 lane-c 2026-09-16 (Sec. 4.4 / Table 4.4.4, corridor
  // text last amended by Ord. #1623-24-04-23). GB1/GB2/LI/O/R/CI/NS/PF/GI/
  // SF-E remain explicit table-note gaps pending the Sec. 4.2.4 conventional-
  // district table extraction.
  "pflugerville-tx": {
    cityKey: "pflugerville-tx",
    cityName: "Pflugerville",
    countyFips: "48453",
    layerUrl:
      "https://maps.pflugervilletx.gov/arcgis/rest/services/Planning/Zoning_Districts/FeatureServer/0",
    codeField: "ZOINING_TY",
    descriptionField: "ZONING_DES",
  },
  // ---------------------------------------------------------------------------
  // Austin (Travis 48453, Williamson 48491, Hays 48209). SOURCE REPLACED
  // 2026-09-17 (P-259) — both the layer and the code field changed. Read this
  // before touching it.
  //
  // WAS: Publish_Zoning_AGOL/FeatureServer/0 with `BASE_ZONE`, "LIVE-VERIFIED
  // 2026-07-24 … clean tokens (SF-1..SF-6, MF-1..MF-6, …)".
  //
  // NOW (A-164, measured live 2026-09-15 anonymously; re-measured by this lane
  // at the fixtures' `fetchedAt`): PLANNINGCADASTRE_zoning_large_map_scale/
  // FeatureServer/0 — HTTP 200, 22,504 zoning polygons, spatial reference wkid
  // 102739 (latestWkid 2277, STATE PLANE FEET) with 558 distinct
  // `ZONING_ZTYPE` values and fields `ZONING_BASE` / `ZONING_ZTYPE`.
  // `ZONING_BASE` collapses codes (plain `SF`/`MF`, no numeric suffix) and
  // cannot be used. `ZONING_ZTYPE` is the district PLUS its combining
  // districts and overlays: "SF-3-HD-NP", "MF-4-H-CO",
  // "CS-1-MU-V-NCCD-ETOD-DBETOD-NP".
  //
  // `codeField` is therefore ZONING_ZTYPE and `baseCodeParse` resolves the base
  // off the front with the LONGEST match over AUSTIN_BASE_CODES, so
  // "CS-1-MU-…" stamps CS-1 and never CS. Both CS and CS-1 are real rows in
  // austin-tx.json AND both exact-match the router, so the truncated reading is
  // not a conservative miss, it is the wrong district's setbacks silently.
  // A value with no known base is stamped VERBATIM and counted separately: the
  // interim `I-*` family (measured: 14 distinct values, 1,229 polygons), the
  // overlay families the layer publishes as bare values (TOD/TOD-NP/TOD-CURE-NP/
  // TOD-H-NP/TOD-NP-CO, NBG-*, ERC, TND, UNZ-*: 138 and 49 and 58 and 2 and 63
  // polygons), and anything else this vocabulary does not carry. The dry run
  // lists every one of them, and
  // `_inbox/2026-09-17_p259-austin-zoning-source_cp1.json` records the measured
  // counts.
  //
  // `descriptionField` is ZONING_BASE: the layer publishes no description, and
  // the collapsed value is the one field worth recording per stamped polygon,
  // because it is exactly what this lane does NOT use and it makes the
  // difference auditable after the fact.
  //
  // The projection is READ at source and the frame is verified per page
  // (zoning-service.ts: `outSR=4326` is requested and a page whose coordinates
  // are outside WGS84 fails the run rather than PIP-ing in a mismatched frame).
  // The layer's own `editingInfo.lastEditDate` is read as the vintage and
  // printed by the CLI (`--layer-meta` is the default at the top of a run).
  //
  // THREE ENTRIES, ONE cityKey. The stamp is county-scoped and one config
  // carries one countyFips, but Austin's jurisdiction spans three counties;
  // the elgin-tx / elgin-tx-travis pair above is the same pattern. All three
  // share cityKey "austin-tx" so a stamped parcel carries the same
  // `zoning_jurisdiction` string wherever it sits — the key the single
  // 37-district austin-tx setback table is routed by.
  // ---------------------------------------------------------------------------
  "austin-tx": {
    cityKey: "austin-tx",
    cityName: "Austin",
    countyFips: "48453",
    layerUrl:
      "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/PLANNINGCADASTRE_zoning_large_map_scale/FeatureServer/0",
    codeField: "ZONING_ZTYPE",
    descriptionField: "ZONING_BASE",
    baseCodeParse: {
      knownBaseCodes: AUSTIN_BASE_CODES,
      plannedDevelopmentPattern: PLANNED_DEVELOPMENT_PATTERN,
      plannedDevelopmentFlags: PLANNED_DEVELOPMENT_FLAGS,
      interimQualifiers: AUSTIN_INTERIM_QUALIFIERS,
    },
  },
  "austin-tx-williamson": {
    cityKey: "austin-tx",
    cityName: "Austin",
    countyFips: "48491",
    layerUrl:
      "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/PLANNINGCADASTRE_zoning_large_map_scale/FeatureServer/0",
    codeField: "ZONING_ZTYPE",
    descriptionField: "ZONING_BASE",
    baseCodeParse: {
      knownBaseCodes: AUSTIN_BASE_CODES,
      plannedDevelopmentPattern: PLANNED_DEVELOPMENT_PATTERN,
      plannedDevelopmentFlags: PLANNED_DEVELOPMENT_FLAGS,
      interimQualifiers: AUSTIN_INTERIM_QUALIFIERS,
    },
  },
  "austin-tx-hays": {
    cityKey: "austin-tx",
    cityName: "Austin",
    countyFips: "48209",
    layerUrl:
      "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/PLANNINGCADASTRE_zoning_large_map_scale/FeatureServer/0",
    codeField: "ZONING_ZTYPE",
    descriptionField: "ZONING_BASE",
    baseCodeParse: {
      knownBaseCodes: AUSTIN_BASE_CODES,
      plannedDevelopmentPattern: PLANNED_DEVELOPMENT_PATTERN,
      plannedDevelopmentFlags: PLANNED_DEVELOPMENT_FLAGS,
      interimQualifiers: AUSTIN_INTERIM_QUALIFIERS,
    },
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
  // 3,220 parcels, verified live 2026-09-08). Layer 1 (fips 48453
  // Travis-county-side sliver, 500 features) is wired below as the
  // separate "elgin-tx-travis" registry entry (CTX-ELGIN dispatch,
  // P-124, 2026-09-08): layer 0's own layerWhere filter matches 100% of
  // its features (no dropped-polygon defect on this layer), so layer 1
  // needed wiring, not a filter fix, for the Travis-county-side cohort.
  // `Zone_Code` carries the raw district
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
  // stamping rather than silently falling through to NULL. Setback table
  // ratified by the operator 2026-08-04 (doc_repo
  // _decisions/2026-08-04_elgin_setback_table_ratified.md) and ported from
  // hauska-engine's packages/adapters/src/local/setbacks/ copy — registered
  // here as elgin-development-code.json, routed from this cityKey
  // (elgin-tx) via isElginCityJurisdiction in lib/adapters's setbacks index.
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
  // Elgin (Travis, 48453). Same FeatureServer as "elgin-tx" above, layer 1
  // (service name "City of Elgin Zoning: Travis County") — the follow-on
  // that entry's own comment named as out of its pass. This is a SEPARATE
  // registry entry (own countyFips, own layerUrl) because the stamp is
  // county-scoped and one config carries one county, but `cityKey` is set
  // to the literal "elgin-tx" (not a distinct key) so `stampCountyZoning`
  // persists `zoning_jurisdiction = 'elgin-tx'` on every match — the exact
  // string `isElginCityJurisdiction` (lib/adapters's setbacks index)
  // checks for, so Travis-side Elgin parcels route to the same ratified
  // elgin-development-code setback table as the Bastrop-side cohort. Same
  // `Zone_Code` domain as layer 0 (verified live 2026-09-08: R-1/R-3/A/
  // C-1/C-2/C-3 present, no R-2/I/S-P currently in this layer) — the
  // identical codeDomainMap is reused unmodified rather than duplicated
  // with drift. layerWhere mirrors layer 0's own filter (499 of 500
  // features carry CITY_LIMIT='ELGIN'; the one remaining feature carries
  // a blank value and is excluded, consistent with layer 0's filter
  // semantics). CTX-ELGIN dispatch (P-124, 2026-09-08): a live
  // point-in-polygon sample of 25 of the 1,680 Travis parcels the
  // pre-bake gate held as zoningDistrict-unaccounted found 21/25 (84%)
  // already covered by this layer today — this was the live, verified
  // basis for wiring it, not an assumption. Re-run the elgin-tx stamp for
  // county 48453 after this lands; a full re-measurement (not the 25-
  // sample estimate) is required before any completeness claim.
  "elgin-tx-travis": {
    cityKey: "elgin-tx",
    cityName: "Elgin",
    countyFips: "48453",
    layerUrl:
      "https://services3.arcgis.com/wdTkTU0MdZbNBEZy/arcgis/rest/services/Elgin_Zoning/FeatureServer/1",
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
  // Lockhart (Caldwell). GIS `ZONING` carries the bare code (RLD/RMD/RHD/
  // CCB/CHB/CLB/CMB/IH/IL/MH/PDD/PI/AO). First Caldwell-county zoning layer.
  // Setback table delivered for RLD/RMD/RHD (Ordinance 2024-18 Appendix II,
  // transcribed 2026-07-23) — lockhart-tx.json. Commercial/industrial codes
  // remain a deliberate, disclosed gap per that file's own note (OMITTED
  // list), not yet owed as a fresh transcription task.
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
  // Layer 0 is corridor overlays — do NOT use. Setback table delivered,
  // primary-source-verified, no atom corpus (researched 2026-09-06) —
  // seguin-tx.json.
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
  // Setback table delivered for SF-1..SF-4, primary-source-verified, no
  // atom corpus (researched 2026-09-06) — cibolo-tx.json. SF-5/SF-6 are
  // live GIS codes with no dimensional-standards subsection in the city's
  // current code (an incomplete-repeal gap in the source document, not a
  // research miss) — honestly omitted, not interpolated.
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
  // (R-1/R-2/R-3/B-*/…). Setback table delivered for A-R1/SR-1/SR-2/R-1/
  // SF-2, human-verified against Killeen's real code-section atom corpus
  // (researched 2026-09-06, corrected 2026-09-07) — killeen-tx.json.
  "killeen-tx": {
    cityKey: "killeen-tx",
    cityName: "Killeen",
    countyFips: "48027",
    layerUrl:
      "https://killeengis.killeentexas.gov/arcgis/rest/services/Zoning/MapServer/7",
    codeField: "CODE",
  },
  // Belton (Bell 48027). Planning FS layer 6 Current_Zoning `Zoning_Abbr`.
  // Values include PD composites — stamped RAW (fact); PD composites and a
  // handful of transect-looking GIS codes (MS/U/T/N) not in the ordinance's
  // own district list will honestly miss. Setback table delivered for all
  // 22 codified base districts, primary-source-verified, no atom corpus
  // (researched 2026-09-06) — belton-tx.json. Temple remains unwired
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

  // ---------------------------------------------------------------------------
  // Burnet (48053, OPS-24 Phase 1). LDT's loader carried NO Burnet city before
  // this pass -- 0 of 59,785 Burnet txgio_parcel rows were zoning-stamped
  // (verified live, 2026-10-08). Of Burnet's 8 incorporated cities, only two
  // publish a machine-readable zoning layer; the other six (Burnet, Bertram,
  // Cottonwood Shores, Granite Shoals, Highland Haven, Meadowlakes) have
  // PDF-only zoning maps and are NOT wired here (no layer exists to register).
  // Burnet's setback numbers themselves are NOT in SETBACK_TABLES yet for
  // either city below -- `getSetbackTableForZoning` throws its own named Gate
  // 2 refusal for every `BURNET_CITY_JURISDICTION_KEYS` entry
  // (county-edition-currency.ts) ahead of the ordinary table lookup, so a
  // Burnet parcel declines honestly rather than serving an unverified or
  // superseded setback. This registry only attaches the REAL district code to
  // the parcel (`zoning_district` / `zoning_jurisdiction`), which is this
  // city's own prerequisite to that gate ever being asked a real question.
  // ---------------------------------------------------------------------------

  // Marble Falls (Burnet, 48053). Public ArcGIS MapServer, layer 16
  // ("Zoning"), live-verified 2026-10-08: HTTP 200, 261 zoning polygons across
  // 17 distinct `Zone_ID` codes (FR/RE/NR/TR/DR/MR/ENZ.1-5/NC/GC/DN/DT/BP/IN --
  // every one of them a district_code the W1-H ordinance register
  // (burnet-tx-ordinance-register.json) already carries for Marble Falls; the
  // register's 18th row, PD, is not currently zoned on the live layer).
  // `robots.txt` on this host returns 404 (no path is disallowed). Source
  // spatial reference wkid 102739 (latestWkid 2277, Texas Central State
  // Plane feet); every page is requested outSR=4326 per zoning-service.ts.
  // The layer publishes no service-level `editingInfo.lastEditDate`; its own
  // `last_edited_date` field's live max is 2026-07-02 (max `Year_Zoned` 2026),
  // read via an `outStatistics` query, not assumed. `Zone_Name` is the
  // human description (e.g. "Existing Neighborhood Zone 4") and `Ordinance`/
  // `Year_Zoned` are additional per-polygon provenance the stamp does not
  // consume but which the PR's dry-run table cites for currency. No
  // `codeExtractRegex`/`codeDomainMap`/`baseCodeParse` is needed -- `Zone_ID`
  // already publishes the clean short code the register's district_code
  // matches exactly (Georgetown's pattern, the simplest case). Dry run
  // against all 30 Marble Falls sample parcels + the 2 no-polygon special
  // cases (road ROW parcel 112953 / riverbank parcel 103196, WDLL
  // Appendix A #41/#42) reproduced the frozen sample's expected district on
  // every parcel with a zoning polygon under it; see the PR body for the
  // full per-parcel table.
  "marble-falls-tx": {
    cityKey: "marble-falls-tx",
    cityName: "Marble Falls",
    countyFips: "48053",
    layerUrl:
      "https://mfgis.marblefallstx.gov/arcgis/rest/services/Planning/PDS/MapServer/16",
    codeField: "Zone_ID",
    descriptionField: "Zone_Name",
  },

  // Horseshoe Bay (Burnet, 48053). `maps.horseshoe-bay-tx.gov` (the city's own
  // GIS host) is network-unreachable (connection timeout, verified again
  // 2026-10-08) -- not a block, a dead host, so it is recorded as unreachable
  // rather than worked around. The city's zoning is instead served from its
  // GIS vendor, newedgeservices.com, behind an ArcGIS Enterprise Portal web
  // map (item `1eefefa6e1ac460ea5aff761f21bdf52`, "Zoning, Water Availability,
  // Landuse, NE_RD", access "public"). `robots.txt` on
  // `horseshoebaygis.newedgeservices.com` returns 404 (nothing disallowed).
  // The web map's own item-data JSON (Portal `content/items/<id>/data`, read
  // plainly, no auth) names the REST FeatureServer layer behind its "Zoning
  // Parcels" operational layer:
  //   https://horseshoebaygis.newedgeservices.com/arcgis/rest/services/Public/Zoning/FeatureServer/2
  // (layer 1 on the same service, "Zoning Labels", is label geometry only --
  // not used). The `services2.arcgis.com` host named in earlier research was
  // not this layer's host; it was not reached and is not relied on here.
  // Live-verified 2026-10-08: HTTP 200, 11,434 zoning-parcel features, `ZONING`
  // (the register's district_code field, e.g. "R-1", "A-1", "C-2") plus
  // `SUB_ZONING` (a refinement -- R-1-SF/R-2-2F/R-4-MF -- not consumed by the
  // stamp). Source spatial reference wkid 102739 (latestWkid 2277); every
  // page requested outSR=4326. No service-level `editingInfo.lastEditDate`;
  // the layer's own `last_edited_date` field's live max is 2024-06-24, read
  // via `outStatistics`. No `codeExtractRegex`/`codeDomainMap`/`baseCodeParse`
  // needed -- `ZONING` already publishes the register's own codes verbatim.
  //
  // PARCEL ID (Burnet stage 3 §3 Bug 2, re-verified live 2026-10-09 by a
  // fresh anonymous `?f=json` read of the layer's field list plus
  // `where=PROP_ID=<id>` queries for the exact sample parcels): this layer
  // IS the city's own parcel fabric -- one feature per CAD parcel -- and
  // `PROP_ID` (esriFieldTypeInteger) carries the Burnet CAD prop id for
  // every sample parcel except ONE. `prop_id_1`/`PROP_ID_1` is a SECOND,
  // unreliable id field (often null; a few rows have it equal to PROP_ID).
  // The one documented exception, 48053:23321 (a county-line parcel), has
  // its real CAD id in `prop_id_1` while `PROP_ID` on that same feature
  // holds an unrelated legacy value (16298) -- live-confirmed again
  // 2026-10-09. `parcelIdField` below names ONLY `PROP_ID`, not both: for
  // 23321 the id join finds no feature and the stamp correctly falls back
  // to the point lookup (counted as `matchMethod: "point"`), which lands in
  // 23321's own feature anyway (ZONING "R-1", matching what `prop_id_1`
  // would have given directly) because 23321's own footprint is not
  // blank-coded -- a documented, harmless fallback, not a second join key
  // added speculatively.
  //
  // TWO DECLARED NO-DISTRICT CASES (WDLL known special cases), BOTH confirmed
  // live at the exact parcel, not inferred: 48053:69366 ("CA" in the frozen
  // staging snapshot -- COMMON AREA land use, not an adopted district per the
  // register's own CA note) carries a BLANK `ZONING` field on this live
  // layer, and 48053:106280 ("UNK" in staging) is likewise BLANK. Before Bug
  // 2's fix both fell through `buildZoningIndex`'s generic empty-code drop
  // and were then (wrongly) point-in-polygon'd into a NEIGHBOUR's coded
  // polygon (C-2 / R-1) -- `parcelIdField` makes the stamp find each
  // parcel's OWN feature FIRST and read its blank code as the declared
  // "no district on the city's own layer" outcome instead (never filled in
  // from a neighbour). A 6-feature ` ` whitespace-only value elsewhere in
  // the layer trims the same way. Two live, currently-unmatched codes were
  // also measured on this layer that the W1-H register does not carry a row
  // for -- "DR" (6 features) and bare "PD" (20 features, distinct from the
  // register's "PDC-2") -- these will correctly decline with the named
  // `SETBACK_SOURCE_NOT_REGISTERED` Gate 2 code rather than serving a
  // guessed setback; recorded here as a disclosed gap, not fixed by this
  // registration (authoring the register's content is W1-H's task).
  "horseshoe-bay-tx": {
    cityKey: "horseshoe-bay-tx",
    cityName: "Horseshoe Bay",
    countyFips: "48053",
    layerUrl:
      "https://horseshoebaygis.newedgeservices.com/arcgis/rest/services/Public/Zoning/FeatureServer/2",
    codeField: "ZONING",
    descriptionField: "SUB_ZONING",
    parcelIdField: "PROP_ID",
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
 * The jurisdiction key a stamped value resolves to, read through this registry's
 * own `cityKey` field — so a value naming an ENTRY resolves to the jurisdiction
 * that entry declares, and every other value passes through unchanged.
 *
 * WHY THIS EXISTS (P-406, 2026-09-22). This map is keyed by ENTRY NAME; an
 * entry's `cityKey` is the jurisdiction that entry serves. For 23 of its 26
 * entries the two strings are identical, which makes the distinction invisible.
 * For the three entries that carry ONE city across SEVERAL counties it is not:
 *
 *     elgin-tx-travis      -> elgin-tx     (Elgin:  48021 Bastrop + 48453 Travis)
 *     austin-tx-williamson -> austin-tx    (Austin: 48453 Travis + 48491 Williamson
 *     austin-tx-hays       -> austin-tx             + 48209 Hays)
 *
 * A stamped value is *meant* to be a jurisdiction key, and `elgin-tx-travis`
 * exists precisely so the Travis Elgin cohort stamps `elgin-tx` (see that
 * entry's own comment). But the entry name is structurally indistinguishable
 * from a key to any consumer that only compares strings, both spellings resolve
 * in `ZONING_LAYERS` itself, and a writer that stamps the name instead of the
 * `cityKey` is accepted silently. Measured live on the serving path 2026-09-22:
 * the record cell for `48453:959606` (Elgin, Travis side) carries
 * `elgin-tx-travis`; `isElginCityJurisdiction` accepts only `elgin-tx` and
 * `elgin-development-code`; so the ratified Elgin development-code table was
 * never reached and the parcel refused `no-district` while PROD drew it R-3.
 *
 * A value that names no entry is returned unchanged — trimmed and lowercased,
 * which is the form every table key in this site is already in, and in its OWN
 * separator convention — so every single-county key, every table-owning key
 * (`elgin-development-code`, `bastrop-development-code`) and every
 * unregistered city passes through byte-identically. The lookup tries the
 * value's own form first and its hyphen form second, never the reverse, so the
 * hyphen fallback cannot re-spell a value that already named an entry; it only
 * reaches entry names written underscore-normalized (`elgin_tx_travis`), which
 * is the spelling `resolveZoningJurisdiction` normalizes away before returning
 * and no current writer emits, but which `readKey` on the record rail would
 * pass through untouched. Nothing is invented: null/blank in, null out.
 */
export function canonicalZoningJurisdictionKey(
  value: string | null | undefined,
): string | null {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!key) return null;
  const entry = ZONING_LAYERS[key] ?? ZONING_LAYERS[key.replace(/_/g, "-")];
  if (!entry) return key;
  // Same separator convention back out: the two forms reach the same setback
  // table (`normalizeJurisdictionKey` hyphenates), and the derivation echoes
  // the key it refused on, so a key that is not a multi-county entry name
  // must not change spelling here.
  return key.includes("_") ? entry.cityKey.replace(/-/g, "_") : entry.cityKey;
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
 *
 * P-273. THE REGISTRY CHECK USED TO VALIDATE NOTHING:
 *
 *     if (stamped && ZONING_LAYERS[stamped]) return stamped;
 *     if (stamped) return stamped; // unknown-but-stamped key still wins over guess
 *
 * Both branches returned the same expression, so whenever `stamped` was
 * truthy one of them fired and the `ZONING_LAYERS[stamped]` test constrained
 * nothing. It read as a registry validation and was not one: a stamped key
 * nothing registered (a city whose layer was retired, a typo'd stamp, a
 * pre-registry row) was indistinguishable from one this build can route.
 *
 * The "unknown-but-stamped wins over guess" rule itself is RIGHT and is kept:
 * the stamp is point-in-polygon evidence that the parcel is in that city, and
 * dropping it to null would throw the evidence away and hand the parcel to
 * the situs guess. What was missing was the DISCLOSURE the registry check was
 * supposed to make. It is now made through `onUnregisteredStamp`, so the two
 * cases are tellable apart by the caller:
 *
 *   registered       -> return the key, no callback
 *   NOT registered   -> return the key, callback fires with the reason
 *
 * Verify by violation: `nowhere-tx` must fire the callback and `austin-tx`
 * (registered) must not.
 */
export function resolveZoningJurisdiction(
  parcel: ZoningJurisdictionParcel,
  opts?: {
    onSitusFallback?: (info: {
      cityKey: string;
      situsCity: string;
      countyFips: string;
    }) => void;
    /**
     * P-273. A stamped `zoning_jurisdiction` that `ZONING_LAYERS` does not
     * carry. The key is still returned (see above) — this reports the fact so
     * a run can count it instead of silently routing the parcel to no table.
     */
    onUnregisteredStamp?: (info: {
      cityKey: string;
      countyFips: string;
    }) => void;
  },
): string | null {
  const stamped = typeof parcel.zoningJurisdiction === "string"
    ? parcel.zoningJurisdiction.trim().toLowerCase().replace(/_/g, "-")
    : "";
  if (stamped && ZONING_LAYERS[stamped]) return stamped;
  if (stamped) {
    // P-273: the registry test above decides WHETHER this is reported. Before
    // this, nothing downstream could tell this case from a registered stamp.
    opts?.onUnregisteredStamp?.({
      cityKey: stamped,
      countyFips:
        typeof parcel.countyFips === "string" ? parcel.countyFips.trim() : "",
    });
    return stamped; // unknown-but-stamped key still wins over guess
  }

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
