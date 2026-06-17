#!/usr/bin/env node
/**
 * Upload ingested OZ + SPDPID files to GCS for cortex-api boot hydration.
 *
 * Prerequisite: run ingest first (pnpm --filter @workspace/scripts run ingest:brokerage-federal-data).
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run publish:brokerage-federal-data-gcs
 *   BROKERAGE_FEDERAL_DATA_GCS_PREFIX=/legacy-design-tools-prod-objects/public/brokerage-federal-data \
 *     pnpm --filter @workspace/scripts run publish:brokerage-federal-data-gcs
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Storage } from "@google-cloud/storage";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir =
  process.env.BROKERAGE_FEDERAL_DATA_DIR?.trim() ??
  join(repoRoot, "var", "brokerage-federal-data");
const gcsPrefix =
  process.env.BROKERAGE_FEDERAL_DATA_GCS_PREFIX?.trim() ??
  "/legacy-design-tools-prod-objects/public/brokerage-federal-data";

const ozVersion = process.env.OZ_TRACT_LIST_VERSION?.trim() ?? "oz-1.0";
const ozLocal = join(dataDir, "opportunity-zones", `${ozVersion}.geojson`);
const spdLocal = join(dataDir, "tx-special-districts.json");

for (const path of [ozLocal, spdLocal]) {
  if (!existsSync(path)) {
    throw new Error(
      `Missing ${path} — run ingest:brokerage-federal-data first`,
    );
  }
}

function parseGcsObjectPath(fullPath) {
  const normalized = fullPath.startsWith("/") ? fullPath.slice(1) : fullPath;
  const slash = normalized.indexOf("/");
  if (slash < 0) {
    throw new Error(`Invalid GCS prefix: ${fullPath}`);
  }
  return {
    bucketName: normalized.slice(0, slash),
    objectPrefix: normalized.slice(slash + 1).replace(/\/+$/, ""),
  };
}

const { bucketName, objectPrefix } = parseGcsObjectPath(gcsPrefix);
const storage = new Storage();
const bucket = storage.bucket(bucketName);

const uploads = [
  {
    local: ozLocal,
    object: `${objectPrefix}/opportunity-zones/${ozVersion}.geojson`,
  },
  {
    local: spdLocal,
    object: `${objectPrefix}/tx-special-districts.json`,
  },
];

for (const { local, object } of uploads) {
  const bytes = readFileSync(local);
  await bucket.file(object).save(bytes, {
    contentType: object.endsWith(".geojson")
      ? "application/geo+json"
      : "application/json",
    resumable: false,
  });
  console.log(`uploaded gs://${bucketName}/${object} (${bytes.length} bytes)`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      bucketName,
      objectPrefix,
      dataDir,
    },
    null,
    2,
  ),
);
