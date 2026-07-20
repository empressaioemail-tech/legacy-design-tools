#!/usr/bin/env node
/**
 * Parcel zoning-district stamp CLI (F11).
 *
 * Attaches the REAL zoning district to self-hosted TxGIO parcels so the
 * buildable-envelope route uses the true district's setbacks instead of the
 * most-conservative fallback. For one city it fetches that city's public
 * zoning GIS layer (config in `zoning-layers.ts`) into an in-memory index,
 * then point-in-polygons each of the city county's `txgio_parcel` centroids
 * against it and writes the matched district code to the parcel's new
 * `zoning_district` column (migration 0059). The api-server surfaces that as
 * `feature.properties.zoningCode` (txgioParcelStore `toFeature()`), which
 * `mapDistrict()` matches to the setback district.
 *
 * Usage:
 *   pnpm --filter @workspace/cad-ingest zoning-stamp -- \
 *     --city=georgetown-tx \
 *     [--limit=N] [--dry-run]
 *   pnpm --filter @workspace/cad-ingest zoning-stamp -- --list
 *
 * DATABASE_URL must point at the target Postgres unless --dry-run. The new
 * `zoning_district` column must exist on the deployment DB (migration 0059)
 * or every UPDATE no-ops silently — apply the migration first.
 *
 * Additive + idempotent + exit-bounded: only `zoning_district` is written,
 * a re-run recomputes and overwrites in place, and the run fetches the
 * zoning layer + stamps + prints a summary, then exits (0 on success, 1 on
 * fatal error or an empty zoning layer).
 *
 * Egress: the zoning fetch is a plain HTTPS GET to the city's ArcGIS host.
 * Some public ArcGIS TLS setups have an unreachable OCSP/CRL endpoint from
 * a sandboxed runner; run the CLI with the sandbox relaxed for the fetch.
 */

import { parseArgs } from "node:util";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { ZONING_LAYERS, resolveZoningLayer } from "./zoning-layers";
import { fetchZoningFeatures } from "./zoning-service";
import { buildZoningIndex } from "./zoning-stamp";
import { stampCountyZoning } from "./zoning-stamp-db";

const { Pool } = pg;

function log(msg: string): void {
  console.log(`[zoning-stamp] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[zoning-stamp] ERROR: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({
    args,
    options: {
      city: { type: "string" },
      limit: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      list: { type: "boolean", default: false },
    },
  });

  if (values.list) {
    log("configured zoning layers (city -> ZONE field / county):");
    for (const c of Object.values(ZONING_LAYERS)) {
      log(
        `  ${c.cityKey.padEnd(16)} county=${c.countyFips} ` +
          `field=${c.codeField} ${c.layerUrl}`,
      );
    }
    log(`total: ${Object.keys(ZONING_LAYERS).length}`);
    return;
  }

  if (!values.city) {
    fail(
      "usage: zoning-stamp --city=<key|name|countyFips> [--limit=N] " +
        "[--dry-run] | zoning-stamp --list",
    );
  }
  const cfg = resolveZoningLayer(values.city);
  if (!cfg) {
    const supported = Object.values(ZONING_LAYERS)
      .map((c) => c.cityKey)
      .join(", ");
    fail(`unknown city "${values.city}" — configured: ${supported}`);
  }

  const dryRun = values["dry-run"] ?? false;
  const databaseUrl = process.env.DATABASE_URL;
  if (!dryRun && !databaseUrl) {
    fail("DATABASE_URL must be set (or pass --dry-run to fetch + PIP only)");
  }
  const limit = values.limit !== undefined ? Number(values.limit) : undefined;
  if (limit !== undefined && !Number.isInteger(limit)) {
    fail(`--limit must be an integer, got "${values.limit}"`);
  }

  const startedAt = Date.now();
  log(`city=${cfg.cityKey} (${cfg.cityName}) county=${cfg.countyFips}`);
  log(`zoning layer: ${cfg.layerUrl}`);
  log(`code field: ${cfg.codeField}${cfg.descriptionField ? ` / desc ${cfg.descriptionField}` : ""}`);

  // 1. Fetch the zoning layer into the in-memory index.
  log("fetching zoning polygons...");
  const raw = await fetchZoningFeatures({
    cfg,
    onPage: ({ total }) => log(`  fetched ${total} zoning features...`),
  });
  const index = buildZoningIndex(raw);
  log(`zoning polygons indexed: ${index.length} (of ${raw.length} fetched)`);
  if (index.length === 0) {
    fail(
      "zero usable zoning polygons — wrong layer URL or field name; " +
        "nothing to stamp",
    );
  }
  // Distinct district codes present in the layer (the audit surface for the
  // ZONE -> setback-district alignment).
  const codesInLayer = [...new Set(index.map((p) => p.code))].sort();
  log(`district codes in layer: ${codesInLayer.join(", ")}`);

  // 2. Stamp the county's parcels.
  if (dryRun && !databaseUrl) {
    log(
      "dry-run without DATABASE_URL: fetched + indexed the zoning layer " +
        "only (no parcel read). Set DATABASE_URL to PIP against parcels.",
    );
    return;
  }
  const pool = new Pool({ connectionString: databaseUrl });
  let summary;
  try {
    const db = drizzle(pool);
    log(`${dryRun ? "DRY-RUN " : ""}stamping ${cfg.countyFips} parcels...`);
    summary = await stampCountyZoning({
      db,
      countyFips: cfg.countyFips,
      index,
      dryRun,
      limit,
      onProgress: (done, matched) =>
        log(`  stamped ${done} parcels (${matched} matched)...`),
    });
  } finally {
    await pool.end();
  }

  // 3. Summary.
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  log("---- zoning stamp summary ----");
  log(`city:             ${cfg.cityKey} (${cfg.cityName})`);
  log(`county:           ${cfg.countyFips}`);
  log(`zoning polygons:  ${index.length}`);
  log(`parcels read:     ${summary.parcelsRead}`);
  log(`parcels matched:  ${summary.parcelsMatched}`);
  log(`parcels null:     ${summary.parcelsUnmatched} (centroid in no zoning polygon)`);
  log(`rows updated:     ${dryRun ? "0 (dry-run)" : summary.rowsUpdated}`);
  const hist = Object.entries(summary.codeHistogram).sort((a, b) => b[1] - a[1]);
  log(`district histogram (${hist.length} codes):`);
  for (const [code, n] of hist) log(`  ${code.padEnd(8)} ${n}`);
  log(`duration:         ${seconds}s`);
  if (summary.parcelsRead === 0) {
    fail(
      `no parcels found for county ${cfg.countyFips} — is the county's ` +
        "geometry ingested (txgio-ingest) on this DB?",
    );
  }
}

main().catch((err) => {
  console.error("[zoning-stamp] FATAL:", err);
  process.exit(1);
});
