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
  assertTexasWgs84Bbox,
  assertWgs84Prj,
  normalizeTxgioFeature,
  TxgioProjectionError,
  TXGIO_ENTRY_FILTER,
} from "./txgio/parse";
export type { TxgioParcelRecord, TxgioFeature } from "./txgio/parse";
export {
  countCountyParcels,
  deleteCountyParcels,
  replaceCountyParcels,
  upsertTxgioParcels,
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
