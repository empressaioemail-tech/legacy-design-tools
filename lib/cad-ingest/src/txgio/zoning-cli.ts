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
 * DATABASE_URL must point at the target Postgres unless --dry-run. The
 * `zoning_district` column (migration 0059) and `zoning_district_interim`
 * (migration 0103) must exist on the deployment DB or the stamp FAILS CLOSED —
 * the batched UPDATE names both columns, so Postgres rejects the unknown one
 * and the first batch aborts with zero rows written. It does not no-op
 * silently. Apply both migrations first.
 *
 * Additive + idempotent + exit-bounded: only the two zoning columns are
 * written, a re-run recomputes and overwrites in place, and the run fetches
 * the zoning layer + stamps + prints a summary, then exits (0 on success, 1
 * on fatal error or an empty zoning layer).
 *
 * FEATURES AND ACCOUNTS (P-259b). `parcels read` counts FEATURES
 * (`DISTINCT ON feature_index`). A feature carrying no CAD account
 * (`prop_id` '0', empty or NULL) is SKIPPED — it writes no row and is never
 * PIPed — and the summary prints, on every leg, the feature count, the
 * account-bearing feature count, the distinct real-account count, and the
 * skipped count by reason. In Travis 423,540 of 828,773 features carry
 * `prop_id '0'`, so a feature count reported as an account count would be
 * wrong by that much; both are named instead.
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
 * notFoundInParcelStore / skippedNoAccount / noZoningPolygonHit, every count
 * named, so a mismatch between the requested list and what's actually in the
 * store is visible before (dry-run) or after (live) any write.
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
import {
  fetchZoningFeatures,
  type RawZoningFeature,
  type ZoningLayerMeta,
} from "./zoning-service";
import { buildZoningIndex } from "./zoning-stamp";
import { stampCountyZoning } from "./zoning-stamp-db";

/**
 * Layer-level audit of the base-code parse (P-259). Pure, over the fetched
 * features, so it can be asserted in a test: how many published values resolved
 * to a base district, how many are planned development, and — listed in full,
 * never sampled — every value that resolved to neither.
 */
export interface LayerParseAudit {
  features: number;
  /** Features whose code field published nothing (dropped from the index). */
  noCode: number;
  distinctValues: number;
  base: number;
  plannedDevelopment: number;
  unrecognised: number;
  /**
   * Of `base`, the features whose published value carried a declared interim
   * qualifier (P-259b) — Austin's `I-<base>`, read as its base. A SUBSET of
   * `base`, never added to it.
   */
  interimBase: number;
  /** Of `plannedDevelopment`, the features whose value was interim (`I-PUD`). */
  interimPlannedDevelopment: number;
  /** Interim published values with their feature counts (`I-SF-2` -> n, …). */
  interimValueHistogram: Record<string, number>;
  baseHistogram: Record<string, number>;
  unrecognisedHistogram: Record<string, number>;
  overlayHistogram: Record<string, number>;
}

export function layerParseAudit(features: RawZoningFeature[]): LayerParseAudit {
  const audit: LayerParseAudit = {
    features: features.length,
    noCode: 0,
    distinctValues: 0,
    base: 0,
    plannedDevelopment: 0,
    unrecognised: 0,
    interimBase: 0,
    interimPlannedDevelopment: 0,
    interimValueHistogram: {},
    baseHistogram: {},
    unrecognisedHistogram: {},
    overlayHistogram: {},
  };
  const bump = (h: Record<string, number>, k: string): void => {
    h[k] = (h[k] ?? 0) + 1;
  };
  for (const f of features) {
    if (f.code === null) {
      // Published nothing (or a configured nullDistrictCode): dropped from the
      // index, so a parcel inside such a polygon lands in the "no polygon"
      // bucket. Counted here so the ambiguity is sized in the log rather than
      // hidden by it.
      audit.noCode += 1;
      continue;
    }
    if (f.parse === undefined) continue;
    if (f.parse.kind === "base") {
      audit.base += 1;
      bump(audit.baseHistogram, f.code);
      if (f.parse.interim) {
        audit.interimBase += 1;
        bump(audit.interimValueHistogram, f.parse.raw.trim());
      }
      // Overlays are counted ONLY here. For a resolved base the parser can
      // prove which tokens are the base and which are the suffix; for a
      // planned-development or unrecognised value the whole published value is
      // stamped raw and its tokens are not classified, so counting them as
      // "overlays" would report a token inside "UNZ-NP" (or the PUD in
      // "PUD-NP") as an overlay token. Left out, not guessed. An INTERIM value
      // IS classified (the qualifier is stripped by the same rule), so "I-SF-2-NP"
      // contributes its NP here and SF-2 to `baseHistogram` — the point of the rule.
      for (const overlay of f.parse.overlays) bump(audit.overlayHistogram, overlay);
    } else if (f.parse.kind === "planned-development") {
      audit.plannedDevelopment += 1;
      bump(audit.baseHistogram, f.code);
      if (f.parse.interim) {
        audit.interimPlannedDevelopment += 1;
        bump(audit.interimValueHistogram, f.parse.raw.trim());
      }
    } else {
      // Includes an interim value whose qualifier was recognised but whose
      // remainder matched no base (`I-XYZ`): disclosed as interim, still
      // unrecognised, still stamped verbatim.
      audit.unrecognised += 1;
      bump(audit.unrecognisedHistogram, f.parse.raw.trim());
    }
  }
  audit.distinctValues =
    Object.keys(audit.baseHistogram).length +
    Object.keys(audit.unrecognisedHistogram).length;
  return audit;
}

/** Rows of `hist`, descending by count (ties by key) — stable output for logs. */
function sortedHist(hist: Record<string, number>): [string, number][] {
  return Object.entries(hist).sort((a, b) =>
    b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0]),
  );
}

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

/**
 * Print what the layer says about itself. The projection is READ AT SOURCE
 * (never assumed): if the host did not answer `?f=json`, say so explicitly
 * rather than print a frame nobody verified. `outSR=4326` is requested on
 * every page and the response frame is checked before any PIP.
 */
function logLayerMeta(meta: ZoningLayerMeta): void {
  if (meta.unavailable) {
    log(
      "layer metadata: UNAVAILABLE (the host did not answer ?f=json) — source " +
        "spatial reference and vintage are NOT read; every page is still " +
        "requested outSR=4326 and its returned frame is verified",
    );
    return;
  }
  log(`layer metadata: ${meta.name ?? "(unnamed)"} (read at source)`);
  log(
    `  source spatial reference: wkid ${meta.sourceWkid ?? "(none published)"}` +
      (meta.sourceLatestWkid !== null ? ` (latestWkid ${meta.sourceLatestWkid})` : "") +
      " — every page is requested outSR=4326 and the returned frame is verified",
  );
  log(
    `  layer vintage (editingInfo.lastEditDate): ${meta.lastEditDate ?? "(not published)"}`,
  );
  log(`  maxRecordCount: ${meta.maxRecordCount ?? "(not published)"}`);
}

/** The base-code parse audit, printed before any PIP so the layer is understood first. */
function logParseAudit(audit: LayerParseAudit): void {
  log("---- layer base-code audit (P-259) ----");
  log(`features fetched:       ${audit.features}`);
  log(
    `  no published code:     ${audit.noCode} (dropped from the index — never a district)`,
  );
  log(
    `resolved to a base:     ${audit.base} features, ${sortedHist(audit.baseHistogram).length} distinct codes`,
  );
  log(
    `  of which interim:     ${audit.interimBase} features (declared interim qualifier read as its base district, P-259b)`,
  );
  log(
    `planned development:    ${audit.plannedDevelopment} features (stamped raw — A-164 PUD message)`,
  );
  if (audit.interimPlannedDevelopment > 0) {
    log(
      `  of which interim:     ${audit.interimPlannedDevelopment} features (I-PUD family)`,
    );
  }
  const interimValues = sortedHist(audit.interimValueHistogram);
  if (interimValues.length > 0) {
    log(
      `interim values read:    ${interimValues.length} distinct published values → ` +
        interimValues.map(([v, n]) => `${v} ${n}`).join(", "),
    );
  }
  log(
    `UNRECOGNISED:           ${audit.unrecognised} features, ` +
      `${sortedHist(audit.unrecognisedHistogram).length} distinct published values ` +
      "(stamped verbatim — never a truncated prefix)",
  );
  for (const [code, n] of sortedHist(audit.unrecognisedHistogram)) {
    log(`    ${code.padEnd(24)} ${n}`);
  }
  const overlays = sortedHist(audit.overlayHistogram);
  log(
    `overlays carried:       ${overlays.length} distinct tokens (` +
      overlays.map(([t, n]) => `${t} ${n}`).join(", ") +
      ")",
  );
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
          `field=${c.codeField}${c.baseCodeParse ? " +base-code-parse" : ""}` +
          (c.baseCodeParse?.interimQualifiers?.length
            ? ` interim=${c.baseCodeParse.interimQualifiers.join("/")}`
            : "") +
          ` ${c.layerUrl}`,
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
    onMeta: logLayerMeta,
    onPage: ({ total }) => log(`  fetched ${total} zoning features...`),
  });
  const audit = layerParseAudit(raw);
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
  log(`codes in the index: ${codesInLayer.join(", ")}`);
  if (cfg.baseCodeParse) logParseAudit(audit);

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
  // Features AND accounts, named separately on every leg (P-259b): the CLI's
  // denominator is FEATURES (`DISTINCT ON feature_index`), and in Travis
  // 423,540 of 828,773 features carry `prop_id '0'`. A figure never travels
  // without its denomination.
  log(`features read:    ${summary.parcelsRead} (DISTINCT feature_index)`);
  log(
    `accounts read:    ${summary.accountsRead} (distinct real prop_id)`,
  );
  log(
    `account-bearing:  ${summary.accountBearingFeatures} features carried a real prop_id`,
  );
  log(
    `skipped:          ${summary.parcelsSkippedNoAccount} features carried NO CAD account ` +
      `(wrote no row, never PIPed; ${sortedHist(summary.skippedNoAccountByReason)
        .map(([r, n]) => `${r} ${n}`)
        .join(", ")})`,
  );
  log(`parcels matched:  ${summary.parcelsMatched} (base district stamped)`);
  log(
    `  of which interim: ${summary.parcelsInterim} (declared interim qualifier read as its base district, P-259b)`,
  );
  log(
    `planned dev:      ${summary.parcelsPlannedDevelopment} (stamped raw — A-164 PUD message)`,
  );
  if (summary.parcelsInterimPlannedDevelopment > 0) {
    log(
      `  of which interim: ${summary.parcelsInterimPlannedDevelopment} (I-PUD family)`,
    );
  }
  log(
    `unrecognised:     ${summary.parcelsUnrecognised} (published value stamped verbatim, no base resolved)`,
  );
  log(
    `parcels null:     ${summary.parcelsUnmatched} ` +
      "(representative point in no zoning polygon carrying a published code: " +
      "outside the city, an un-zoned pocket, or one of the layer's empty-code polygons)",
  );
  log(
    `buckets sum:      ${
      summary.parcelsMatched +
      summary.parcelsPlannedDevelopment +
      summary.parcelsUnrecognised +
      summary.parcelsUnmatched +
      summary.parcelsSkippedNoAccount
    } (must equal features read; a feature is in exactly one of matched / planned dev / ` +
      "unrecognised / null / skipped-no-account)",
  );
  log(`rows updated:     ${dryRun ? "0 (dry-run)" : summary.rowsUpdated}`);
  const interimVals = sortedHist(summary.interimValueHistogram);
  if (interimVals.length > 0) {
    log(
      `interim values stamped (${interimVals.length} distinct, every one listed):`,
    );
    for (const [value, n] of interimVals) {
      log(`  ${value.padEnd(24)} ${n}`);
    }
    log(
      `  read as (interim base histogram): ` +
        sortedHist(summary.interimBaseHistogram)
          .map(([base, n]) => `${base} ${n}`)
          .join(", "),
    );
  }
  const hist = sortedHist(summary.codeHistogram);
  log(`district histogram (${hist.length} codes):`);
  for (const [code, n] of hist) log(`  ${code.padEnd(8)} ${n}`);
  const unrec = sortedHist(summary.unrecognisedHistogram);
  if (unrec.length > 0) {
    log(`unrecognised values (${unrec.length} distinct, every one listed):`);
    for (const [code, n] of unrec) log(`  ${code.padEnd(24)} ${n}`);
  }
  const overlays = sortedHist(summary.overlayHistogram);
  if (overlays.length > 0) {
    log(
      `overlays on stamped parcels (${overlays.length} tokens): ` +
        overlays.map(([t, n]) => `${t} ${n}`).join(", "),
    );
  }
  log(`duration:         ${seconds}s`);

  if (propIds !== undefined) {
    log("---- scoped mode (--prop-ids-file) ----");
    log(`listSize:              ${summary.listSize}`);
    log(`matched (in store):    ${summary.matched}`);
    log(`stamped:               ${dryRun ? "0 (dry-run)" : summary.parcelsMatched}`);
    log(
      `  of which interim:    ${summary.parcelsInterim} (declared interim qualifier read as its base district)`,
    );
    log(`notFoundInParcelStore: ${summary.notFoundInParcelStore?.length ?? 0}`);
    if (summary.notFoundInParcelStore && summary.notFoundInParcelStore.length > 0) {
      log(`  ids: ${summary.notFoundInParcelStore.join(", ")}`);
    }
    log(
      `skippedNoAccount:      ${summary.skippedNoAccountPropIds?.length ?? 0} (no CAD account — wrote no row, never PIPed)`,
    );
    if (
      summary.skippedNoAccountPropIds &&
      summary.skippedNoAccountPropIds.length > 0
    ) {
      log(`  ids: ${summary.skippedNoAccountPropIds.join(", ")}`);
    }
    log(`noZoningPolygonHit:    ${summary.noZoningPolygonHit?.length ?? 0}`);
    if (summary.noZoningPolygonHit && summary.noZoningPolygonHit.length > 0) {
      log(`  ids: ${summary.noZoningPolygonHit.join(", ")}`);
    }
    log(
      `unrecognisedInPolygon: ${summary.unrecognisedPropIds?.length ?? 0} (published value stamped verbatim, no base resolved)`,
    );
    if (summary.unrecognisedPropIds && summary.unrecognisedPropIds.length > 0) {
      log(`  ids: ${summary.unrecognisedPropIds.join(", ")}`);
    }
    if (summary.perParcel && summary.perParcel.length > 0) {
      log(`${dryRun ? "would-stamp" : "stamped"} per-parcel table:`);
      log(
        `  ${"prop_id".padEnd(12)} ${"feature_index".padEnd(14)} ${"kind".padEnd(20)} ${"interim".padEnd(8)} district`,
      );
      for (const row of summary.perParcel) {
        log(
          `  ${row.propId.padEnd(12)} ${String(row.featureIndex).padEnd(14)} ` +
            `${row.kind.padEnd(20)} ${(row.interim === undefined ? "-" : String(row.interim)).padEnd(8)} ${row.district ?? "(none)"}` +
            (row.publishedCode && row.publishedCode !== row.district
              ? `   [published: ${row.publishedCode}]`
              : ""),
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
