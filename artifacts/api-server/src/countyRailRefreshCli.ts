#!/usr/bin/env node
/**
 * County Manifest rail dimension REFRESH CLI.
 *
 * `county_rail` (see `lib/db/src/schema/countyRail.ts`) was seeded once by
 * migration 0068 (PR #391) and never updated after — a snapshot of what was
 * true at seed time, presented by the county-ledger endpoint as current.
 * This CLI is the fix for that CLASS of defect: it diffs the live table
 * against the checked-in declaration at
 * `lib/db/src/schema/countyRailDimension.ts` (`COUNTY_RAIL_DECLARATION`,
 * the single obvious place to edit when the atom contract publishes a new
 * family or the engine registers a new entity type) and reports/applies
 * exactly the rows that differ. Re-running it after editing the
 * declaration is how the class of defect gets fixed permanently instead of
 * once.
 *
 * Three kinds of change it can make:
 *   - UPDATE  a rail_key present in both, where any declared column
 *             differs from the live row.
 *   - INSERT  a rail_key present in the declaration but absent from the
 *             live table (none expected today; all twelve pre-exist from
 *             migration 0068, minus `join`).
 *   - DELETE  a rail_key present in the live table but absent from the
 *             declaration (`join`, removed 2026-08-08 per the join-is-a-
 *             derived-metric-not-a-rail ruling).
 *
 * Never touches `county_facet_coverage` (the measured cells) or
 * `county_manifest` (the county roster) — those are separate tables this
 * script does not read or write.
 *
 * READ-ONLY on `county_facet_coverage`/`county_manifest`. The ONLY table
 * this script writes is `county_rail`, and even that is skipped under
 * `--dry-run` (the default — `--apply` is required to write).
 *
 * Usage (from repo root):
 *   tsx artifacts/api-server/src/countyRailRefreshCli.ts            # dry-run, prints the diff
 *   tsx artifacts/api-server/src/countyRailRefreshCli.ts --apply    # writes the diff
 *
 * DATABASE_URL must point at the deployment Postgres (falls back to
 * loading the DEPLOYMENT_DATABASE_URL secret via gcloud, identical to
 * countyCoverageScoreCli.ts / the bake CLIs).
 *
 * Exit-bounded: connect -> read -> diff -> report (-> write under --apply)
 * -> exit. Exit 0 on success (including a clean no-op diff), 1 on fatal
 * error.
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import pg from "pg";

import {
  COUNTY_RAIL_DECLARATION,
  type CountyRailDeclaration,
} from "@workspace/db";

const { Pool } = pg;

function log(msg: string): void {
  console.log(`[county-rail-refresh] ${msg}`);
}
function fail(msg: string): never {
  console.error(`[county-rail-refresh] ERROR: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Live row shape (subset of county_rail columns this script compares).
// ---------------------------------------------------------------------------

interface LiveRailRow {
  rail_key: string;
  display_name: string;
  ordinal: number;
  rail_letter: string | null;
  kind: string;
  threshold_pct: string; // numeric column, arrives as string from pg
  atom_family_state: string;
  atom_family_ref: string | null;
  has_writer: boolean;
  writer_ref: string | null;
  declared_source: string;
  notes: string | null;
}

/** The declared columns this script owns and compares — every column in the table except `updated_at` (server-set) and the `rail_key` primary key itself. */
const COMPARED_COLUMNS = [
  "displayName",
  "ordinal",
  "railLetter",
  "kind",
  "thresholdPct",
  "atomFamilyState",
  "atomFamilyRef",
  "hasWriter",
  "writerRef",
  "declaredSource",
  "notes",
] as const;
type ComparedColumn = (typeof COMPARED_COLUMNS)[number];

function liveValue(row: LiveRailRow, col: ComparedColumn): string | number | boolean | null {
  switch (col) {
    case "displayName":
      return row.display_name;
    case "ordinal":
      return row.ordinal;
    case "railLetter":
      return row.rail_letter;
    case "kind":
      return row.kind;
    case "thresholdPct":
      return Number(row.threshold_pct);
    case "atomFamilyState":
      return row.atom_family_state;
    case "atomFamilyRef":
      return row.atom_family_ref;
    case "hasWriter":
      return row.has_writer;
    case "writerRef":
      return row.writer_ref;
    case "declaredSource":
      return row.declared_source;
    case "notes":
      return row.notes;
  }
}

function declaredValue(
  decl: CountyRailDeclaration,
  col: ComparedColumn,
): string | number | boolean | null {
  switch (col) {
    case "displayName":
      return decl.displayName;
    case "ordinal":
      return decl.ordinal;
    case "railLetter":
      return decl.railLetter;
    case "kind":
      return decl.kind;
    case "thresholdPct":
      return decl.thresholdPct;
    case "atomFamilyState":
      return decl.atomFamilyState;
    case "atomFamilyRef":
      return decl.atomFamilyRef;
    case "hasWriter":
      return decl.hasWriter;
    case "writerRef":
      return decl.writerRef;
    case "declaredSource":
      return decl.declaredSource;
    case "notes":
      return decl.notes;
  }
}

// ---------------------------------------------------------------------------
// Diff — PURE, unit-testable without a DB.
// ---------------------------------------------------------------------------

export interface FieldDiff {
  column: ComparedColumn;
  live: string | number | boolean | null;
  declared: string | number | boolean | null;
}

export interface RailDiff {
  railKey: string;
  kind: "update" | "insert" | "delete";
  fields: FieldDiff[];
}

/** Diff the live county_rail rows against the declaration. PURE — no I/O. */
export function diffRails(
  live: LiveRailRow[],
  declaration: ReadonlyArray<CountyRailDeclaration>,
): RailDiff[] {
  const liveByKey = new Map(live.map((r) => [r.rail_key, r]));
  const declByKey = new Map(declaration.map((d) => [d.railKey, d]));
  const diffs: RailDiff[] = [];

  for (const decl of declaration) {
    const liveRow = liveByKey.get(decl.railKey);
    if (!liveRow) {
      diffs.push({
        railKey: decl.railKey,
        kind: "insert",
        fields: COMPARED_COLUMNS.map((col) => ({
          column: col,
          live: null,
          declared: declaredValue(decl, col),
        })),
      });
      continue;
    }
    const fields: FieldDiff[] = [];
    for (const col of COMPARED_COLUMNS) {
      const lv = liveValue(liveRow, col);
      const dv = declaredValue(decl, col);
      if (lv !== dv) fields.push({ column: col, live: lv, declared: dv });
    }
    if (fields.length > 0) {
      diffs.push({ railKey: decl.railKey, kind: "update", fields });
    }
  }

  for (const liveRow of live) {
    if (!declByKey.has(liveRow.rail_key)) {
      diffs.push({
        railKey: liveRow.rail_key,
        kind: "delete",
        fields: COMPARED_COLUMNS.map((col) => ({
          column: col,
          live: liveValue(liveRow, col),
          declared: null,
        })),
      });
    }
  }

  return diffs;
}

function columnToSnakeCase(col: ComparedColumn): string {
  const map: Record<ComparedColumn, string> = {
    displayName: "display_name",
    ordinal: "ordinal",
    railLetter: "rail_letter",
    kind: "kind",
    thresholdPct: "threshold_pct",
    atomFamilyState: "atom_family_state",
    atomFamilyRef: "atom_family_ref",
    hasWriter: "has_writer",
    writerRef: "writer_ref",
    declaredSource: "declared_source",
    notes: "notes",
  };
  return map[col];
}

function reportDiff(diff: RailDiff): void {
  log(`${diff.kind.toUpperCase()} ${diff.railKey}`);
  for (const f of diff.fields) {
    log(
      `    ${f.column}: ${JSON.stringify(f.live)} -> ${JSON.stringify(f.declared)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// DATABASE_URL resolution (identical fallback to countyCoverageScoreCli.ts
// / the bake CLIs).
// ---------------------------------------------------------------------------

function resolveDatabaseUrl(): string {
  const direct = process.env.DATABASE_URL?.trim();
  if (direct) return direct;
  const gcloud =
    process.env.GCLOUD_BIN ??
    (process.platform === "win32"
      ? "C:\\Users\\cente\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd"
      : "gcloud");
  const project = process.env.GCP_PROJECT ?? "legacy-design-tools-prod";
  try {
    const out = execFileSync(
      gcloud,
      [
        "secrets",
        "versions",
        "access",
        "latest",
        "--secret=DEPLOYMENT_DATABASE_URL",
        `--project=${project}`,
      ],
      { encoding: "utf8" },
    ).trim();
    if (out) return out;
  } catch (err) {
    fail(
      "DATABASE_URL not set and gcloud secret fetch failed: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  return fail("DATABASE_URL could not be resolved");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      apply: { type: "boolean", default: false },
    },
  });
  const apply = values.apply ?? false;

  const startedAt = Date.now();
  const databaseUrl = resolveDatabaseUrl();
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("sslmode=")
      ? undefined
      : { rejectUnauthorized: false },
    max: 2,
  });

  let diffs: RailDiff[] = [];
  try {
    const { rows } = await pool.query<LiveRailRow>(
      "SELECT rail_key, display_name, ordinal, rail_letter, kind, threshold_pct, atom_family_state, atom_family_ref, has_writer, writer_ref, declared_source, notes FROM county_rail ORDER BY ordinal",
    );
    diffs = diffRails(rows, COUNTY_RAIL_DECLARATION);

    log(`live rows:        ${rows.length}`);
    log(`declared rows:    ${COUNTY_RAIL_DECLARATION.length}`);
    log(`diffs found:      ${diffs.length}`);
    for (const d of diffs) reportDiff(d);

    if (apply && diffs.length > 0) {
      await pool.query("BEGIN");
      try {
        for (const d of diffs) {
          if (d.kind === "delete") {
            await pool.query("DELETE FROM county_rail WHERE rail_key = $1", [
              d.railKey,
            ]);
            continue;
          }
          const decl = COUNTY_RAIL_DECLARATION.find(
            (x) => x.railKey === d.railKey,
          );
          if (!decl) continue; // unreachable for update/insert diffs
          if (d.kind === "insert") {
            await pool.query(
              `INSERT INTO county_rail
                 (rail_key, display_name, ordinal, rail_letter, kind, threshold_pct,
                  atom_family_state, atom_family_ref, has_writer, writer_ref,
                  declared_source, notes, updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())`,
              [
                decl.railKey,
                decl.displayName,
                decl.ordinal,
                decl.railLetter,
                decl.kind,
                decl.thresholdPct,
                decl.atomFamilyState,
                decl.atomFamilyRef,
                decl.hasWriter,
                decl.writerRef,
                decl.declaredSource,
                decl.notes,
              ],
            );
            continue;
          }
          // update: only touch columns that actually diffed, plus updated_at.
          const setCols = d.fields.map((f) => columnToSnakeCase(f.column));
          const setSql = setCols
            .map((col, i) => `${col} = $${i + 2}`)
            .join(", ");
          const setVals = d.fields.map((f) => declaredValue(decl, f.column));
          await pool.query(
            `UPDATE county_rail SET ${setSql}, updated_at = now() WHERE rail_key = $1`,
            [decl.railKey, ...setVals],
          );
        }
        await pool.query("COMMIT");
      } catch (err) {
        await pool.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await pool.end();
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  log("---- county-rail-refresh summary ----");
  log(`mode:             ${apply ? "APPLY (wrote diffs)" : "DRY-RUN (no writes)"}`);
  log(`updates:          ${diffs.filter((d) => d.kind === "update").length}`);
  log(`inserts:          ${diffs.filter((d) => d.kind === "insert").length}`);
  log(`deletes:          ${diffs.filter((d) => d.kind === "delete").length}`);
  log(`duration:         ${seconds}s`);
  if (!apply && diffs.length > 0) {
    log("dry-run only — re-run with --apply to write these changes.");
  }
}

/** Entrypoint guard — only run main() when executed directly, not on import. */
function isDirectRun(): boolean {
  const entry = argv[1];
  if (!entry) return false;
  try {
    const entryReal = realpathSync(entry);
    const thisReal = realpathSync(fileURLToPath(import.meta.url));
    return entryReal === thisReal;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
