#!/usr/bin/env node
/**
 * P-85 WDLL item 14 — daily records portal canary (selector drift detection).
 *
 * Runs versioned recipe selector probes for each P-85 portal and persists
 * canary_status on clerk_portal_terms. Failing probes mark lookup-failed until
 * the next passing run.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/p85/run-records-portal-canary.mjs
 *   DATABASE_URL=... node scripts/p85/run-records-portal-canary.mjs --portal-id=hays-erss
 *   DATABASE_URL=... node scripts/p85/run-records-portal-canary.mjs --dry-run
 *
 * Schedule: daily via Cloud Scheduler → Cloud Run Job (operator wires cron).
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const portalIds = [];
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("--portal-id=")) {
      portalIds.push(arg.slice("--portal-id=".length).trim());
    }
  }
  return { portalIds, dryRun };
}

async function main() {
  const { portalIds, dryRun } = parseArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL?.trim()) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const workerDir = path.resolve("artifacts/records-request-worker");
  const runnerPath = path.join(workerDir, "src/canaryCli.ts");

  const args = ["tsx", runnerPath];
  if (portalIds.length > 0) {
    args.push("--portal-ids", portalIds.join(","));
  }
  if (dryRun) {
    args.push("--dry-run");
  }

  const result = spawnSync("pnpm", args, {
    cwd: workerDir,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { parseArgs };
