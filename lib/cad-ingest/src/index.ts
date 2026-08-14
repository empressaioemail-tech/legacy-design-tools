/**
 * @workspace/cad-ingest — batch ingest of free county appraisal
 * district (CAD) bulk exports into the `cad_property` store.
 *
 * See src/cli.ts for the operator entrypoint and src/counties.ts for
 * the supported counties + formats.
 */

export * from "./types";
export * from "./counties";
export { CAD_BULK_SOURCES, resolveCadBulkSource } from "./sources";
export type {
  CadBulkSource,
  OpenFetchSource,
  ManualDownloadSource,
  BulkDataset,
} from "./sources";
export * from "./normalize";
export { readCsvRows, HeaderIndex } from "./csv";
export {
  parsePacsExport,
  parsePacsInfoLine,
  readImprovementRollups,
} from "./pacs/parser";
export {
  APPRAISAL_INFO,
  APPRAISAL_INFO_MIN_LEN,
  EXEMPTION_FLAGS,
  IMPROVEMENT_DETAIL,
} from "./pacs/layout";
export {
  parseOrionExport,
  readOrionOwners,
  readOrionSegments,
  classifyOrionHeader,
} from "./orion/parser";
export { upsertCadProperties, DEFAULT_BATCH_SIZE } from "./ingest";
export type { CadIngestDb, UpsertOptions } from "./ingest";
export {
  DECLARED_CAD_VINTAGES,
  VINTAGE_GAP_ABSENCE_BASIS,
  classifyCadPropertyMiss,
  resolveDeclaredCadVintage,
  tryResolveDeclaredCadVintage,
} from "./vintage";
export type { DeclaredCadVintage, CadVintageMissClass } from "./vintage";
export { downloadToFile, isUrl, BROWSER_UA } from "./download";
export {
  extractCadDrop,
  extractZipEntries,
  PACS_ENTRY_FILTER,
  ORION_ENTRY_FILTER,
} from "./zip";
export * from "./txgio/geo";
export {
  TXGIO_ABSENT_FROM_STRATMAP,
  TXGIO_COUNTIES,
  TXGIO_STATEWIDE_COUNTIES,
  isTexasCountyFips,
  isTxgioCountyLoaded,
  resolveTxgioCounty,
  txgioDownloadUrl,
} from "./txgio/counties";
export type { TxgioCounty } from "./txgio/counties";
export {
  assertDeclineCeiling,
  assertFinalDeclineCeiling,
  assertTexasWgs84Bbox,
  assertWgs84Prj,
  classifyPrj,
  isNullPlaceholderFeature,
  normalizeTxgioFeature,
  TxgioDeclineCeilingError,
  TxgioProjectionError,
  FRACTION_CEILING_MIN_SAMPLE,
  TXGIO_ENTRY_FILTER,
  TXGIO_MAX_DECLINED_ABSOLUTE,
  TXGIO_MAX_DECLINED_FRACTION,
  TXGIO_MAX_GEOMETRY_ABSENT_FRACTION,
} from "./txgio/parse";
export type {
  TxgioParcelRecord,
  TxgioFeature,
  TxgioNormalizeOptions,
  TxgioPrjKind,
} from "./txgio/parse";
export {
  reprojectGeometry,
  webMercatorToWgs84,
  wgs84ToWebMercator,
  TxgioReprojectionError,
  WEB_MERCATOR_MAX_M,
  WEB_MERCATOR_RADIUS_M,
} from "./txgio/reproject";
export type { SupportedSourceCrs } from "./txgio/reproject";
export {
  discoverAllShapefiles,
  selectShapefileLayers,
  multiShapefileVintage,
} from "./txgio/shapefile-discover";
export type {
  MultiShpMode,
  ResolvedShapefile,
} from "./txgio/shapefile-discover";
export {
  countCountyParcels,
  listLoadedCountyFips,
  storeLoadedLabel,
  storeListLoadState,
  deleteCountyParcels,
  replaceCountyParcels,
  upsertTxgioParcels,
  vintageWithProvenance,
  REPROJECTED_VINTAGE_SUFFIX,
  TXGIO_DEFAULT_BATCH_SIZE,
} from "./txgio/ingest";
export type {
  TxgioIngestDb,
  TxgioReplaceSummary,
  TxgioTransactionalDb,
  TxgioUpsertOptions,
  TxgioUpsertSummary,
} from "./txgio/ingest";
export { ADDRESS_COUNTIES, resolveAddressCounty } from "./address/counties";
export type { AddressCounty } from "./address/counties";
export {
  getJurisdictionConfig,
  listJurisdictions,
  listJurisdictionFips,
  unlinkedSetbackKeys,
} from "./jurisdictions";
export type { JurisdictionConfig } from "./jurisdictions";
export {
  addressLayerUrl,
  countAddressPoints,
  fetchAddressFeatures,
  ADDRESS_PAGE_SIZE,
  ADDRESS_RATE_MS,
} from "./address/service";
export type { AddressServiceOptions, FetchJson } from "./address/service";
export { normalizeAddressFeature } from "./address/parse";
export type { TxgioAddressRecord, AddressFeature } from "./address/parse";
export {
  deleteCountyAddresses,
  upsertAddresses,
  ADDRESS_DEFAULT_BATCH_SIZE,
} from "./address/ingest";
export type {
  AddressIngestDb,
  AddressUpsertOptions,
  AddressUpsertSummary,
} from "./address/ingest";
export {
  cityLayerUrl,
  countyLayerUrl,
  countCityBoundaries,
  countCountyBoundaries,
  fetchCityBoundaryFeatures,
  fetchCountyBoundaryFeatures,
  CITY_SOURCE_CITATION,
  COUNTY_SOURCE_CITATION,
  CITY_DEFAULT_VINTAGE,
  COUNTY_DEFAULT_VINTAGE,
} from "./boundary/service";
export {
  normalizeCityBoundaryFeature,
  normalizeCountyBoundaryFeature,
} from "./boundary/parse";
export type {
  TxCityBoundaryRecord,
  TxCountyBoundaryRecord,
  BoundaryFeature,
} from "./boundary/parse";
export {
  deleteAllCityBoundaries,
  deleteAllCountyBoundaries,
  upsertCityBoundaries,
  upsertCountyBoundaries,
  BOUNDARY_DEFAULT_BATCH_SIZE,
} from "./boundary/ingest";
export type {
  BoundaryIngestDb,
  BoundaryUpsertOptions,
  BoundaryUpsertSummary,
} from "./boundary/ingest";
export {
  buildCityBoundaryIndex,
  buildCountyBoundaryIndex,
  resolveCityContainment,
  resolveCityContainmentAtPoint,
  resolveCountyContainment,
  resolveCountyContainmentAtPoint,
  representativePoint,
} from "./boundary/containment";
export type {
  CityBoundaryIndexEntry,
  CountyBoundaryIndexEntry,
  CityContainmentResult,
  CountyContainmentResult,
} from "./boundary/containment";
export {
  NFHL_DEFAULT_SOURCE,
  NFHL_DEFAULT_VINTAGE,
  NFHL_FLOOD_LAYER,
  NFHL_SOURCE_CITATION,
  nfhlBulkDownloadUrl,
} from "./nfhl/service";
export { normalizeNfhlFeature, assertNfhlGeographicCoordinates } from "./nfhl/parse";
export type { TxFemaNfhlFloodZoneRecord, NfhlFeature } from "./nfhl/parse";
export {
  deleteAllNfhlFloodZones,
  countAllNfhlFloodZones,
  upsertNfhlFloodZones,
  NFHL_DEFAULT_BATCH_SIZE,
} from "./nfhl/ingest";
export type { NfhlIngestDb, NfhlUpsertOptions, NfhlUpsertSummary } from "./nfhl/ingest";
export {
  buildNfhlZoneIndex,
  resolveParcelFloodZones,
} from "./nfhl/evaluation";
export type {
  NfhlZoneIndexEntry,
  ParcelFloodZoneHit,
  ParcelFloodZoneResult,
} from "./nfhl/evaluation";
