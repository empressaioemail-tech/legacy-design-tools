#!/usr/bin/env node
/**
 * TxGIO/StratMap land-parcel ingest CLI — self-hosted parcel geometry
 * for the Texas map store. Any of the 254 Texas counties may be
 * ingested; `--list` shows which are already loaded and which are not.
 * (Before 2026-08-08 the CLI resolved only against the 19 loaded
 * counties and failed closed on everything else before any network
 * call, so an unloaded county could not even be dry-run. That gate
 * encoded no real constraint — the URL template and DBF schema are
 * statewide-uniform — and it blocked the statewide acquisition.)
 *
 * Usage:
 *   pnpm --filter @workspace/cad-ingest txgio-ingest -- \
 *     --county=48209 \
 *     [--file=<local zip | dir | .shp | https URL>]  # default: TxGIO per-county zip
 *     [--vintage=<label>]      # default: shapefile basename, e.g.
 *                              #   stratmap25-landparcels_48209_hays_202503
 *     [--batch-size=250] [--limit=N] [--dry-run]
 *     [--reproject=3857]       # convert EPSG:3857 metres -> WGS84
 *     [--multi-shp=concat]     # required when the archive ships N>1 .shp
 *                              # (Harris 48201 east+west). Fail-closed
 *                              # otherwise — never silently take the first.
 *     [--declined-out=<path>]  # write the identified declined roster
 *   pnpm --filter @workspace/cad-ingest txgio-ingest -- --list
 *
 * DATABASE_URL must point at the target Postgres unless --dry-run.
 *
 * Replace semantics: the county's existing rows are deleted and the
 * new ones streamed IN ONE TRANSACTION, so re-runs and fresher
 * vintages are idempotent, never strand stale rows, and — since
 * 2026-08-08 — can never leave a county deleted-but-not-loaded when a
 * run dies partway. The run is exit-bounded: download + parse + load +
 * summary, then exit. Exit code 0 on success (even with skipped
 * malformed features), 1 on fatal errors or zero features.
 *
 * PROJECTION. Most stratmap25 shapefiles ship GCS_WGS_1984, but the
 * 202505 vintage ships Web Mercator METERS under a
 * `PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere", GEOGCS["GCS_WGS_1984",...]]`
 * whose nested GEOGCS satisfied the old substring guard. The CLI
 * rejects a PROJCS `.prj` outright, AND every feature's coordinates are
 * range-asserted against the Texas WGS84 envelope in `parse.ts` — which
 * is the guard that actually holds, because it also covers the
 * no-`.prj` case, axis swaps, and any future source change. A county
 * that is not in degrees fails the run instead of loading garbage.
 *
 * REPROJECTION (`--reproject=3857`, operator ruling 2026-08-08). 57 of
 * the 235 unloaded counties are on the 202505 vintage, so failing them
 * all closed blocked the statewide acquisition — six of the ten
 * SMALLEST counties are 202505, meaning the natural first wave was
 * exactly the blocked wave. The CLI now DETECTS EPSG:3857 and, when the
 * operator passes `--reproject=3857`, converts every feature to WGS84
 * degrees at parse time (`reproject.ts`, closed-form inverse Mercator).
 *
 * Three properties make this safe rather than a loosening:
 *   1. OPT-IN. Detection alone converts nothing. Without the flag a
 *      projected county still fails closed — it just now names the flag
 *      in the error instead of leaving the operator to read WKT.
 *   2. THE GUARD STILL RUNS, on the CONVERTED coordinates. Reprojection
 *      is a step BEFORE `assertTexasWgs84Bbox`, never a bypass of it, so
 *      a bad conversion fails exactly as an unconverted county does.
 *   3. PROVENANCE ON THE ROW. Every converted row's `source_vintage`
 *      carries `+reprojected-from-epsg3857`, which rides all the way out
 *      to the served parcel feature. No silent conversion exists.
 * The flag authorizes converting Web Mercator specifically; an
 * unsupported projection (state plane, NAD83) is still refused WITH the
 * flag passed.
 *
 * DRY RUN PREDICTS THE APPLY. `--dry-run` parses the real archive and
 * reports the rows an apply WOULD delete and insert, so a dry/apply
 * pair is comparable. It opens a read-only DB connection when
 * DATABASE_URL is present (to count existing rows) and reports the
 * delete count as unknown when it is not. It never writes.
 */

import { parseArgs } from "node:util";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import shapefile from "shapefile";
import {
  resolveTxgioCounty,
  TXGIO_ABSENT_FROM_STRATMAP,
  TXGIO_STATEWIDE_COUNTIES,
} from "./counties";
import type { TxgioParcelRecord } from "./parse";
import {
  assertDeclineCeiling,
  assertFinalDeclineCeiling,
  assertWgs84Prj,
  classifyPrj,
  normalizeTxgioFeature,
  TXGIO_ENTRY_FILTER,
  type TxgioFeature,
  type TxgioPrjKind,
} from "./parse";
import type { SupportedSourceCrs } from "./reproject";
import {
  countCountyParcels,
  listLoadedCountyFips,
  replaceCountyParcels,
  storeListLoadState,
  storeLoadedLabel,
  vintageWithProvenance,
  TXGIO_DEFAULT_BATCH_SIZE,
  type TxgioTransactionalDb,
} from "./ingest";
import {
  TXGIO_MAX_DECLINED_ABSOLUTE,
  TXGIO_MAX_DECLINED_FRACTION,
} from "./parse";
import {
  multiShapefileVintage,
  selectShapefileLayers,
  type MultiShpMode,
  type ResolvedShapefile,
} from "./shapefile-discover";
import { newCounters, summarizeDeclines, type ParseCounters } from "../types";

/**
 * How many declined features to print inline. The full roster always
 * goes to `--declined-out` uncapped; this only keeps a pathological run
 * from flooding the terminal. Above the halt ceiling the run dies
 * anyway, so in practice this cap is never reached on a landing county.
 */
const DECLINE_LOG_CAP = 25;
import { downloadToFile, isUrl } from "../download";
import { extractZipEntries } from "../zip";

const { Pool } = pg;

function log(msg: string): void {
  console.log(`[txgio-ingest] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[txgio-ingest] ERROR: ${msg}`);
  process.exit(1);
}

async function pathKind(p: string): Promise<"file" | "dir" | "missing"> {
  try {
    const s = await stat(p);
    return s.isDirectory() ? "dir" : "file";
  } catch {
    return "missing";
  }
}

async function* readTxgioFeatures(
  countyFips: string,
  layers: ResolvedShapefile[],
  counters: ParseCounters,
  limit?: number,
  reprojectFrom?: SupportedSourceCrs,
): AsyncGenerator<TxgioParcelRecord> {
  // Continuous feature_index across every shapefile part. Harris east
  // then west must not restart at 0 — the PK is (county_fips, tile_key,
  // feature_index) and a restart would collide inside shared tiles.
  let featureIndex = 0;
  for (let part = 0; part < layers.length; part += 1) {
    const { shpFile, dbfFile } = layers[part]!;
    log(
      `reading shapefile part ${part + 1}/${layers.length}: ${basename(shpFile)}`,
    );
    // The TxGIO shapefiles ship a UTF-8 .cpg; pass the encoding through.
    const source = await shapefile.open(shpFile, dbfFile, { encoding: "utf8" });
    for (;;) {
      if (limit !== undefined && counters.rowsParsed >= limit) return;
      const result = await source.read();
      if (result.done) break;
      counters.rowsRead += 1;
      const declinedBefore = counters.declined.length;
      const record = normalizeTxgioFeature(
        countyFips,
        featureIndex,
        result.value as TxgioFeature,
        counters,
        { reprojectFrom },
      );
      featureIndex += 1;
      // Enforce the halt-versus-decline ceiling AS THE STREAM ADVANCES, so
      // a county that is broadly defective dies early rather than after
      // loading most of a garbage county. Only checked when a declination
      // actually happened — the common path pays nothing.
      if (counters.declined.length !== declinedBefore) {
        assertDeclineCeiling(counters, countyFips);
      }
      if (record) {
        counters.rowsParsed += 1;
        yield record;
      }
    }
  }
  // END-OF-STREAM ceiling for the geometry-absence class. Raised from
  // INSIDE the generator so it propagates into `replaceCountyParcels`'s
  // transaction and rolls the load back — a county over this ceiling
  // must not commit. Checked once after ALL parts, not per part.
  assertFinalDeclineCeiling(counters, countyFips);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({
    args,
    options: {
      county: { type: "string" },
      file: { type: "string" },
      vintage: { type: "string" },
      "batch-size": { type: "string" },
      limit: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      reproject: { type: "string" },
      "multi-shp": { type: "string" },
      "declined-out": { type: "string" },
    },
  });
  const declinedOut = values["declined-out"];

  // --reproject=3857 is the ONLY accepted value. Anything else is a
  // typo or an unsupported projection, and both must fail before any
  // network or DB work rather than silently degrading to no conversion.
  let reprojectRequested: SupportedSourceCrs | undefined;
  if (values.reproject !== undefined) {
    const v = values.reproject.trim().toLowerCase().replace(/^epsg:/, "");
    if (v !== "3857") {
      fail(
        `--reproject=${values.reproject} is not supported — the only ` +
          "convertible source CRS is 3857 (EPSG:3857 Web Mercator metres, " +
          "which the 202505 StratMap vintage ships). A county in any other " +
          "projection must be reprojected upstream before ingest.",
      );
    }
    reprojectRequested = "EPSG:3857";
  }

  // --multi-shp=concat is the ONLY accepted value. N>1 archives fail
  // closed without it (Harris truncation defect). Unknown values fail
  // before any network or DB work.
  let multiShp: MultiShpMode | undefined;
  if (values["multi-shp"] !== undefined) {
    const v = values["multi-shp"].trim().toLowerCase();
    if (v !== "concat") {
      fail(
        `--multi-shp=${values["multi-shp"]} is not supported — the only ` +
          "accepted value is concat (concatenate every .shp in the archive " +
          "under one continuous feature_index stream). Omit the flag when " +
          "the archive has a single shapefile.",
      );
    }
    multiShp = "concat";
  }

  // --list: print every Texas county with store-derived load state.
  // LOADED comes from DISTINCT county_fips in txgio_parcel when
  // DATABASE_URL is set. Without DATABASE_URL we label UNKNOWN rather
  // than pretending the hand-maintained TXGIO_COUNTIES map is store truth.
  if (values.list) {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    let loadedFips: Set<string> | null = null;
    let pool: pg.Pool | undefined;
    try {
      if (databaseUrl) {
        pool = new Pool({ connectionString: databaseUrl });
        const fipsList = await listLoadedCountyFips(
          drizzle(pool) as unknown as TxgioTransactionalDb,
        );
        loadedFips = new Set(fipsList);
      }
    } finally {
      await pool?.end();
    }
    log(
      loadedFips
        ? "Texas counties (LOADED = DISTINCT county_fips in txgio_parcel):"
        : "Texas counties (LOADED UNKNOWN — set DATABASE_URL to query txgio_parcel; " +
            "hand map is not store truth):",
    );
    let loadedCount = 0;
    let unknownCount = 0;
    for (const [fips, name] of Object.entries(TXGIO_STATEWIDE_COUNTIES)) {
      const state = storeListLoadState(
        fips,
        loadedFips,
        TXGIO_ABSENT_FROM_STRATMAP[fips] !== undefined,
      );
      if (state === "LOADED") loadedCount += 1;
      if (state === "UNKNOWN") unknownCount += 1;
      log(`  ${fips}  ${state}  ${name}`);
    }
    const loadedSummary =
      loadedFips === null
        ? `${unknownCount} UNKNOWN (no DATABASE_URL)`
        : `${loadedCount} loaded (store)`;
    log(
      `total: ${Object.keys(TXGIO_STATEWIDE_COUNTIES).length} counties, ` +
        `${loadedSummary}, ` +
        `${Object.keys(TXGIO_ABSENT_FROM_STRATMAP).length} absent from StratMap`,
    );
    return;
  }

  if (!values.county) {
    fail(
      "usage: txgio-ingest --county=<fips|name> [--file=<path-or-url>] " +
        "[--vintage=label] [--limit=N] [--reproject=3857] [--dry-run] | " +
        "txgio-ingest --list",
    );
  }
  const county = resolveTxgioCounty(values.county);
  if (!county) {
    fail(
      `"${values.county}" is not a Texas county — expected a 5-digit FIPS ` +
        `(48001..48507, odd county codes) or a county name. Run --list for ` +
        "all 254.",
    );
  }
  // Named absence: a county whose StratMap archive is a confirmed 404
  // fails with an explanation rather than a transport stack trace.
  // Overridable with --file, which is exactly how such a county gets
  // loaded from a county CAD/ArcGIS export instead.
  const absentReason = TXGIO_ABSENT_FROM_STRATMAP[county.fips];
  if (absentReason && !values.file) {
    fail(
      `${county.fips} (${county.name}) is not available from StratMap: ` +
        `${absentReason}. Acquire it from the county CAD or ArcGIS and pass ` +
        "--file=<path-or-url>; there is nothing to fetch from the bulk program.",
    );
  }
  const dryRun = values["dry-run"] ?? false;
  const databaseUrl = process.env.DATABASE_URL;
  if (!dryRun && !databaseUrl) {
    fail("DATABASE_URL must be set (or pass --dry-run to parse only)");
  }

  const startedAt = Date.now();

  // 1. Resolve input: default TxGIO URL -> download; zip -> extract.
  let input = values.file ?? county.downloadUrl;
  const sourceLabel = input;
  const workDir = await mkdtemp(join(tmpdir(), "txgio-ingest-"));
  if (isUrl(input)) {
    input = await downloadToFile(input, workDir, log);
  }
  const sourceFile = basename(input);

  let files: string[];
  const kind = await pathKind(input);
  if (kind === "missing") fail(`input not found: ${input}`);
  if (kind === "file" && /\.zip$/i.test(input)) {
    files = await extractZipEntries(input, workDir, TXGIO_ENTRY_FILTER, log);
  } else if (kind === "dir") {
    const names = await readdir(input);
    files = names.map((n) => join(input, n));
  } else {
    const stem = input.replace(/\.[^.]+$/, "");
    files = [input, `${stem}.dbf`, `${stem}.prj`];
  }
  let layers: ResolvedShapefile[];
  try {
    ({ layers } = selectShapefileLayers(files, multiShp));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  // Honest-absence: every discovered shapefile is named in the log.
  // A discarded part is a hard fail above; this line is the audit trail
  // for what WILL be read.
  log(
    `shapefiles discovered (${layers.length}): ` +
      layers.map((l) => basename(l.shpFile)).join(", "),
  );
  if (layers.length > 1) {
    log(
      `!! MULTI-SHP CONCAT: ${layers.length} shapefile parts will be ` +
        "streamed under one continuous feature_index (--multi-shp=concat)",
    );
  }

  // 2. SR handling — DETECT, then require an EXPLICIT opt-in to convert.
  //
  //    The default path is unchanged and still fails closed: a projected
  //    county with no --reproject is refused by `assertWgs84Prj` before
  //    a single feature is read. Detection alone never converts
  //    anything. What detection buys is the ERROR MESSAGE — a blocked
  //    202505 county now names the exact flag that unblocks it instead
  //    of leaving the operator to diagnose WKT.
  //
  //    Why opt-in rather than automatic: storing coordinates in a CRS
  //    other than the one the source declared is a decision about data
  //    provenance, and the ingest's posture is that such a decision is
  //    made by an operator per run, not inferred by a parser. The flag
  //    IS the decision, the log lines below are the record of it, and
  //    `+reprojected-from-epsg3857` on every row is the durable marker.
  //
  //    Multi-shp: every part's .prj is classified. Mixed CRS across
  //    parts fails closed — concatenating degrees with metres would
  //    invent geography.
  let reprojectFrom: SupportedSourceCrs | undefined;
  let prjKind: TxgioPrjKind | "absent" = "absent";
  const prjKindsSeen = new Set<TxgioPrjKind | "absent">();
  for (const layer of layers) {
    const prjFile = layer.prjFile;
    if (prjFile && (await pathKind(prjFile)) === "file") {
      const prjText = await readFile(prjFile, "utf8");
      const kind = classifyPrj(prjText);
      prjKindsSeen.add(kind);
      if (kind === "web-mercator") {
        if (!reprojectRequested) {
          fail(
            `${basename(prjFile)} declares EPSG:3857 Web Mercator (metres), ` +
              "not WGS84 degrees — this is the 202505 StratMap vintage that " +
              `57 of 254 counties ship. Refusing to store projected ` +
              "coordinates without an explicit decision. Re-run with " +
              "--reproject=3857 to convert to WGS84 at parse time (every row " +
              "is then stamped +reprojected-from-epsg3857, and the Texas " +
              "coordinate-range assertion still runs on the CONVERTED " +
              "coordinates).",
          );
        }
        reprojectFrom = "EPSG:3857";
        log(
          "!! REPROJECTING: source declares EPSG:3857 Web Mercator (metres) " +
            `in ${basename(prjFile)}; --reproject=3857 given, so every ` +
            "feature is converted to WGS84 degrees BEFORE the Texas " +
            "coordinate-range assertion, and every row's source_vintage is " +
            "stamped +reprojected-from-epsg3857",
        );
      } else {
        assertWgs84Prj(prjText, prjFile);
        log(`projection: GCS_WGS_1984 geographic (${basename(prjFile)})`);
        if (reprojectRequested) {
          log(
            "note: --reproject=3857 given but the source is already WGS84 " +
              "geographic — no conversion applied, nothing stamped",
          );
        }
      }
      prjKind = kind;
    } else {
      prjKindsSeen.add("absent");
      log(
        `WARNING: no .prj next to ${basename(layer.shpFile)} — the ` +
          "per-feature Texas WGS84 coordinate-range assertion is the only " +
          "projection guard for this part",
      );
    }
  }
  if (prjKindsSeen.size > 1) {
    fail(
      `multi-shapefile parts declare mixed CRS kinds (${[...prjKindsSeen].join(", ")}) — ` +
        "refusing to concatenate. Every part must share one CRS declaration " +
        "(or all lack a .prj, relying on the Texas envelope assertion).",
    );
  }
  if (prjKindsSeen.has("absent") && reprojectRequested && !reprojectFrom) {
    reprojectFrom = "EPSG:3857";
    log(
      "!! REPROJECTING from EPSG:3857 on the strength of --reproject=3857 " +
        "alone (no .prj to corroborate) — the Texas coordinate-range " +
        "assertion on the CONVERTED coordinates is the only check that " +
        "this was the right call",
    );
  }

  const baseVintage =
    values.vintage ??
    (layers.length === 1
      ? basename(layers[0]!.shpFile, extname(layers[0]!.shpFile)).toLowerCase()
      : multiShapefileVintage(layers));
  // Provenance travels on the row, not just in this log.
  const vintage = vintageWithProvenance(
    baseVintage,
    reprojectFrom,
  );
  const limit = values.limit !== undefined ? Number(values.limit) : undefined;

  log(`county=${county.fips} (${county.name}) source=${sourceLabel}`);
  log(
    `shapefile: ${layers.map((l) => l.shpFile).join(" + ")}`,
  );
  log(`vintage=${vintage}`);

  // 3. Parse + load (or drain, when --dry-run).
  const counters = newCounters();
  const records = readTxgioFeatures(
    county.fips,
    layers,
    counters,
    limit,
    reprojectFrom,
  );

  const batchSize =
    values["batch-size"] !== undefined
      ? Number(values["batch-size"])
      : TXGIO_DEFAULT_BATCH_SIZE;

  let featuresLoaded = 0;
  let rowsInserted = 0;
  // Rows the county holds now; every one of them an apply would delete.
  // `null` means the dry run had no DATABASE_URL and could not count.
  let rowsExisting: number | null = null;

  if (dryRun) {
    // Parse the real archive and PREDICT the apply: features that would
    // load, rows that would be inserted (one per intersecting grid
    // cell, exactly as the loader counts them), and rows the replace
    // would delete. Read-only — no transaction, no write, and the
    // connection is opened only to run one count(*).
    let pool: pg.Pool | undefined;
    try {
      if (databaseUrl) {
        pool = new Pool({ connectionString: databaseUrl });
        rowsExisting = await countCountyParcels(
          drizzle(pool) as unknown as TxgioTransactionalDb,
          county.fips,
        );
      }
      for await (const rec of records) {
        featuresLoaded += 1;
        rowsInserted += rec.tileKeys.length;
      }
    } finally {
      await pool?.end();
    }
  } else {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const db = drizzle(pool) as unknown as TxgioTransactionalDb;
      rowsExisting = await countCountyParcels(db, county.fips);
      log(
        `replacing existing ${county.fips} rows (${rowsExisting} present) ` +
          "— delete + load run in ONE transaction",
      );
      const summary = await replaceCountyParcels(db, county.fips, records, {
        sourceFile,
        sourceVintage: vintage,
        batchSize,
        onBatch: (total) => {
          if (total % 25_000 < batchSize) {
            log(`inserted ${total} rows...`);
          }
        },
      });
      featuresLoaded = summary.featuresLoaded;
      rowsInserted = summary.rowsInserted;
    } finally {
      await pool.end();
    }
  }

  // 4. Summary. The dry-run and apply lines are the SAME quantities so
  //    a dry/apply pair can be diffed directly.
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const wouldOrDid = dryRun ? "would " : "";
  const deleteCount = rowsExisting === null ? "unknown (no DATABASE_URL)" : rowsExisting;
  log(`---- ingest summary${dryRun ? " (DRY RUN — nothing written)" : ""} ----`);
  log(`county:           ${county.fips} (${county.name})`);
  // Store-derived: yes when rowsExisting > 0, no when 0, unknown when
  // dry-run had no DATABASE_URL. Do not use isTxgioCountyLoaded /
  // TXGIO_COUNTIES here — that hand map is for jurisdictions.ts only.
  log(`loaded before:    ${storeLoadedLabel(rowsExisting)}`);
  log(`source file:      ${sourceFile}`);
  log(`source vintage:   ${vintage}`);
  log(
    `source CRS:       ${
      prjKind === "absent" ? "undeclared (no .prj)" : prjKind
    }${reprojectFrom ? ` -> REPROJECTED to WGS84 from ${reprojectFrom}` : ""}`,
  );
  log(`features read:    ${counters.rowsRead}`);
  log(`features parsed:  ${counters.rowsParsed}`);
  log(`features ${wouldOrDid}load: ${featuresLoaded}`);
  log(`rows ${wouldOrDid}delete:  ${deleteCount}`);
  log(
    `rows ${wouldOrDid}insert:  ${rowsInserted} (one per intersecting grid cell)`,
  );
  // DECLINED FEATURES, BY CAUSE AND BY NAME. The old line reported a
  // single integer labelled "(no polygon geometry)", which was wrong for
  // two of the three paths feeding it and carried no identity at all —
  // that is how 148 features were dropped across 9 counties with nobody
  // able to say which. Every declination is now named.
  const byReason = summarizeDeclines(counters.declined);
  const reasonSummary = Object.entries(byReason)
    .map(([r, n]) => `${r}=${n}`)
    .join(", ");
  log(
    `features declined: ${counters.declined.length}` +
      (reasonSummary ? ` (${reasonSummary})` : ""),
  );
  for (const d of counters.declined.slice(0, DECLINE_LOG_CAP)) {
    log(
      `  DECLINED feature ${d.featureIndex} prop_id=${d.propId ?? "-"} ` +
        `geo_id=${d.geoId ?? "-"} objectid=${d.objectId ?? "-"} ` +
        `reason=${d.reason} :: ${d.detail}`,
    );
  }
  if (counters.declined.length > DECLINE_LOG_CAP) {
    log(
      `  ... ${counters.declined.length - DECLINE_LOG_CAP} more (full roster ` +
        `only in --declined-out)`,
    );
  }
  log(`duration:         ${seconds}s`);
  // The durable artifact: the full identified roster on disk, so a
  // declined parcel is answerable long after the run's stdout is gone.
  if (declinedOut) {
    await writeFile(
      declinedOut,
      JSON.stringify(
        {
          generated: new Date().toISOString(),
          county: county.fips,
          countyName: county.name,
          sourceFile,
          sourceVintage: vintage,
          dryRun,
          featuresRead: counters.rowsRead,
          featuresParsed: counters.rowsParsed,
          declinedCount: counters.declined.length,
          declinedByReason: byReason,
          ceiling: {
            absolute: TXGIO_MAX_DECLINED_ABSOLUTE,
            fraction: TXGIO_MAX_DECLINED_FRACTION,
          },
          declined: counters.declined,
        },
        null,
        2,
      ),
      "utf8",
    );
    log(`declined roster:  ${declinedOut}`);
  }
  if (counters.rowsParsed === 0) {
    fail("zero features parsed — wrong file or schema drift; nothing ingested");
  }
}

main().catch((err) => {
  console.error("[txgio-ingest] FATAL:", err);
  process.exit(1);
});
