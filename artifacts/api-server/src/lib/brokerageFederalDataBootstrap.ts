/**
 * Optional GCS hydration for live OZ + SPDPID federal data.
 *
 * When BROKERAGE_FEDERAL_DATA_GCS_PREFIX is set (e.g.
 * `/legacy-design-tools-prod-objects/public/brokerage-federal-data`),
 * download the published objects into BROKERAGE_FEDERAL_DATA_DIR on boot.
 * Ingest + publish are separate jobs — see scripts/publish-brokerage-federal-data-gcs.mjs.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { objectStorageClient } from "./objectStorage";
import {
  OZ_TRACT_LIST_VERSION,
  resolveBrokerageFederalDataDir,
  resolveOzTractDataPath,
  resolveTxSpecialDistrictsDataPath,
} from "./brokerageFederalDataPaths";

type BootLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

function parseGcsObjectPath(fullPath: string): {
  bucketName: string;
  objectPrefix: string;
} {
  const normalized = fullPath.startsWith("/") ? fullPath.slice(1) : fullPath;
  const slash = normalized.indexOf("/");
  if (slash < 0) {
    throw new Error(
      `BROKERAGE_FEDERAL_DATA_GCS_PREFIX must be /bucket/prefix — got ${fullPath}`,
    );
  }
  return {
    bucketName: normalized.slice(0, slash),
    objectPrefix: normalized.slice(slash + 1).replace(/\/+$/, ""),
  };
}

async function downloadGcsObject(
  bucketName: string,
  objectName: string,
  destPath: string,
): Promise<void> {
  const [bytes] = await objectStorageClient
    .bucket(bucketName)
    .file(objectName)
    .download();
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, bytes);
}

export async function ensureBrokerageFederalDataFromGcs(
  logger: BootLogger,
): Promise<void> {
  const prefix = process.env.BROKERAGE_FEDERAL_DATA_GCS_PREFIX?.trim();
  if (!prefix) return;

  const { bucketName, objectPrefix } = parseGcsObjectPath(prefix);
  const destDir = resolveBrokerageFederalDataDir();
  const ozDest = resolveOzTractDataPath();
  const spdDest = resolveTxSpecialDistrictsDataPath();

  const objects = [
    {
      key: `${objectPrefix}/opportunity-zones/${OZ_TRACT_LIST_VERSION}.geojson`,
      dest: ozDest,
    },
    {
      key: `${objectPrefix}/tx-special-districts.json`,
      dest: spdDest,
    },
  ];

  logger.info(
    { bucketName, objectPrefix, destDir },
    "brokerage federal data: syncing from GCS",
  );

  for (const { key, dest } of objects) {
    try {
      await downloadGcsObject(bucketName, key, dest);
      logger.info({ key, dest }, "brokerage federal data: downloaded object");
    } catch (err) {
      logger.warn(
        { err, key, dest },
        "brokerage federal data: GCS download failed — using image fixtures",
      );
    }
  }
}
