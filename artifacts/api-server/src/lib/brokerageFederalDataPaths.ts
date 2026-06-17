/**
 * Runtime paths for federal brokerage reference data (OZ tracts, TX SPDPID).
 *
 * Production images ship bundled CI fixtures under BROKERAGE_FEDERAL_DATA_DIR.
 * Live national data is ingested via a separate job, published to GCS, and
 * hydrated on boot when BROKERAGE_FEDERAL_DATA_GCS_PREFIX is set.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const OZ_TRACT_LIST_VERSION =
  process.env.OZ_TRACT_LIST_VERSION ?? "oz-1.0";

/** Production default — matches Dockerfile ENV + bundled fixture copy. */
export const BROKERAGE_FEDERAL_DATA_DIR_DEFAULT =
  "/app/var/brokerage-federal-data";

function bundledOzTractPath(version: string): string {
  return join(bundledDataDir(), "opportunity-zones", `${version}.geojson`);
}

function bundledTxSpecialDistrictsPath(): string {
  return join(bundledDataDir(), "tx-special-districts.json");
}

function bundledDataDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "../../data");
}

export function resolveBrokerageFederalDataDir(): string {
  const env = process.env.BROKERAGE_FEDERAL_DATA_DIR?.trim();
  if (env) return env;
  return bundledDataDir();
}

export function resolveOzTractDataPath(
  version = OZ_TRACT_LIST_VERSION,
): string {
  const explicit = process.env.OZ_TRACT_DATA_PATH?.trim();
  if (explicit) return explicit;
  const primary = join(
    resolveBrokerageFederalDataDir(),
    "opportunity-zones",
    `${version}.geojson`,
  );
  if (federalDataFileExists(primary)) return primary;
  return bundledOzTractPath(version);
}

export function resolveTxSpecialDistrictsDataPath(): string {
  const explicit = process.env.TX_SPECIAL_DISTRICTS_DATA_PATH?.trim();
  if (explicit) return explicit;
  const primary = join(
    resolveBrokerageFederalDataDir(),
    "tx-special-districts.json",
  );
  if (federalDataFileExists(primary)) return primary;
  return bundledTxSpecialDistrictsPath();
}

export function federalDataFileExists(path: string): boolean {
  return existsSync(path);
}
