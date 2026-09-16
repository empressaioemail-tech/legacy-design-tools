#!/usr/bin/env node
/**
 * Texas ETJ bulk ingest CLI — one publisher at a time, from the register
 * (feat/p241-etj-acquisition, P-241 acquisition half).
 *
 * Usage:
 *   pnpm exec tsx src/boundary/etj-cli.ts [--dry-run] [--count-only]
 *     [--city=<cityKey>]...          # default: every register entry
 *     [--limit=N] [--batch-size=100] [--rate-ms=500] [--vintage=label]
 *     [--verify]                     # live resolve the register's control points
 *     [--json]                       # with --verify: one JSON document, nothing else
 *
 * DATABASE_URL must point at the target Postgres unless --dry-run, --count-only
 * or --verify.
 *
 * Mirrors `boundary-ingest`, with the two differences the per-publisher shape
 * forces:
 *   - acquisition is per publisher, so replace semantics are per publisher too.
 *     Only the city keys named in this run are deleted before insert; a refresh
 *     of Austin cannot drop San Antonio.
 *   - every register entry lands a `tx_etj_source` row, including the cities
 *     whose publisher exposes no ETJ layer. Those rows are the record of the
 *     enumeration, and they are what the read path uses to answer "this city
 *     publishes no ETJ" as a checked fact.
 *
 * --verify runs the REAL register, the REAL client and the REAL resolver
 * against the live publishers and prints one JSON line per control point. It
 * is the instrument for this lane's own claims: it needs no database and no
 * credential, and it fails loudly when a publisher goes stale or a predicate
 * stops selecting ETJ rows. Its output is what the close's falsifier section
 * pastes.
 *
 * This CLI is never run against production by this lane; a real bulk ingest is
 * a separate, operator-triggered step per this repo's ingest conventions.
 */

import { parseArgs } from "node:util";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  ETJ_REGISTRY,
  ETJ_SOURCE_VINTAGE,
  etjRegistryEntry,
  type EtjRegistryEntry,
} from "./etjRegistry";
import {
  countEtjFeatures,
  fetchEtjBoundaryFeatures,
  fetchEtjSourceMetadata,
} from "./etjService";
import {
  normalizeEtjBoundaryFeature,
  type TxEtjBoundaryRecord,
} from "./etjParse";
import {
  ETJ_DEFAULT_BATCH_SIZE,
  deleteEtjBoundariesForSources,
  upsertEtjBoundaries,
  upsertEtjSources,
  type EtjSourceRowMeta,
} from "./etjIngest";
import { newCounters } from "../types";
import { ETJ_CONTROL_POINTS, verifyEtjControlPoints } from "./etjVerify";

const { Pool } = pg;

/**
 * True when `--json` was passed: one machine-readable document on stdout and
 * nothing else, so an instrument (scripts/surface-probe.mjs's P-241 row) can
 * read the run without parsing prose or dropping interleaved progress lines.
 * Human progress moves to stderr in this mode rather than disappearing.
 */
let jsonMode = false;

function log(msg: string): void {
  if (jsonMode) {
    console.error(`[etj-ingest] ${msg}`);
    return;
  }
  console.log(`[etj-ingest] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[etj-ingest] ERROR: ${msg}`);
  process.exit(1);
}

interface CityOutcome {
  cityKey: string;
  mode: string;
  serviceCount: number;
  parsed: number;
  inserted: number;
  hasRings: boolean;
  layerName: string | null;
  extentWgs84: string | null;
}

async function ingestCity(opts: {
  entry: EtjRegistryEntry;
  dryRun: boolean;
  db: ReturnType<typeof drizzle> | null;
  limit?: number;
  batchSize: number;
  rateMs: number;
  vintage: string;
}): Promise<{ outcome: CityOutcome; sourceRow: EtjSourceRowMeta }> {
  const { entry } = opts;
  const counters = newCounters();

  if (entry.layerUrl === null) {
    log(`${entry.cityKey}: mode=${entry.mode} — no ETJ layer published; recorded, no rings`);
    return {
      outcome: {
        cityKey: entry.cityKey,
        mode: entry.mode,
        serviceCount: 0,
        parsed: 0,
        inserted: 0,
        hasRings: false,
        layerName: null,
        extentWgs84: null,
      },
      sourceRow: {
        cityKey: entry.cityKey,
        cityName: entry.cityName,
        cityGeoId: entry.cityGeoId,
        mode: entry.mode,
        layerUrl: null,
        layerName: null,
        hasEtjRings: false,
        bbox: null,
        etjRingCount: 0,
        layerLastEditAt: null,
        sourceVintage: opts.vintage,
        sourceCitation: `no published ETJ layer (enumerated ${entry.verifiedAt})`,
      },
    };
  }

  const metadata = await fetchEtjSourceMetadata(entry);
  const serviceCount = await countEtjFeatures(entry);
  log(
    `${entry.cityKey}: layer "${metadata.layerName ?? "?"}" reports ${serviceCount} ETJ features ` +
      `(extent ${metadata.extentWgs84 ? "read" : "UNREADABLE"}, lastEdit ${metadata.lastEditAt ?? "not published"})`,
  );
  if (serviceCount === 0) {
    fail(
      `${entry.cityKey}: the publisher's ETJ predicate selected ZERO features. ` +
        `A predicate that matches nothing is a stale registry entry or a changed attribute, ` +
        `never an ETJ-less city — refusing to record it as one.`,
    );
  }

  async function* records(): AsyncGenerator<TxEtjBoundaryRecord> {
    for await (const feature of fetchEtjBoundaryFeatures(entry, {
      limit: opts.limit,
      rateMs: opts.rateMs,
      onPage: ({ offset, got, total }) =>
        log(`${entry.cityKey}: page offset=${offset} got=${got} total=${total}`),
    })) {
      counters.rowsRead += 1;
      const rec = normalizeEtjBoundaryFeature(entry, feature, metadata, counters);
      if (rec) {
        counters.rowsParsed += 1;
        yield rec;
      }
    }
  }

  let inserted = 0;
  if (!opts.dryRun && opts.db) {
    await deleteEtjBoundariesForSources(opts.db, [entry.cityKey]);
    const summary = await upsertEtjBoundaries(opts.db, records(), {
      source: entry.owner,
      sourceVintage: opts.vintage,
      batchSize: opts.batchSize,
      onBatch: (total) => log(`${entry.cityKey}: inserted ${total} rings...`),
    });
    inserted = summary.rowsInserted;
  } else {
    for await (const _ of records()) {
      // drain
    }
  }

  if (counters.rowsParsed === 0) {
    fail(`${entry.cityKey}: zero ETJ features parsed`);
  }
  if (counters.rowsParsed !== serviceCount) {
    log(
      `${entry.cityKey}: NOTE parsed ${counters.rowsParsed} of ${serviceCount} reported ` +
        `(${counters.rowsSkipped} declined: ${counters.skipSamples.join("; ") || "no samples"})`,
    );
  }

  return {
    outcome: {
      cityKey: entry.cityKey,
      mode: entry.mode,
      serviceCount,
      parsed: counters.rowsParsed,
      inserted,
      hasRings: true,
      layerName: metadata.layerName,
      extentWgs84: metadata.extentWgs84
        ? `${metadata.extentWgs84.westLng.toFixed(4)},${metadata.extentWgs84.southLat.toFixed(4)} .. ` +
          `${metadata.extentWgs84.eastLng.toFixed(4)},${metadata.extentWgs84.northLat.toFixed(4)}`
        : null,
    },
    sourceRow: {
      cityKey: entry.cityKey,
      cityName: entry.cityName,
      cityGeoId: entry.cityGeoId,
      mode: entry.mode,
      layerUrl: entry.layerUrl,
      layerName: metadata.layerName,
      hasEtjRings: true,
      bbox: metadata.extentWgs84,
      etjRingCount: counters.rowsParsed,
      layerLastEditAt: metadata.lastEditAt,
      sourceVintage: opts.vintage,
      sourceCitation: entry.layerUrl,
    },
  };
}

async function runVerify(): Promise<void> {
  log(`verifying ${ETJ_CONTROL_POINTS.length} control points against the live register`);
  const result = await verifyEtjControlPoints();
  if (jsonMode) {
    // One document, not JSONL: the three `kind`s the instrument emits, grouped.
    const events = result.lines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, unknown> => e !== null);
    process.stdout.write(
      JSON.stringify(
        {
          instrument: "lib/cad-ingest/src/boundary/etjCli.ts --verify",
          ranAt: new Date().toISOString(),
          registerVintage: ETJ_SOURCE_VINTAGE,
          registerSize: ETJ_REGISTRY.length,
          publishers: events.filter((e) => e.kind === "publisher"),
          controlPoints: events.filter((e) => e.kind === "control-point"),
          summary: events.find((e) => e.kind === "summary") ?? null,
          passed: result.passed,
          failed: result.failed,
        },
        null,
        2,
      ) + "\n",
    );
    if (result.failed > 0) process.exit(1);
    return;
  }
  for (const line of result.lines) console.log(line);
  log(
    `verify summary: ${result.passed} passed, ${result.failed} failed ` +
      `(exit ${result.failed === 0 ? 0 : 1})`,
  );
  if (result.failed > 0) process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({
    args,
    options: {
      "dry-run": { type: "boolean", default: false },
      "count-only": { type: "boolean", default: false },
      verify: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      city: { type: "string", multiple: true },
      limit: { type: "string" },
      "batch-size": { type: "string" },
      "rate-ms": { type: "string" },
      vintage: { type: "string" },
    },
  });

  jsonMode = values.json ?? false;

  const dryRun = values["dry-run"] ?? false;
  const countOnly = values["count-only"] ?? false;
  const verify = values.verify ?? false;

  if (verify) {
    await runVerify();
    return;
  }

  const selected: EtjRegistryEntry[] = [];
  for (const key of values.city ?? []) {
    const entry = etjRegistryEntry(key);
    if (!entry) {
      fail(`--city=${key}: not in the register (${ETJ_REGISTRY.length} entries)`);
    }
    selected.push(entry);
  }
  const entries = selected.length > 0 ? selected : [...ETJ_REGISTRY];

  if (countOnly) {
    for (const entry of entries) {
      if (entry.layerUrl === null) {
        log(`${entry.cityKey}: 0 (mode=${entry.mode}, no ETJ layer)`);
        continue;
      }
      const n = await countEtjFeatures(entry);
      log(`${entry.cityKey}: ${n} ETJ features`);
      log(`  ${entry.layerUrl}`);
    }
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!dryRun && !databaseUrl) {
    fail("DATABASE_URL must be set (or pass --dry-run / --count-only / --verify)");
  }

  const limit = values.limit !== undefined ? Number(values.limit) : undefined;
  const batchSize =
    values["batch-size"] !== undefined
      ? Number(values["batch-size"])
      : ETJ_DEFAULT_BATCH_SIZE;
  const rateMs = values["rate-ms"] !== undefined ? Number(values["rate-ms"]) : 500;
  const vintage = values.vintage ?? ETJ_SOURCE_VINTAGE;

  const startedAt = Date.now();
  let pool: pg.Pool | null = null;
  let db: ReturnType<typeof drizzle> | null = null;
  if (!dryRun && databaseUrl) {
    pool = new Pool({ connectionString: databaseUrl });
    db = drizzle(pool);
  }

  const outcomes: CityOutcome[] = [];
  const sourceRows: EtjSourceRowMeta[] = [];
  try {
    for (const entry of entries) {
      const { outcome, sourceRow } = await ingestCity({
        entry,
        dryRun,
        db,
        limit,
        batchSize,
        rateMs,
        vintage,
      });
      outcomes.push(outcome);
      sourceRows.push(sourceRow);
    }

    if (!dryRun && db) {
      const written = await upsertEtjSources(db, sourceRows);
      log(`tx_etj_source: upserted ${written} register rows`);
    }
  } finally {
    if (pool) await pool.end();
  }

  log("---- etj summary ----");
  for (const o of outcomes) {
    log(
      `${o.cityKey.padEnd(20)} mode=${o.mode.padEnd(16)} service=${String(o.serviceCount).padStart(5)} ` +
        `parsed=${String(o.parsed).padStart(5)} inserted=${dryRun ? "0 (dry-run)" : String(o.inserted).padStart(5)}` +
        (o.extentWgs84 ? ` extent=${o.extentWgs84}` : ""),
    );
  }
  const withRings = outcomes.filter((o) => o.hasRings).length;
  log(
    `publishers with ETJ rings: ${withRings}; enumerated with no ETJ layer: ${
      outcomes.length - withRings
    }`,
  );
  log(`duration: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error("[etj-ingest] FATAL:", err);
  process.exit(1);
});
