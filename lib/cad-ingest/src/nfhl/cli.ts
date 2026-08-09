#!/usr/bin/env node
/**
 * FEMA NFHL statewide flood-zone ingest CLI — layer-first L4a.
 *
 * Usage:
 *   pnpm exec tsx src/nfhl/cli.ts [--dry-run] [--count-only]
 *     [--file=<local NFHL_48_*.zip | https URL>]  # default: FEMA bulk URL
 *     [--limit=N] [--batch-size=250] [--vintage=label]
 *
 * DATABASE_URL must point at the target Postgres unless --dry-run / --count-only.
 *
 * Acquires the full Texas NFHL polygon set in one pass from the MSC
 * statewide bulk zip (`NFHL_48_20260101.zip`, S_FLD_HAZ_AR layer inside
 * the FileGDB). Replace semantics: DELETE all rows, then batch insert.
 * Re-runs are idempotent.
 *
 * Projection: the FileGDB ships NAD83 geographic (EPSG:4269, degrees).
 * ogr2ogr reprojects to EPSG:4326 at extract time; parse.ts then runs
 * the Texas WGS84 coordinate-range assertion on every feature (same
 * discipline as txgio/parse.ts after PR #396/#397).
 *
 * DRY RUN PREDICTS THE APPLY: reports features parsed, rows that would
 * be deleted (existing table count), and rows that would be inserted.
 */

import { parseArgs } from "node:util";
import { mkdtemp } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { downloadToFile, isUrl } from "../download";
import { newCounters } from "../types";
import {
  countAllNfhlFloodZones,
  deleteAllNfhlFloodZones,
  NFHL_DEFAULT_BATCH_SIZE,
  upsertNfhlFloodZones,
  type NfhlIngestDb,
} from "./ingest";
import { normalizeNfhlFeature } from "./parse";
import { ogrInfoLayer, streamGdbLayerGeoJson } from "./gdal";
import {
  gdbDirFromArchive,
  NFHL_DEFAULT_SOURCE,
  NFHL_DEFAULT_VINTAGE,
  NFHL_FLOOD_LAYER,
  NFHL_SOURCE_CITATION,
  nfhlBulkDownloadUrl,
} from "./service";

const { Pool } = pg;

function log(msg: string): void {
  console.log(`[nfhl-ingest] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[nfhl-ingest] ERROR: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({
    args,
    options: {
      "dry-run": { type: "boolean", default: false },
      "count-only": { type: "boolean", default: false },
      file: { type: "string" },
      limit: { type: "string" },
      "batch-size": { type: "string" },
      vintage: { type: "string" },
    },
  });

  const dryRun = values["dry-run"] ?? false;
  const countOnly = values["count-only"] ?? false;
  const databaseUrl = process.env.DATABASE_URL;
  if (!dryRun && !countOnly && !databaseUrl) {
    fail("DATABASE_URL must be set (or pass --dry-run / --count-only)");
  }

  const sourceUrl = values.file ?? nfhlBulkDownloadUrl();
  const archiveName = basename(isUrl(sourceUrl) ? sourceUrl : sourceUrl);
  const gdbDir = gdbDirFromArchive(archiveName);
  const vintage = values.vintage ?? NFHL_DEFAULT_VINTAGE;
  const limit = values.limit !== undefined ? Number(values.limit) : undefined;
  const batchSize =
    values["batch-size"] !== undefined
      ? Number(values["batch-size"])
      : NFHL_DEFAULT_BATCH_SIZE;

  const startedAt = Date.now();
  const workDir = await mkdtemp(join(tmpdir(), "nfhl-ingest-"));

  let zipPath = sourceUrl;
  if (isUrl(sourceUrl)) {
    log(`fetching ${sourceUrl}`);
    zipPath = await downloadToFile(sourceUrl, workDir, log);
  }

  const loc = { zipPath, gdbDir };

  log(`probing ${NFHL_FLOOD_LAYER} in ${archiveName}/${gdbDir}`);
  const layerInfo = await ogrInfoLayer(loc, NFHL_FLOOD_LAYER);
  log(
    `source layer: ${layerInfo.layerName} geometry=${layerInfo.geometryType} ` +
      `features=${layerInfo.featureCount} srs=EPSG:${layerInfo.srsEpsg ?? "?"}`,
  );
  if (!layerInfo.fields.includes("FLD_ZONE")) {
    fail(
      `layer ${NFHL_FLOOD_LAYER} missing FLD_ZONE — wrong layer index ` +
        `(fields: ${layerInfo.fields.slice(0, 8).join(", ")})`,
    );
  }

  if (countOnly) {
    log(`feature count: ${layerInfo.featureCount}`);
    return;
  }

  const counters = newCounters();

  async function* normalizedRecords() {
    for await (const feature of streamGdbLayerGeoJson(
      loc,
      NFHL_FLOOD_LAYER,
      { limit },
    )) {
      counters.rowsRead += 1;
      const rec = normalizeNfhlFeature(feature, counters);
      if (rec) {
        counters.rowsParsed += 1;
        yield rec;
      }
    }
  }

  let rowsExisting: number | null = null;
  let rowsInserted = 0;

  if (dryRun) {
    let pool: pg.Pool | undefined;
    try {
      if (databaseUrl) {
        pool = new Pool({ connectionString: databaseUrl });
        rowsExisting = await countAllNfhlFloodZones(
          drizzle(pool) as unknown as NfhlIngestDb,
        );
      }
      for await (const _ of normalizedRecords()) {
        rowsInserted += 1;
      }
    } finally {
      await pool?.end();
    }
  } else {
    const pool = new Pool({ connectionString: databaseUrl! });
    try {
      const db = drizzle(pool) as unknown as NfhlIngestDb;
      rowsExisting = await countAllNfhlFloodZones(db);
      log(`replacing all tx_fema_nfhl_flood_zone rows (${rowsExisting} present)`);
      await deleteAllNfhlFloodZones(db);
      const summary = await upsertNfhlFloodZones(db, normalizedRecords(), {
        source: NFHL_DEFAULT_SOURCE,
        sourceVintage: vintage,
        sourceCitation: NFHL_SOURCE_CITATION,
        batchSize,
        onBatch: (total) => {
          if (total % 10_000 < batchSize) log(`inserted ${total} rows...`);
        },
      });
      rowsInserted = summary.rowsInserted;
    } finally {
      await pool.end();
    }
  }

  const wouldOrDid = dryRun ? "would " : "";
  const deleteCount =
    rowsExisting === null ? "unknown (no DATABASE_URL)" : rowsExisting;
  log(`---- nfhl ingest summary${dryRun ? " (DRY RUN — nothing written)" : ""} ----`);
  log(`archive:          ${archiveName}`);
  log(`gdb layer:        ${NFHL_FLOOD_LAYER}`);
  log(`service count:    ${layerInfo.featureCount}`);
  log(`source CRS:       EPSG:${layerInfo.srsEpsg ?? "?"} (NAD83 geographic) -> WGS84 via ogr2ogr`);
  log(`source vintage:   ${vintage}`);
  log(`features read:    ${counters.rowsRead}`);
  log(`features parsed:  ${counters.rowsParsed}`);
  log(`rows ${wouldOrDid}delete:  ${deleteCount}`);
  log(`rows ${wouldOrDid}insert:  ${rowsInserted}`);
  log(`features skipped: ${counters.rowsSkipped}`);
  log(`duration:         ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  if (counters.skipSamples.length > 0) {
    log(`skip samples:     ${counters.skipSamples.join(" | ")}`);
  }
  if (counters.rowsParsed === 0) {
    fail("zero features parsed — wrong layer or projection failure");
  }
}

main().catch((err) => {
  console.error("[nfhl-ingest] FATAL:", err);
  process.exit(1);
});
