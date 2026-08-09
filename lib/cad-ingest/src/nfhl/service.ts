/**
 * FEMA NFHL statewide bulk source constants and probe evidence.
 *
 * Four-point probe (2026-08-08, primary):
 *
 * BULK FILE — hazards.fema.gov/nfhlv2/output/State/NFHL_48_20260101.zip
 *   1. File root: HTTP 206 Partial Content, application/x-zip-compressed,
 *      Content-Range bytes 0-0/1810100601 (~1.81 GB), Last-Modified
 *      Sat, 03 Jan 2026 10:17:57 GMT.
 *   2. Archive contents (zip local headers): NFHL_48_20260101.gdb/
 *      FileGDB (OpenFileGDB driver).
 *   3. Target layer S_FLD_HAZ_AR (verified via ogrinfo on the live zip):
 *      Multi Polygon, Feature Count 198240 (Texas statewide), fields
 *      FLD_ZONE, ZONE_SUBTY, SFHA_TF, STATIC_BFE, DFIRM_ID, FLD_AR_ID
 *      (exact casing), FID OBJECTID, display/id companion FLD_AR_ID.
 *   4. Owner: FEMA / MSC; $0 public download.
 *
 * Adversarial re-probe (2026-08-08):
 *   - S_FIRM_PAN in the same gdb: 5328 panel-index polygons, NO FLD_ZONE
 *     field — confirms S_FLD_HAZ_AR is the flood-zone layer, not panels.
 *   - ArcGIS MapServer layer 0 "NFHL Availability": 3199 features (not
 *     flood zones); layer 28 "Flood Hazard Zones": 5,805,168 nationwide —
 *     layer 28 matches S_FLD_HAZ_AR semantics; layer 0 would be wrong.
 *   - Sample S_FLD_HAZ_AR feature: FLD_ZONE='A', SFHA_TF='T', DFIRM_ID
 *     present — not a line/point layer.
 *
 * LIVE POINT-QUERY LAYER (unchanged; out-of-state + freshness fallback):
 *   https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28
 */

import { basename } from "node:path";

export const NFHL_BULK_BASE_URL =
  "https://hazards.fema.gov/nfhlv2/output/State";

export const NFHL_DEFAULT_ARCHIVE = "NFHL_48_20260101.zip";

export const NFHL_DEFAULT_GDB_DIR = "NFHL_48_20260101.gdb";

/** Flood-hazard area polygon layer inside the Texas NFHL FileGDB. */
export const NFHL_FLOOD_LAYER = "S_FLD_HAZ_AR";

export const NFHL_SOURCE_CITATION = `${NFHL_BULK_BASE_URL}/${NFHL_DEFAULT_ARCHIVE}`;

export const NFHL_DEFAULT_VINTAGE = "NFHL_48_20260101";

export const NFHL_DEFAULT_SOURCE = "FEMA NFHL (MSC statewide bulk)";

export const NFHL_ARCGIS_LAYER_URL =
  "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28";

/** FEMA ships STATIC_BFE/DEPth sentinels at -9999 when absent. */
export const NFHL_NULL_NUMERIC = -9999;

export function nfhlBulkDownloadUrl(
  archive = NFHL_DEFAULT_ARCHIVE,
): string {
  return `${NFHL_BULK_BASE_URL}/${archive}`;
}

export function gdbDirFromArchive(archive: string): string {
  const base = basename(archive);
  if (/^NFHL_\d+_\d+\.zip$/i.test(base)) {
    return base.replace(/\.zip$/i, ".gdb");
  }
  // Local copies may use arbitrary filenames; the MSC archive always
  // contains NFHL_48_<date>.gdb at a fixed inner path.
  return NFHL_DEFAULT_GDB_DIR;
}
