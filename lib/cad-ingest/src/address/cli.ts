#!/usr/bin/env node
/**
 * TxGIO/StratMap address-point ingest CLI — self-hosted geocoded
 * delivery points from the free statewide StratMap Address Points
 * service (feature.geographic.texas.gov, open paginated ArcGIS REST,
 * no auth).
 *
 * Usage:
 *   pnpm exec tsx src/address/cli.ts \
 *     --county=48453 \                 # fips|name for a known county
 *     [--county-name=Travis] \         # service county name override
 *     [--fips=48453] \                 # store fips override (with --county-name)
 *     [--vintage=<label>] \            # default: the service layer id
 *     [--limit=N] \                    # bounded sample (proves the path)
 *     [--batch-size=1000] [--rate-ms=500] [--dry-run] [--count-only]
 *
 *   (Use `pnpm exec tsx ...` — the permits-ingest trap: a
 *   `pnpm --filter ... <cmd> -- --flag` run injects an extra `--` the
 *   parser rejects.)
 *
 * DATABASE_URL must point at the target Postgres unless --dry-run /
 * --count-only.
 *
 * Replace semantics: the county's existing rows are deleted before the
 * insert pass, so re-runs and fresher vintages are idempotent. The run
 * is EXIT-BOUNDED and county-partitioned: count -> page -> load ->
 * summary, then exit. A statewide crawl is the operator looping this CLI
 * over counties (each resumable at its county boundary); this CLI never
 * pulls the full ~11.7M statewide set in one invocation. Pass --limit
 * for a bounded sample. Exit code 0 on success, 1 on fatal errors or
 * when zero features parsed (non-count/dry-run).
 */

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { resolveAddressCounty } from "./counties";
import {
  addressLayerUrl,
  countAddressPoints,
  fetchAddressFeatures,
  ADDRESS_RATE_MS,
} from "./service";
import { normalizeAddressFeature, type AddressFeature } from "./parse";
import {
  deleteCountyAddresses,
  upsertAddresses,
  ADDRESS_DEFAULT_BATCH_SIZE,
} from "./ingest";
import { newCounters, type ParseCounters } from "../types";
import type { TxgioAddressRecord } from "./parse";
import { isClusterJobExecution, LAPTOP_WRITE_FROZEN, LAPTOP_WRITE_FROZEN_MESSAGE } from "../jobPlane";

const { Pool } = pg;

function log(msg: string): void {
  console.log(`[address-ingest] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[address-ingest] ERROR: ${msg}`);
  process.exit(1);
}

export interface WriteGateRefusal {
  code: typeof LAPTOP_WRITE_FROZEN;
  message: string;
}

/**
 * Cluster-job write gate (2026-10-07 stage-3 ruling; jobPlane.ts, reused —
 * not copied — from cad-ingest's cli.ts gate in #793). `isWriteRun` is the
 * caller's own determination of whether this invocation will write (here:
 * neither --dry-run nor --count-only). Returns a refusal descriptor for a
 * write run outside a cluster Job; null when the run may proceed. Exported
 * so the gate is testable directly, independent of argv parsing / network /
 * DB.
 */
export function addressIngestWriteGate(
  isWriteRun: boolean,
  env: NodeJS.ProcessEnv = process.env,
): WriteGateRefusal | null {
  if (!isWriteRun) return null;
  if (isClusterJobExecution(env)) return null;
  return { code: LAPTOP_WRITE_FROZEN, message: LAPTOP_WRITE_FROZEN_MESSAGE };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({
    args,
    options: {
      county: { type: "string" },
      "county-name": { type: "string" },
      fips: { type: "string" },
      vintage: { type: "string" },
      "batch-size": { type: "string" },
      "rate-ms": { type: "string" },
      limit: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "count-only": { type: "boolean", default: false },
    },
  });

  // Resolve (fips, service county name). Either a known --county, or an
  // explicit --county-name (+ --fips for the store key) for a county
  // outside the convenience registry.
  let fips: string | undefined;
  let countyName: string | undefined;
  if (values.county) {
    const c = resolveAddressCounty(values.county);
    if (c) {
      fips = c.fips;
      countyName = c.name;
    } else if (/^\d{5}$/.test(values.county.trim())) {
      fips = values.county.trim();
    } else {
      countyName = values.county.trim();
    }
  }
  if (values["county-name"]) countyName = values["county-name"].trim();
  if (values.fips) fips = values.fips.trim();
  if (!countyName) {
    fail(
      "need a county name — pass --county=<name|known-fips> or " +
        "--county-name=<Name> (the service filters by county name)",
    );
  }
  if (!fips) {
    fail(
      `need the 5-digit store FIPS for ${countyName} — it is not in the ` +
        "convenience registry; pass --fips=48XXX",
    );
  }

  const countOnly = values["count-only"] ?? false;
  const dryRun = values["dry-run"] ?? false;
  const databaseUrl = process.env.DATABASE_URL;
  if (!countOnly && !dryRun && !databaseUrl) {
    fail("DATABASE_URL must be set (or pass --dry-run / --count-only)");
  }

  // 2026-10-07 stage-3 ruling (jobPlane.ts): a write (not --dry-run /
  // --count-only) runs only inside a cluster Job on the DigitalOcean job
  // plane -- no break-glass laptop run (carries the 2026-09-12
  // no-break-glass ruling to this loader, which previously checked
  // nothing). Refuses before any network call.
  const addressGateRefusal = addressIngestWriteGate(!countOnly && !dryRun);
  if (addressGateRefusal) {
    console.error(
      JSON.stringify({ event: "address-ingest.refused", ...addressGateRefusal }),
    );
    process.exit(2);
  }

  const rateMs =
    values["rate-ms"] !== undefined
      ? Number(values["rate-ms"])
      : ADDRESS_RATE_MS;
  const limit = values.limit !== undefined ? Number(values.limit) : undefined;
  const vintage = values.vintage ?? "stratmap_address_points_48_most_recent";
  const sourceFile = addressLayerUrl();

  const startedAt = Date.now();
  log(`county=${fips} (${countyName}) service=${sourceFile}`);

  // 1. Bounded count (single call).
  const count = await countAddressPoints({ countyName });
  log(`service reports ${count} address points for ${countyName}`);
  if (countOnly) {
    log("count-only — exiting.");
    return;
  }

  // 2. Page + normalize (exit-bounded generator).
  const counters: ParseCounters = newCounters();
  async function* records(): AsyncGenerator<TxgioAddressRecord> {
    for await (const feature of fetchAddressFeatures({
      countyName: countyName as string,
      limit,
      rateMs,
      onPage: ({ offset, got, total }) =>
        log(`page offset=${offset} got=${got} total=${total}`),
    })) {
      counters.rowsRead += 1;
      const rec = normalizeAddressFeature(
        fips as string,
        feature as AddressFeature,
        counters,
      );
      if (rec) {
        counters.rowsParsed += 1;
        yield rec;
      }
    }
  }

  // 3. Load (or drain when --dry-run).
  let rowsInserted = 0;
  let duplicateObjectIds = 0;
  if (dryRun) {
    for await (const _rec of records()) {
      // parse-only
    }
  } else {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const db = drizzle(pool);
      log(`replacing existing ${fips} rows`);
      await deleteCountyAddresses(db, fips as string);
      const summary = await upsertAddresses(db, records(), {
        sourceFile,
        sourceVintage: vintage,
        batchSize:
          values["batch-size"] !== undefined
            ? Number(values["batch-size"])
            : ADDRESS_DEFAULT_BATCH_SIZE,
        onBatch: (total) => {
          if (total % 25_000 < ADDRESS_DEFAULT_BATCH_SIZE) {
            log(`inserted ${total} rows...`);
          }
        },
      });
      rowsInserted = summary.rowsInserted;
      duplicateObjectIds = summary.duplicateObjectIds;
    } finally {
      await pool.end();
    }
  }

  // 4. Summary.
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  log("---- ingest summary ----");
  log(`county:            ${fips} (${countyName})`);
  log(`service count:     ${count}`);
  log(`vintage:           ${vintage}`);
  log(`features read:     ${counters.rowsRead}`);
  log(`features parsed:   ${counters.rowsParsed}`);
  log(`rows inserted:     ${dryRun ? "0 (dry-run)" : rowsInserted}`);
  log(`features skipped:  ${counters.rowsSkipped} (no addr / no objectid / no geometry)`);
  log(
    `duplicate objectids dropped: ${dryRun ? "0 (dry-run)" : duplicateObjectIds}` +
      " (same objectid seen twice in this load -- should be 0; a reconciliation gap means it was not)",
  );
  if (limit !== undefined) log(`limit:             ${limit} (bounded sample)`);
  log(`duration:          ${seconds}s`);
  if (counters.skipSamples.length > 0) {
    log(`skip samples:      ${counters.skipSamples.join(" | ")}`);
  }
  if (counters.rowsParsed === 0) {
    fail("zero features parsed — wrong county name or service schema drift");
  }
}

// Direct-execution guard: only run when this file is the entrypoint (`tsx
// src/address/cli.ts`), not when it is imported for its exported
// `addressIngestWriteGate` by a test. Mirrors ../txgio/zoning-cli.ts's own
// guard. `pathToFileURL` normalizes Windows drive-letter/slash-style
// differences between `import.meta.url` and `process.argv[1]`.
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error("[address-ingest] FATAL:", err);
    process.exit(1);
  });
}
