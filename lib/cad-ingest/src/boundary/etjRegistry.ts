/**
 * ETJ publisher register — one declarative entry per enumerated city
 * (feat/p241-etj-acquisition, P-241 acquisition half).
 *
 * There is no statewide ETJ layer. Every municipality publishes its own, so
 * acquiring ETJ means a per-publisher configuration entry, never a per-city
 * code branch. This file is that configuration and nothing else: the service,
 * parser, ingest and CLI all read it, and adding a city is adding a row here.
 *
 * EVERY URL, PREDICATE AND FIELD NAME BELOW WAS RESOLVED FROM THE PUBLISHER'S
 * OWN REST DIRECTORY AND RE-VERIFIED LIVE ON 2026-09-16, not taken on faith
 * from the 2026-09-15 enumeration close doc
 * (`_inbox/2026-09-15_p241-etj-enumeration_close.json`). Re-verification
 * mattered:
 *
 *   - the close doc cited layer/service URLs for Leander, San Marcos, Waco,
 *     Seguin and Belton that do not exist as written;
 *   - it listed `round-rock-tx` and `cedar-park-tx` as having an ETJ layer;
 *     both publishers expose city limits only, confirmed by browsing their own
 *     REST directories and finding no ETJ layer (matching the close doc's own
 *     `HAS_CITY_LIMITS_ONLY` for those two, so the aggregate lines and the
 *     per-city rows disagree there);
 *   - it read Killeen as "ETJ published, via a neighbouring city's portal",
 *     which is exactly right and is why `killeen-tx` below points at Belton's
 *     regional Bell County layer rather than at Killeen's own host.
 *
 * WHAT MAKES A PREDICATE MANDATORY. Two different traps, both live in this
 * register, and both would put the wrong geometry into a city's ETJ rings:
 *
 *   - `layerCarriesCityLimits` — the layer holds city limits and ETJ together,
 *     separated by an attribute value (`mode: "combined"`). Austin is the
 *     canonical case: JURISDICTION_TYPE in {2MILE, 5MIL, 2MILE_AG} is ETJ,
 *     while FULL and LTD are not — and LTD is limited-purpose annexation,
 *     which is INSIDE the city, not outside it. Bastrop is the same trap in a
 *     layer that looks ETJ-shaped by name ("ETJ Areas") but carries a
 *     `juris="CITY LIMIT"` row alongside its two ETJ rows.
 *   - `layerJurisdictions > 1` — the layer is ETJ only, but for several
 *     cities. Elgin's `ElectionPrecinct_CityExtraterritorialJurisdiction`
 *     layer carries six Bastrop-county cities; Belton's regional
 *     `Bell County ETJ's` layer carries seventeen.
 *
 * `etjPredicateMustBeSelective()` states both conditions, and both the ingest
 * CLI and the verify instrument treat a predicate that selects the whole layer
 * as a failure rather than a log line.
 *
 * `labelField` is where the publisher states the ring's own name in words
 * (`AUSTIN 2 MILE ETJ`, `KYLE ETJ`, ...). Some publishers carry none —
 * Dripping Springs publishes only an integer Id, Waco only an INSIDE flag,
 * Seguin no attribute at all — so those entries fall back to the publisher's
 * layer name, which is itself a published string. Nothing here is synthesised,
 * and no ring label is ever computed from a statute: §42.021 buffer derivation
 * is retired for this work, because Austin's real ETJ is shaped by individual
 * development agreements and disannexation actions that a formula would
 * contradict.
 */

/** How a city's ETJ is published. */
export type EtjSourceMode = "combined" | "etj_layer" | "city_limits_only";

/** Attribute-value predicate that selects ETJ rows out of a shared layer. */
export interface EtjMembershipPredicate {
  field: string;
  values: Array<string | number>;
}

export interface EtjRegistryEntry {
  /** Stable registry key, e.g. `austin-tx`. Also the tx_etj_boundary city_key. */
  cityKey: string;
  /** Display name, e.g. `Austin`. */
  cityName: string;
  /** CPA place geo_id from TxGIO City_Boundaries when the city joins to it. */
  cityGeoId: string | null;
  mode: EtjSourceMode;
  /** The published ETJ layer. Null exactly when mode is city_limits_only. */
  layerUrl: string | null;
  /**
   * How many jurisdictions' rings the layer carries, read live. 1 means the
   * layer is this city's alone; >1 means a predicate is mandatory or a
   * neighbouring city's ETJ would be ingested as this city's.
   */
  layerJurisdictions: number | null;
  /** Predicate selecting ETJ rows for THIS city; null only when none is needed. */
  etjMembership: EtjMembershipPredicate | null;
  /**
   * True when the layer also carries non-ETJ jurisdiction rows, so a predicate
   * is required regardless of how many cities it names.
   */
  layerCarriesCityLimits: boolean;
  /** Attribute carrying the publisher's own ring name; null when none exists. */
  labelField: string | null;
  /** Publisher's layer name, used as the ring label when labelField is empty. */
  layerNameFallback: string | null;
  /** Owning organisation as published. */
  owner: string;
  /** The publisher's city-limits layer, recorded even when no ETJ layer exists. */
  cityLimitsLayerUrl: string | null;
  /** Publisher's last-edit timestamp observed on 2026-09-16 (null: none published). */
  layerLastEditAt: string | null;
  /** Date this entry was last verified against the live service. */
  verifiedAt: string;
  /** Live feature count observed at verification (whole layer). */
  verifiedFeatureCount: number | null;
}

/**
 * True when this entry's predicate has to do real work: the layer mixes city
 * limits in, or names more than one city. A predicate that matches the whole
 * layer in either case is not a predicate and would put another jurisdiction's
 * geometry in this city's rings.
 */
export function etjPredicateMustBeSelective(entry: EtjRegistryEntry): boolean {
  return (
    entry.etjMembership !== null &&
    (entry.layerCarriesCityLimits || (entry.layerJurisdictions ?? 1) > 1)
  );
}

/** Acquisition vintage label for this register revision. */
export const ETJ_SOURCE_VINTAGE = "p241_etj_publishers_20260916";

/** The one register. Order is irrelevant; lookups are by cityKey. */
export const ETJ_REGISTRY: readonly EtjRegistryEntry[] = [
  {
    cityKey: "austin-tx",
    cityName: "Austin",
    cityGeoId: "4805000",
    mode: "combined",
    layerUrl:
      "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/BOUNDARIES_jurisdictions/FeatureServer/0",
    layerJurisdictions: 1,
    etjMembership: {
      field: "JURISDICTION_TYPE",
      values: ["2MILE", "5MIL", "2MILE_AG"],
    },
    layerCarriesCityLimits: true,
    labelField: "JURISDICTION_LABEL",
    layerNameFallback: null,
    owner: "City of Austin",
    cityLimitsLayerUrl: null,
    layerLastEditAt: "2026-09-15T23:20:38.665Z",
    verifiedAt: "2026-09-16",
    verifiedFeatureCount: 388,
  },
  {
    cityKey: "new-braunfels-tx",
    cityName: "New Braunfels",
    cityGeoId: "4850840",
    mode: "combined",
    layerUrl:
      "https://gismaps.newbraunfels.gov/arcserverwa22/rest/services/OpenData/AddressesBoundaries/MapServer/1",
    layerJurisdictions: 1,
    // BoundaryType is an integer field: 0 = City Limits, 1 = ETJ,
    // 2 = Limited Purpose annexation (inside the city, not ETJ).
    etjMembership: { field: "BoundaryType", values: [1] },
    layerCarriesCityLimits: true,
    labelField: "Name",
    layerNameFallback: null,
    owner: "City of New Braunfels",
    cityLimitsLayerUrl: null,
    layerLastEditAt: null,
    verifiedAt: "2026-09-16",
    verifiedFeatureCount: 9,
  },
  {
    cityKey: "kyle-tx",
    cityName: "Kyle",
    cityGeoId: "4839952",
    mode: "combined",
    layerUrl:
      "https://services5.arcgis.com/Zhdeglqfvv6JnrnU/arcgis/rest/services/Jurisdiction_and_Zoning_Finder/FeatureServer/6",
    layerJurisdictions: 1,
    etjMembership: { field: "JURIS_TYPE", values: ["ETJ"] },
    layerCarriesCityLimits: true,
    labelField: "CITY_NAME",
    layerNameFallback: null,
    owner: "City of Kyle",
    cityLimitsLayerUrl: null,
    layerLastEditAt: "2020-10-22T21:11:47.525Z",
    verifiedAt: "2026-09-16",
    verifiedFeatureCount: 18,
  },
  {
    cityKey: "cibolo-tx",
    cityName: "Cibolo",
    cityGeoId: "4814974",
    mode: "combined",
    layerUrl:
      "https://services3.arcgis.com/D32JCd9p0r1BYMwd/arcgis/rest/services/CiboloCityLimits/FeatureServer/30",
    layerJurisdictions: 1,
    etjMembership: { field: "Name", values: ["Cibolo ETJ"] },
    layerCarriesCityLimits: true,
    labelField: "Name",
    layerNameFallback: null,
    owner: "City of Cibolo",
    cityLimitsLayerUrl: null,
    layerLastEditAt: "2026-08-06T21:50:21.041Z",
    verifiedAt: "2026-09-16",
    verifiedFeatureCount: 3,
  },
  {
    cityKey: "georgetown-tx",
    cityName: "Georgetown",
    cityGeoId: "4829336",
    mode: "etj_layer",
    layerUrl:
      "https://gis.georgetowntexas.gov/arcgis/rest/services/PublicWebMaps/ETJdisannexationsWebMap/MapServer/4",
    layerJurisdictions: 1,
    etjMembership: null,
    layerCarriesCityLimits: false,
    labelField: "CITY_NAME",
    layerNameFallback: "Extra-Territorial Jurisdiction",
    owner: "City of Georgetown",
    cityLimitsLayerUrl:
      "https://gis.georgetowntexas.gov/arcgis/rest/services/PublicWebMaps/ETJdisannexationsWebMap/MapServer/3",
    layerLastEditAt: null,
    verifiedAt: "2026-09-16",
    verifiedFeatureCount: 1,
  },
  {
    cityKey: "leander-tx",
    cityName: "Leander",
    cityGeoId: "4842016",
    mode: "etj_layer",
    layerUrl:
      "https://services1.arcgis.com/L0MLvN0Ay0iEjnCT/arcgis/rest/services/ETJ/FeatureServer/2002",
    layerJurisdictions: 1,
    etjMembership: null,
    layerCarriesCityLimits: false,
    labelField: "CITY_NAME",
    layerNameFallback: "ETJ",
    owner: "City of Leander",
    cityLimitsLayerUrl:
      "https://services1.arcgis.com/L0MLvN0Ay0iEjnCT/arcgis/rest/services/Leander_City_Limits/FeatureServer/2001",
    layerLastEditAt: "2026-08-24T20:43:17.915Z",
    verifiedAt: "2026-09-16",
    verifiedFeatureCount: 1,
  },
  {
    cityKey: "hutto-tx",
    cityName: "Hutto",
    cityGeoId: "4835600",
    mode: "etj_layer",
    layerUrl:
      "https://services.arcgis.com/YZhxlqU7ABWQBGTG/arcgis/rest/services/Hutto_ETJ/FeatureServer/0",
    layerJurisdictions: 1,
    etjMembership: null,
    layerCarriesCityLimits: false,
    labelField: "Name_1",
    layerNameFallback: "Hutto ETJ",
    owner: "City of Hutto",
    cityLimitsLayerUrl:
      "https://services.arcgis.com/YZhxlqU7ABWQBGTG/arcgis/rest/services/Hutto_City_Limits/FeatureServer/0",
    layerLastEditAt: "2026-09-14T21:36:51.109Z",
    verifiedAt: "2026-09-16",
    verifiedFeatureCount: 1,
  },
  {
    cityKey: "buda-tx",
    cityName: "Buda",
    cityGeoId: "4811080",
    mode: "etj_layer",
    layerUrl:
      "https://services6.arcgis.com/vXZW4vAaPRr14z2s/arcgis/rest/services/Buda_ETJ/FeatureServer/0",
    layerJurisdictions: 1,
    etjMembership: null,
    layerCarriesCityLimits: false,
    labelField: "Notes",
    layerNameFallback: "Buda_ETJ",
    owner: "City of Buda",
    cityLimitsLayerUrl:
      "https://services6.arcgis.com/vXZW4vAaPRr14z2s/arcgis/rest/services/City_Limits_October_2017/FeatureServer/0",
    layerLastEditAt: "2026-08-25T21:20:05.744Z",
    verifiedAt: "2026-09-16",
    verifiedFeatureCount: 1,
  },
  {
    cityKey: "dripping-springs-tx",
    cityName: "Dripping Springs",
    cityGeoId: "4821424",
    mode: "etj_layer",
    layerUrl:
      "https://services6.arcgis.com/XnTA1N5QxtOFa9o8/arcgis/rest/services/ExtraTerritorialJurisdiction/FeatureServer/0",
    layerJurisdictions: 1,
    etjMembership: null,
    layerCarriesCityLimits: false,
    // The layer publishes an integer Id only; the layer name is the label.
    labelField: null,
    layerNameFallback: "ExtraTerritorialJurisdiction",
    owner: "City of Dripping Springs",
    cityLimitsLayerUrl:
      "https://services6.arcgis.com/XnTA1N5QxtOFa9o8/arcgis/rest/services/City_Limits2026_shp/FeatureServer/0",
    layerLastEditAt: "2022-06-13T16:38:28.088Z",
    verifiedAt: "2026-09-16",
    verifiedFeatureCount: 1,
  },
  {
    cityKey: "san-marcos-tx",
    cityName: "San Marcos",
    cityGeoId: "4865600",
    mode: "etj_layer",
    layerUrl:
      "https://smgis.sanmarcostx.gov/arcgis/rest/services/ETJOnly/MapServer/0",
    layerJurisdictions: 1,
    etjMembership: null,
    layerCarriesCityLimits: false,
    labelField: "SPATIALARE",
    layerNameFallback: "ETJ",
    owner: "City of San Marcos",
    cityLimitsLayerUrl:
      "https://smgis.sanmarcostx.gov/arcgis/rest/services/CityLimitOnly_BaseMap/MapServer/0",
    layerLastEditAt: null,
    verifiedAt: "2026-09-16",
    verifiedFeatureCount: 1,
  },
  {
    cityKey: "taylor-tx",
    cityName: "Taylor",
    cityGeoId: "4871948",
    mode: "etj_layer",
    layerUrl:
      "https://services7.arcgis.com/SQVxkeGOcRYhZqOD/arcgis/rest/services/City_Limits_ETJ_082321/FeatureServer/6",
    layerJurisdictions: 1,
    etjMembership: null,
    layerCarriesCityLimits: false,
    labelField: "POLIT_NAME",
    layerNameFallback: "ETJ Boundary",
    owner: "City of Taylor",
    cityLimitsLayerUrl:
      "https://services7.arcgis.com/SQVxkeGOcRYhZqOD/arcgis/rest/services/City_Limits_ETJ_082321/FeatureServer/5",
    layerLastEditAt: "2026-07-21T19:43:17.704Z",
    verifiedAt: "2026-09-16",
    verifiedFeatureCount: 23,
  },
  {
    cityKey: "liberty-hill-tx",
    cityName: "Liberty Hill",
    cityGeoId: "4842648",
    mode: "etj_layer",
    layerUrl:
      "https://services8.arcgis.com/qwMz1Ra8Qny9RDxC/arcgis/rest/services/ETJLimits_241031/FeatureServer/108",
    layerJurisdictions: 1,
    etjMembership: null,
    layerCarriesCityLimits: false,
    labelField: "NAME",
    layerNameFallback: "ETJ",
    owner: "City of Liberty Hill",
    cityLimitsLayerUrl:
      "https://services8.arcgis.com/qwMz1Ra8Qny9RDxC/arcgis/rest/services/CityLimits_241031/FeatureServer/33",
    layerLastEditAt: "2026-07-02T15:40:56.952Z",
    verifiedAt: "2026-09-16",
    verifiedFeatureCount: 1,
  },
  {
    cityKey: "pflugerville-tx",
    cityName: "Pflugerville",
    cityGeoId: "4857196",
    mode: "etj_layer",
    layerUrl:
      "https://maps.pflugervilletx.gov/arcgis/rest/services/Planning/ETJ/FeatureServer/0",
    layerJurisdictions: 1,
    etjMembership: null,
    layerCarriesCityLimits: false,
    labelField: "TYPE",
    layerNameFallback: "ETJ",
    owner: "City of Pflugerville",
    cityLimitsLayerUrl:
      "https://maps.pflugervilletx.gov/arcgis/rest/services/Planning/City_Limits/FeatureServer/0",
    layerLastEditAt: null,
    verifiedAt: "2026-09-16",
    verifiedFeatureCount: 1,
  },
  {
    cityKey: "bastrop-city-tx",
    cityName: "Bastrop",
    cityGeoId: "4805864",
    mode: "combined",
    layerUrl:
      "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/City_Limit_and_ETJ_Map_WFL1/FeatureServer/6",
    layerJurisdictions: 1,
    // The layer is named "ETJ Areas" but carries `juris="CITY LIMIT"` /
    // extent="FULL PURPOSE" alongside its two ETJ rows. Without this predicate
    // Bastrop's own city limits would be ingested as Bastrop's ETJ.
    etjMembership: { field: "juris", values: ["ETJ"] },
    layerCarriesCityLimits: true,
    labelField: "juris",
    layerNameFallback: "ETJ Areas",
    owner: "City of Bastrop",
    cityLimitsLayerUrl:
      "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/City_Limit_and_ETJ_Map_WFL1/FeatureServer/5",
    layerLastEditAt: "2023-10-20T21:30:36.755Z",
    verifiedAt: "2026-09-16",
    verifiedFeatureCount: 3,
  },
  {
    cityKey: "san-antonio-tx",
    cityName: "San Antonio",
    cityGeoId: "4865000",
    mode: "etj_layer",
    layerUrl:
      "https://services.arcgis.com/g1fRTDLeMgspWrYp/arcgis/rest/services/COSA_ETJ/FeatureServer/3",
    layerJurisdictions: 1,
    etjMembership: null,
    layerCarriesCityLimits: false,
    labelField: "Name",
    layerNameFallback: "COSA_ETJ",
    owner: "City of San Antonio",
    cityLimitsLayerUrl:
      "https://services.arcgis.com/g1fRTDLeMgspWrYp/arcgis/rest/services/COSABoundary/FeatureServer/1",
    layerLastEditAt: "2026-09-14T14:57:30.739Z",
    verifiedAt: "2026-09-16",
    verifiedFeatureCount: 1,
  },
  {
    cityKey: "elgin-tx",
    cityName: "Elgin",
    cityGeoId: "4823040",
    mode: "etj_layer",
    layerUrl:
      "https://services3.arcgis.com/wdTkTU0MdZbNBEZy/arcgis/rest/services/ElectionPrecinct_CityExtraterritorialJurisdiction/FeatureServer/0",
    // The layer is county-wide: six Bastrop-county cities' ETJs.
    layerJurisdictions: 6,
    etjMembership: { field: "etj", values: ["Elgin ETJ"] },
    layerCarriesCityLimits: false,
    labelField: "etj",
    layerNameFallback:
      "ElectionPrecinct_CityExtraterritorialJurisdiction",
    owner: "City of Elgin",
    cityLimitsLayerUrl:
      "https://services3.arcgis.com/wdTkTU0MdZbNBEZy/arcgis/rest/services/City_Limits/FeatureServer/0",
    layerLastEditAt: "2026-03-13T19:02:33.623Z",
    verifiedAt: "2026-09-16",
    verifiedFeatureCount: 6,
  },
  {
    cityKey: "seguin-tx",
    cityName: "Seguin",
    cityGeoId: "4866644",
    mode: "etj_layer",
    layerUrl:
      "https://gis.seguintexas.gov/arcgis/rest/services/Data_Download/Seguin_ETJ_Open_Data/FeatureServer/0",
    layerJurisdictions: 1,
    etjMembership: null,
    layerCarriesCityLimits: false,
    // Publishes no attribute beyond globalid; the layer name is the label.
    labelField: null,
    layerNameFallback: "Seguin ETJ",
    owner: "City of Seguin",
    cityLimitsLayerUrl:
      "https://gis.seguintexas.gov/arcgis/rest/services/Data_Download/City_Limits_Open_Data/FeatureServer/0",
    layerLastEditAt: null,
    verifiedAt: "2026-09-16",
    verifiedFeatureCount: 1,
  },
  {
    cityKey: "waco-tx",
    cityName: "Waco",
    cityGeoId: "4876000",
    mode: "etj_layer",
    layerUrl:
      "https://gis.wacotx.gov/server/rest/services/Waco_ETJ/FeatureServer/0",
    layerJurisdictions: 1,
    etjMembership: null,
    layerCarriesCityLimits: false,
    // INSIDE is an integer flag, not a name; the layer name is the label.
    labelField: null,
    layerNameFallback: "Waco ETJ",
    owner: "City of Waco",
    cityLimitsLayerUrl:
      "https://gis.wacotx.gov/server/rest/services/Waco_City_Limits/FeatureServer/0",
    layerLastEditAt: null,
    verifiedAt: "2026-09-16",
    verifiedFeatureCount: 1,
  },
  {
    cityKey: "belton-tx",
    cityName: "Belton",
    cityGeoId: "4807492",
    mode: "etj_layer",
    layerUrl:
      "https://services5.arcgis.com/FkDUU6xkZJTbBa9X/arcgis/rest/services/Admin_Boundaries/FeatureServer/5",
    layerJurisdictions: 1,
    etjMembership: null,
    layerCarriesCityLimits: false,
    labelField: "Label",
    layerNameFallback: "Belton_ETJ",
    owner: "City of Belton",
    cityLimitsLayerUrl:
      "https://services5.arcgis.com/FkDUU6xkZJTbBa9X/arcgis/rest/services/Admin_Boundaries/FeatureServer/0",
    layerLastEditAt: "2026-01-08T21:53:43.240Z",
    verifiedAt: "2026-09-16",
    verifiedFeatureCount: 2,
  },
  {
    cityKey: "killeen-tx",
    cityName: "Killeen",
    cityGeoId: "4839148",
    mode: "etj_layer",
    // Killeen's own host publishes city limits only, so its ETJ is acquired
    // from the neighbouring regional layer that carries it — the same
    // adjacent-authority finding the 2026-09-15 enumeration recorded. The
    // city-limits URL below is Killeen's own.
    layerUrl:
      "https://services5.arcgis.com/FkDUU6xkZJTbBa9X/arcgis/rest/services/Admin_Boundaries/FeatureServer/3",
    layerJurisdictions: 17,
    etjMembership: { field: "CITY_NAME", values: ["KILLEEN"] },
    layerCarriesCityLimits: false,
    labelField: "Label",
    layerNameFallback: "Bell County ETJ's",
    owner: "City of Belton (regional Bell County layer carrying Killeen's ETJ)",
    cityLimitsLayerUrl:
      "https://killeengis.killeentexas.gov/arcgis/rest/services/Hosted/CityLimits/FeatureServer/0",
    layerLastEditAt: null,
    verifiedAt: "2026-09-16",
    verifiedFeatureCount: 17,
  },

  // ---- enumerated, city limits only: the publisher exposes no ETJ layer ----
  {
    cityKey: "round-rock-tx",
    cityName: "Round Rock",
    cityGeoId: "4863500",
    mode: "city_limits_only",
    layerUrl: null,
    layerJurisdictions: null,
    etjMembership: null,
    layerCarriesCityLimits: false,
    labelField: null,
    layerNameFallback: null,
    owner: "City of Round Rock",
    cityLimitsLayerUrl:
      "https://maps.roundrocktexas.gov/arcgis/rest/services/CityLimitsWMTS_Round6/MapServer/0",
    layerLastEditAt: null,
    verifiedAt: "2026-09-16",
    verifiedFeatureCount: 1,
  },
  {
    cityKey: "cedar-park-tx",
    cityName: "Cedar Park",
    cityGeoId: "4813552",
    mode: "city_limits_only",
    layerUrl: null,
    layerJurisdictions: null,
    etjMembership: null,
    layerCarriesCityLimits: false,
    labelField: null,
    layerNameFallback: null,
    owner: "City of Cedar Park",
    cityLimitsLayerUrl:
      "https://gisrest.cedarparktexas.gov/cpgis/rest/services/Planning/CityLimits/MapServer/0",
    layerLastEditAt: null,
    verifiedAt: "2026-09-16",
    verifiedFeatureCount: 2,
  },
  {
    cityKey: "lockhart-tx",
    cityName: "Lockhart",
    cityGeoId: "4843240",
    mode: "city_limits_only",
    layerUrl: null,
    layerJurisdictions: null,
    etjMembership: null,
    layerCarriesCityLimits: false,
    labelField: null,
    layerNameFallback: null,
    owner: "City of Lockhart",
    // No public layer found on the city's own host; the close doc also recorded
    // this one as a known miss (token-gated). Recorded as enumerated-with-no-
    // source rather than dropped, so "checked, nothing published" stays visible
    // and distinct from a city nobody looked at.
    cityLimitsLayerUrl: null,
    layerLastEditAt: null,
    verifiedAt: "2026-09-16",
    verifiedFeatureCount: null,
  },
];

/** Cities in the register that publish a queryable ETJ layer. */
export function etjSourceEntries(): EtjRegistryEntry[] {
  return ETJ_REGISTRY.filter((e) => e.layerUrl !== null);
}

/** Cities enumerated and found to publish no ETJ layer of their own. */
export function cityLimitsOnlyEntries(): EtjRegistryEntry[] {
  return ETJ_REGISTRY.filter((e) => e.layerUrl === null);
}

/** Look up one register entry by city key. */
export function etjRegistryEntry(cityKey: string): EtjRegistryEntry | null {
  return ETJ_REGISTRY.find((e) => e.cityKey === cityKey) ?? null;
}

/**
 * Build the ArcGIS `where` clause for an entry: the ETJ membership predicate
 * for a shared layer, `1=1` for a layer that is already this city's ETJ alone.
 * Numeric values are emitted bare (New Braunfels' BoundaryType is an integer
 * field); string values are single-quoted with embedded quotes doubled.
 */
export function etjWhereClause(entry: EtjRegistryEntry): string {
  if (entry.etjMembership === null) return "1=1";
  const { field, values } = entry.etjMembership;
  if (values.length === 0) return "1=0";
  const rendered = values.map((v) =>
    typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`,
  );
  return `${field} IN (${rendered.join(",")})`;
}
