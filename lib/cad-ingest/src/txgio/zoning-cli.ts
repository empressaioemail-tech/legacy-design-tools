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
 *     [--limit=N] [--dry-run] [--prop-ids-file=<path>]
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
 * `--prop-ids-file=<path>` (scoped mode): restricts the parcel READ (and
 * therefore the UPDATE, which only ever targets rows produced by that
 * read) to exactly the prop ids listed in the file — one per line, either
 * a raw CAD prop id ("31131") or a full parcelNodeId ("48021:31131"; the
 * county-fips prefix is stripped and ignored, the flag's own --city still
 * governs which county/layer is queried). Ids are normalized the same way
 * `parcelNodeId.ts` normalizes CAD prop ids (leading zeros stripped) and
 * deduped before use. WITHOUT this flag the CLI is byte-identical to the
 * whole-county path other cities depend on — this flag only ever narrows.
 * The resolved summary reports listSize / matched / stamped /
 * notFoundInParcelStore / noZoningPolygonHit, every count named, so a
 * mismatch between the requested list and what's actually in the store is
 * visible before (dry-run) or after (live) any write.
 *
 * Egress: the zoning fetch is a plain HTTPS GET to the city's ArcGIS host.
 * Some public ArcGIS TLS setups have an unreachable OCSP/CRL endpoint from
 * a sandboxed runner; run the CLI with the sandbox relaxed for the fetch.
 */

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { ZONING_LAYERS, resolveZoningLayer } from "./zoning-layers";
import { fetchZoningFeatures } from "./zoning-service";
import { buildZoningIndex } from "./zoning-stamp";
import { stampCountyZoning } from "./zoning-stamp-db";

/**
 * Normalize a raw prop id (leading zeros stripped from an all-digit id,
 * left untouched otherwise). Mirrors `normalizeCadPropId` in
 * `artifacts/api-server/src/lib/parcelNodeId.ts` — duplicated here (not
 * imported) so `cad-ingest` stays dependency-free of `api-server`.
 */
export function normalizePropId(propId: string): string {
  const t = propId.trim();
  if (!/^\d+$/.test(t)) return t;
  return t.replace(/^0+(?=\d)/, "");
}

/**
 * Parse a `--prop-ids-file`: one id per line, blank lines and `#`-prefixed
 * comment lines ignored. Each line may be a raw prop id ("31131") or a
 * full `county:propId` parcelNodeId ("48021:31131") — the county prefix
 * (if present) is stripped since --city already selects the county. Every
 * surviving id must be non-empty; throws loud on an empty file, a file
 * with zero usable ids, or any unparseable line (never silently drops a
 * malformed entry).
 */
export function parsePropIdsFile(raw: string): Set<string> {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length === 0) {
    throw new Error("--prop-ids-file is empty (no usable lines)");
  }
  const ids = new Set<string>();
  for (const line of lines) {
    const afterColon = line.includes(":") ? line.split(":").pop()! : line;
    const trimmed = afterColon.trim();
    if (!trimmed) {
      throw new Error(`--prop-ids-file: unparseable line "${line}"`);
    }
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(
        `--prop-ids-file: line "${line}" is not a positive integer prop id`,
      );
    }
    ids.add(normalizePropId(trimmed));
  }
  return ids;
}

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
      "prop-ids-file": { type: "string" },
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
        "[--dry-run] [--prop-ids-file=<path>] | zoning-stamp --list",
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

  let propIds: Set<string> | undefined;
  if (values["prop-ids-file"] !== undefined) {
    let raw: string;
    try {
      raw = readFileSync(values["prop-ids-file"], "utf8");
    } catch (err) {
      fail(
        `--prop-ids-file could not be read: ${values["prop-ids-file"]} (${(err as Error).message})`,
      );
    }
    try {
      propIds = parsePropIdsFile(raw);
    } catch (err) {
      fail(`--prop-ids-file: ${(err as Error).message}`);
    }
    log(
      `scoped mode: --prop-ids-file=${values["prop-ids-file"]} (${propIds.size} distinct prop ids requested)`,
    );
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
      cityKey: cfg.cityKey,
      index,
      dryRun,
      limit,
      propIds,
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

  if (propIds !== undefined) {
    log("---- scoped mode (--prop-ids-file) ----");
    log(`listSize:              ${summary.listSize}`);
    log(`matched (in store):    ${summary.matched}`);
    log(`stamped:               ${dryRun ? "0 (dry-run)" : summary.parcelsMatched}`);
    log(`notFoundInParcelStore: ${summary.notFoundInParcelStore?.length ?? 0}`);
    if (summary.notFoundInParcelStore && summary.notFoundInParcelStore.length > 0) {
      log(`  ids: ${summary.notFoundInParcelStore.join(", ")}`);
    }
    log(`noZoningPolygonHit:    ${summary.noZoningPolygonHit?.length ?? 0}`);
    if (summary.noZoningPolygonHit && summary.noZoningPolygonHit.length > 0) {
      log(`  ids: ${summary.noZoningPolygonHit.join(", ")}`);
    }
    if (summary.perParcel && summary.perParcel.length > 0) {
      log(`${dryRun ? "would-stamp" : "stamped"} per-parcel table:`);
      log(`  ${"prop_id".padEnd(12)} ${"feature_index".padEnd(14)} district`);
      for (const row of summary.perParcel) {
        log(
          `  ${row.propId.padEnd(12)} ${String(row.featureIndex).padEnd(14)} ${row.district ?? "(none)"}`,
        );
      }
    }
  }

  if (summary.parcelsRead === 0) {
    fail(
      `no parcels found for county ${cfg.countyFips} — is the county's ` +
        "geometry ingested (txgio-ingest) on this DB?",
    );
  }
}

// Direct-execution guard: only run when this file is the entrypoint (`tsx
// src/txgio/zoning-cli.ts` / the `zoning-stamp` npm script), not when it is
// imported for its exported helpers (`normalizePropId`, `parsePropIdsFile`)
// by a test. `pathToFileURL` normalizes Windows drive-letter/slash-style
// differences between `import.meta.url` and `process.argv[1]`.
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error("[zoning-stamp] FATAL:", err);
    process.exit(1);
  });
}
