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
