/**
 * @workspace/permit-ingest — batch ingest of free municipal permit
 * open-data exports (Austin/San Antonio) into the `building_permits`
 * store.
 *
 * Column mapping is shared with the K2 calibration harness via
 * `@workspace/calibration-engines/k2` (`permitColumns.ts`), so the
 * store and the harness read the same corpus identically. See
 * `src/cli.ts` for the operator entrypoint and `src/sources.ts` for the
 * supported sources.
 */

export * from "./types";
export * from "./sources";
export { readCsvStream, readCsvFile, rowToRecord } from "./csv";
export type { CsvRow } from "./csv";
export {
  toCalendarDate,
  normalizePermitRow,
  parsePermitStream,
} from "./normalize";
export { openInput, isGcsUri, deriveVintage } from "./input";
export type { ResolvedInput } from "./input";
export { upsertBuildingPermits, DEFAULT_BATCH_SIZE } from "./ingest";
export type { PermitIngestDb, UpsertOptions } from "./ingest";
