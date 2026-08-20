#!/usr/bin/env node
/**
 * ONE scorer CLI for EVERY rail (lane SS-W12, P-47).
 *
 * Replaces the pattern where each rail's coverage arrives via a script
 * somebody wrote for one afternoon. `countyGeometryScoreCli.ts` and
 * `countyFloodScoreCli.ts` are near-identical files differing only in an
 * entity type and a threshold constant; `score_cad_rails_fast.mjs` is a third
 * copy of the same measurement with a clamp bolted on. What varies between
 * rails is DATA, so it lives in `lib/railScoring/registry.ts` and this CLI has
 * no per-rail branch at all.
 *
 * Usage (from repo root):
 *   tsx artifacts/api-server/src/countyRailScoreCli.ts --rail=flood --county=48021 --dry-run
 *   tsx artifacts/api-server/src/countyRailScoreCli.ts --rail=flood --rail=owner --dry-run
 *   tsx artifacts/api-server/src/countyRailScoreCli.ts --all-scoreable --dry-run
 *   tsx artifacts/api-server/src/countyRailScoreCli.ts --list
 *
 * `--dry-run` is the DEFAULT-SAFE path: it measures and diffs and writes
 * nothing, and its report still names every cell a real run would move.
 * Writing requires `--apply` explicitly. A ledger write is the one bulk-write
 * slot on this database (AGENT_CONTRACT section 3) and must be a deliberate
 * keystroke, never the consequence of forgetting a flag.
 *
 * CONNECTIONS, both named explicitly. `--atoms-url` / `ATOMS_DATABASE_URL`
 * for the atoms store; `--deployment-url` / `DEPLOYMENT_DATABASE_URL` for the
 * deployment store, each falling back to the matching gcloud secret. The bare
 * name `DATABASE_URL` is deliberately NOT read: it means the ATOMS store in
 * the older scorer CLIs and the DEPLOYMENT store in api-server, and one name
 * with two opposite meanings is not something to build more code on top of.
 *
 * Exit-bounded: resolve -> measure -> report -> exit. 0 on success, 1 on
 * fatal error, 2 when a requested rail could not be scored (a NAMED refusal,
 * distinct from success, so a caller can tell "nothing to do" from "would not
 * do it"), 3 when a peer holds the scoring advisory lock and nothing ran.
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import pg from "pg";

import type {
  MeasureContext,
  RailScoreRunReport,
} from "./lib/railScoring";

const { Pool } = pg;

/**
 * The capability is loaded DYNAMICALLY, after connection strings resolve.
 *
 * ORIGINAL REASON, NOW REMOVED. `lib/railScoring/engine.ts` used to import
 * `classifyFacet` from `countyCoverageScoreCli.ts`, which imports
 * `@workspace/cad-ingest`, which imports `@workspace/db`, whose module body
 * THROWS unless `DATABASE_URL` is set. This CLI opens its own pools and never
 * touches that singleton, so a static import would have made it die on a
 * variable it does not use — and on the one variable name that means the ATOMS
 * store in the sibling scorer CLIs and the DEPLOYMENT store in api-server.
 * Static imports are hoisted above the module body, so defaulting the variable
 * in `main()` would have been too late.
 *
 * That header named the better fix — moving `classifyFacet` into a leaf module
 * — and deferred it because the file was owned by an in-flight lane. Lane
 * SS-W18 took it on 2026-08-19 (`lib/countyCoverageClassification.ts`), for a
 * more expensive reason: the same import chain also put a CLI in the SERVER
 * boot graph, and the canary deploy of `5688aa31` exited before Express
 * listened. Verified after that change: the whole `lib/railScoring` barrel now
 * reaches only `@workspace/db/schema`, which is a pure subpath export and does
 * not read `DATABASE_URL`.
 *
 * The dynamic import is RETAINED rather than converted, because converting it
 * is a behaviour change to a CLI this lane was not scoped to touch and it buys
 * nothing today. It is recorded as a leave-behind, not as a live constraint.
 * What must not happen is this comment continuing to assert a reason that no
 * longer exists.
 */
type RailScoringModule = typeof import("./lib/railScoring");
let railScoring: RailScoringModule | null = null;
async function loadRailScoring(): Promise<RailScoringModule> {
  if (!railScoring) railScoring = await import("./lib/railScoring");
  return railScoring;
}

function log(msg: string): void {
  console.log(`[rail-score] ${msg}`);
}
function fail(msg: string): never {
  console.error(`[rail-score] ERROR: ${msg}`);
  process.exit(1);
}

function resolveViaGcloud(
  envVar: string,
  secretName: string,
  projectEnvVar: string,
  defaultProject: string,
  required: boolean,
): string | null {
  const direct = process.env[envVar]?.trim();
  if (direct) return direct;
  const gcloud =
    process.env.GCLOUD_BIN ??
    (process.platform === "win32"
      ? "C:\\Users\\cente\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd"
      : "gcloud");
  const project = process.env[projectEnvVar] ?? defaultProject;
  try {
    const out = execFileSync(
      gcloud,
      [
        "secrets",
        "versions",
        "access",
        "latest",
        `--secret=${secretName}`,
        `--project=${project}`,
      ],
      { encoding: "utf8" },
    ).trim();
    if (out) return out;
  } catch (err) {
    if (required) {
      fail(
        `${envVar} not set and gcloud secret fetch failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    return null;
  }
  return required ? fail(`${envVar} could not be resolved`) : null;
}

function makePool(connectionString: string, max: number): pg.Pool {
  return new Pool({
    connectionString,
    ssl: connectionString.includes("sslmode=")
      ? undefined
      : { rejectUnauthorized: false },
    max,
  });
}

/**
 * `--list` reads a checked-in declaration and touches no database, so it must
 * not need a connection string. It imports `./lib/railScoring/registry`
 * DIRECTLY rather than the barrel. The original reason was that the barrel
 * re-exported the engine, which imported classifyFacet from
 * countyCoverageScoreCli.ts, which reached @workspace/db and threw without
 * DATABASE_URL. Caught by running the cheapest command in the tool, which had
 * become the one command that could not run.
 *
 * Lane SS-W18 removed that chain on 2026-08-19, so the direct import is now
 * narrowness rather than necessity. It is kept because importing the one
 * module you need is correct regardless, and because the barrel is exactly the
 * hop that carried the boot-graph defect into production.
 */
async function printRegistry(): Promise<void> {
  const { RAIL_SCORING_DECLARATION, scoreableRailKeys, unspecifiedRails } =
    await import("./lib/railScoring/registry");
  log("--- rail scoring registry ---");
  for (const rule of RAIL_SCORING_DECLARATION) {
    if (rule.kind === "unspecified") {
      log(
        `  ${rule.railKey.padEnd(14)} NOT SCOREABLE  owner=${rule.specOwner}`,
      );
      log(`    ${rule.unspecifiedReason}`);
    } else {
      log(
        `  ${rule.railKey.padEnd(14)} ${rule.kind.padEnd(34)} den=${rule.denominator.kind}`,
      );
    }
  }
  log(
    `scoreable: ${scoreableRailKeys().length} of ${RAIL_SCORING_DECLARATION.length}; ` +
      `awaiting a measurement spec: ${unspecifiedRails().map((r) => r.railKey).join(", ")}`,
  );
}

function printReport(report: RailScoreRunReport): void {
  log("---- rail-score run ----");
  log(`mode:            ${report.dryRun ? "DRY-RUN (no writes)" : "APPLY"}`);
  log(`county target:   ${report.countyTargetBasis}`);
  for (const rail of report.rails) {
    log(
      `  ${rail.railKey.padEnd(14)} scored=${String(rail.countiesScored).padStart(3)} ` +
        `changed=${String(rail.cellsChanged).padStart(3)} coverageMoved=${String(rail.cellsCoverageMoved).padStart(3)} unchanged=${String(rail.cellsUnchanged).padStart(3)} ` +
        `written=${String(rail.cellsWritten).padStart(3)} refused=${String(rail.countiesRefused.length).padStart(3)} ` +
        `states=${JSON.stringify(rail.byRailState)}`,
    );
    // The counting rule travels WITH the number, at the point of use.
    log(`    denominator (${rail.denominator.kind}): ${rail.denominator.basis}`);
    if (rail.overcountCounties.length > 0) {
      log(
        `    OVERCOUNT (numerator > denominator, failed closed to not-yet, never clamped): ` +
          rail.overcountCounties.join(","),
      );
    }
    for (const refusal of rail.absenceRefusals) {
      log(`    ABSENCE REFUSED ${refusal.countyFips}: ${refusal.reason}`);
    }
    for (const kept of rail.absencesPreserved) {
      log(
        `    ABSENCE PRESERVED ${kept.countyFips}: this rail has no probe able to ` +
          `reassess it (basis: ${kept.basis ?? "none recorded"})`,
      );
    }
    // NOT MEASURED is a first-class result, printed with its counts and one
    // worked example per code. On the zoning rail this is most of Texas: 23
    // city zoning layers are wired across 10 counties against 1,222
    // incorporated municipalities. A summary that showed only `scored=` would
    // let a reader believe the other 244 counties had been looked at.
    if (rail.countiesRefused.length > 0) {
      log(
        `    NOT MEASURED: ${rail.countiesRefused.length} of ${
          rail.countiesRefused.length + rail.countiesScored
        } counties. No row is written for these; the console shows them as ` +
          `not-measured, distinct from measured-below-bar.`,
      );
      for (const [code, n] of Object.entries(rail.refusalCounts).sort()) {
        const example = rail.countiesRefused.find((r) => r.refusal === code);
        log(`      ${code.padEnd(24)} ${String(n).padStart(4)}  e.g. ${example?.countyFips ?? "?"}`);
        if (example) log(`        basis: ${example.basis}`);
      }
    }
    if (rail.cellsOmittedReason) log(`    cells omitted: ${rail.cellsOmittedReason}`);
    for (const cell of rail.cells ?? []) {
      log(
        `    ${cell.countyFips} ${String(cell.numerator ?? "na").padStart(8)}/${String(
          cell.denominator ?? "na",
        ).padStart(8)} = ${cell.honestCoveragePct.toFixed(2).padStart(7)}%` +
          ` -> ${cell.railState}${cell.overcount ? " OVERCOUNT" : ""}${cell.changed ? " CHANGED" : ""}`,
      );
    }
  }
  for (const u of report.railsUnavailable) {
    log(`  ${u.railKey.padEnd(14)} UNAVAILABLE (${u.reason}): ${u.message}`);
  }
  log(
    `totals: changed=${report.totals.cellsChanged} coverageMoved=${report.totals.cellsCoverageMoved} unchanged=${report.totals.cellsUnchanged} ` +
      `written=${report.totals.cellsWritten} refused=${report.totals.cellsRefused} ` +
      `duration=${(report.durationMs / 1000).toFixed(1)}s`,
  );
  if (report.dryRun && report.totals.cellsWritten !== 0) {
    fail(
      `INVARIANT VIOLATED: a dry run reported ${report.totals.cellsWritten} writes`,
    );
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      rail: { type: "string", multiple: true },
      county: { type: "string", multiple: true },
      "all-scoreable": { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      json: { type: "string" },
      cells: { type: "boolean", default: false },
      "reassess-absences": { type: "boolean", default: false },
    },
  });

  if (values.list) {
    await printRegistry();
    return;
  }

  const railKeys = values.rail ?? [];
  const allScoreable = values["all-scoreable"] ?? false;
  if (railKeys.length === 0 && !allScoreable) {
    fail("pass --rail=<key> (repeatable), --all-scoreable, or --list");
  }
  if (values.apply && values["dry-run"]) {
    fail("--apply and --dry-run are mutually exclusive");
  }
  const dryRun = !values.apply;

  const deploymentUrl = resolveViaGcloud(
    "DEPLOYMENT_DATABASE_URL",
    "DEPLOYMENT_DATABASE_URL",
    "GCP_PROJECT",
    "legacy-design-tools-prod",
    true,
  ) as string;
  const atomsUrl = resolveViaGcloud(
    "ATOMS_DATABASE_URL",
    "DATABASE_URL",
    "GCP_ATOMS_PROJECT",
    "hauska-prod-497015",
    false,
  );

  // Satisfy `@workspace/db`'s module-body guard BEFORE the dynamic import
  // below pulls it in transitively. This CLI never uses that singleton; it
  // opens its own pools. Pointing it at the DEPLOYMENT store is the correct
  // meaning of `DATABASE_URL` inside api-server, so nothing downstream is
  // misdirected. `new Pool()` does not connect, so this costs no connection.
  if (!process.env.DATABASE_URL?.trim()) {
    process.env.DATABASE_URL = deploymentUrl;
  }
  const { runRailScore, scoreableRailKeys, withRailScoreLock, RAIL_SCORE_LOCK_NAMESPACE } =
    await loadRailScoring();

  const deploymentPool = makePool(deploymentUrl, 4);
  const atomsPool = atomsUrl ? makePool(atomsUrl, 2) : null;
  if (!atomsPool) {
    log(
      "ATOMS store NOT configured: atom-count rails will be reported UNAVAILABLE, never scored as zero",
    );
  }

  const ctx: MeasureContext = {
    deployment: deploymentPool,
    atoms: atomsPool,
  };

  // ONE scoring run at a time, the same advisory lock the route takes. Without
  // this the serialization control existed only on the HTTP path, while the
  // CLI is the path a human runs by hand. A session-scoped lock lives on ONE
  // connection, so the lock is held on a dedicated client checked out of the
  // pool for the duration, never on the pool itself.
  const lockClient = await deploymentPool.connect();
  let report: RailScoreRunReport;
  try {
    const outcome = await withRailScoreLock(
      lockClient as unknown as Parameters<typeof withRailScoreLock>[0],
      RAIL_SCORE_LOCK_NAMESPACE,
      async () =>
        await runRailScore(ctx, {
          railKeys: allScoreable ? scoreableRailKeys() : railKeys,
          countyFips: values.county ?? undefined,
          dryRun,
          includeCells: values.cells ?? false,
          reassessAbsences: values["reassess-absences"] ?? false,
        }),
    );
    if (!outcome.acquired) {
      log(
        "another rail scoring run holds the cluster advisory lock; at most one runs at a time. Nothing was measured and nothing was written.",
      );
      process.exitCode = 3;
      return;
    }
    report = outcome.result;
  } finally {
    lockClient.release();
    await deploymentPool.end();
    if (atomsPool) await atomsPool.end();
  }

  printReport(report);
  if (values.json) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(values.json, JSON.stringify(report, null, 2), "utf8");
    log(`report written to ${values.json}`);
  }
  if (report.railsUnavailable.length > 0) {
    process.exitCode = 2;
  }
}

/** Entrypoint guard — only run main() when executed directly, never on import. */
function isDirectRun(): boolean {
  const entry = argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error("[rail-score] FATAL:", err);
    process.exit(1);
  });
}
