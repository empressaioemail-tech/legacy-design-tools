/**
 * @workspace/cad-ingest — batch ingest of free county appraisal
 * district (CAD) bulk exports into the `cad_property` store.
 *
 * See src/cli.ts for the operator entrypoint and src/counties.ts for
 * the supported counties + formats.
 */

export * from "./types";
export * from "./counties";
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
  TXGIO_COUNTIES,
  resolveTxgioCounty,
  txgioDownloadUrl,
} from "./txgio/counties";
export type { TxgioCounty } from "./txgio/counties";
export {
  normalizeTxgioFeature,
  assertWgs84Prj,
  TXGIO_ENTRY_FILTER,
} from "./txgio/parse";
export type { TxgioParcelRecord, TxgioFeature } from "./txgio/parse";
export {
  deleteCountyParcels,
  upsertTxgioParcels,
  TXGIO_DEFAULT_BATCH_SIZE,
} from "./txgio/ingest";
export type {
  TxgioIngestDb,
  TxgioUpsertOptions,
  TxgioUpsertSummary,
} from "./txgio/ingest";
