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
 * do it").
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import pg from "pg";

import {
  RAIL_SCORING_DECLARATION,
  runRailScore,
  scoreableRailKeys,
  unspecifiedRails,
  type MeasureContext,
  type RailScoreRunReport,
} from "./lib/railScoring";

const { Pool } = pg;

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

function printRegistry(): void {
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
        `changed=${String(rail.cellsChanged).padStart(3)} unchanged=${String(rail.cellsUnchanged).padStart(3)} ` +
        `written=${String(rail.cellsWritten).padStart(3)} states=${JSON.stringify(rail.byRailState)}`,
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
  }
  for (const u of report.railsUnavailable) {
    log(`  ${u.railKey.padEnd(14)} UNAVAILABLE (${u.reason}): ${u.message}`);
  }
  log(
    `totals: changed=${report.totals.cellsChanged} unchanged=${report.totals.cellsUnchanged} ` +
      `written=${report.totals.cellsWritten} duration=${(report.durationMs / 1000).toFixed(1)}s`,
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
    },
  });

  if (values.list) {
    printRegistry();
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

  let report: RailScoreRunReport;
  try {
    report = await runRailScore(ctx, {
      railKeys: allScoreable ? scoreableRailKeys() : railKeys,
      countyFips: values.county ?? undefined,
      dryRun,
    });
  } finally {
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
