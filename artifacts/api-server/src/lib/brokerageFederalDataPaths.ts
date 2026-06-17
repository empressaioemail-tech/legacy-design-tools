/**
 * Runtime paths for federal brokerage reference data (OZ tracts, TX SPDPID).
 *
 * Production images bake live ingests under BROKERAGE_FEDERAL_DATA_DIR
 * (see Dockerfile). Local dev / CI without ingest fall back to bundled
 * minimal fixtures under artifacts/api-server/data.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const OZ_TRACT_LIST_VERSION =
  process.env.OZ_TRACT_LIST_VERSION ?? "oz-1.0";

/** Production default — matches Dockerfile ENV + ingest output. */
export const BROKERAGE_FEDERAL_DATA_DIR_DEFAULT =
  "/app/var/brokerage-federal-data";

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
  return join(
    resolveBrokerageFederalDataDir(),
    "opportunity-zones",
    `${version}.geojson`,
  );
}

export function resolveTxSpecialDistrictsDataPath(): string {
  const explicit = process.env.TX_SPECIAL_DISTRICTS_DATA_PATH?.trim();
  if (explicit) return explicit;
  return join(resolveBrokerageFederalDataDir(), "tx-special-districts.json");
}

export function federalDataFileExists(path: string): boolean {
  return existsSync(path);
}
