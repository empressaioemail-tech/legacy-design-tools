#!/usr/bin/env node
/**
 * Texas city + county boundary ingest CLI — statewide uniform layers (L1).
 *
 * Usage:
 *   pnpm exec tsx src/boundary/cli.ts [--dry-run] [--count-only]
 *     [--layer=city|county|both]  # default: both
 *     [--limit=N] [--batch-size=100] [--rate-ms=500]
 *     [--city-vintage=label] [--county-vintage=label]
 *
 * DATABASE_URL must point at the target Postgres unless --dry-run / --count-only.
 *
 * Acquires the full statewide set in one pass per layer (exit-bounded
 * pagination, then exit). Replace semantics: DELETE all rows for the layer,
 * then batch insert. Re-runs are idempotent.
 *
 * Sources (four-point probed 2026-08-08, see boundary/service.ts):
 *   City:   TxGIO City_Boundaries/.../MapServer/0 (~1,225 polygons)
 *   County: Census TIGERweb State_County/MapServer/1 (254 TX counties;
 *           TxGIO has no county layer)
 */

import { parseArgs } from "node:util";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  CITY_DEFAULT_VINTAGE,
  CITY_SOURCE_CITATION,
  COUNTY_DEFAULT_VINTAGE,
  COUNTY_SOURCE_CITATION,
  countCityBoundaries,
  countCountyBoundaries,
  fetchCityBoundaryFeatures,
  fetchCountyBoundaryFeatures,
} from "./service";
import {
  normalizeCityBoundaryFeature,
  normalizeCountyBoundaryFeature,
  type BoundaryFeature,
} from "./parse";
import {
  deleteAllCityBoundaries,
  deleteAllCountyBoundaries,
  upsertCityBoundaries,
  upsertCountyBoundaries,
  BOUNDARY_DEFAULT_BATCH_SIZE,
} from "./ingest";
import { newCounters } from "../types";

const { Pool } = pg;

function log(msg: string): void {
  console.log(`[boundary-ingest] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[boundary-ingest] ERROR: ${msg}`);
  process.exit(1);
}

type LayerChoice = "city" | "county" | "both";

async function ingestCityLayer(opts: {
  dryRun: boolean;
  db: ReturnType<typeof drizzle> | null;
  limit?: number;
  batchSize: number;
  rateMs: number;
  vintage: string;
}): Promise<{ parsed: number; inserted: number; serviceCount: number }> {
  const serviceCount = await countCityBoundaries();
  log(`city service reports ${serviceCount} features`);
  const counters = newCounters();
  async function* records() {
    for await (const feature of fetchCityBoundaryFeatures({
      limit: opts.limit,
      rateMs: opts.rateMs,
      onPage: ({ offset, got, total }) =>
        log(`city page offset=${offset} got=${got} total=${total}`),
    })) {
      counters.rowsRead += 1;
      const rec = normalizeCityBoundaryFeature(
        feature as BoundaryFeature,
        counters,
      );
      if (rec) {
        counters.rowsParsed += 1;
        yield rec;
      }
    }
  }
  let inserted = 0;
  if (!opts.dryRun && opts.db) {
    log("replacing all tx_city_boundary rows");
    await deleteAllCityBoundaries(opts.db);
    const summary = await upsertCityBoundaries(opts.db, records(), {
      source: "TxGIO/CPA",
      sourceVintage: opts.vintage,
      sourceCitation: CITY_SOURCE_CITATION,
      batchSize: opts.batchSize,
      onBatch: (total) => {
        if (total % 500 < opts.batchSize) log(`city inserted ${total} rows...`);
      },
    });
    inserted = summary.rowsInserted;
  } else {
    for await (const _ of records()) {
      // drain
    }
  }
  return { parsed: counters.rowsParsed, inserted, serviceCount };
}

async function ingestCountyLayer(opts: {
  dryRun: boolean;
  db: ReturnType<typeof drizzle> | null;
  limit?: number;
  batchSize: number;
  rateMs: number;
  vintage: string;
}): Promise<{ parsed: number; inserted: number; serviceCount: number }> {
  const serviceCount = await countCountyBoundaries();
  log(`county service reports ${serviceCount} TX features`);
  const counters = newCounters();
  async function* records() {
    for await (const feature of fetchCountyBoundaryFeatures({
      limit: opts.limit,
      rateMs: opts.rateMs,
      onPage: ({ offset, got, total }) =>
        log(`county page offset=${offset} got=${got} total=${total}`),
    })) {
      counters.rowsRead += 1;
      const rec = normalizeCountyBoundaryFeature(
        feature as BoundaryFeature,
        counters,
      );
      if (rec) {
        counters.rowsParsed += 1;
        yield rec;
      }
    }
  }
  let inserted = 0;
  if (!opts.dryRun && opts.db) {
    log("replacing all tx_county_boundary rows");
    await deleteAllCountyBoundaries(opts.db);
    const summary = await upsertCountyBoundaries(opts.db, records(), {
      source: "U.S. Census Bureau (TIGERweb)",
      sourceVintage: opts.vintage,
      sourceCitation: COUNTY_SOURCE_CITATION,
      batchSize: opts.batchSize,
      onBatch: (total) => {
        if (total % 100 < opts.batchSize) log(`county inserted ${total} rows...`);
      },
    });
    inserted = summary.rowsInserted;
  } else {
    for await (const _ of records()) {
      // drain
    }
  }
  return { parsed: counters.rowsParsed, inserted, serviceCount };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({
    args,
    options: {
      "dry-run": { type: "boolean", default: false },
      "count-only": { type: "boolean", default: false },
      layer: { type: "string", default: "both" },
      limit: { type: "string" },
      "batch-size": { type: "string" },
      "rate-ms": { type: "string" },
      "city-vintage": { type: "string" },
      "county-vintage": { type: "string" },
    },
  });

  const layer = (values.layer ?? "both") as LayerChoice;
  if (layer !== "city" && layer !== "county" && layer !== "both") {
    fail(`unknown --layer=${layer}; use city, county, or both`);
  }

  const dryRun = values["dry-run"] ?? false;
  const countOnly = values["count-only"] ?? false;
  const databaseUrl = process.env.DATABASE_URL;
  if (!dryRun && !countOnly && !databaseUrl) {
    fail("DATABASE_URL must be set (or pass --dry-run / --count-only)");
  }

  if (countOnly) {
    if (layer === "city" || layer === "both") {
      log(`city count: ${await countCityBoundaries()}`);
    }
    if (layer === "county" || layer === "both") {
      log(`county count: ${await countCountyBoundaries()}`);
    }
    return;
  }

  const limit = values.limit !== undefined ? Number(values.limit) : undefined;
  const batchSize =
    values["batch-size"] !== undefined
      ? Number(values["batch-size"])
      : BOUNDARY_DEFAULT_BATCH_SIZE;
  const rateMs = values["rate-ms"] !== undefined ? Number(values["rate-ms"]) : 500;
  const cityVintage = values["city-vintage"] ?? CITY_DEFAULT_VINTAGE;
  const countyVintage = values["county-vintage"] ?? COUNTY_DEFAULT_VINTAGE;

  const startedAt = Date.now();
  let pool: pg.Pool | null = null;
  let db: ReturnType<typeof drizzle> | null = null;
  if (!dryRun && databaseUrl) {
    pool = new Pool({ connectionString: databaseUrl });
    db = drizzle(pool);
  }

  try {
    if (layer === "city" || layer === "both") {
      const city = await ingestCityLayer({
        dryRun,
        db,
        limit,
        batchSize,
        rateMs,
        vintage: cityVintage,
      });
      log("---- city summary ----");
      log(`service count:  ${city.serviceCount}`);
      log(`parsed:       ${city.parsed}`);
      log(`inserted:     ${dryRun ? "0 (dry-run)" : city.inserted}`);
      if (city.parsed === 0) fail("zero city features parsed");
    }

    if (layer === "county" || layer === "both") {
      const county = await ingestCountyLayer({
        dryRun,
        db,
        limit,
        batchSize,
        rateMs,
        vintage: countyVintage,
      });
      log("---- county summary ----");
      log(`service count:  ${county.serviceCount}`);
      log(`parsed:       ${county.parsed}`);
      log(`inserted:     ${dryRun ? "0 (dry-run)" : county.inserted}`);
      if (county.parsed === 0) fail("zero county features parsed");
    }
  } finally {
    if (pool) await pool.end();
  }

  log(`duration: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error("[boundary-ingest] FATAL:", err);
  process.exit(1);
});
